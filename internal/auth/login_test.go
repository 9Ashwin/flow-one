// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 登录链路：state → 轮询令牌（11217 继续等）→ 轮询账号（12151 继续等）→ 落盘。
//
// 「继续等」那两个码被当成错误会让登录在第一秒就失败，所以这里既断言最终结果，
// 也断言轮询确实发生过多次、且没有提前返回。
func TestLoginPollsUntilTokenReady(t *testing.T) {
	var tokenPolls, accountPolls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/plugin/auth/state":
			assert.Equal(t, http.MethodPost, r.Method)
			assert.Equal(t, "ide", r.URL.Query().Get("platform"))
			assert.Equal(t, "copilot.tencent.com", r.Header.Get("X-Domain"))
			assert.Equal(t, "true", r.Header.Get("X-No-Authorization"))
			assert.Equal(t, "true", r.Header.Get("X-No-User-Id"))
			assert.Equal(t, "true", r.Header.Get("X-No-Enterprise-Id"))
			assert.Equal(t, "true", r.Header.Get("X-No-Department-Info"))
			assert.Equal(t, "CodeBuddyIDE/1.106.1", r.Header.Get("User-Agent"))
			assert.Zero(t, r.ContentLength, "取 state 不带请求体")
			writeJSON(w, `{"code":0,"data":{"state":"st-1","authUrl":"https://example.test/authorize?state=st-1"}}`)
		case "/v2/plugin/auth/token":
			assert.Equal(t, http.MethodGet, r.Method)
			assert.Equal(t, "st-1", r.URL.Query().Get("state"))
			assert.Equal(t, "true", r.Header.Get("X-No-Authorization"))
			assert.Equal(t, "CodeBuddyIDE/1.106.1", r.Header.Get("User-Agent"))
			if tokenPolls.Add(1) <= 2 {
				writeJSON(w, `{"code":11217,"msg":"令牌还没好"}`)
				return
			}
			writeJSON(w, `{"code":0,"data":{"accessToken":"tok-1","refreshToken":"ref-1","expiresIn":3600,"domain":"copilot.tencent.com"}}`)
		case "/v2/plugin/login/account":
			assert.Equal(t, "Bearer tok-1", r.Header.Get("Authorization"))
			assert.Equal(t, "copilot.tencent.com", r.Header.Get("X-Domain"))
			assert.Equal(t, "true", r.Header.Get("X-No-User-Id"))
			if accountPolls.Add(1) == 1 {
				writeJSON(w, `{"code":12151,"msg":"账号信息未完成"}`)
				return
			}
			writeJSON(w, `{"code":0,"data":{"uid":"u-1","nickname":"阿星","enterpriseId":"ent-1","type":"enterprise"}}`)
		default:
			t.Errorf("意外的请求：%s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client, opened := testClient(t)
	product := testProduct(server)
	start := time.Now()
	credential, err := client.Login(context.Background(), product)
	elapsed := time.Since(start)

	require.NoError(t, err)
	assert.Equal(t, "tok-1", credential.AccessToken)
	assert.Equal(t, "ref-1", credential.RefreshToken)
	require.NotNil(t, credential.Account)
	assert.Equal(t, "阿星", credential.Account.Nickname)
	assert.Equal(t, "ent-1", credential.Account.EnterpriseID)
	assert.Equal(t, "enterprise", credential.Account.AccountType)
	assert.NotZero(t, credential.ExpiresAt)

	// 轮询期间进程不能自己走掉：必须等够那两个「还没好」。
	assert.GreaterOrEqual(t, tokenPolls.Load(), int32(3))
	assert.GreaterOrEqual(t, accountPolls.Load(), int32(2))
	assert.GreaterOrEqual(t, elapsed, 2*client.PollInterval)

	// 凭据按来源 id 落盘。
	stored, ok := client.store().Get(product.ID)
	require.True(t, ok)
	assert.Equal(t, "tok-1", stored.AccessToken)

	// 授权链接交给了浏览器。
	require.Len(t, *opened, 1)
	assert.Equal(t, "https://example.test/authorize?state=st-1", (*opened)[0])
}

// 轮询期间的单次网络抖动不该中断整次登录（用户可能正在浏览器里点授权）。
func TestPollTokenSurvivesNetworkBlips(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/plugin/auth/token" {
			t.Errorf("意外的请求：%s", r.URL.Path)
			return
		}
		if polls.Add(1) <= 2 {
			// 直接断连：客户端拿到的是传输层错误，而不是一个响应。
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("测试服务器不支持 Hijack")
				return
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("Hijack 失败：%v", err)
				return
			}
			_ = connection.Close()
			return
		}
		writeJSON(w, `{"code":0,"data":{"accessToken":"tok-after-blip"}}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	token, err := client.PollToken(context.Background(), testProduct(server), "st-1")

	require.NoError(t, err)
	assert.Equal(t, "tok-after-blip", token.AccessToken)
	assert.GreaterOrEqual(t, polls.Load(), int32(3))
}

// 5 分钟没授权就是登录超时（不是「获取令牌失败」这种含糊的错误）。
func TestLoginTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/plugin/auth/state" {
			writeJSON(w, `{"code":0,"data":{"state":"st-1","authUrl":"https://example.test/a"}}`)
			return
		}
		writeJSON(w, `{"code":11217}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	client.LoginTimeout = 40 * time.Millisecond
	_, err := client.Login(context.Background(), testProduct(server))

	typed := typedError(t, err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeLoginTimeout, typed.Subtype)
}

