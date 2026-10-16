// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package gateway 是「转发给已有的 OpenAI 兼容网关」这条来源：
// 不登录、不套任何形状门禁、也不做内容风控改写 —— 它就是个通用 OpenAI 客户端。
//
// 它对应 Node 版的 createGatewayUpstream。与 OpenCode Go 的区别是：那边端点与规矩
// 都是写死的，这边端点由用户给，模型清单从 `/v1/models` 现拉。
package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/sse"
)

// Config 是一条网关来源的全部输入。
type Config struct {
	// BaseURL 形如 http://127.0.0.1:8326（结尾斜杠会被去掉）。
	BaseURL string
	// APIKey 为空表示该网关不要鉴权。
	APIKey string
	// DefaultModel 是没有指定模型时的兜底（裸 ID）。
	DefaultModel string
	// HTTPClient 覆盖出站客户端，测试用。
	HTTPClient *http.Client
}

// Source 实现 source.Source。
type Source struct {
	config Config
	client *http.Client
}

var _ source.Source = (*Source)(nil)

// New 建一条网关来源。地址不合法时给的是「怎么办」，而不是一句解析失败。
func New(cfg Config) (*Source, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return nil, errs.Config(errs.SubtypeSettingsMissing, "网关模式没给上游地址").
			WithHint("加 --upstream http://127.0.0.1:8326，或设 UPSTREAM_BASE_URL")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return nil, errs.Validation(errs.SubtypeInvalidURL, fmt.Sprintf("上游地址只支持 http/https：%s", cfg.BaseURL)).
			WithParam("--upstream")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	return &Source{config: Config{BaseURL: base, APIKey: cfg.APIKey, DefaultModel: cfg.DefaultModel}, client: client}, nil
}

func (s *Source) ID() string            { return "gw" }
func (s *Source) Label() string         { return "已有网关 " + s.config.BaseURL }
func (s *Source) Auth() source.AuthMode { return source.AuthNone }

func (s *Source) DefaultModel() string {
	if s.config.DefaultModel != "" {
		return s.config.DefaultModel
	}
	return "default"
}

// Rewriter 永远返回 nil：网关背后的模型与腾讯内容风控无关，改写只会破坏 prompt。
func (s *Source) Rewriter() source.Rewriter { return nil }

func (s *Source) headers() map[string]string {
	headers := map[string]string{"content-type": "application/json"}
	if s.config.APIKey != "" {
		headers["authorization"] = "Bearer " + s.config.APIKey
	}
	return headers
}

// ListModels 从 `/v1/models` 拉清单。网关没有能力元数据，窗口留 0（上层据此不加 [1m]）。
func (s *Source) ListModels(ctx context.Context) ([]source.Model, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.config.BaseURL+"/v1/models", nil)
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	for key, value := range s.headers() {
		request.Header.Set(key, value)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errs.Network(errs.SubtypeConnectFailed, fmt.Sprintf("连不上网关：%v", err)).
			WithHint("确认网关在跑：" + s.config.BaseURL + "/v1/models")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		failure := sse.Failure(response)
		return nil, failure
	}
	var payload struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, errs.Upstream(errs.SubtypeParseFailed, "网关的 /v1/models 不是合法 JSON").
			WithHint("确认上游是 OpenAI 兼容网关（例如 dsh-our-free-model 的 8326）")
	}
	models := make([]source.Model, 0, len(payload.Data))
	for _, row := range payload.Data {
		name := row.Name
		if name == "" {
			name = row.ID
		}
		models = append(models, source.Model{ID: row.ID, Name: name})
	}
	return models, nil
}

// Chat 发一次对话，流式与非流式都走同一条路（上游一律 stream=true，由翻译层决定怎么用）。
func (s *Source) Chat(ctx context.Context, req source.ChatRequest) (source.Stream, error) {
	body, err := forceStream(req.Body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.config.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	for key, value := range s.headers() {
		request.Header.Set(key, value)
	}
	request.Header.Set("accept", "text/event-stream")
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errs.Network(errs.SubtypeConnectFailed, fmt.Sprintf("网关请求失败：%v", err))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, sse.Failure(response)
	}
	return sse.NewReader(response.Body), nil
}

// forceStream 把 stream 置为 true：翻译层的两种收尾都基于分片流，
// 非流式只是把分片流读完之后再归并。
func forceStream(body []byte) ([]byte, error) {
	if len(body) == 0 {
		return body, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		// 翻译层已经保证是合法 JSON；这里出错说明上游给的报文被改坏了，
		// 原样透传比编一个更安全。
		return body, nil
	}
	payload["stream"] = true
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	return encoded, nil
}

var _ = io.Discard
