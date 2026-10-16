// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeStream 是一串固定的上游分片。
type fakeStream struct{ frames [][]byte }

func (f *fakeStream) Next() ([]byte, bool, error) {
	if len(f.frames) == 0 {
		return nil, false, nil
	}
	frame := f.frames[0]
	f.frames = f.frames[1:]
	return frame, true, nil
}

func (f *fakeStream) Close() error { return nil }

// fakeSource 记录出站请求，便于断言「谁被改写、谁没被改写」。
type fakeSource struct {
	id      string
	rewrite bool
	sent    []byte
}

func (f *fakeSource) ID() string            { return f.id }
func (f *fakeSource) Label() string         { return "假来源 " + f.id }
func (f *fakeSource) Auth() source.AuthMode { return source.AuthNone }
func (f *fakeSource) DefaultModel() string  { return "default-model" }
func (f *fakeSource) Rewriter() source.Rewriter {
	if !f.rewrite {
		return nil
	}
	return func(system string) string { return "REWRITTEN:" + system }
}

func (f *fakeSource) ListModels(context.Context) ([]source.Model, error) {
	return []source.Model{{ID: "default-model", Name: "Default"}}, nil
}

func (f *fakeSource) Chat(_ context.Context, req source.ChatRequest) (source.Stream, error) {
	f.sent = req.Body
	return &fakeStream{frames: [][]byte{[]byte(`{"choices":[{"delta":{"content":"hi"}}]}`)}}, nil
}

func newTestServer(t *testing.T, apiKey string, sources ...*fakeSource) (*Server, *TranslateOptions, Hooks) {
	t.Helper()
	registry := make([]source.Source, 0, len(sources))
	for _, item := range sources {
		registry = append(registry, item)
	}
	captured := &TranslateOptions{}
	hooks := Hooks{
		ToOpenAI: func(body []byte, opts TranslateOptions) ([]byte, error) {
			*captured = opts
			return []byte(`{"model":"` + opts.Model + `","messages":[]}`), nil
		},
		Stream: func(w io.Writer, _ source.Stream, _ TranslateOptions) error {
			_, err := io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return err
		},
		Message: func(_ source.Stream, _ TranslateOptions) ([]byte, error) {
			return []byte(`{"type":"message","content":[]}`), nil
		},
		EstimateTokens: func([]byte) int { return 42 },
	}
	return New(Options{
		Host: "127.0.0.1", Port: 0, APIKey: apiKey, Model: "ocg/deepseek-v4.1-flash",
		HeartbeatMs: 60_000, Registry: source.NewRegistry(registry...), Hooks: hooks,
	}), captured, hooks
}

func TestAuthRejectsWrongKey(t *testing.T) {
	// 本地服务也不该让密钥被逐字节试探：错误密钥一律 401
	srv, _, _ := newTestServer(t, "secret", &fakeSource{id: "oc"})
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("x-api-key", "wrong")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	req2 := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	req2.Header.Set("Authorization", "Bearer secret")
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req2)
	assert.NotEqual(t, http.StatusUnauthorized, rec2.Code)
}

func TestHealthReportsSourcesAndModelCount(t *testing.T) {
	srv, _, _ := newTestServer(t, "", &fakeSource{id: "oc"}, &fakeSource{id: "ocg"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, true, payload["ok"])
	assert.EqualValues(t, 2, payload["models"], "两条来源各一个模型")
	assert.Contains(t, payload["upstream"], "假来源 oc")
}

func TestModelsArePrefixed(t *testing.T) {
	srv, _, _ := newTestServer(t, "", &fakeSource{id: "ocg"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	assert.Contains(t, rec.Body.String(), "ocg/default-model")
}

func TestModelSuffixIsStrippedBeforeRouting(t *testing.T) {
	// Claude Code 可能把 [1m] 留在模型名上，必须先剥再解析来源
	ocg := &fakeSource{id: "ocg"}
	srv, captured, _ := newTestServer(t, "", ocg)
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"ocg/deepseek-v4.1-flash[1m]","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "deepseek-v4.1-flash", captured.Model, "来源前缀与 [1m] 都要剥掉")
}

func TestNonTencentSourceGetsNoRewriter(t *testing.T) {
	// 套餐分离不变式：非 WorkBuddy 来源绝不能拿到内容风控改写器
	oc := &fakeSource{id: "oc", rewrite: false}
	srv, captured, _ := newTestServer(t, "", oc)
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"oc/x","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	srv.Handler().ServeHTTP(httptest.NewRecorder(), req)
	assert.Nil(t, captured.Rewriter, "OpenCode 来源的 Rewriter 必须是 nil")

	// 反过来：腾讯系来源必须有改写器（否则内容风控会拦）
	cn := &fakeSource{id: "cn", rewrite: true}
	srvCN, capturedCN, _ := newTestServer(t, "", cn)
	reqCN := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"cn/x","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	srvCN.Handler().ServeHTTP(httptest.NewRecorder(), reqCN)
	require.NotNil(t, capturedCN.Rewriter)
	assert.Equal(t, "REWRITTEN:abc", capturedCN.Rewriter("abc"))
}

func TestStreamingSetsSSEHeaders(t *testing.T) {
	srv, _, _ := newTestServer(t, "", &fakeSource{id: "oc"})
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"oc/x","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	assert.Equal(t, "text/event-stream", rec.Header().Get("content-type"))
	assert.Contains(t, rec.Body.String(), "message_stop")
}

func TestCountTokensUsesLocalEstimate(t *testing.T) {
	srv, _, _ := newTestServer(t, "", &fakeSource{id: "oc"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`{}`)))
	assert.Contains(t, rec.Body.String(), "42")
}
