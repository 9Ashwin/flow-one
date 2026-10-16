// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/9Ashwin/flow-one/errs"
)

// AuthState 是 `/v2/plugin/auth/state` 的结果：state 是服务端签发的兑换凭据，
// URL 是让用户去浏览器完成授权的地址。
type AuthState struct {
	State string
	URL   string
}

// FetchAuthState 取一次登录 state 与授权地址。
func (c *Client) FetchAuthState(ctx context.Context, p Product) (AuthState, error) {
	endpoint := p.Endpoint + "/v2/plugin/auth/state?platform=" + url.QueryEscape(p.Platform)
	headers := map[string]string{
		"X-Domain":             p.APIDomain,
		"X-No-Authorization":   "true",
		"X-No-User-Id":         "true",
		"X-No-Enterprise-Id":   "true",
		"X-No-Department-Info": "true",
		"User-Agent":           p.UserAgent,
	}
	status, body, err := c.control(ctx, http.MethodPost, endpoint, headers, StateTimeout)
	if err != nil {
		return AuthState{}, errs.Wrap(err, errs.CategoryNetwork, errs.SubtypeConnectFailed, p.Label+"：获取登录地址失败").
			WithHint("检查网络与代理设置，重试一次")
	}
	if status != http.StatusOK {
		return AuthState{}, errs.Auth(errs.SubtypeLoginFailed,
			fmt.Sprintf("%s：获取登录地址失败（HTTP %d %s）", p.Label, status, messageOf(body))).
			WithCode(status)
	}
	data, _ := dataOf(body)
	fields, _ := data.(map[string]any)
	state := textOf(fields["state"])
	authURL := textOf(fields["authUrl"])
	if state == "" || authURL == "" {
		return AuthState{}, errs.Auth(errs.SubtypeLoginFailed, p.Label+"：登录地址响应缺少 state 或 authUrl")
	}
	return AuthState{State: state, URL: authURL}, nil
}

