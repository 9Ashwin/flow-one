// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// scratch 给每个用例一个隔离的数据目录与 Claude 配置目录：
// 一律走 t.Setenv，绝不碰真实家目录。
func scratch(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	configDir := t.TempDir()
	t.Setenv("BRIDGE_HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	return home, configDir
}

// readFile 读回一个 JSON 文件。
func readFile(t *testing.T, file string) map[string]any {
	t.Helper()
	payload, err := os.ReadFile(file)
	require.NoError(t, err)
	var document map[string]any
	require.NoError(t, json.Unmarshal(payload, &document))
	return document
}

func writeFile(t *testing.T, file string, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(file), 0o700))
	require.NoError(t, os.WriteFile(file, []byte(content), 0o600))
}

func TestConfigDirHonorsOverride(t *testing.T) {
	home, configDir := scratch(t)
	dir, err := ConfigDir()
	require.NoError(t, err)
	assert.Equal(t, configDir, dir, "CLAUDE_CONFIG_DIR 优先（macOS 与 Linux 同一条规则）")

	settings, err := SettingsPath()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(configDir, "settings.json"), settings)

	// 没设就退回 ~/.claude
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	dir, err = ConfigDir()
	require.NoError(t, err)
	userHome, err := os.UserHomeDir()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(userHome, ".claude"), dir)
	assert.NotEmpty(t, home)
}

func TestInstallMergesInsteadOfOverwriting(t *testing.T) {
	home, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{
	  "permissions": {"allow": ["Bash(ls:*)"]},
	  "env": {"DISABLE_TELEMETRY": "1", "ANTHROPIC_BASE_URL": "http://127.0.0.1:18899"},
	  "model": "sonnet",
	  "timeout": 30000
	}`)

	applied, err := Install(InstallOptions{
		BaseURL:       "http://127.0.0.1:8788",
		APIKey:        "k-1",
		Model:         "cn/deepseek-v4.1-flash",
		ContextWindow: 1_000_000,
	})
	require.NoError(t, err)

	// 必须留下备份
	require.NotEmpty(t, applied.Backup)
	assert.True(t, strings.HasPrefix(applied.Backup, file+".bak-"), "备份名带时间戳：%s", applied.Backup)
	backup, err := os.ReadFile(applied.Backup)
	require.NoError(t, err)
	assert.Contains(t, string(backup), "18899", "备份里是写之前的内容")

	written := readFile(t, file)
	// 别人的键一个都不能少
	assert.Equal(t, map[string]any{"allow": []any{"Bash(ls:*)"}}, written["permissions"])
	raw, err := os.ReadFile(file)
	require.NoError(t, err)
	assert.Contains(t, string(raw), `"timeout": 30000`, "别人的数字字段原样保留（不被改写成 3e+04）")

	env, isObject := written["env"].(map[string]any)
	require.True(t, isObject)
	assert.Equal(t, "1", env["DISABLE_TELEMETRY"], "别人的 env 键要留着")
	assert.Equal(t, "http://127.0.0.1:8788", env["ANTHROPIC_BASE_URL"])
	assert.Equal(t, "k-1", env["ANTHROPIC_AUTH_TOKEN"])
	// 1M 窗口才登记 [1m]
	assert.Equal(t, "cn/deepseek-v4.1-flash[1m]", env["ANTHROPIC_MODEL"])
	assert.Equal(t, "cn/deepseek-v4.1-flash[1m]", env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	assert.Equal(t, "cn/deepseek-v4.1-flash[1m]", env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
	assert.Equal(t, "cn/deepseek-v4.1-flash[1m]", env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
	assert.Equal(t, "cn/deepseek-v4.1-flash[1m]", written["model"], "顶层 model 与 env 必须同一个值")
	assert.NotContains(t, written, "modelOverrides")

	// 账本：写在哪、备份在哪、写了哪些键值，都要认账
	state := ReadInstallState(home)
	record, recorded := recordOf(state)
	require.True(t, recorded)
	assert.Equal(t, file, record.File)
	assert.Equal(t, applied.Backup, *record.Backup)
	assert.Equal(t, "sonnet", record.PreviousModel)
	info, err := os.Stat(InstallStatePath(home))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "账本 0600")
}

func TestInstallWithoutExistingFileDoesNotBackup(t *testing.T) {
	_, configDir := scratch(t)
	applied, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k", Model: "oc/x", ContextWindow: 200_000})
	require.NoError(t, err)
	assert.Empty(t, applied.Backup, "原文件不存在就没有备份可写")

	written := readFile(t, filepath.Join(configDir, "settings.json"))
	assert.Equal(t, "oc/x", written["model"])
	env, _ := written["env"].(map[string]any)
	assert.Equal(t, "oc/x", env["ANTHROPIC_MODEL"], "200k 的模型不能登记成 1M")
}

func TestUninstallOnlyRemovesOurUntouchedKeys(t *testing.T) {
	home, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{"env":{"KEEP":"me"},"model":"opus"}`)
	_, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k-2", Model: "cn/x", ContextWindow: 1_000_000})
	require.NoError(t, err)
	assert.Equal(t, "cn/x[1m]", readFile(t, file)["model"])

	// 用户自己改了令牌，还原时就不能动它
	edited := readFile(t, file)
	edited["env"].(map[string]any)["ANTHROPIC_AUTH_TOKEN"] = "user-changed"
	payload, err := json.Marshal(edited)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(file, payload, 0o600))

	result, err := Uninstall()
	require.NoError(t, err)
	assert.False(t, result.Skipped)
	assert.NotEmpty(t, result.Backup, "还原前也要备份")

	after := readFile(t, file)
	env, _ := after["env"].(map[string]any)
	assert.Equal(t, "me", env["KEEP"])
	assert.Equal(t, "user-changed", env["ANTHROPIC_AUTH_TOKEN"], "用户改过的值必须保留")
	assert.NotContains(t, env, "ANTHROPIC_BASE_URL")
	assert.NotContains(t, env, "ANTHROPIC_MODEL")
	assert.Equal(t, "opus", after["model"], "顶层 model 要还原成安装前的值")
	assert.Contains(t, result.Removed, "ANTHROPIC_BASE_URL")
	assert.NotContains(t, result.Removed, "ANTHROPIC_AUTH_TOKEN")

	// 账本里那一节要清掉，免得再还原一次
	assert.NotContains(t, ReadInstallState(home), settingsKey)
}

