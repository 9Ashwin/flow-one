// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/auth"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 目录：企业端点优先，/v3/config 补齐，用户自己的身份头一个不少。
func TestListModelsMergesBothEndpoints(t *testing.T) {
	var scopedHits, configHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/console/enterprises/personal/models":
			scopedHits.Add(1)
			assert.Equal(t, http.MethodGet, r.Method)
			assert.Equal(t, "Bearer access-1", r.Header.Get("Authorization"))
			assert.Equal(t, "SaaS", r.Header.Get("X-Product"))
			assert.Equal(t, "codebuddy", r.Header.Get("X-Product-Code"))
			assert.Equal(t, "copilot.tencent.com", r.Header.Get("X-Domain"))
			assert.Equal(t, "CodeBuddyIDE/1.106.1", r.Header.Get("User-Agent"))
			assert.Equal(t, "ent-1", r.Header.Get("X-Enterprise-Id"))
			assert.Equal(t, "ent-1", r.Header.Get("X-Tenant-Id"))
			writeJSON(w, `{"code":0,"data":{"models":[
				{"id":"glm-5.3","name":"GLM 5.3","maxInputTokens":128000,"maxOutputTokens":8192},
				{"id":"nes-1"},
				{"id":"auto"}
			]}}`)
		case "/v3/config":
			configHits.Add(1)
			writeJSON(w, `{"code":0,"data":{"models":[
				{"id":"glm-5.3"},
				{"id":"hy4-preview-f","reasoning":{"supportedEfforts":["low","high"],"defaultEffort":"high"}}
			]}}`)
		default:
			t.Errorf("意外的请求：%s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	models, err := origin.ListModels(context.Background())
	require.NoError(t, err)
	require.Len(t, models, 2)
	assert.Equal(t, "glm-5.3", models[0].ID)
	assert.Equal(t, "GLM 5.3", models[0].Name)
	assert.Equal(t, 128000, models[0].ContextWindow)
	assert.Equal(t, 8192, models[0].MaxOutputTokens)
	assert.Equal(t, "hy4-preview-f", models[1].ID)
	assert.Equal(t, []string{"low", "high"}, models[1].Efforts)

	// 目录有 60s 缓存：Registry.Find 每个请求都会调 ListModels，不该每次都打上游。
	again, err := origin.ListModels(context.Background())
	require.NoError(t, err)
	assert.Len(t, again, 2)
	assert.Equal(t, int32(1), scopedHits.Load())
	assert.Equal(t, int32(1), configHits.Load())
}

// 两个端点都拿不到时用内置兜底清单（不然用户会看到「一个模型都没有」）。
func TestListModelsFallsBackToBuiltInList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	models, err := origin.ListModels(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, models)
	assert.Equal(t, CN.FallbackModels[0], models[0].ID)
	assert.Equal(t, CN.FallbackModels[0], models[0].Name)
}

// 没有凭据时返回 errs.Auth，而不是空列表 —— 空列表会被上层误读成「这条线没有模型」。
func TestListModelsWithoutCredentialIsAuthError(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	origin, err := New(cfg)
	require.NoError(t, err)

	_, err = origin.ListModels(context.Background())
	typed, ok := errs.As(err)
	require.True(t, ok, "应当是类型化错误，实际是 %v", err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)
	assert.Contains(t, typed.Hint, "login cn")
	assert.Zero(t, hits.Load(), "没凭据就不该发请求")
}

