// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// BRIDGE_HOME 要能整体改道数据目录（测试靠它隔离）。
func TestStorePathFollowsBridgeHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BRIDGE_HOME", dir)

	path, err := StorePath()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(dir, "credentials.json"), path)
}

// 没有 BRIDGE_HOME 时按 os.UserHomeDir() 拼，不写死 macOS 路径。
func TestStorePathUsesUserHomeDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("BRIDGE_HOME", "")
	t.Setenv("HOME", home)

	path, err := StorePath()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(home, ".claude-code-openai-bridge", "credentials.json"), path)
}

// 条目按来源 id 分：写一条不该把别的来源挤掉（cn / intl / ocg 共用一份文件）。
func TestStoreKeepsOtherSources(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "credentials.json")}
	require.NoError(t, store.Save("cn", Credential{Token: Token{AccessToken: "cn-token", RefreshToken: "cn-refresh", TokenType: "Bearer"}}))
	require.NoError(t, store.Save("ocg", Credential{Token: Token{AccessToken: "ocg-token", TokenType: "Bearer"}}))

	raw, err := os.ReadFile(store.Path)
	require.NoError(t, err)
	var table map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &table))
	require.Len(t, table, 2)

	cn, ok := store.Get("cn")
	require.True(t, ok)
	assert.Equal(t, "cn-token", cn.AccessToken)
	assert.Equal(t, "cn-refresh", cn.RefreshToken)

	require.NoError(t, store.Drop("ocg"))
	_, ok = store.Get("ocg")
	assert.False(t, ok)
	_, ok = store.Get("cn")
	assert.True(t, ok, "删掉一条不该动到另一条")
}

// 凭据 0600、目录 0700，两边一致。
func TestStorePermissions(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "nested", "credentials.json")}
	require.NoError(t, store.Save("cn", Credential{Token: Token{AccessToken: "t", TokenType: "Bearer"}}))

	info, err := os.Stat(store.Path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	dirInfo, err := os.Stat(filepath.Dir(store.Path))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), dirInfo.Mode().Perm())
}

// 原子写：写完不留临时文件（读到的永远是一份完整凭据）。
func TestStoreLeavesNoTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	store := Store{Path: filepath.Join(dir, "credentials.json")}
	require.NoError(t, store.Save("cn", Credential{Token: Token{AccessToken: "t", TokenType: "Bearer"}}))

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "credentials.json", entries[0].Name())
}

// 文件缺失或坏掉时当空表：凭据坏了不该让进程连「重新登录」都进不去。
func TestStoreReadToleratesMissingAndBrokenFiles(t *testing.T) {
	dir := t.TempDir()
	missing := Store{Path: filepath.Join(dir, "nope.json")}
	assert.Empty(t, missing.Read())

	broken := Store{Path: filepath.Join(dir, "broken.json")}
	require.NoError(t, os.WriteFile(broken.Path, []byte("{not json"), 0o600))
	assert.Empty(t, broken.Read())
	_, ok := broken.Get("cn")
	assert.False(t, ok)

	// 坏文件也不该挡住写入：重新登录必须能把它覆盖掉。
	require.NoError(t, broken.Save("cn", Credential{Token: Token{AccessToken: "fresh", TokenType: "Bearer"}}))
	stored, ok := broken.Get("cn")
	require.True(t, ok)
	assert.Equal(t, "fresh", stored.AccessToken)
}

// 落盘字段名与 Node 版逐字一致（Go 版与 Node 版读同一份文件）。
func TestStoredCredentialFieldNames(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "credentials.json")}
	require.NoError(t, store.Save("cn", Credential{
		Token:   Token{AccessToken: "tok", RefreshToken: "ref", TokenType: "Bearer", Domain: "copilot.tencent.com", ExpiresAt: 1_700_000_500_000},
		Account: &Account{UID: "u1", Nickname: "阿星", EnterpriseID: "e1", AccountType: "personal"},
	}))

	raw, err := os.ReadFile(store.Path)
	require.NoError(t, err)
	var table map[string]map[string]any
	require.NoError(t, json.Unmarshal(raw, &table))
	entry := table["cn"]
	assert.Equal(t, "tok", entry["accessToken"])
	assert.Equal(t, "ref", entry["refreshToken"])
	assert.Equal(t, "Bearer", entry["tokenType"])
	assert.Equal(t, "copilot.tencent.com", entry["domain"])
	assert.EqualValues(t, 1_700_000_500_000, entry["expiresAt"])
	account, ok := entry["account"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "阿星", account["nickname"])
	assert.Equal(t, "e1", account["enterpriseId"])
}

func TestStoreBacksUpBrokenFileBeforeRewriting(t *testing.T) {
	// 凭据文件里同时躺着腾讯两条线的登录态：坏掉的 JSON 既不能被静默毁掉，
	// 也不能把「重新登录」堵死 —— 所以策略是**先备份再重写**。
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	original := `{"cn": {"accessToken": "keep-me"},`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{Path: path}
	require.NoError(t, store.Save("cn", Credential{Token: Token{AccessToken: "fresh"}}),
		"坏文件不该挡住重新登录")

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	backups := []string{}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".bak-") {
			backups = append(backups, entry.Name())
		}
	}
	require.Len(t, backups, 1, "重写前必须留一份备份")
	kept, err := os.ReadFile(filepath.Join(dir, backups[0]))
	require.NoError(t, err)
	assert.Equal(t, original, string(kept), "备份里要原样保留坏文件内容，便于手工修复")

	stored, ok := store.Get("cn")
	require.True(t, ok)
	assert.Equal(t, "fresh", stored.AccessToken)

	// 文件不存在时正常写入，且不产生备份
	fresh := Store{Path: filepath.Join(dir, "nested", "credentials.json")}
	require.NoError(t, fresh.Save("cn", Credential{}))
}
