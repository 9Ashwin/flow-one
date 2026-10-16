// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// scratch 给每个用例一个隔离的数据目录：账本与服务文件都写到那里，绝不碰真实家目录。
func scratch(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("BRIDGE_HOME", home)
	return home
}

// 公共用例只碰纯函数与账本，**不调 launchctl / systemctl**（那两条路径在
// service_darwin_test.go / service_linux_test.go 里用假命令断言）。

func TestSystemdUnitShape(t *testing.T) {
	unit, err := SystemdUnit(Options{
		Port:    9000,
		APIKey:  "k-4",
		Env:     map[string]string{"BRIDGE_MODE": "direct"},
		Command: []string{"/usr/bin/node", "/opt/ccb/cli.mjs"},
	})
	require.NoError(t, err)
	assert.Contains(t, unit, "ExecStart=/usr/bin/node /opt/ccb/cli.mjs")
	assert.Contains(t, unit, "Environment=BRIDGE_PORT=9000")
	assert.Contains(t, unit, "Environment=BRIDGE_API_KEY=k-4")
	assert.Contains(t, unit, "Environment=BRIDGE_MODE=direct")
	assert.Contains(t, unit, "Restart=always")
	assert.Contains(t, unit, "RestartSec=3")
	assert.Contains(t, unit, "WantedBy=default.target")
	assert.True(t, strings.HasSuffix(unit, "\n"), "服务文件要以换行收尾")
}

func TestSystemdUnitOmitsEmptyAPIKey(t *testing.T) {
	unit, err := SystemdUnit(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	assert.NotContains(t, unit, "BRIDGE_API_KEY", "空密钥不该写进服务文件")
}

func TestSystemdUnitQuotesPathsWithSpaces(t *testing.T) {
	// 路径里带空格时（macOS 的家目录很常见，容器里也有）不加引号 systemd 会把它当成
	// 两个参数，服务直接起不来。
	unit, err := SystemdUnit(Options{Port: 8788, Command: []string{"/Users/a b/ccb", "serve"}})
	require.NoError(t, err)
	assert.Contains(t, unit, `ExecStart="/Users/a b/ccb" serve`)
}

func TestLaunchAgentPlistShape(t *testing.T) {
	home := scratch(t)
	plist, err := LaunchAgentPlist(Options{
		Port:    8788,
		APIKey:  "k-3",
		Command: []string{"/usr/local/bin/claude-code-bridge"},
		LogDir:  home,
	})
	require.NoError(t, err)
	assert.Contains(t, plist, "<key>Label</key>\n  <string>"+ServiceLabel+"</string>")
	assert.Contains(t, plist, "<string>/usr/local/bin/claude-code-bridge</string>")
	assert.Contains(t, plist, "<key>BRIDGE_PORT</key>\n    <string>8788</string>")
	assert.Contains(t, plist, "<key>BRIDGE_API_KEY</key>\n    <string>k-3</string>")
	assert.Contains(t, plist, "<key>RunAtLoad</key>")
	assert.Contains(t, plist, "<key>KeepAlive</key>")
	assert.Contains(t, plist, filepath.Join(home, "bridge.log"))
	assert.Contains(t, plist, filepath.Join(home, "bridge.err.log"))
	assert.NotContains(t, plist, "&amp;amp;", "转义只做一遍")
}

func TestLaunchAgentPlistEscapesAndKeepsExtraEnv(t *testing.T) {
	home := scratch(t)
	// 服务是不带参数启动的：模式与模型必须落进服务环境，否则会退回默认配置
	plist, err := LaunchAgentPlist(Options{
		Port:    8788,
		APIKey:  "",
		Env:     map[string]string{"BRIDGE_MODE": "gateway", "BRIDGE_MODEL": "workbuddy/x&y"},
		Command: []string{"/n"},
		LogDir:  home,
	})
	require.NoError(t, err)
	assert.Contains(t, plist, "<key>BRIDGE_MODE</key>\n    <string>gateway</string>")
	assert.Contains(t, plist, "<key>BRIDGE_MODEL</key>\n    <string>workbuddy/x&amp;y</string>")
	assert.NotContains(t, plist, "BRIDGE_API_KEY", "空密钥不该写进服务文件")
}

func TestServiceEnvOrderIsStable(t *testing.T) {
	// 顺序固定，服务文件的文本才可断言：端口永远第一，其余按 key 排序
	pairs := serviceEnv(Options{Port: 8788, APIKey: "k", Env: map[string]string{"BRIDGE_MODEL": "oc/x", "BRIDGE_MODE": "direct"}})
	keys := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		keys = append(keys, pair.Key)
	}
	assert.Equal(t, []string{"BRIDGE_PORT", "BRIDGE_API_KEY", "BRIDGE_MODE", "BRIDGE_MODEL"}, keys)
}

