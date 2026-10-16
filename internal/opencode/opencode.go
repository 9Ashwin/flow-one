// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package opencode 实现 OpenCode 的两条路：免费档（`oc`）与 Go 套餐（`ocg`）。
//
// 两条路是**两条**，规矩完全不同，别把它们的处理混在一起：
//
//   - 免费档（`oc`）：匿名 `Bearer public`，端点 `/inference/v1`。上游按**报文形状**
//     判断调用方是不是官方客户端，所以必须凑齐 5 个 `x-opencode-*` 头、`ses_` 形状的
//     会话 id、`stream:true`，以及 bash/glob/grep/read 四个小写 function 工具；
//     工具名来回都要改（见 gate.go）。规则与证据见 docs/gates.md。
//   - Go 套餐（`ocg`）：`oc_sk_…` + **必填**的 `x-opencode-session`，端点 `/zen/go/v1`。
//     不需要那套形状，也不发 `x-opencode-client`（多发了反而是「冒充免费档」）。
//
// 两条路都**不做**腾讯内容风控改写：Rewriter() 一律返回 nil。判据是「这条来源是谁」，
// 不是「模型名前缀长什么样」—— 任何按前缀猜是不是腾讯系的旁路都算 bug（AGENTS.md 的
// 套餐分离不变式）。
package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
)

const (
	// anonymousKey 是免费档的匿名凭据（官方 CLI 没有 key 时也用它）。
	anonymousKey = "public"

	// defaultUserAgent 是免费档照抄官方客户端的 UA（版本号是照抄的一部分）。
	defaultUserAgent = "opencode/1.18.22"

	// 两条路的端点不一样：免费档在 /inference/v1，Go 套餐在 /zen/go/v1。
	freeBaseURL    = "https://opencode.ai/inference"
	freeChatPath   = "/v1/chat/completions"
	freeModelsPath = "/v1/models"

	goBaseURL    = "https://opencode.ai/zen/go/v1"
	goChatPath   = "/chat/completions"
	goModelsPath = "/models"

	// 免费档形状门禁要求的 5 个头。
	projectHeader    = "x-opencode-project"
	sessionHeader    = "x-opencode-session"
	sessionIDHeader  = "x-opencode-session-id"
	requestHeader    = "x-opencode-request"
	clientHeader     = "x-opencode-client"
	clientHeaderName = "cli"

	// modelsDevURL 是能力元数据源（官方 CLI 自己也用它；/v1/models 里没有任何能力字段）。
	modelsDevURL   = "https://models.dev/api.json"
	modelsDevTTL   = time.Hour
	modelsDevLimit = 32 << 20

	// modelsTimeout 是模型清单与能力表的出站上限；对话不走它（跟着请求的 ctx 取消）。
	modelsTimeout = 20 * time.Second

	// maxErrorBody 限制我们为了报错而读进来的正文长度。
	maxErrorBody = 64 << 10
)

// Options 是构造一条来源的输入。零值即生产默认：真上游端点、BRIDGE_HOME 下的数据目录、
// 默认的 http.Client。测试用 BaseURL / ModelsDevURL / HTTPClient 指向 httptest.Server。
type Options struct {
	// Home 是数据目录（BRIDGE_HOME）；空则用 config.Home()。
	Home string
	// CredentialFile 是凭据文件；空则用 Home/credentials.json（与腾讯两条线共用一份）。
	CredentialFile string
	// BaseURL 覆盖上游端点，用于测试。
	BaseURL string
	// ModelsDevURL 覆盖能力元数据源，用于测试。
	ModelsDevURL string
	// HTTPClient 覆盖出站客户端，用于测试。
	HTTPClient *http.Client
	// Logf 是进度输出（stderr 那一侧），默认丢弃。
	Logf func(format string, args ...any)
}

// client 是两条路共用的出站配置。
type client struct {
	baseURL        string
	modelsDevURL   string
	home           string
	credentialFile string
	httpClient     *http.Client
	logf           func(format string, args ...any)
}