// 出站对话：URL / 头 / 体逐项钉住（体是腾讯真正接受的那种形状）。
func TestChatAssertsOutboundRequest(t *testing.T) {
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v2/chat/completions", r.URL.Path)
		assert.Equal(t, "Bearer access-1", r.Header.Get("Authorization"))
		assert.Equal(t, "SaaS", r.Header.Get("X-Product"))
		assert.Equal(t, "codebuddy", r.Header.Get("X-Product-Code"))
		assert.Equal(t, "copilot.tencent.com", r.Header.Get("X-Domain"))
		assert.Equal(t, "CodeBuddyIDE/1.106.1", r.Header.Get("User-Agent"))
		assert.Equal(t, "ent-1", r.Header.Get("X-Enterprise-Id"))
		assert.Equal(t, "text/event-stream", r.Header.Get("Accept"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, "conversation", r.Header.Get("X-Agent-Purpose"))
		assert.Equal(t, "CodeBuddy", r.Header.Get("X-IDE-Name"))
		assert.Equal(t, "CodeBuddy", r.Header.Get("X-IDE-Type"))
		assert.Equal(t, "1.106.1", r.Header.Get("X-IDE-Version"))

		payload, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.Unmarshal(payload, &body))
		requests <- body

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n" +
			"data: [DONE]\n\n"))
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	// 客户端给的是桥内部的 OpenAI 形状：model 带前缀、带 tool_choice/top_p、max_tokens 超限。
	body := `{"model":"cn/deepseek-v4.1-flash","stream":true,
		"messages":[{"role":"user","content":"你好"}],
		"tool_choice":"auto","top_p":0.9,"max_tokens":999999}`
	stream, err := origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(body),
		Model: "deepseek-v4.1-flash",
		Meta:  &source.Model{MaxOutputTokens: 2048, Efforts: []string{"low", "high"}},
	})
	require.NoError(t, err)
	defer stream.Close()

	wire := <-requests
	assert.Equal(t, "deepseek-v4.1-flash", wire["model"], "发出去的必须是裸 ID")
	assert.Equal(t, true, wire["stream"], "这条上游没有非流式接口")
	assert.NotContains(t, wire, "tool_choice")
	assert.NotContains(t, wire, "top_p")
	assert.Equal(t, float64(2048), wire["max_tokens"], "按模型上限裁")

	messages, ok := wire["messages"].([]any)
	require.True(t, ok)
	require.Len(t, messages, 2, "首条缺 system 时要补一条")
	first := messages[0].(map[string]any)
	assert.Equal(t, "system", first["role"])
	assert.Equal(t, defaultSystem, first["content"])

	assert.Equal(t, map[string]any{"type": "enabled"}, wire["thinking"], "deepseek 族要带 thinking")
	assert.Equal(t, "high", wire["reasoning_effort"])
	key, ok := wire["prompt_cache_key"].(string)
	require.True(t, ok)
	assert.Len(t, key, 32)

	// 分片照原样交给翻译层，[DONE] 之后干净收尾。
	first_frame, ok, err := stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, string(first_frame), "你")
	second_frame, ok, err := stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, string(second_frame), "好")
	_, ok, err = stream.Next()
	require.NoError(t, err)
	assert.False(t, ok)
	assert.NoError(t, stream.Close())
	assert.NoError(t, stream.Close(), "Close 必须可重复调用")
}

// 401 用 refresh token 静默续期并重试一次（长会话里令牌过期是常态）。
func TestChatRenewsAndRetriesOnceAfterUnauthorized(t *testing.T) {
	var chatHits, refreshHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/chat/completions":
			if chatHits.Add(1) == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				writeJSON(w, `{"code":0,"msg":"token invalid"}`)
				return
			}
			assert.Equal(t, "Bearer access-2", r.Header.Get("Authorization"), "重试要用续期后的令牌")
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DONE]\n\n"))
		case "/v2/plugin/auth/token/refresh":
			refreshHits.Add(1)
			assert.Equal(t, "refresh-1", r.Header.Get("X-Refresh-Token"))
			writeJSON(w, `{"code":0,"data":{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":3600}}`)
		default:
			t.Errorf("意外的请求：%s", r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	stream, err := origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"system","content":"s"},{"role":"user","content":"hi"}]}`),
		Model: "glm-5.3",
	})
	require.NoError(t, err)
	defer stream.Close()

	_, ok, err := stream.Next()
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, int32(2), chatHits.Load())
	assert.Equal(t, int32(1), refreshHits.Load())

	stored, ok := auth.Store{Path: cfg.StorePath}.Get(cfg.Product.ID)
	require.True(t, ok)
	assert.Equal(t, "access-2", stored.AccessToken, "续期结果要落盘")
}

// 只重试一次：第二次还被拒就是真的要重新登录了。
func TestChatDoesNotRetryMoreThanOnce(t *testing.T) {
	var chatHits, refreshHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/chat/completions":
			chatHits.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			writeJSON(w, `{"msg":"token revoked"}`)
		case "/v2/plugin/auth/token/refresh":
			refreshHits.Add(1)
			writeJSON(w, `{"code":0,"data":{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":3600}}`)
		}
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	_, err = origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
		Model: "glm-5.3",
	})

	typed, ok := errs.As(err)
	require.True(t, ok, "应当是类型化错误，实际是 %v", err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)
	assert.Equal(t, http.StatusUnauthorized, typed.Code, "Code 放 HTTP 状态码，消费方要如实透传")
	assert.Equal(t, int32(2), chatHits.Load())
	assert.Equal(t, int32(1), refreshHits.Load())
}

// 400 + code 11128 是内容风控拦截：分类成 content_blocked，状态码如实带出去。
func TestChatContentBlocked(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, `{"code":11128,"msg":"请求被拦截，Illegal API invocation from an unapproved channel"}`)
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	_, err = origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
		Model: "glm-5.3",
	})

	typed, ok := errs.As(err)
	require.True(t, ok)
	assert.Equal(t, errs.CategoryUpstream, typed.Category)
	assert.Equal(t, errs.SubtypeContentBlocked, typed.Subtype)
	assert.Equal(t, http.StatusBadRequest, typed.Code)
	assert.Contains(t, typed.Message, "Illegal API invocation")
}

