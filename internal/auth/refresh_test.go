// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 续期：POST + X-Refresh-Token + X-Auth-Refresh-Source，换回来的令牌落盘，
// 账号信息原样带过去。
func TestRefreshAssertsOutboundRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v2/plugin/auth/token/refresh", r.URL.Path)
		assert.Equal(t, "copilot.tencent.com", r.Header.Get("X-Domain"))
		assert.Equal(t, "Bearer old-access", r.Header.Get("Authorization"))
		assert.Equal(t, "old-refresh", r.Header.Get("X-Refresh-Token"))
		assert.Equal(t, "ide-main", r.Header.Get("X-Auth-Refresh-Source"))
		assert.Equal(t, "CodeBuddyIDE/1.106.1", r.Header.Get("User-Agent"))
		body, err := io.ReadAll(r.Body)
		assert.NoError(t, err)
		assert.Empty(t, body, "续期不带请求体")
		writeJSON(w, `{"code":0,"data":{"accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600}}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	product := testProduct(server)
	refreshed, err := client.Refresh(context.Background(), product, Credential{
		Token:   Token{AccessToken: "old-access", RefreshToken: "old-refresh", TokenType: "Bearer"},
		Account: &Account{UID: "u-1", Nickname: "阿星", EnterpriseID: "ent-1"},
	})

	require.NoError(t, err)
	assert.Equal(t, "new-access", refreshed.AccessToken)
	assert.Equal(t, "new-refresh", refreshed.RefreshToken)
	require.NotNil(t, refreshed.Account, "续期不该丢掉账号信息")
	assert.Equal(t, "阿星", refreshed.Account.Nickname)

	stored, ok := client.store().Get(product.ID)
	require.True(t, ok)
	assert.Equal(t, "new-access", stored.AccessToken)
	assert.Equal(t, "ent-1", stored.Account.EnterpriseID)
}

func TestRefreshWithoutRefreshToken(t *testing.T) {
	client, _ := testClient(t)
	_, err := client.Refresh(context.Background(), Product{ID: "cn", Label: "测试产品"}, Credential{
		Token: Token{AccessToken: "a"},
	})

	typed := typedError(t, err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)
	assert.Contains(t, typed.Hint, "login cn")
}

// 401 / 403 / 文案里说 expired|invalid = 凭据本身失效，只能重新登录。
func TestRefreshInvalidCredentialIsNotLoggedIn(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
	}{
		{"401", http.StatusUnauthorized, `{"msg":"unauthorized"}`},
		{"403", http.StatusForbidden, `{"msg":"forbidden"}`},
		{"文案说 expired", http.StatusBadRequest, `{"code":11000,"msg":"refresh token expired"}`},
		{"文案说 invalid", http.StatusBadRequest, `{"msg":"Invalid refresh token"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(testCase.status)
				writeJSON(w, testCase.payload)
			}))
			defer server.Close()

			client, _ := testClient(t)
			_, err := client.Refresh(context.Background(), testProduct(server), Credential{
				Token: Token{AccessToken: "a", RefreshToken: "r"},
			})

			typed := typedError(t, err)
			assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)
			assert.Equal(t, testCase.status, typed.Code)
			assert.Contains(t, typed.Message, "登录已失效")
		})
	}
}

