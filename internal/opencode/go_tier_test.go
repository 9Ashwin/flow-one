// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"net/http"
	"testing"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 免费档那套客户端头一个都不能出现在 Go 套餐的报文里。
var freeClientHeaders = []string{
	"X-Opencode-Client",
	"X-Opencode-Project",
	"X-Opencode-Session-Id",
	"X-Opencode-Request",
}

func TestGoTierWithoutKeyFailsBeforeAnyRequest(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, nil)
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	_, err = goTier.ListModels(context.Background())
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeMissingAPIKey, typed.Subtype)
	assert.Contains(t, typed.Message, "还没配置 API key")

	_, err = goTier.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "deepseek-v4.1-flash"})
	require.Error(t, err)
	typed, isTyped = errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.SubtypeMissingAPIKey, typed.Subtype)
	assert.Equal(t, 0, rec.count(), "没配 key 就不该发一个必然 401 的请求")
}

func TestGoTierChatShapeIsBareOpenAI(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	saved, err := SaveGoKey("oc_sk_test_0000000000000000000000000000")
	require.NoError(t, err)

	rec := newRecorder(t, nil)
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	stream, err := goTier.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "deepseek-v4.1-flash"})
	require.NoError(t, err)
	drain(t, stream)

	require.Equal(t, 1, rec.count())
	got := rec.taken()[0]
	assert.Equal(t, "/chat/completions", got.path)
	assert.Equal(t, "Bearer "+saved.APIKey, got.header.Get("Authorization"))
	assert.Equal(t, saved.Session, got.header.Get("X-Opencode-Session"), "会话头必填（缺 → 400 MissingSessionID）")
	for _, name := range freeClientHeaders {
		assert.Emptyf(t, got.header.Get(name), "Go 套餐不该发免费档的 %s", name)
	}

	// 裸 OpenAI 报文：只补 model 与 stream，不打桩、不改工具名
	assert.Equal(t, true, got.body["stream"])
	assert.Equal(t, "deepseek-v4.1-flash", got.body["model"])
	names := toolNames(t, got.body)
	assert.Equal(t, []string{"Bash", "Read", "Edit"}, names, "认证通道不需要补门禁工具，也不改大小写")
}

func TestGoTierChatWithoutToolsKeepsBodyBare(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	_, err := SaveGoKey("oc_sk_test_1111111111111111111111111111")
	require.NoError(t, err)
	rec := newRecorder(t, nil)
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	stream, err := goTier.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"user","content":"ping"}]}`),
		Model: "deepseek-v4.1-flash",
	})
	require.NoError(t, err)
	drain(t, stream)

	got := rec.taken()[0]
	assert.NotContains(t, got.body, "tools", "裸报文直接 200，不该被塞进门禁形状")
	assert.Equal(t, true, got.body["stream"])
}

func TestGoTierListModelsCarriesKeyAndSession(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	dev := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"opencode":{"models":{"deepseek-v4.1-flash":{"limit":{"context":1000000,"output":384000}}}}}`))
		return true
	})
	saved, err := SaveGoKey("oc_sk_test_2222222222222222222222222222")
	require.NoError(t, err)

	upstream := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"deepseek-v4.1-flash","object":"model","created":3,"owned_by":"opencode"}]}`))
		return true
	})
	goTier, err := NewGoTier(Options{
		BaseURL:      upstream.server.URL,
		ModelsDevURL: dev.server.URL + "/api.json",
		HTTPClient:   upstream.server.Client(),
	})
	require.NoError(t, err)

	models, err := goTier.ListModels(context.Background())
	require.NoError(t, err)
	require.Len(t, models, 1)
	assert.Equal(t, "deepseek-v4.1-flash", models[0].ID)
	assert.Equal(t, 1000000, models[0].ContextWindow, "Go 套餐是 1M 窗口（与免费档的 200k 不同）")
	assert.Equal(t, 384000, models[0].MaxOutputTokens)
	assert.False(t, models[0].Free)

	listing := upstream.taken()[0]
	assert.Equal(t, "/models", listing.path)
	assert.Equal(t, "Bearer "+saved.APIKey, listing.header.Get("Authorization"))
	assert.Equal(t, saved.Session, listing.header.Get("X-Opencode-Session"), "清单请求也要带会话头")
}

func TestGoTierMissingSessionIDIsTyped(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	_, err := SaveGoKey("oc_sk_test_3333333333333333333333333333")
	require.NoError(t, err)
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		upstreamError(w, http.StatusBadRequest, "invalid_request_error", "MissingSessionID: request cannot be routed efficiently")
		return true
	})
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	_, err = goTier.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "x"})
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.CategoryUpstream, typed.Category)
	assert.Equal(t, errs.SubtypeMissingSession, typed.Subtype)
	assert.Equal(t, http.StatusBadRequest, typed.Code)
}

func TestGoTierMetadataErrorTaxonomy(t *testing.T) {
	home := scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		upstreamError(w, http.StatusTooManyRequests, "rate_limit_error", "Too many requests")
		return true
	})
	require.NoError(t, writeFile(t, home+"/credentials.json",
		`{"opencode-go":{"apiKey":"oc_sk_test_4444444444444444444444444444","session":"ses_0123456789ab0123456789ABCD"}}`))

	// 额度受限要单独报出来：它不是「门禁问题」，也不该被当成网络故障
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)
	_, err = goTier.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "x"})
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.SubtypeQuotaLimited, typed.Subtype)
	assert.Equal(t, http.StatusTooManyRequests, typed.Code)
}

func TestGoTierMetadata(t *testing.T) {
	goTier, err := NewGoTier(Options{Home: t.TempDir()})
	require.NoError(t, err)
	assert.Equal(t, "ocg", goTier.ID())
	assert.Equal(t, "OpenCode Go 套餐", goTier.Label())
	assert.Equal(t, source.AuthKey, goTier.Auth())
	assert.Equal(t, "deepseek-v4.1-flash", goTier.DefaultModel())
}

func TestSourceEndpoints(t *testing.T) {
	// 两条路的端点不同是刻意的：免费档在 /inference/v1，Go 套餐在 /zen/go/v1，
	// 把它们合成一条会同时弄坏两边。
	assert.Equal(t, "https://opencode.ai/inference/v1/chat/completions", FreeBaseURL+FreeChatPath)
	assert.Equal(t, "https://opencode.ai/inference/v1/models", FreeBaseURL+FreeModelsPath)
	assert.Equal(t, "https://opencode.ai/zen/go/v1/chat/completions", GoBaseURL+GoChatPath)
	assert.Equal(t, "https://opencode.ai/zen/go/v1/models", GoBaseURL+GoModelsPath)
}

func TestGoTierStickySessionWhenCredentialHasNone(t *testing.T) {
	home := scratch(t)
	resetCapabilities(t)
	// 手写/老版本的凭据里只有 key，没有会话 id：铸一个并在进程内粘住，
	// 不能每次请求换一个（那会让同一台机器被看成很多独立客户端）
	require.NoError(t, writeFile(t, home+"/credentials.json", `{"opencode-go":{"apiKey":"oc_sk_handwritten"}}`))
	rec := newRecorder(t, nil)
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	for range 2 {
		stream, err := goTier.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "x"})
		require.NoError(t, err)
		drain(t, stream)
	}
	requests := rec.taken()
	require.Len(t, requests, 2)
	session := requests[0].header.Get("X-Opencode-Session")
	assert.Regexp(t, uuidPattern, session)
	assert.Equal(t, session, requests[1].header.Get("X-Opencode-Session"))
}