// DecorateLoginURL 给国际版的登录链接补 version 与 loginSessionId。
//
// loginSessionId 只是服务端日志追踪用的 UUID（实测无校验语义）。路径与 state
// 一律用服务端下发的那份，只追加查询参数；解析不了就原样返回，不擅自改链接。
func (c *Client) DecorateLoginURL(raw string, p Product) string {
	if !p.SessionParams {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	if p.PluginVersion != "" {
		query.Set("version", p.PluginVersion)
	}
	if session := newUUID(); session != "" {
		query.Set("loginSessionId", session)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// PollToken 轮询到令牌。code 11217 表示「还没好」，继续等。
//
// 网络抖动（control 返回 error）不中断整个登录：用户可能正在浏览器里点授权，
// 一次失败的轮询什么都不说明。
func (c *Client) PollToken(ctx context.Context, p Product, state string) (Token, error) {
	endpoint := p.Endpoint + "/v2/plugin/auth/token?state=" + url.QueryEscape(state)
	headers := map[string]string{"X-No-Authorization": "true", "User-Agent": p.UserAgent}
	deadline := c.now().Add(c.loginTimeout())
	for c.now().Before(deadline) {
		if err := wait(ctx, c.pollInterval()); err != nil {
			return Token{}, cancelled(p, err)
		}
		status, body, err := c.control(ctx, http.MethodGet, endpoint, headers, RequestTimeout)
		if err != nil {
			continue
		}
		if status == http.StatusOK {
			if data, present := dataOf(body); present {
				token := c.parseToken(data)
				if token.AccessToken != "" {
					return token, nil
				}
				continue
			}
		}
		if code, ok := codeOf(body); ok && code == CodeTokenNotReady {
			continue
		}
		return Token{}, errs.Auth(errs.SubtypeLoginFailed,
			fmt.Sprintf("%s：获取令牌失败（HTTP %d code=%s）", p.Label, status, codeText(body))).
			WithCode(status)
	}
	return Token{}, errs.Auth(errs.SubtypeLoginTimeout,
		fmt.Sprintf("%s：登录超时（%s 内未在浏览器完成授权）", p.Label, c.loginTimeout()))
}

// PollAccount 轮询账号信息。code 12151 表示「还没好」，继续等。
//
// 账号拿不到不该让整次登录白费：令牌已经在手，昵称与企业 id 都只是附加项，
// 所以超时或 404 都返回 (nil, nil)。
func (c *Client) PollAccount(ctx context.Context, p Product, state string, token Token) (*Account, error) {
	endpoint := p.Endpoint + "/v2/plugin/login/account?state=" + url.QueryEscape(state)
	domain := token.Domain
	if domain == "" {
		// 登录流程里 domain 是服务端本次刚下发的权威值，非空时以它为准。
		domain = p.APIDomain
	}
	headers := map[string]string{
		"X-Domain":           domain,
		"Authorization":      "Bearer " + token.AccessToken,
		"X-No-User-Id":       "true",
		"X-No-Enterprise-Id": "true",
		"User-Agent":         p.UserAgent,
	}
	deadline := c.now().Add(c.loginTimeout())
	for c.now().Before(deadline) {
		if err := wait(ctx, c.pollInterval()); err != nil {
			return nil, cancelled(p, err)
		}
		status, body, err := c.control(ctx, http.MethodGet, endpoint, headers, RequestTimeout)
		if err != nil {
			continue
		}
		if status == http.StatusOK {
			if data, present := dataOf(body); present {
				fields, _ := data.(map[string]any)
				accountType := textOf(fields["type"])
				if accountType == "" {
					accountType = "personal"
				}
				return &Account{
					UID:          textOf(fields["uid"]),
					Nickname:     textOf(fields["nickname"]),
					EnterpriseID: textOf(fields["enterpriseId"]),
					AccountType:  accountType,
				}, nil
			}
		}
		if code, ok := codeOf(body); ok && code == CodeAccountNotReady {
			continue
		}
		if status == http.StatusOK || status == http.StatusNotFound {
			return nil, nil
		}
		return nil, errs.Auth(errs.SubtypeLoginFailed,
			fmt.Sprintf("%s：获取账号信息失败（HTTP %d code=%s）", p.Label, status, codeText(body))).
			WithCode(status)
	}
	return nil, nil
}

// CompleteLogin 用已有的 state 把登录收尾。
//
// state 由服务端签发，只要还在有效期内就仍可兑换 —— 所以授权完成后哪怕进程重启过、
// 轮询被中断过，也能把凭据取回来。
func (c *Client) CompleteLogin(ctx context.Context, p Product, state string) (Credential, error) {
	token, err := c.PollToken(ctx, p, state)
	if err != nil {
		return Credential{}, err
	}
	account, err := c.PollAccount(ctx, p, state, token)
	if err != nil {
		return Credential{}, err
	}
	credential := Credential{Token: token, Account: account}
	if err := c.store().Save(p.ID, credential); err != nil {
		return Credential{}, err
	}
	nickname := ""
	if account != nil && account.Nickname != "" {
		nickname = "（" + account.Nickname + "）"
	}
	c.logf("%s：登录成功%s，凭据已保存", p.Label, nickname)
	return credential, nil
}

// Login 是完整的一次登录：取 state → 用户浏览器授权 → 轮询令牌 → 轮询账号。
func (c *Client) Login(ctx context.Context, p Product) (Credential, error) {
	c.logf("%s：正在获取登录地址……", p.Label)
	state, err := c.FetchAuthState(ctx, p)
	if err != nil {
		return Credential{}, err
	}
	link := c.DecorateLoginURL(state.URL, p)
	// 链接一律打印：SSH / 容器里没有 open 或 xdg-open，用户得自己点。
	c.logf("%s：请在浏览器中完成登录：\n  %s", p.Label, link)
	c.openBrowser(link)
	c.logf("%s：等待授权（最长 %s）……", p.Label, c.loginTimeout())
	return c.CompleteLogin(ctx, p, state.State)
}

// openBrowser 调起授权页；打不开不是失败（链接已经打印过了）。
func (c *Client) openBrowser(link string) {
	open := c.Open
	if open == nil {
		open = openInBrowser
	}
	open(link, c.Log)
}

// wait 阻塞调用方直到到点或 ctx 结束。
//
// ⚠️ 必须**阻塞当前调用方**：不要改成「起个后台 goroutine 然后返回」。Node 版在这
// 里踩过 sleep 被 unref 的坑 —— 等待期间进程里没有别的句柄，unref 之后就没人去取
// 令牌了，表现为「打印完登录链接就没了」。`login` 是独立命令，等待就是它的全部工作。
func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// cancelled 把取消（Ctrl-C、父 context 结束）收敛成类型化错误。
func cancelled(p Product, cause error) *errs.Error {
	return errs.Auth(errs.SubtypeLoginFailed, p.Label+"：登录已取消").WithCause(cause)
}

// newUUID 生成 v4 UUID。用 crypto/rand：这个值会进服务端日志当追踪 id。
//
// 取不到随机数时返回空串，调用方跳过该参数 —— 一条日志参数不值得让登录失败。
func newUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return ""
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// openInBrowser 用平台命令打开授权页。
//
// 命令名在 browser_darwin.go / browser_linux.go 里按 build tag 分文件给出；起不来
// （SSH、容器里没有这个命令）只记一行提示，不当作失败 —— 链接本来就打印出来了。
func openInBrowser(link string, log func(string)) {
	command := exec.Command(browserCommand, link)
	if err := command.Start(); err != nil {
		if log != nil {
			log("无法自动打开浏览器，请手动访问：" + link)
		}
		return
	}
	// 不等它退出：浏览器是用户的进程，不是我们的子任务。
	_ = command.Process.Release()
}

// ProductHint 是「还没登录」时给用户的那一条补救命令。
func ProductHint(id string) string {
	return "flow-one login " + strings.TrimSpace(id)
}
