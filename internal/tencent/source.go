// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/auth"
	"github.com/9Ashwin/flow-one/internal/source"
)

const (
	// enterpriseScope 是企业模型端点的 scope 段（两条产品线都是个人版）。
	enterpriseScope = "personal"
	// catalogTTL 是模型目录的缓存时长。
	//
	// source.Registry 的 Find 每次都会调 ListModels，而这条线一次要发两个请求；
	// Node 版在上游层也有同样一份 60s 缓存。
	catalogTTL = 60 * time.Second
	// requestTimeout 是目录请求的超时。对话请求的超时只覆盖到响应头（见 post）。
	requestTimeout = 60 * time.Second
	// maxErrorBytes 是失败响应最多读多少字节。
	maxErrorBytes = 1 << 20
	// detailLimit 是错误文案的长度上限（Node 版取 raw.slice(0, 300)）。
	detailLimit = 300
)

// Config 描述一条腾讯来源。
type Config struct {
	// Product 是产品线常量（tencent.CN / tencent.INTL）。
	Product auth.Product
	// StorePath 覆盖凭据文件位置；空则按 BRIDGE_HOME / 家目录解析。
	StorePath string
	// Client 可注入已配置好的登录客户端（测试要调小轮询间隔与超时）。nil 时新建。
	Client *auth.Client
	// Log 收进度与告警；nil 时静默。
	Log func(string)
}

// Source 是一条腾讯产品线（cn / intl）。
//
// 身份头、报文形状与内容风控改写都在本包内闭环；登录与凭据转交 internal/auth。
// 实现并发安全：模型清单会被多个请求同时读。
type Source struct {
	product auth.Product
	client  *auth.Client
	log     func(string)

	mu        sync.Mutex
	catalog   []catalogModel
	catalogAt time.Time
}

// 编译期钉住冻结接口：实现漂了在这里就报错，而不是等接线时才发现。
var _ source.Source = (*Source)(nil)

// New 建立一条腾讯来源。
func New(cfg Config) (*Source, error) {
	if strings.TrimSpace(cfg.Product.ID) == "" || strings.TrimSpace(cfg.Product.Endpoint) == "" {
		return nil, errs.Validation(errs.SubtypeUnknownSource, "腾讯来源缺少产品描述（id / endpoint）").
			WithHint("用 tencent.CN 或 tencent.INTL，或 ProductByName 按名字取")
	}
	client := cfg.Client
	if client == nil {
		client = auth.NewClient()
	}
	if cfg.StorePath != "" {
		client.File = cfg.StorePath
	}
	if cfg.Log != nil {
		client.Log = cfg.Log
	}
	return &Source{product: cfg.Product, client: client, log: cfg.Log}, nil
}

// ID 是来源前缀（cn / intl）。
func (s *Source) ID() string { return s.product.ID }

// Label 是给人看的名字。
func (s *Source) Label() string { return s.product.Label }

// Auth 是浏览器授权轮询。
func (s *Source) Auth() source.AuthMode { return source.AuthOAuth }

// DefaultModel 是远端目录拿不到时的第一条内置兜底模型。
func (s *Source) DefaultModel() string {
	if len(s.product.FallbackModels) == 0 {
		return ""
	}
	return s.product.FallbackModels[0]
}

// Rewriter 返回内容风控改写器。
//
// **腾讯是唯一需要内容风控改写的来源**，所以这里返回非 nil；OpenCode 的两条路
// 必须返回 nil，翻译层据此保证它们的 system 逐字节不变（套餐分离不变式）。
func (s *Source) Rewriter() source.Rewriter { return RewriteFingerprints }

// ListModels 取模型目录：企业端点（元数据最全）优先，空或失败时回退 `/v3/config`，
// 两层都拿不到才用产品兜底表。
//
// 没有凭据时返回 errs.Auth 错误，而不是空列表 —— 空列表会被上层误读成
// 「这条线没有模型」。
func (s *Source) ListModels(ctx context.Context) ([]source.Model, error) {
	if models, ok := s.cachedCatalog(); ok {
		return models, nil
	}
	credential, err := s.client.Ensure(ctx, s.product)
	if err != nil {
		return nil, err
	}
	headers := s.headers(credential, "")
	scoped := s.fetchCatalog(ctx, s.product.Endpoint+"/console/enterprises/"+enterpriseScope+"/models", headers)
	configured := s.fetchCatalog(ctx, s.product.Endpoint+"/v3/config", headers)

	merged := scoped
	known := make(map[string]bool, len(scoped))
	for _, entry := range scoped {
		known[entry.model.ID] = true
	}
	for _, entry := range configured {
		if known[entry.model.ID] {
			continue
		}
		known[entry.model.ID] = true
		merged = append(merged, entry)
	}
	if len(merged) == 0 {
		s.logf("%s：远端模型目录为空，使用内置兜底清单", s.product.Label)
		merged = fallbackCatalog(s.product.FallbackModels)
	}
	s.cacheCatalog(merged)
	return modelsOf(merged), nil
}

