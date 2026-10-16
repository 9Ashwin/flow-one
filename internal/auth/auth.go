// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package auth 管腾讯两条线（国内版 CodeBuddy / 国际版 WorkBuddy）的登录、
// 凭据落盘与静默续期。
//
// 采用**外部链接轮询式**登录，不起本地回调服务器：
//
//	POST /v2/plugin/auth/state?platform=<platform>  → {state, authUrl}
//	打开浏览器到 authUrl                             → 用户在网页上完成登录
//	GET  /v2/plugin/auth/token?state=<state>        → 轮询拿 accessToken（1s 间隔，5 分钟超时）
//	GET  /v2/plugin/login/account?state=<state>     → 轮询拿账号（uid / 昵称 / 企业 id）
//	POST /v2/plugin/auth/token/refresh              → 之后静默续期
//
// 两个「还没好」的错误码必须当成继续等而不是失败：11217（令牌未就绪）、
// 12151（账号信息未完成）—— 把它们当错误会让登录在第一秒就失败。
//
// 凭据落在 `~/.claude-code-openai-bridge/credentials.json`（0600，原子写），
// 条目按来源 id 分（cn / intl / ocg 共用一份文件）；`BRIDGE_HOME` 可覆盖数据目录。
//
// 本包只认「产品」这一份描述（Product）；具体来源实现（模型目录、对话报文、
// 内容风控改写）在 internal/tencent —— 后者 import 前者，反过来会成环。
package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// StateTimeout 是取登录地址的超时：这一步只发一个短请求。
	StateTimeout = 10 * time.Second
	// RequestTimeout 是登录与续期里单个请求的超时。
	RequestTimeout = 60 * time.Second
	// DefaultLoginTimeout 是「用户去浏览器授权」的等待上限。
	DefaultLoginTimeout = 5 * time.Minute
	// DefaultPollInterval 是轮询间隔。
	DefaultPollInterval = time.Second
	// RefreshMargin 是到期前多久开始续期：留出一次网络往返的余量。
	RefreshMargin = 120 * time.Second

	// CodeTokenNotReady：令牌还没好，继续轮询。
	CodeTokenNotReady = 11217
	// CodeAccountNotReady：账号信息还没好，继续轮询。
	CodeAccountNotReady = 12151
)

// maxBodyBytes 是控制面响应的读取上限：这些端点只回一小段 JSON，读不完说明对面
// 不正常，不该把内存交给它。
const maxBodyBytes = 4 << 20

// Client 发起腾讯侧的登录与续期。零值即可用：HTTP / Log / Open / Now 都有默认值。
//
// 出站超时一律由每次请求自己的 context 决定（与 Node 版 AbortSignal.timeout 的
// 分工一致），所以默认客户端不设全局 Timeout。
type Client struct {
	// HTTP 是出站客户端。nil 时用 http.DefaultClient。
	HTTP *http.Client
	// Log 收进度与提示（stderr 那一侧）。nil 时静默。
	Log func(string)
	// Open 打开授权页，第二个参数是「打不开时怎么说」。nil 时用平台默认命令
	// （macOS `open` / Linux `xdg-open`）；打不开不算失败 —— 链接本来就会打印出来。
	Open func(url string, log func(string))
	// Now 是可注入的时钟，测试用。
	Now func() time.Time
	// PollInterval 是轮询间隔，0 表示 DefaultPollInterval。
	PollInterval time.Duration
	// LoginTimeout 是等待授权的上限，0 表示 DefaultLoginTimeout。
	LoginTimeout time.Duration
	// File 覆盖凭据文件位置；空则按 BRIDGE_HOME / 家目录解析。
	File string
}

// NewClient 返回一个全默认的客户端。
func NewClient() *Client { return &Client{} }

// HTTPClient 返回出站客户端。
//
// 来源实现（internal/tencent）用同一个客户端发模型目录与对话请求：注入一处，
// 测试里换一个 Transport 就能同时罩住登录、目录与对话。
func (c *Client) HTTPClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) logf(format string, args ...any) {
	if c.Log != nil {
		c.Log(fmt.Sprintf(format, args...))
	}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) pollInterval() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return DefaultPollInterval
}

func (c *Client) loginTimeout() time.Duration {
	if c.LoginTimeout > 0 {
		return c.LoginTimeout
	}
	return DefaultLoginTimeout
}

func (c *Client) store() Store { return Store{Path: c.File} }

// control 发一次控制面请求，返回状态码与解出来的 JSON 对象。
//
// 传输层失败返回 error（轮询里的网络抖动据此 continue）；响应体不是 JSON 对象时
// body 为 nil —— 交给状态码判断，与 Node 版一致。
func (c *Client) control(ctx context.Context, method, url string, headers map[string]string, timeout time.Duration) (int, map[string]any, error) {
	if ctx == nil {
		// 兜底：nil 父 context 会让 context.WithTimeout 直接 panic，
		// 而 CLI 崩掉对用户来说毫无信息量（真机上撞过一次）。
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return 0, nil, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.HTTPClient().Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, decodeBody(payload), nil
}

// decodeBody 把响应体解成 JSON 对象；不是对象（或坏 JSON / 空体）返回 nil。
//
// 用 UseNumber：令牌里的 expiresAt 是毫秒时间戳，走 float64 会抹掉尾数。
func decodeBody(payload []byte) map[string]any {
	if len(bytes.TrimSpace(payload)) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var body any
	if err := decoder.Decode(&body); err != nil {
		return nil
	}
	object, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	return object
}
