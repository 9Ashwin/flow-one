// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fixedClock(ms int64) func() time.Time {
	return func() time.Time { return time.UnixMilli(ms) }
}

// 服务端给了绝对时刻就以它为准（毫秒、秒、ISO 串三种写法都要认）。
func TestParseTokenExpiryForms(t *testing.T) {
	client := &Client{Now: fixedClock(1_700_000_000_000)}

	// 毫秒时间戳
	token := client.parseToken(map[string]any{
		"accessToken": "a", "expiresAt": json.Number("1700000500000"), "expiresIn": json.Number("10"),
	})
	assert.Equal(t, int64(1_700_000_500_000), token.ExpiresAt, "绝对值优先于相对秒数")

	// 秒时间戳（小于 1e12 当秒）
	token = client.parseToken(map[string]any{"accessToken": "a", "expiresAt": json.Number("1700000500")})
	assert.Equal(t, int64(1_700_000_500_000), token.ExpiresAt)

	// 字符串形式的秒时间戳
	token = client.parseToken(map[string]any{"accessToken": "a", "expiresAt": "1700000500"})
	assert.Equal(t, int64(1_700_000_500_000), token.ExpiresAt)

	// ISO 串
	token = client.parseToken(map[string]any{"accessToken": "a", "expiresAt": "2026-10-16T12:00:00Z"})
	assert.Equal(t, time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC).UnixMilli(), token.ExpiresAt)

	// 相对秒数
	token = client.parseToken(map[string]any{"accessToken": "a", "expiresIn": json.Number("3600")})
	assert.Equal(t, int64(1_700_003_600_000), token.ExpiresAt)
	assert.Zero(t, token.RefreshExpiresAt)

	// refreshExpiresIn 同理
	token = client.parseToken(map[string]any{"accessToken": "a", "refreshExpiresIn": json.Number("7200")})
	assert.Equal(t, int64(1_700_007_200_000), token.RefreshExpiresAt)
}

// 服务端没下发绝对时间时，用令牌自己的 exp 兜底。
func TestParseTokenFallsBackToJWTClaim(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1760000000}`))
	token := (&Client{}).parseToken(map[string]any{"accessToken": "head." + payload + ".sig"})

	assert.Equal(t, int64(1_760_000_000_000), token.ExpiresAt)
}

// 拿不到任何过期时间时留 0：Ensure 据此不主动续期（没有依据就别白跑一趟）。
func TestParseTokenWithoutExpiry(t *testing.T) {
	token := (&Client{}).parseToken(map[string]any{"accessToken": "a"})

	assert.Zero(t, token.ExpiresAt)
	assert.Equal(t, "Bearer", token.TokenType, "tokenType 缺省是 Bearer")
}

// 非对象的 data（字符串、数组）当空令牌，与 Node 版对 record 的处理一致。
func TestParseTokenWithNonObjectData(t *testing.T) {
	token := (&Client{}).parseToken("nonsense")

	assert.Empty(t, token.AccessToken)
	assert.Equal(t, "Bearer", token.TokenType)
}

func TestTextOf(t *testing.T) {
	assert.Equal(t, "a b c", textOf("a\r\n\tb\tc  "))
	assert.Equal(t, "123", textOf(json.Number("123")))
	assert.Empty(t, textOf(nil))
	assert.Empty(t, textOf(true))
	assert.Empty(t, textOf(""))
}

// code 必须是数字：字符串 "11217" 不算 —— 那种响应另有毛病，不该被当成「还没好」。
func TestCodeOfRequiresNumber(t *testing.T) {
	code, ok := codeOf(map[string]any{"code": json.Number("11217")})
	require.True(t, ok)
	assert.Equal(t, 11217, code)

	_, ok = codeOf(map[string]any{"code": "11217"})
	assert.False(t, ok)

	_, ok = codeOf(nil)
	assert.False(t, ok)

	assert.Equal(t, "-", codeText(map[string]any{"code": "11217"}))
	assert.Equal(t, "12151", codeText(map[string]any{"code": json.Number("12151")}))
}

func TestMessageOf(t *testing.T) {
	assert.Equal(t, "boom", messageOf(map[string]any{"msg": "boom", "message": "other"}))
	assert.Equal(t, "second", messageOf(map[string]any{"msg": "", "message": "second"}))
	assert.Equal(t, "第四", messageOf(map[string]any{"errorMsg": "第四"}))
	assert.Empty(t, messageOf(nil))
}

// dataOf 认「键在且不是 null」，与 Node 版的判据一致。
func TestDataOf(t *testing.T) {
	value, ok := dataOf(map[string]any{"data": map[string]any{"a": 1}})
	require.True(t, ok)
	assert.NotNil(t, value)

	_, ok = dataOf(map[string]any{"data": nil})
	assert.False(t, ok)
	_, ok = dataOf(map[string]any{})
	assert.False(t, ok)
	_, ok = dataOf(nil)
	assert.False(t, ok)
}

func TestDecodeBody(t *testing.T) {
	assert.Nil(t, decodeBody(nil), "空体交给状态码判断")
	assert.Nil(t, decodeBody([]byte("   ")))
	assert.Nil(t, decodeBody([]byte("[1,2]")))
	assert.Nil(t, decodeBody([]byte("<html>")))

	body := decodeBody([]byte(`{"code":11217}`))
	require.NotNil(t, body)
	assert.Equal(t, json.Number("11217"), body["code"])
}