// 流内拦截是「HTTP 200 + 一帧 {code,msg}」：必须翻成错误，而不是干净收尾。
func TestChatTurnsInStreamInterceptionIntoError(t *testing.T) {
	cases := []struct {
		name    string
		frame   string
		subtype string
		code    int
		message string
	}{
		{"风控 11128", `{"code":11128,"msg":"请求被拦截"}`, errs.SubtypeContentBlocked, 11128, "请求被拦截"},
		{"别的业务码", `{"code":11140,"msg":"当前请求过于频繁"}`, errs.SubtypeBadStatus, 11140, "当前请求过于频繁"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: " + testCase.frame + "\n\n"))
			}))
			defer server.Close()

			cfg := testConfig(t, server.URL)
			seedCredential(t, cfg, liveCredential())
			origin, err := New(cfg)
			require.NoError(t, err)

			stream, err := origin.Chat(context.Background(), source.ChatRequest{
				Body:  []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
				Model: "glm-5.3",
			})
			require.NoError(t, err, "HTTP 是 200，拿到响应头时还不算失败")
			defer stream.Close()

			payload, ok, err := stream.Next()
			assert.Nil(t, payload)
			assert.False(t, ok)
			typed, isTyped := errs.As(err)
			require.True(t, isTyped, "应当是类型化错误，实际是 %v", err)
			assert.Equal(t, errs.CategoryUpstream, typed.Category)
			assert.Equal(t, testCase.subtype, typed.Subtype)
			assert.Equal(t, testCase.code, typed.Code)
			assert.Contains(t, typed.Message, testCase.message)
		})
	}
}

// 坏帧丢掉而不是打断整轮；注释行与心跳不影响取数据。
func TestChatStreamSkipsUnparsableFrames(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(": 心跳\n\n" +
			"data: {半截帧\n\n" +
			"event: message\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n" +
			"data: [DONE]\n\n"))
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	stream, err := origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
		Model: "glm-5.3",
	})
	require.NoError(t, err)
	defer stream.Close()

	payload, ok, err := stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, string(payload), "好")
	_, ok, err = stream.Next()
	require.NoError(t, err)
	assert.False(t, ok)
}

// 连不上是 network 错误，不是 upstream：退出码与补救动作都不一样。
func TestChatConnectFailure(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	endpoint := dead.URL
	dead.Close()

	cfg := testConfig(t, endpoint)
	seedCredential(t, cfg, liveCredential())
	origin, err := New(cfg)
	require.NoError(t, err)

	_, err = origin.Chat(context.Background(), source.ChatRequest{
		Body:  []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
		Model: "glm-5.3",
	})

	typed, ok := errs.As(err)
	require.True(t, ok)
	assert.Equal(t, errs.CategoryNetwork, typed.Category)
	assert.Equal(t, errs.SubtypeConnectFailed, typed.Subtype)
}

// 这条来源的对外契约：前缀、授权方式、兜底模型，以及**非 nil 的改写器**。
func TestSourceContract(t *testing.T) {
	cfg := Config{Product: CN, StorePath: filepath.Join(t.TempDir(), "credentials.json")}
	origin, err := New(cfg)
	require.NoError(t, err)

	assert.Equal(t, "cn", origin.ID())
	assert.Equal(t, CN.Label, origin.Label())
	assert.Equal(t, source.AuthOAuth, origin.Auth())
	assert.Equal(t, "deepseek-v4.1-flash", origin.DefaultModel())

	rewriter := origin.Rewriter()
	require.NotNil(t, rewriter, "腾讯是唯一需要内容风控改写的来源")
	assert.Equal(t,
		"You are Claude Code, an official CLI for Claude",
		rewriter("You are Claude Code, Anthropic's official CLI for Claude"))

	// 国际版同样要有（两条线都走腾讯后端）
	origin, err = New(Config{Product: INTL, StorePath: filepath.Join(t.TempDir(), "credentials.json")})
	require.NoError(t, err)
	assert.NotNil(t, origin.Rewriter())
	assert.Equal(t, "default-model", origin.DefaultModel())
}

func TestNewRejectsIncompleteProduct(t *testing.T) {
	_, err := New(Config{Product: auth.Product{Label: "没有 id 和端点"}})

	typed, ok := errs.As(err)
	require.True(t, ok)
	assert.Equal(t, errs.CategoryValidation, typed.Category)
	assert.Equal(t, errs.SubtypeUnknownSource, typed.Subtype)
}