func newClient(opts Options, defaultBaseURL string) (client, error) {
	home := opts.Home
	if home == "" {
		resolved, err := config.Home()
		if err != nil {
			return client{}, err
		}
		home = resolved
	}
	c := client{
		baseURL:        opts.BaseURL,
		modelsDevURL:   opts.ModelsDevURL,
		home:           home,
		credentialFile: opts.CredentialFile,
		httpClient:     opts.HTTPClient,
		logf:           opts.Logf,
	}
	if c.baseURL == "" {
		c.baseURL = defaultBaseURL
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")
	if c.modelsDevURL == "" {
		c.modelsDevURL = modelsDevURL
	}
	if c.credentialFile == "" {
		c.credentialFile = config.CredentialPath(home)
	}
	if c.httpClient == nil {
		c.httpClient = &http.Client{}
	}
	if c.logf == nil {
		c.logf = func(string, ...any) {}
	}
	return c, nil
}

// ok 报告上游是不是 2xx（Node 版的 response.ok）。
func ok(resp *http.Response) bool {
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// failure 把上游的非 2xx 响应收敛成类型化错误：分类看状态码与正文，消息尽量保留
// 上游原本的理由 —— FreeTierError 与 MissingSessionID 这两句要能一眼看见。
func failure(status int, raw []byte) *errs.Error {
	message := failureMessage(status, raw)
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "free tier can only be used"), strings.Contains(lower, "freetiererror"):
		return errs.Upstream(errs.SubtypeShapeRejected, message).WithCode(status)
	case strings.Contains(lower, "missingsessionid"), strings.Contains(lower, "missing session"):
		return errs.Upstream(errs.SubtypeMissingSession, message).WithCode(status)
	case status == http.StatusTooManyRequests, strings.Contains(lower, "quota"), strings.Contains(lower, "rate limit"):
		return errs.Upstream(errs.SubtypeQuotaLimited, message).WithCode(status)
	default:
		return errs.Upstream(errs.SubtypeBadStatus, message).WithCode(status)
	}
}

// failureMessage 从上游正文里抽出最像「理由」的那句话；抽不出来就退回状态码本身。
func failureMessage(status int, raw []byte) string {
	message := fmt.Sprintf("上游返回 %d", status)
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return message
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return truncate(text, 500)
	}
	if detail := detailOf(payload); detail != "" {
		return detail
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return truncate(text, 500)
	}
	return truncate(string(encoded), 500)
}

// detailOf 取上游报文里最像「理由」的字段：OpenCode 是 `{error:{type,message}}`，
// 别家多是 `{error:{message}}` 或 `{msg}`。
func detailOf(payload map[string]any) string {
	if inner, isObject := payload["error"].(map[string]any); isObject {
		if text, found := stringField(inner, "message"); found {
			return text
		}
		if text, found := stringField(inner, "type"); found {
			return text
		}
		if encoded, err := json.Marshal(inner); err == nil {
			return truncate(string(encoded), 500)
		}
	}
	for _, key := range []string{"msg", "message", "error"} {
		if text, found := stringField(payload, key); found {
			return text
		}
	}
	return ""
}

func stringField(payload map[string]any, key string) (string, bool) {
	text, isText := payload[key].(string)
	if !isText || text == "" {
		return "", false
	}
	return text, true
}

// truncate 按字符（不是字节）截断，别把一个 UTF-8 字符切成半个。
func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// networkFailure 把出站失败收敛成 network 分类：超时与连不上要分得开。
func networkFailure(label string, err error) *errs.Error {
	subtype := errs.SubtypeConnectFailed
	var timeout interface{ Timeout() bool }
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		subtype = errs.SubtypeTimeout
	}
	return errs.Wrap(err, errs.CategoryNetwork, subtype, fmt.Sprintf("%s：连不上上游（%v）", label, err)).
		WithHint("检查网络与代理设置；公司网络下可能需要放行 opencode.ai")
}

// decodeBody 解析出站请求体。数字用 json.Number 接住：走一遍 map 不该把
// max_tokens 之类的整数改写成 1e+06。
func decodeBody(raw []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	body := map[string]any{}
	if err := decoder.Decode(&body); err != nil {
		return nil, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeParseFailed, "请求体不是合法 JSON 对象")
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

// readErrorBody 读一点正文用于报错（上限 maxErrorBody，别把一整篇 HTML 读进来）。
func readErrorBody(body io.Reader) []byte {
	raw, err := io.ReadAll(io.LimitReader(body, maxErrorBody))
	if err != nil {
		return nil
	}
	return raw
}

// getJSON 发一次 GET 并把 2xx 的正文交给 decode；失败一律是类型化错误。
func (c client) getJSON(ctx context.Context, label string, url string, header http.Header, decode func(io.Reader) error) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return errs.InternalFrom(err)
	}
	for key, values := range header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return networkFailure(label, err)
	}
	defer response.Body.Close()
	if !ok(response) {
		return failure(response.StatusCode, readErrorBody(response.Body))
	}
	return decode(response.Body)
}
