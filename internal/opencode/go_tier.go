// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
)

// GoTier 是 OpenCode Go 套餐（来源 id `ocg`）。
//
// 与免费档**不是同一条路**（2026-10-16 实测）：
//
//   - 端点 `/zen/go/v1`（免费档是 `/inference/v1`），模型清单也不同；
//   - `Authorization: Bearer oc_sk_…` 必需，乱写 key 一律 401；
//   - `x-opencode-session` 必需（缺 → 400 MissingSessionID），值 UUID 或 `ses_` 都收；
//   - **不需要**免费档那套形状门禁：裸 OpenAI 报文直接 200，所以这里既不补桩也不改工具名。
type GoTier struct {
	client
}

// NewGoTier 建一条 Go 套餐来源。
func NewGoTier(opts Options) (*GoTier, error) {
	conn, err := newClient(opts, goBaseURL)
	if err != nil {
		return nil, err
	}
	return &GoTier{client: conn}, nil
}

func (g *GoTier) ID() string { return "ocg" }

// Label 是给人看的名字。
func (g *GoTier) Label() string { return "OpenCode Go 套餐" }

// Auth 要一个 API key。
func (g *GoTier) Auth() source.AuthMode { return source.AuthKey }

// DefaultModel 是 Go 套餐里对 Claude Code 最有用的一个。
func (g *GoTier) DefaultModel() string { return "deepseek-v4.1-flash" }

// Rewriter 返回 nil：Go 套餐不是 WorkBuddy，**绝不**走腾讯内容风控改写（硬不变式）。
func (g *GoTier) Rewriter() source.Rewriter { return nil }

// ListModels 列出 Go 套餐的模型。没有 key 时返回 auth 错误，而不是空列表。
func (g *GoTier) ListModels(ctx context.Context) ([]source.Model, error) {
	key, configured := g.credential()
	if !configured {
		return nil, missingKey(g.Label())
	}
	header := http.Header{}
	header.Set("authorization", "Bearer "+key.APIKey)
	header.Set(sessionHeader, key.Session)
	ctx, cancel := withTimeout(ctx, modelsTimeout)
	defer cancel()
	ids := []string{}
	if err := g.getJSON(ctx, g.Label(), g.baseURL+goModelsPath, header, func(body io.Reader) error {
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
	return describeModels(ids, capabilities.get(ctx, g.client)), nil
}

// Chat 发起一次 Go 套餐对话。报文是裸 OpenAI 形状：只补 `model` 与 `stream`，
// 不打桩、不改工具名，也不发免费档那套客户端头。
func (g *GoTier) Chat(ctx context.Context, req source.ChatRequest) (source.Stream, error) {
	key, configured := g.credential()
	if !configured {
		return nil, missingKey(g.Label())
	}
	body, err := decodeBody(req.Body)
	if err != nil {
		return nil, err
	}
	body["model"] = req.Model
	body["stream"] = true
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+goChatPath, bytes.NewReader(payload))
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	request.Header.Set("authorization", "Bearer "+key.APIKey)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "text/event-stream")
	request.Header.Set(sessionHeader, key.Session)
	response, err := g.httpClient.Do(request)
	if err != nil {
		return nil, networkFailure(g.Label(), err)
	}
	if !ok(response) {
		read := readErrorBody(response.Body)
		response.Body.Close()
		failed := failure(response.StatusCode, read)
		if failed.Subtype == errs.SubtypeMissingSession {
			// 会话头本应自动带上；真出现说明是我们这边的 bug
			g.logf("%s：上游要求会话头 %s（应已自动带上，若出现请提 issue）", g.Label(), sessionHeader)
		}
		return nil, failed
	}
	g.logf("%s：%s 已建立回合（会话 %s…）", g.Label(), req.Model, truncate(key.Session, 8))
	return newSSEStream(response.Body), nil
}

// credential 每次请求都重新读一遍：向导存下 key 之后，已经建好的来源要能立刻用上。
func (g *GoTier) credential() (GoKey, bool) { return readGoKey(g.credentialFile) }

// missingKey 是「还没配 key」的类型化错误：归到认证，别让用户以为是网络问题。
func missingKey(label string) *errs.Error {
	return errs.Auth(errs.SubtypeMissingAPIKey, label+"：还没配置 API key").
		WithHint("在菜单里配一次（opencode.ai 控制台上的 Go 套餐 key），或先用免费档")
}