// 5xx / 限流是「这一趟没成功」：凭据还在，别报成要重新登录。
func TestRefreshTransientFailureIsRefreshFailed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, `{"msg":"internal error"}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	_, err := client.Refresh(context.Background(), testProduct(server), Credential{
		Token: Token{AccessToken: "a", RefreshToken: "r"},
	})

	typed := typedError(t, err)
	assert.Equal(t, errs.SubtypeRefreshFailed, typed.Subtype)
	assert.Equal(t, http.StatusInternalServerError, typed.Code)
	assert.Contains(t, typed.Message, "续期失败")
}

func TestRefreshMissingData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"code":0}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	_, err := client.Refresh(context.Background(), testProduct(server), Credential{
		Token: Token{AccessToken: "a", RefreshToken: "r"},
	})

	typed := typedError(t, err)
	assert.Equal(t, errs.SubtypeRefreshFailed, typed.Subtype)
	assert.Contains(t, typed.Message, "缺少 data")
}

// 快到期才续期：还早的话一次网络都不发。
func TestEnsureRefreshesOnlyWhenExpiring(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, `{"code":0,"data":{"accessToken":"renewed","refreshToken":"r2","expiresIn":3600}}`)
	}))
	defer server.Close()

	product := testProduct(server)
	now := time.Now().UnixMilli()

	fresh := Credential{Token: Token{AccessToken: "fresh", RefreshToken: "r", ExpiresAt: now + 3_600_000}}
	for _, testCase := range []struct {
		name       string
		credential Credential
	}{
		{"还早", fresh},
		{"服务端没给过期时间", Credential{Token: Token{AccessToken: "fresh", RefreshToken: "r"}}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			client, _ := testClient(t)
			require.NoError(t, client.store().Save(product.ID, testCase.credential))
			hits.Store(0)

			credential, err := client.Ensure(context.Background(), product)
			require.NoError(t, err)
			assert.Equal(t, "fresh", credential.AccessToken)
			assert.Zero(t, hits.Load(), "没到期不该发续期请求")
		})
	}

	// 到期前 2 分钟内（REFRESH_MARGIN）就该续期。
	client, _ := testClient(t)
	require.NoError(t, client.store().Save(product.ID, Credential{
		Token: Token{AccessToken: "stale", RefreshToken: "r", ExpiresAt: now + 30_000},
	}))
	credential, err := client.Ensure(context.Background(), product)
	require.NoError(t, err)
	assert.Equal(t, "renewed", credential.AccessToken)
	assert.Equal(t, int32(1), hits.Load())
}

// Renew 是「上游刚回 401」用的：令牌看着没过期也强制续期一次。
func TestRenewForcesRefresh(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, `{"code":0,"data":{"accessToken":"renewed"}}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	product := testProduct(server)
	require.NoError(t, client.store().Save(product.ID, Credential{
		Token: Token{AccessToken: "stale", RefreshToken: "r", ExpiresAt: time.Now().UnixMilli() + 3_600_000},
	}))

	credential, err := client.Renew(context.Background(), product)
	require.NoError(t, err)
	assert.Equal(t, "renewed", credential.AccessToken)
	assert.Equal(t, int32(1), hits.Load())
}

// 续期失败一律汇总成「需要重新登录」，但原始分类留在原因链里。
func TestEnsureWrapsRefreshFailureAsNotLoggedIn(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client, _ := testClient(t)
	product := testProduct(server)
	require.NoError(t, client.store().Save(product.ID, Credential{
		Token: Token{AccessToken: "stale", RefreshToken: "r", ExpiresAt: time.Now().UnixMilli() + 1000},
	}))

	_, err := client.Ensure(context.Background(), product)
	typed := typedError(t, err)
	assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)

	inner, ok := errs.As(err.(*errs.Error).Unwrap())
	require.True(t, ok, "原因链里要留着 refresh_failed")
	assert.Equal(t, errs.SubtypeRefreshFailed, inner.Subtype)
}

func TestEnsureWithoutCredential(t *testing.T) {
	client, _ := testClient(t)
	_, err := client.Ensure(context.Background(), Product{ID: "cn", Label: "测试产品"})

	typed := typedError(t, err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeNotLoggedIn, typed.Subtype)
	assert.Contains(t, typed.Message, "尚未登录")
	assert.Contains(t, typed.Hint, "login cn")
}

// status 不发任何网络请求。
func TestStatusDoesNotTouchNetwork(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer server.Close()

	client, _ := testClient(t)
	product := testProduct(server)

	assert.False(t, client.Status(product).LoggedIn)

	require.NoError(t, client.store().Save(product.ID, Credential{
		Token:   Token{AccessToken: "tok", RefreshToken: "ref", ExpiresAt: time.Now().UnixMilli() + 60_000},
		Account: &Account{Nickname: "阿星"},
	}))
	status := client.Status(product)

	assert.True(t, status.LoggedIn)
	assert.Equal(t, "阿星", status.Nickname)
	assert.True(t, status.Refreshable)
	assert.Positive(t, status.ExpiresInMs)
	assert.Zero(t, hits.Load())
}