// Chat 发起一次对话。
//
// 令牌失效（401/403）时用 refresh token 静默续期并**重试一次** —— 长会话里令牌
// 过期是常态，让用户因此丢一轮回答是不可接受的。
func (s *Source) Chat(ctx context.Context, req source.ChatRequest) (source.Stream, error) {
	wire, err := toBuddyBody(req.Body, req.Model, s.metaFor(req.Model, req.Meta))
	if err != nil {
		return nil, err
	}
	credential, err := s.client.Ensure(ctx, s.product)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		response, release, err := s.post(ctx, s.product.Endpoint+"/v2/chat/completions", s.chatHeaders(credential, req.Model), wire)
		if err != nil {
			return nil, err
		}
		if response.StatusCode == http.StatusOK {
			return newStream(response.Body, s.product.Label, release), nil
		}
		status := response.StatusCode
		message, code := readFailure(response, release)
		if (status == http.StatusUnauthorized || status == http.StatusForbidden) && attempt == 0 {
			s.logf("%s：令牌被拒（HTTP %d），正在续期后重试", s.product.Label, status)
			credential, err = s.client.Renew(ctx, s.product)
			if err != nil {
				return nil, err
			}
			continue
		}
		return nil, s.upstreamError(status, message, code)
	}
	return nil, errs.Auth(errs.SubtypeNotLoggedIn, s.product.Label+"：登录已失效，请重新执行 login "+s.product.ID).
		WithHint(auth.ProductHint(s.product.ID))
}

// headers 是官方客户端的身份头：缺一个都会被后台归因成 `-` 或直接拒绝。
//
// model 为空表示控制面请求（模型目录），用产品默认档的 User-Agent。
func (s *Source) headers(credential auth.Credential, model string) map[string]string {
	userAgent := s.product.UserAgent
	if model != "" {
		userAgent = UserAgentFor(s.product, model)
	}
	headers := map[string]string{
		"X-Domain":       s.product.APIDomain,
		"X-Product":      "SaaS",
		"X-Product-Code": s.product.ProductCode,
		"User-Agent":     userAgent,
		"Authorization":  "Bearer " + credential.AccessToken,
	}
	if credential.Account != nil && credential.Account.EnterpriseID != "" {
		headers["X-Enterprise-Id"] = credential.Account.EnterpriseID
		headers["X-Tenant-Id"] = credential.Account.EnterpriseID
	}
	return headers
}

// chatHeaders 是身份头加上对话面专有的那几个。
func (s *Source) chatHeaders(credential auth.Credential, model string) map[string]string {
	headers := s.headers(credential, model)
	headers["Accept"] = "text/event-stream"
	headers["Content-Type"] = "application/json"
	headers["X-Agent-Purpose"] = "conversation"
	headers["X-IDE-Name"] = s.product.AttributionName
	headers["X-IDE-Type"] = s.product.AttributionName
	headers["X-IDE-Version"] = s.product.ClientVersion
	return headers
}

// fetchCatalog 取一个端点的目录：状态不是 200 或网络失败都当空
// （两个端点都拿不到才用兜底表）。
func (s *Source) fetchCatalog(ctx context.Context, endpoint string, headers map[string]string) []catalogModel {
	payload, status, err := s.get(ctx, endpoint, headers)
	if err != nil || status != http.StatusOK {
		return nil
	}
	return parseModels(decodeObject(payload))
}

// get 发一次 GET 并读完响应体。
func (s *Source) get(ctx context.Context, endpoint string, headers map[string]string) ([]byte, int, error) {
	ctx, cancel := withTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, errs.InternalFrom(err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := s.client.HTTPClient().Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return payload, response.StatusCode, nil
}

// post 发一次对话请求。
//
// 返回的 release 由调用方在读完（或丢弃）响应体时调用：它同时解掉「等服务端响应头」
// 的超时。**流式响应可以读很久，所以超时只覆盖到响应头为止** —— Node 版对带了
// signal 的调用同样不加自己的超时（服务端断开会取消它）。
func (s *Source) post(ctx context.Context, endpoint string, headers map[string]string, body []byte) (*http.Response, func(), error) {
	requestCtx, cancel := context.WithCancel(ctx)
	var timedOut atomic.Bool
	var timer *time.Timer
	if _, ok := ctx.Deadline(); !ok {
		timer = time.AfterFunc(requestTimeout, func() {
			timedOut.Store(true)
			cancel()
		})
	}
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
		}
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		stopTimer()
		cancel()
		return nil, nil, errs.InternalFrom(err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := s.client.HTTPClient().Do(request)
	if err != nil {
		stopTimer()
		cancel()
		if timedOut.Load() {
			return nil, nil, errs.Network(errs.SubtypeTimeout, s.product.Label+"：等待上游响应超时").
				WithCause(err).
				WithHint("上游可能正忙，稍后重试")
		}
		return nil, nil, errs.Wrap(err, errs.CategoryNetwork, errs.SubtypeConnectFailed, s.product.Label+"：连接上游失败").WithCause(err)
	}
	stopTimer()
	return response, cancel, nil
}

// cachedCatalog 取缓存的目录；过期或为空时返回 false。
func (s *Source) cachedCatalog() ([]source.Model, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.catalog) == 0 || time.Since(s.catalogAt) >= catalogTTL {
		return nil, false
	}
	return modelsOf(s.catalog), true
}

