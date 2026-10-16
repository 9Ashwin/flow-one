// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/9Ashwin/flow-one/internal/sse"
)

// FreeTier 是 OpenCode 免费档（来源 id `oc`）。
//
// 匿名可用，但上游按**报文形状**判断调用方是不是官方客户端：头、会话 id 形状、
// stream 与四个小写工具都得对（见 ApplyFreeTierGate 与 ShapeHeaders）。
type FreeTier struct {
	client
	mu      sync.Mutex
	session string
}

// NewFreeTier 建一条免费档来源。
func NewFreeTier(opts Options) (*FreeTier, error) {
	conn, err := newClient(opts, FreeBaseURL)
	if err != nil {
		return nil, err
	}
	return &FreeTier{client: conn}, nil
}

func (f *FreeTier) ID() string { return "oc" }

// Label 是给人看的名字。
func (f *FreeTier) Label() string { return "OpenCode 免费模型" }

// Auth 是匿名：免费档不需要任何凭据。
func (f *FreeTier) Auth() source.AuthMode { return source.AuthNone }

// DefaultModel 是免费档里对 Claude Code 最有用的一个。
func (f *FreeTier) DefaultModel() string { return "deepseek-v4.1-flash-free" }

// Rewriter 返回 nil：免费档不是 WorkBuddy，**绝不**走腾讯内容风控改写（硬不变式）。
func (f *FreeTier) Rewriter() source.Rewriter { return nil }

// ListModels 列出免费档可用的模型。能力元数据取 models.dev（1 小时缓存，失败就退回
// 无元数据 —— 上层据此不加 `[1m]` 后缀）。
func (f *FreeTier) ListModels(ctx context.Context) ([]source.Model, error) {
	header := http.Header{}
	header.Set("authorization", "Bearer "+AnonymousKey)
	header.Set("user-agent", DefaultUserAgent)
	ctx, cancel := withTimeout(ctx, modelsTimeout)
	defer cancel()
	ids := []string{}
	if err := f.getJSON(ctx, f.Label(), f.baseURL+FreeModelsPath, header, func(body io.Reader) error {
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.NewDecoder(body).Decode(&payload); err != nil {
			return errs.Wrap(err, errs.CategoryUpstream, errs.SubtypeParseFailed, "模型清单不是合法 JSON")
		}
		for _, row := range payload.Data {
			if row.ID != "" {
				ids = append(ids, row.ID)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	table := capabilities.get(ctx, f.client)
	return describeModels(ids, table), nil
}

// Chat 发起一次免费档对话。出站报文按门禁形状组装，响应分片里的工具名会改回
// 调用方的原名（桩工具的调用整条丢弃）。
func (f *FreeTier) Chat(ctx context.Context, req source.ChatRequest) (source.Stream, error) {
	body, err := decodeBody(req.Body)
	if err != nil {
		return nil, err
	}
	body["model"] = req.Model
	gated, gate := ApplyFreeTierGate(body)
	payload, err := json.Marshal(gated)
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	session := f.currentSession()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.baseURL+FreeChatPath, bytes.NewReader(payload))
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	request.Header.Set("authorization", "Bearer "+AnonymousKey)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "text/event-stream")
	for key, values := range ShapeHeaders(projectID(f.home), session, NewRequestID()) {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := f.httpClient.Do(request)
	if err != nil {
		return nil, networkFailure(f.Label(), err)
	}
	if !ok(response) {
		failed := classify(sse.Failure(response))
		response.Body.Close()
		if failed.Subtype == errs.SubtypeShapeRejected {
			// FreeTierError 只说明形状没被认出来，指出来比让用户猜有用
			f.logf("%s：被免费档门禁拒绝（报文形状未被识别），请提 issue 附上本机版本", f.Label())
		}
		return nil, failed
	}
	f.logf("%s：%s 已建立回合（会话 %s…）", f.Label(), req.Model, shortID(session, 12))
	return newRestoreStream(sse.NewReader(response.Body), gate), nil
}

// currentSession 返回进程级复用的会话 id：一个进程一个 id，别每次请求都换 ——
// 每次随机会让同一调用方在服务端被看成很多独立会话，反而破坏亲和。
func (f *FreeTier) currentSession() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.session == "" {
		f.session = NewSessionID()
	}
	return f.session
}

// ShapeHeaders 是发往免费档的头集，照官方客户端的形状。
//
// `x-opencode-session-id` 这个别名头实测当前已非必填（2026-10-16 `fo doctor` 逐项重推
// 判成 relaxed：去掉它照样 200），但仍照发 —— 与官方客户端同形，上游哪天重新收紧时
// 不必再改代码。规则与证据见 docs/gates.md。
func ShapeHeaders(project string, session string, request string) http.Header {
	header := http.Header{}
	header.Set(projectHeader, project)
	header.Set(sessionHeader, session)
	header.Set(sessionIDHeader, session)
	header.Set(requestHeader, request)
	header.Set(clientHeader, clientHeaderName)
	header.Set("user-agent", DefaultUserAgent)
	return header
}

// describeModels 把裸模型 ID 与能力表拼成给上层的形状。
func describeModels(ids []string, table map[string]capability) []source.Model {
	out := make([]source.Model, 0, len(ids))
	for _, id := range ids {
		// `-free` 结尾的是官方免费档；其余需要 OpenCode Go 订阅（$10/月起）。
		row := source.Model{
			ID:   id,
			Name: id,
			Free: strings.HasSuffix(id, "-free") || id == "big-pickle",
		}
		if meta, found := table[id]; found {
			if meta.Name != "" {
				row.Name = meta.Name
			}
			row.ContextWindow = meta.ContextWindow
			row.MaxOutputTokens = meta.MaxOutputTokens
			row.SupportsImages = meta.SupportsImages
		}
		out = append(out, row)
	}
	return out
}
