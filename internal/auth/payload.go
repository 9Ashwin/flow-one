// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// dataOf 取 body.data。第二个返回值是「键在且不是 null」—— Node 版的
// `data !== undefined && data !== null` 就是这两条。
func dataOf(body map[string]any) (any, bool) {
	if body == nil {
		return nil, false
	}
	value, ok := body["data"]
	if !ok || value == nil {
		return nil, false
	}
	return value, true
}

// codeOf 取 body.code，且必须是数字（Node 版用 typeof === 'number' 判断；
// 字符串 "11217" 不算 —— 那种响应另有毛病，不该被当成「还没好」一直等下去）。
func codeOf(body map[string]any) (int, bool) {
	if body == nil {
		return 0, false
	}
	number, ok := body["code"].(json.Number)
	if !ok {
		return 0, false
	}
	if value, err := number.Int64(); err == nil {
		return int(value), true
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) {
		return 0, false
	}
	return int(value), true
}

// codeText 把 code 渲染成错误信息里的那一段：取不到就是 `-`。
func codeText(body map[string]any) string {
	if code, ok := codeOf(body); ok {
		return strconv.Itoa(code)
	}
	return "-"
}

// messageOf 依次找 msg / message / displayMsg / errorMsg 里第一个非空字符串。
func messageOf(body map[string]any) string {
	for _, key := range []string{"msg", "message", "displayMsg", "errorMsg"} {
		if value, ok := body[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

var lineBreaks = regexp.MustCompile(`[\r\n\t]+`)

// textOf 把响应里的标量收敛成文本：字符串去掉换行与制表符再 trim，数字按原文。
func textOf(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(lineBreaks.ReplaceAllString(typed, " "))
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

// epochLayouts 是 toEpochMs 认的日期串格式。
//
// 没有时区的写法按本机时区解 —— 与 JS 的 Date.parse 一致（那些格式本来就被当成
// 本地时间）。
var epochLayouts = []string{
	time.RFC3339,
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	time.RFC1123,
}

// parseToken 解出令牌。过期时间的优先级：服务端给的绝对值 → 相对秒数 → JWT 的 exp。
//
// value 可以是任意 JSON 值：非对象时各字段为空（Node 版对非对象的 record 也当 {}）。
func (c *Client) parseToken(value any) Token {
	data, _ := value.(map[string]any)
	token := Token{
		AccessToken:  textOf(data["accessToken"]),
		RefreshToken: textOf(data["refreshToken"]),
		TokenType:    textOf(data["tokenType"]),
		Domain:       textOf(data["domain"]),
	}
	if token.TokenType == "" {
		token.TokenType = "Bearer"
	}
	token.ExpiresAt = c.epochOf(data["expiresAt"], data["expiresIn"], jwtExpiresAt(token.AccessToken))
	token.RefreshExpiresAt = c.epochOf(data["refreshExpiresAt"], data["refreshExpiresIn"], 0)
	return token
}

// epochOf 依次尝试：绝对时刻（毫秒 / 秒 / ISO 串）→ 相对秒数 → 兜底。
func (c *Client) epochOf(absolute any, relative any, fallback int64) int64 {
	if value, ok := toEpochMs(absolute); ok {
		return value
	}
	if value, ok := relativeEpoch(relative, c.now()); ok {
		return value
	}
	return fallback
}

// relativeEpoch：`expiresIn` 是「还能用多少秒」的相对值，基准是 now。
func relativeEpoch(value any, now time.Time) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	seconds, err := number.Float64()
	if err != nil || math.IsNaN(seconds) || seconds <= 0 {
		return 0, false
	}
	return now.UnixMilli() + int64(seconds*1000), true
}

var allDigits = regexp.MustCompile(`^\d+$`)

// toEpochMs 把后端可能给出的毫秒数、秒数或日期串统一成毫秒时刻。
func toEpochMs(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return scaleEpoch(number)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		if allDigits.MatchString(trimmed) {
			number, err := strconv.ParseFloat(trimmed, 64)
			if err != nil {
				return 0, false
			}
			return scaleEpoch(number)
		}
		for _, layout := range epochLayouts {
			if parsed, err := time.ParseInLocation(layout, trimmed, time.Local); err == nil {
				return parsed.UnixMilli(), true
			}
		}
		return 0, false
	default:
		return 0, false
	}
}

// scaleEpoch：比 1e12 大的当毫秒，否则当秒（Node 版同一条判据）。
func scaleEpoch(value float64) (int64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	if value > 1e12 {
		return int64(value), true
	}
	return int64(value * 1000), true
}

// jwtExpiresAt 从令牌自带的 exp 声明取过期时刻；服务端没下发绝对时间时用它兜底。
func jwtExpiresAt(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		if payload, err = base64.URLEncoding.DecodeString(parts[1]); err != nil {
			return 0
		}
	}
	claims := decodeBody(payload)
	seconds, ok := claims["exp"].(json.Number)
	if !ok {
		return 0
	}
	value, err := seconds.Float64()
	if err != nil {
		return 0
	}
	return int64(value * 1000)
}
