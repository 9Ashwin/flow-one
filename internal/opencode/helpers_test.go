// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/stretchr/testify/require"
)

// scratch 给每个用例一个隔离的 BRIDGE_HOME：项目 id 与凭据都写到那里，绝不碰真实家目录。
func scratch(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("BRIDGE_HOME", home)
	return home
}

// resetCapabilities 换一份干净的进程级能力缓存：它是模块级的（两条路共用），
// 用例之间必须隔离。
func resetCapabilities(t *testing.T) {
	t.Helper()
	capabilities = newCapabilityCache(modelsDevTTL)
}

// sseBody 拼一段上游 SSE：每帧一行 data:，末尾 [DONE]。
func sseBody(frames ...string) string {
	var out strings.Builder
	for _, frame := range frames {
		out.WriteString("data: " + frame + "\n\n")
	}
	out.WriteString("data: [DONE]\n\n")
	return out.String()
}

// drain 读完一条流并返回每一帧的原文。
func drain(t *testing.T, stream source.Stream) []string {
	t.Helper()
	defer stream.Close()
	var frames []string
	for {
		payload, ok, err := stream.Next()
		require.NoError(t, err)
		if !ok {
			return frames
		}
		frames = append(frames, string(payload))
	}
}

// recorded 是一次被接住的上游请求。
type recorded struct {
	method string
	path   string
	header http.Header
	body   map[string]any
}

// recorder 是接住出站请求的假上游：默认回一句 SSE，respond 非 nil 时由它接管。
type recorder struct {
	mu       sync.Mutex
	requests []recorded
	server   *httptest.Server
}

func newRecorder(t *testing.T, respond func(w http.ResponseWriter, r *http.Request, body map[string]any) bool) *recorder {
	t.Helper()
	rec := &recorder{}
	rec.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if raw, err := io.ReadAll(r.Body); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		rec.mu.Lock()
		rec.requests = append(rec.requests, recorded{method: r.Method, path: r.URL.Path, header: r.Header.Clone(), body: body})
		rec.mu.Unlock()
		if respond != nil && respond(w, r, body) {
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(sseBody(`{"choices":[{"delta":{"content":"ok"}}]}`)))
	}))
	t.Cleanup(rec.server.Close)
	return rec
}

func (r *recorder) taken() []recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recorded(nil), r.requests...)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.requests)
}

// upstreamError 按 OpenCode 的形状回一个错误。
func upstreamError(w http.ResponseWriter, status int, errorType string, message string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	payload, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]string{"type": errorType, "message": message}})
	_, _ = w.Write(payload)
}

// testOptions 指向假上游：BaseURL 覆盖端点，HTTPClient 用 httptest 的客户端。
func testOptions(rec *recorder, modelsDevURL string) Options {
	return Options{BaseURL: rec.server.URL, ModelsDevURL: modelsDevURL, HTTPClient: rec.server.Client()}
}

// freeBody 是一份最小的、带调用方工具的免费档请求体。
func freeBody() []byte {
	return []byte(`{
		"messages": [{"role": "user", "content": "列出当前目录"}],
		"max_tokens": 128,
		"tools": [
			{"type": "function", "function": {"name": "Bash", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}},
			{"type": "function", "function": {"name": "Read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
			{"type": "function", "function": {"name": "Edit", "parameters": {"type": "object"}}}
		]
	}`)
}

// toolNames 取出请求体里的工具名。
func toolNames(t *testing.T, body map[string]any) []string {
	t.Helper()
	tools, ok := body["tools"].([]any)
	require.True(t, ok, "报文里必须有 tools 数组")
	names := make([]string, 0, len(tools))
	for _, item := range tools {
		tool, isTool := item.(map[string]any)
		require.True(t, isTool)
		function, isFunction := tool["function"].(map[string]any)
		require.True(t, isFunction)
		name, isName := function["name"].(string)
		require.True(t, isName)
		names = append(names, name)
	}
	return names
}

// contains 报告切片里有没有某个值。
func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// writeFile 写一个用例用的文件，失败即用例失败。
func writeFile(t *testing.T, file string, content string) error {
	t.Helper()
	return os.WriteFile(file, []byte(content), 0o600)
}
