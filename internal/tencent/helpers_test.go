// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/auth"
	"github.com/stretchr/testify/require"
)

// writeJSON 回一段 JSON（腾讯控制面无论成败都是 200 + code）。
func writeJSON(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(payload))
}

// testConfig 把端点指向 httptest 服务器、凭据改道临时目录，并把轮询间隔压到毫秒级。
func testConfig(t *testing.T, endpoint string) Config {
	t.Helper()
	t.Setenv("BRIDGE_HOME", t.TempDir())
	product := CN
	product.Endpoint = endpoint
	return Config{
		Product:   product,
		StorePath: filepath.Join(t.TempDir(), "credentials.json"),
		Client: &auth.Client{
			PollInterval: 5 * time.Millisecond,
			LoginTimeout: time.Second,
			Log:          func(string) {},
		},
		Log: func(string) {},
	}
}

// seedCredential 预置一份凭据，省掉测试里的登录流程。
func seedCredential(t *testing.T, cfg Config, credential auth.Credential) {
	t.Helper()
	require.NoError(t, auth.Store{Path: cfg.StorePath}.Save(cfg.Product.ID, credential))
}

// liveCredential 是一份「还早、不需要续期」的凭据（带企业 id，出站要发两个头）。
func liveCredential() auth.Credential {
	return auth.Credential{
		Token: auth.Token{
			AccessToken:  "access-1",
			RefreshToken: "refresh-1",
			TokenType:    "Bearer",
			Domain:       "copilot.tencent.com",
			ExpiresAt:    time.Now().UnixMilli() + 3_600_000,
		},
		Account: &auth.Account{UID: "u-1", Nickname: "阿星", EnterpriseID: "ent-1", AccountType: "personal"},
	}
}
