// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// expiredMessage 是「凭据本身失效」在文案上的判据（与状态码 401/403 一起用）。
var expiredMessage = regexp.MustCompile(`(?i)expired|invalid`)

// Refresh 用 refresh token 换一份新凭据并落盘。
//
// 刷新失败分两类，消费方据此分支：凭据失效（登录已失效，只能重新 login）与
// 这一趟没成功（网络、5xx、限流 —— 凭据还在，等下再试）。
func (c *Client) Refresh(ctx context.Context, p Product, credential Credential) (Credential, error) {
	if strings.TrimSpace(credential.RefreshToken) == "" {
		return Credential{}, errs.Auth(errs.SubtypeNotLoggedIn, p.Label+"：凭据里没有 refresh token，请重新执行 login").
			WithHint(ProductHint(p.ID))
	}
	headers := map[string]string{
		"X-Domain":             p.APIDomain,
		"User-Agent":           p.UserAgent,
		"Authorization":        "Bearer " + credential.AccessToken,
		"X-Refresh-Token":      credential.RefreshToken,
		"X-Auth-Refresh-Source": "ide-main",
	}
	status, body, err := c.control(ctx, http.MethodPost, p.Endpoint+"/v2/plugin/auth/token/refresh", headers, RequestTimeout)
	if err != nil {
		return Credential{}, errs.Wrap(err, errs.CategoryNetwork, errs.SubtypeConnectFailed, p.Label+"：续期请求失败").
			WithHint("检查网络后重试；凭据本身还在")
	}
	if status != http.StatusOK {
		message := messageOf(body)
		if status == http.StatusUnauthorized || status == http.StatusForbidden || expiredMessage.MatchString(message) {
			return Credential{}, errs.Auth(errs.SubtypeNotLoggedIn, p.Label+"：登录已失效，请重新执行 login").
				WithCode(status).
				WithHint(ProductHint(p.ID))
		}
		return Credential{}, errs.Auth(errs.SubtypeRefreshFailed,
			fmt.Sprintf("%s：续期失败（HTTP %d %s）", p.Label, status, message)).
			WithCode(status)
	}
	data, present := dataOf(body)
	if !present {
		return Credential{}, errs.Auth(errs.SubtypeRefreshFailed, p.Label+"：续期响应缺少 data")
	}
	refreshed := Credential{Token: c.parseToken(data), Account: credential.Account}
	if err := c.store().Save(p.ID, refreshed); err != nil {
		return Credential{}, err
	}
	return refreshed, nil
}

// Ensure 取一份可用凭据：快到期就先续期。
//
// 这是所有对外请求的唯一入口，所以「令牌过期」在整条链路上只处理一次。续期没成功
// 一律按「需要重新登录」上报（消费方据此回 401），原始原因留在 cause 里。
func (c *Client) Ensure(ctx context.Context, p Product) (Credential, error) {
	stored, ok := c.store().Get(p.ID)
	if !ok || strings.TrimSpace(stored.AccessToken) == "" {
		return Credential{}, notLoggedIn(p)
	}
	// 服务端没下发过期时间时（ExpiresAt == 0）不主动续期：没有依据，续期只是白跑一趟。
	if stored.ExpiresAt == 0 || stored.ExpiresAt-c.now().UnixMilli() >= RefreshMargin.Milliseconds() {
		return stored, nil
	}
	c.logf("%s：令牌即将过期，正在续期……", p.Label)
	refreshed, err := c.Refresh(ctx, p, stored)
	if err != nil {
		return Credential{}, asNotLoggedIn(p, err)
	}
	return refreshed, nil
}

// Renew 强制续期一次。
//
// 用于「上游刚回 401/403，本地看着还没过期」这种令牌已被吊销的情形。
func (c *Client) Renew(ctx context.Context, p Product) (Credential, error) {
	stored, ok := c.store().Get(p.ID)
	if !ok || strings.TrimSpace(stored.AccessToken) == "" {
		return Credential{}, notLoggedIn(p)
	}
	refreshed, err := c.Refresh(ctx, p, stored)
	if err != nil {
		return Credential{}, asNotLoggedIn(p, err)
	}
	return refreshed, nil
}

// Status 读一份展示用的登录状态；不发起任何网络请求。
func (c *Client) Status(p Product) Status {
	stored, ok := c.store().Get(p.ID)
	if !ok || strings.TrimSpace(stored.AccessToken) == "" {
		return Status{Product: p.ID, Label: p.Label}
	}
	status := Status{
		Product:     p.ID,
		Label:       p.Label,
		LoggedIn:    true,
		Refreshable: strings.TrimSpace(stored.RefreshToken) != "",
	}
	if stored.Account != nil {
		status.Nickname = stored.Account.Nickname
	}
	if stored.ExpiresAt != 0 {
		status.ExpiresAt = stored.ExpiresAt
		status.ExpiresInMs = stored.ExpiresAt - c.now().UnixMilli()
	}
	return status
}

// notLoggedIn 是「本地根本没有可用凭据」这一句。
func notLoggedIn(p Product) *errs.Error {
	return errs.Auth(errs.SubtypeNotLoggedIn, p.Label+"：尚未登录，请先执行：claude-code-bridge login "+p.ID).
		WithHint(ProductHint(p.ID))
}

// asNotLoggedIn 把续期失败统一收敛成「需要重新登录」，但保留原始分类：
// 已经是 not_logged_in（被吊销 / 过期）的原样返回，refresh_failed（这一趟没成功）
// 才包装 —— 包装会换 subtype，所以只在这两者需要合并成同一个出口时做。
func asNotLoggedIn(p Product, cause error) *errs.Error {
	var typed *errs.Error
	if errors.As(cause, &typed) && typed.Subtype == errs.SubtypeNotLoggedIn {
		return typed
	}
	return errs.Auth(errs.SubtypeNotLoggedIn, cause.Error()).
		WithCause(cause).
		WithHint(ProductHint(p.ID))
}
