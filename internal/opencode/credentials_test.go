// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestSaveGoKeyPersistsAndReusesSession(t *testing.T) {
	home := scratch(t)
	assert.False(t, HasGoKey())
	assert.Empty(t, GoKeyTail())

	first, err := SaveGoKey("  oc_sk_test_0000000000000000000000000000  ")
	require.NoError(t, err)
	assert.Equal(t, "oc_sk_test_0000000000000000000000000000", first.APIKey, "key 两边的空白要去掉")
	assert.Regexp(t, uuidPattern, first.Session)
	assert.True(t, HasGoKey())
	assert.Equal(t, "0000", GoKeyTail())

	// 会话 id 落盘复用：再存一次 key 不该换会话（换了会让同一台机器被看成很多客户端），
	// 但 key 本身要换成新的
	second, err := SaveGoKey("oc_sk_test_1111111111111111111111111111")
	require.NoError(t, err)
	assert.Equal(t, first.Session, second.Session)
	assert.Equal(t, "1111", GoKeyTail())

	// 读回来的是同一份（凭据文件在 BRIDGE_HOME 下，0600）
	stored, ok := ReadGoKey()
	require.True(t, ok)
	assert.Equal(t, second.APIKey, stored.APIKey)
	assert.Equal(t, second.Session, stored.Session)
	info, err := os.Stat(home + "/credentials.json")
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "凭据文件必须 0600")

	// 落盘形状要与腾讯两条线共用的那份文件兼容：顶层按条目名分节
	raw, err := os.ReadFile(home + "/credentials.json")
	require.NoError(t, err)
	var document map[string]map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	require.Contains(t, document, "opencode-go")
	assert.Equal(t, second.Session, document["opencode-go"]["session"])
	assert.NotEmpty(t, document["opencode-go"]["savedAt"])
}

func TestSaveGoKeyRejectsEmptyKey(t *testing.T) {
	scratch(t)
	_, err := SaveGoKey("   ")
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.CategoryValidation, typed.Category)
	assert.Equal(t, errs.SubtypeMissingArgument, typed.Subtype)
}

func TestSaveGoKeyDoesNotClobberBrokenStore(t *testing.T) {
	home := scratch(t)
	// 坏掉的凭据文件不能当成空表覆盖：那会顺手毁掉腾讯两条线的登录态
	broken := `{"cn": {"accessToken": "x"` // 少一个右括号
	require.NoError(t, writeFile(t, home+"/credentials.json", broken))

	_, err := SaveGoKey("oc_sk_test_5555555555555555555555555555")
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.SubtypeParseFailed, typed.Subtype)
	raw, readErr := os.ReadFile(home + "/credentials.json")
	require.NoError(t, readErr)
	assert.Equal(t, broken, string(raw), "坏文件必须原样留着，等用户自己修")
}

func TestSaveGoKeyKeepsOtherEntries(t *testing.T) {
	home := scratch(t)
	require.NoError(t, writeFile(t, home+"/credentials.json", `{"cn":{"accessToken":"keep-me","account":{"nickname":"我"}}}`))
	_, err := SaveGoKey("oc_sk_test_6666666666666666666666666666")
	require.NoError(t, err)

	raw, err := os.ReadFile(home + "/credentials.json")
	require.NoError(t, err)
	var document map[string]map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	assert.Equal(t, "keep-me", document["cn"]["accessToken"], "腾讯那条线的凭据不能被吃掉")
}

func TestReadGoKeyWithoutSessionMintsUUID(t *testing.T) {
	home := scratch(t)
	require.NoError(t, writeFile(t, home+"/credentials.json", `{"opencode-go":{"apiKey":"oc_sk_x"}}`))
	key, ok := ReadGoKey()
	require.True(t, ok)
	assert.Equal(t, "oc_sk_x", key.APIKey)
	assert.Regexp(t, uuidPattern, key.Session, "没有会话 id 就现场铸一个 UUID，不能不带这个头")
}

func TestReadGoKeyWithoutEntry(t *testing.T) {
	scratch(t)
	_, ok := ReadGoKey()
	assert.False(t, ok)
	assert.Empty(t, GoKeyTail())
}
