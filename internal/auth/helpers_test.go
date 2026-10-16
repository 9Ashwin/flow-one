// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/stretchr/testify/require"
)

// writeJSON 回一段 JSON（腾讯控制面无论成败都是 200 + code）。
func writeJSON(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(payload))
}

// testProduct 是一条指向 httptest 服务器的产品线：除了端点，别的头都照真实常量。
func testProduct(server *httptest.Server) Product {
	return Product{
		ID:              "cn",
		Label:           "测试产品",
		Platform:        "ide",
		Endpoint:        server.URL,
		APIDomain:       "copilot.tencent.com",
		ProductCode:     "codebuddy",
		AttributionName: "CodeBuddy",
		ClientVersion:   "1.106.1",
		UserAgent:       "CodeBuddyIDE/1.106.1",
		FallbackModels:  []string{"deepseek-v4.1-flash"},
	}
}

// testClient 把凭据文件、轮询间隔与「打开浏览器」全部改道：测试不碰真家目录、
// 真浏览器，也不真的等 5 分钟。
func testClient(t *testing.T) (*Client, *[]string) {
	t.Helper()
	t.Setenv("BRIDGE_HOME", t.TempDir())
	opened := &[]string{}
	client := &Client{
		File:         filepath.Join(t.TempDir(), "credentials.json"),
		PollInterval: 5 * time.Millisecond,
		LoginTimeout: 2 * time.Second,
		Log:          func(string) {},
		Open:         func(url string, _ func(string)) { *opened = append(*opened, url) },
	}
	return client, opened
}

// typedError 断言 err 是类型化错误并返回它。
func typedError(t *testing.T, err error) *errs.Error {
	t.Helper()
	require.Error(t, err)
	typed, ok := errs.As(err)
	require.True(t, ok, "期望 errs.Error，实际是 %T：%v", err, err)
	return typed
}