func TestServiceEnvExtraOverridesPortWithoutDuplicating(t *testing.T) {
	pairs := serviceEnv(Options{Port: 8788, Env: map[string]string{"BRIDGE_PORT": "9001"}})
	require.Len(t, pairs, 1)
	assert.Equal(t, "9001", pairs[0].Value, "额外项最后合并，能覆盖端口；但不能写出重复的键")
}

func TestCLIPathFromServiceFile(t *testing.T) {
	// launchd：Go 版服务文件的第一条就是本程序的二进制
	snapshot := `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/me/.local/bin/claude-code-bridge</string>
  </array>
</dict></plist>`
	assert.Equal(t, "/Users/me/.local/bin/claude-code-bridge", CLIPathFromServiceFile(snapshot, KindLaunchd))

	systemdUnit := "[Service]\nExecStart=/usr/local/bin/claude-code-bridge serve\n"
	assert.Equal(t, "/usr/local/bin/claude-code-bridge", CLIPathFromServiceFile(systemdUnit, KindSystemd))
	// systemd 允许在前缀写 `-`（忽略失败）之类的标记
	assert.Equal(t, "/opt/ccb", CLIPathFromServiceFile("[Service]\nExecStart=-/opt/ccb\n", KindSystemd))
	assert.Equal(t, "/a b/ccb", CLIPathFromServiceFile("[Service]\nExecStart=\"/a b/ccb\" --serve\n", KindSystemd))

	assert.Empty(t, CLIPathFromServiceFile("", KindLaunchd))
	assert.Empty(t, CLIPathFromServiceFile("<plist></plist>", KindLaunchd))
	assert.Empty(t, CLIPathFromServiceFile("", KindSystemd))
}

func TestRenderersAgreeOnExecutable(t *testing.T) {
	// 两份服务文件必须指向同一个入口，否则「服务代码不一致」的告警会在两台机器上
	// 给出互相矛盾的结论
	opts := Options{Port: 8788, Command: []string{"/opt/ccb/bridge", "serve"}, LogDir: t.TempDir()}
	plist, err := LaunchAgentPlist(opts)
	require.NoError(t, err)
	unit, err := SystemdUnit(opts)
	require.NoError(t, err)
	assert.Equal(t, "/opt/ccb/bridge", CLIPathFromServiceFile(plist, KindLaunchd))
	assert.Equal(t, "/opt/ccb/bridge", CLIPathFromServiceFile(unit, KindSystemd))
}

func TestChoiceRoundTrip(t *testing.T) {
	home := scratch(t)
	_, asked := LastChoice()
	assert.False(t, asked, "没问过就该说没问过：向导据此决定要不要问")

	require.NoError(t, RecordChoice(true))
	choice, asked := LastChoice()
	require.True(t, asked)
	assert.True(t, choice.AutoStart)

	require.NoError(t, RecordChoice(false))
	choice, asked = LastChoice()
	require.True(t, asked)
	assert.False(t, choice.AutoStart)

	// 记在账本里（不是内存变量）：每次运行都是新进程
	state := readStateFile(t, home)
	assert.Equal(t, true, state["autoStartAsked"])
	assert.Equal(t, false, state["autoStart"])
}

func TestRecordReportsWhatWeInstalled(t *testing.T) {
	home := scratch(t)
	_, recorded := Record()
	assert.False(t, recorded)

	writeStateFile(t, home, map[string]any{
		"service": map[string]any{
			"kind": "systemd", "path": "/tmp/x.service", "port": 8788,
			"env": map[string]string{"BRIDGE_MODEL": "oc/x"}, "cliPath": "/opt/ccb/bridge",
		},
	})

	record, recorded := Record()
	require.True(t, recorded)
	assert.Equal(t, KindSystemd, record.Kind)
	assert.Equal(t, "/tmp/x.service", record.Path)
	assert.Equal(t, 8788, record.Port)
	assert.Equal(t, map[string]string{"BRIDGE_MODEL": "oc/x"}, record.Env)
	assert.Equal(t, "/opt/ccb/bridge", record.CLIPath)
}

func TestLogAndRestartHintsArePlatformSpecific(t *testing.T) {
	scratch(t)
	hint := LogHint()
	restart := RestartHint()
	assert.NotEmpty(t, hint)
	assert.NotEmpty(t, restart)
	assert.NotContains(t, restart, "http://", "提示应当是可直接粘贴的命令")
}

// readStateFile 直接读账本原文（用例断言的是落盘形状，不是内存形状）。
func readStateFile(t *testing.T, home string) map[string]any {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(home, "install.json"))
	require.NoError(t, err)
	state := map[string]any{}
	require.NoError(t, json.Unmarshal(payload, &state))
	return state
}

func writeStateFile(t *testing.T, home string, state map[string]any) {
	t.Helper()
	payload, err := json.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(home, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(home, "install.json"), payload, 0o600))
}
