// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
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

func TestSaveGoKeyBacksUpBrokenStoreBeforeRewriting(t *testing.T) {
	home := scratch(t)
	// 坏掉的凭据文件里可能躺着腾讯两条线的登录态：不能静默整表重写（先备份再说），
	// 也不能直接拒绝写（那会让人连重新配 key 都做不了）——
	// 这条策略与 internal/auth 的 Store.update 保持一致。
	broken := `{"cn": {"accessToken": "x"` // 少一个右括号
	require.NoError(t, writeFile(t, home+"/credentials.json", broken))

	saved, err := SaveGoKey("oc_sk_test_5555555555555555555555555555")
	require.NoError(t, err)
	assert.Regexp(t, uuidPattern, saved.Session)

	// 原文留在备份里（0600）
	entries, err := os.ReadDir(home)
	require.NoError(t, err)
	backups := []string{}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "credentials.json.bak-") {
			backups = append(backups, entry.Name())
		}
	}
	require.Len(t, backups, 1, "坏文件必须先备份：%v", backups)
	backup, err := os.ReadFile(home + "/" + backups[0])
	require.NoError(t, err)
	assert.Equal(t, broken, string(backup), "备份里是原文")
	info, err := os.Stat(home + "/" + backups[0])
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	// 写出来的是一份合法凭据
	stored, ok := ReadGoKey()
	require.True(t, ok)
	assert.Equal(t, "oc_sk_test_5555555555555555555555555555", stored.APIKey)
}

func TestReadGoKeyDoesNotTouchTheFileOnBrokenStore(t *testing.T) {
	home := scratch(t)
	broken := `{"cn": {`
	require.NoError(t, writeFile(t, home+"/credentials.json", broken))

	// 读路径（向导与 status 会频繁调用）不能有副作用：不备份、不改写
	_, ok := ReadGoKey()
	assert.False(t, ok)
	assert.Empty(t, GoKeyTail())
	entries, err := os.ReadDir(home)
	require.NoError(t, err)
	assert.Len(t, entries, 1, "读一次不该多出备份文件：%v", entries)
	raw, err := os.ReadFile(home + "/credentials.json")
	require.NoError(t, err)
	assert.Equal(t, broken, string(raw))
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