func (s *Source) cacheCatalog(rows []catalogModel) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.catalog = rows
	s.catalogAt = time.Now()
}

// metaFor 取对话要用的元数据：调用方给的优先，目录缓存补上 defaultEffort
// （source.Model 里没有这一项 —— 它只在腾讯这条线上有意义）。
func (s *Source) metaFor(model string, provided *source.Model) modelMeta {
	meta := modelMeta{}
	s.mu.Lock()
	for _, entry := range s.catalog {
		if entry.model.ID != model {
			continue
		}
		meta.maxOutputTokens = entry.model.MaxOutputTokens
		meta.efforts = entry.model.Efforts
		meta.defaultEffort = entry.defaultEffort
		break
	}
	s.mu.Unlock()
	if provided != nil {
		meta.maxOutputTokens = provided.MaxOutputTokens
		meta.efforts = provided.Efforts
	}
	return meta
}

func (s *Source) logf(format string, args ...any) {
	if s.log != nil {
		s.log(fmt.Sprintf(format, args...))
	}
}

// modelsOf 把缓存条目拷成对外清单：调用方会在 ID 上加来源前缀，别让它改到缓存。
func modelsOf(rows []catalogModel) []source.Model {
	models := make([]source.Model, 0, len(rows))
	for _, entry := range rows {
		models = append(models, entry.model)
	}
	return models
}

// readFailure 读完失败响应、释放连接，并尽量保留上游原本的理由。
//
// 第二个返回值是上游的业务码（腾讯的风控码 11128 就在这里）。
func readFailure(response *http.Response, release func()) (string, int) {
	defer func() {
		response.Body.Close()
		release()
	}()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return "", 0
	}
	body := decodeObject(payload)
	if body == nil {
		return truncate(trimmed, detailLimit), 0
	}
	code := 0
	if value, ok := numberOf(body["code"]); ok {
		code = int(value)
	}
	for _, key := range []string{"msg", "message"} {
		if value, ok := stringOf(body[key]); ok && value != "" {
			return truncate(value, detailLimit), code
		}
	}
	if nested, ok := objectOf(body["error"]); ok {
		if value, ok := stringOf(nested["message"]); ok && value != "" {
			return truncate(value, detailLimit), code
		}
	}
	return truncate(trimmed, detailLimit), code
}

// upstreamError 把上游的非 2xx 翻成类型化错误。
//
// Code 一律放 **HTTP 状态码**：消费方要按它如实透传状态；腾讯的业务码（风控的
// 11128）体现在 subtype 与文案里 —— subtype 才是稳定分支依据。
func (s *Source) upstreamError(status int, message string, code int) *errs.Error {
	text := message
	if text == "" {
		text = fmt.Sprintf("上游返回 %d", status)
	}
	switch {
	case code == codeContentBlocked:
		return errs.Upstream(errs.SubtypeContentBlocked, text).WithCode(status).
			WithHint("这是腾讯侧的内容风控拦截（code 11128），换个说法或换个模型再试")
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return errs.Auth(errs.SubtypeNotLoggedIn, text).WithCode(status).
			WithHint(auth.ProductHint(s.product.ID))
	case status == http.StatusTooManyRequests:
		return errs.Upstream(errs.SubtypeQuotaLimited, text).WithCode(status).
			WithHint("额度或频率受限，稍后重试")
	case status == http.StatusNotFound:
		return errs.Upstream(errs.SubtypeModelUnavailable, text).WithCode(status)
	default:
		return errs.Upstream(errs.SubtypeBadStatus, text).WithCode(status)
	}
}

// truncate 按**字符**截断（Node 版按 UTF-16 码元，中文文案不该被截成半个字）。
func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// withTimeout 在调用方没给截止时间时补一个：Node 版对带了 signal 的调用不加自己的
// 超时，这里的判据一致。
func withTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, timeout)
}