func TestUninstallRemovesModelWhenThereWasNone(t *testing.T) {
	_, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{"env":{"ANTHROPIC_BASE_URL":"http://old"}}`)
	_, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k", Model: "oc/x"})
	require.NoError(t, err)

	result, err := Uninstall()
	require.NoError(t, err)
	assert.Contains(t, result.Removed, "model")
	after := readFile(t, file)
	assert.NotContains(t, after, "model", "安装前没有 model，还原后也不该留着")
	assert.NotContains(t, after, "env", "env 被清空后就整个删掉")
}

func TestUninstallKeepsUserEditedModel(t *testing.T) {
	_, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{"model":"opus"}`)
	_, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k", Model: "oc/x"})
	require.NoError(t, err)

	// 用户自己把顶层 model 换成了别的
	edited := readFile(t, file)
	edited["model"] = "sonnet"
	payload, err := json.Marshal(edited)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(file, payload, 0o600))

	result, err := Uninstall()
	require.NoError(t, err)
	assert.NotContains(t, result.Removed, "model")
	assert.Equal(t, "sonnet", readFile(t, file)["model"], "用户自己改过的顶层 model 不能被吃掉")
}

func TestUninstallWithoutRecordSkips(t *testing.T) {
	scratch(t)
	result, err := Uninstall()
	require.NoError(t, err)
	assert.True(t, result.Skipped)
	assert.Contains(t, result.Reason, "没有本工具写入过的记录")
}

func TestUninstallWhenSettingsFileIsGoneSkips(t *testing.T) {
	_, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{}`)
	_, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k", Model: "oc/x"})
	require.NoError(t, err)
	require.NoError(t, os.Remove(file))

	result, err := Uninstall()
	require.NoError(t, err)
	assert.True(t, result.Skipped)
	assert.Contains(t, result.Reason, "不存在")
}

func TestSizedModelFollowsRealContextWindow(t *testing.T) {
	// 免费档的 deepseek-v4.1-flash-free 实测是 200k：给它加 [1m] 会让 Claude Code
	// 到 1M 才压缩上下文，然后撞上模型真实上限。
	assert.Equal(t, "oc/deepseek-v4.1-flash-free", sizedModel("oc/deepseek-v4.1-flash-free", 200_000))
	// 窗口未知时也不加（Claude Code 对未识别 ID 的默认假设正是 200k）
	assert.Equal(t, "oc/whatever", sizedModel("oc/whatever", 0))
	assert.Equal(t, "oc/whatever", sizedModel("oc/whatever", -1))
	// 超过 200k 才登记 1M
	assert.Equal(t, "intl/deepseek-v4.1-flash[1m]", sizedModel("intl/deepseek-v4.1-flash", 1_000_000))
	assert.Equal(t, "cn/x[1m]", sizedModel("cn/x[1m]", 0), "带后缀进来的不能被叠成两个")
}

func TestReadSettingsSurvivesGarbage(t *testing.T) {
	_, configDir := scratch(t)
	file := filepath.Join(configDir, "settings.json")
	writeFile(t, file, `{"broken": `)

	applied, err := Install(InstallOptions{BaseURL: "http://127.0.0.1:8788", APIKey: "k", Model: "oc/x"})
	require.NoError(t, err)
	assert.NotEmpty(t, applied.Backup, "坏文件也要先备份再写")
	backup, err := os.ReadFile(applied.Backup)
	require.NoError(t, err)
	assert.Equal(t, `{"broken": `, string(backup))
	written := readFile(t, file)
	assert.Equal(t, "oc/x", written["model"])
}