// 取消（Ctrl-C / 父 context 结束）是个明确的错误，不是静默返回。
func TestPollTokenCancelled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"code":11217}`)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client, _ := testClient(t)
	_, err := client.PollToken(ctx, testProduct(server), "st-1")

	typed := typedError(t, err)
	assert.Equal(t, errs.SubtypeLoginFailed, typed.Subtype)
	assert.Contains(t, typed.Message, "登录已取消")
}

// 账号信息拿不到不该让整次登录白费：令牌已经在手，昵称只是展示项。
func TestCompleteLoginToleratesMissingAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/plugin/auth/token":
			writeJSON(w, `{"code":0,"data":{"accessToken":"tok-1","expiresAt":"2026-10-16T12:00:00Z"}}`)
		case "/v2/plugin/login/account":
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, _ := testClient(t)
	credential, err := client.CompleteLogin(context.Background(), testProduct(server), "st-1")

	require.NoError(t, err)
	assert.Nil(t, credential.Account)
	assert.Equal(t, int64(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC).UnixMilli()), credential.ExpiresAt)

	stored, ok := client.store().Get("cn")
	require.True(t, ok)
	assert.Equal(t, "tok-1", stored.AccessToken)
}

func TestFetchAuthStateMissingFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"code":0,"data":{"state":"st-1"}}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	_, err := client.FetchAuthState(context.Background(), testProduct(server))

	typed := typedError(t, err)
	assert.Equal(t, errs.CategoryAuth, typed.Category)
	assert.Equal(t, errs.SubtypeLoginFailed, typed.Subtype)
}

func TestFetchAuthStateHTTPFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		writeJSON(w, `{"msg":"网关出错"}`)
	}))
	defer server.Close()

	client, _ := testClient(t)
	_, err := client.FetchAuthState(context.Background(), testProduct(server))

	typed := typedError(t, err)
	assert.Equal(t, errs.SubtypeLoginFailed, typed.Subtype)
	assert.Equal(t, http.StatusBadGateway, typed.Code)
	assert.Contains(t, typed.Message, "网关出错")
}

// 连不上是 network，不是 auth：退出码与补救动作都不一样。
func TestFetchAuthStateConnectFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	dead := server.URL
	server.Close()

	client, _ := testClient(t)
	_, err := client.FetchAuthState(context.Background(), Product{
		ID: "cn", Label: "测试产品", Platform: "ide", Endpoint: dead,
	})

	typed := typedError(t, err)
	assert.Equal(t, errs.CategoryNetwork, typed.Category)
	assert.Equal(t, errs.SubtypeConnectFailed, typed.Subtype)
}

// 国际版的登录链接要带 version 与 loginSessionId；国内版一个都不加。
func TestDecorateLoginURL(t *testing.T) {
	client := &Client{}
	intl := Product{ID: "intl", SessionParams: true, PluginVersion: "5.5.2"}

	link := client.DecorateLoginURL("https://www.workbuddy.ai/login?state=st-1&from=cli", intl)
	parsed, err := url.Parse(link)
	require.NoError(t, err)
	assert.Equal(t, "st-1", parsed.Query().Get("state"), "服务端下发的参数一个都不能丢")
	assert.Equal(t, "cli", parsed.Query().Get("from"))
	assert.Equal(t, "5.5.2", parsed.Query().Get("version"))
	assert.Regexp(t, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
		parsed.Query().Get("loginSessionId"))

	other, err := url.Parse(client.DecorateLoginURL("https://www.workbuddy.ai/login?state=st-1", intl))
	require.NoError(t, err)
	assert.NotEqual(t, parsed.Query().Get("loginSessionId"), other.Query().Get("loginSessionId"),
		"每次登录都要一个独立的追踪 id")

	cn := Product{ID: "cn"}
	raw := "https://copilot.tencent.com/login?state=st-1"
	assert.Equal(t, raw, client.DecorateLoginURL(raw, cn))

	// 解析不了的链接原样返回，不擅自改。
	assert.Equal(t, "://坏链接", client.DecorateLoginURL("://坏链接", intl))
}

// 没有浏览器可用时也不能静默失败：链接必须打印出来（SSH 场景就靠它）。
func TestLoginPrintsLinkWhenBrowserFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/plugin/auth/state":
			writeJSON(w, `{"code":0,"data":{"state":"st-1","authUrl":"https://example.test/authorize?state=st-1"}}`)
		case "/v2/plugin/auth/token":
			writeJSON(w, `{"code":0,"data":{"accessToken":"tok-1"}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	logs := &[]string{}
	client := &Client{
		File:         t.TempDir() + "/credentials.json",
		PollInterval: 5 * time.Millisecond,
		LoginTimeout: time.Second,
		Log:          func(line string) { *logs = append(*logs, line) },
		Open:         func(link string, log func(string)) { log("无法自动打开浏览器，请手动访问：" + link) },
	}
	_, err := client.Login(context.Background(), testProduct(server))
	require.NoError(t, err)

	joined := strings.Join(*logs, "\n")
	assert.Contains(t, joined, "https://example.test/authorize?state=st-1")
	assert.Contains(t, joined, "无法自动打开浏览器")
	assert.Contains(t, joined, "登录成功")
}
