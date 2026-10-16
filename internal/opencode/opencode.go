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

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/config"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/9Ashwin/flow-one/internal/sse"
)

// 两条路的**事实**（端点、匿名凭据、UA）。导出是因为 doctor 要自己构造原始请求去
// 逐项重推门禁形状（先确认完整形状 200，再逐个去掉一个要件确认它仍必填）——
// 探测的那一侧必须拿得到同样的端点与头部取值。
const (
	// AnonymousKey 是免费档的匿名凭据（官方 CLI 没有 key 时也用它）。
	AnonymousKey = "public"

	// DefaultUserAgent 是免费档照抄官方客户端的 UA（版本号是照抄的一部分）。
	DefaultUserAgent = "opencode/1.18.22"

	// 两条路的端点不一样：免费档在 /inference/v1，Go 套餐在 /zen/go/v1。
	FreeBaseURL    = "https://opencode.ai/inference"
	FreeChatPath   = "/v1/chat/completions"
	FreeModelsPath = "/v1/models"

	GoBaseURL    = "https://opencode.ai/zen/go/v1"
	GoChatPath   = "/chat/completions"
	GoModelsPath = "/models"

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

// classify 在 sse.Failure 的通用分类（upstream/bad_status）之上，再细分本来源自己的
// 几种失败：免费档门禁（403 FreeTierError）与缺会话头（400 MissingSessionID）都要能
// 一眼看出来 —— 它们**响亮但容易被误读**，doctor 与向导据此给不同的话。
func classify(failed *errs.Error) *errs.Error {
	lower := strings.ToLower(failed.Message)
	switch {
	case strings.Contains(lower, "free tier can only be used"), strings.Contains(lower, "freetiererror"):
		return errs.Upstream(errs.SubtypeShapeRejected, failed.Message).WithCode(failed.Code)
	case strings.Contains(lower, "missingsessionid"), strings.Contains(lower, "missing session"):
		return errs.Upstream(errs.SubtypeMissingSession, failed.Message).WithCode(failed.Code)
	case failed.Code == http.StatusTooManyRequests, strings.Contains(lower, "quota"), strings.Contains(lower, "rate limit"):
		return errs.Upstream(errs.SubtypeQuotaLimited, failed.Message).WithCode(failed.Code)
	default:
		return failed
	}
}

// shortID 取 id 的前几位，只用于日志里认人（会话 id 是 ASCII，按字节切安全）。
func shortID(id string, length int) string {
	if len(id) <= length {
		return id
	}
	return id[:length]
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
		return classify(sse.Failure(response))
	}
	return decode(response.Body)
}

// source.Stream 的编译期断言：两条路交出去的分片都必须能直接喂给翻译层。
var _ source.Stream = (*sse.Reader)(nil)
