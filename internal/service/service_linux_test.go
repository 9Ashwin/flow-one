// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

//go:build linux

package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeSystemctl 把 systemctl 换成假的：平台断言必须能离线跑，
// 绝不真去动本机的 systemd。
type fakeSystemctl struct {
	calls       [][]string
	failReload  bool
	failEnable  bool
	failDisable bool
}

func (f *fakeSystemctl) run(args ...string) error {
	f.calls = append(f.calls, args)
	joined := strings.Join(args, " ")
	switch {
	case f.failReload && joined == "--user daemon-reload":
		return errs.Internal(errs.SubtypeUnexpected, "Failed to reload daemon: 挂了")
	case f.failEnable && strings.Contains(joined, "enable --now"):
		return errs.Internal(errs.SubtypeUnexpected, "Failed to enable unit: 挂了")
	case f.failDisable && strings.Contains(joined, "disable --now"):
		return errs.Internal(errs.SubtypeUnexpected, "Failed to disable unit: 挂了")
	}
	return nil
}

// setup 把 HOME 与 BRIDGE_HOME 都指到临时目录：unit 写到假家目录下，
// 不碰真实 ~/.config/systemd/user。
func setup(t *testing.T) (*fakeSystemctl, string, string) {
	t.Helper()
	home := t.TempDir()
	bridgeHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BRIDGE_HOME", bridgeHome)
	t.Setenv("XDG_CONFIG_HOME", "")
	fake := &fakeSystemctl{}
	systemctl = fake.run
	t.Cleanup(func() { systemctl = runSystemctl })
	return fake, home, bridgeHome
}

func unitFile(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", ServiceLabel+".service")
}

func TestInstallOnLinuxReloadsThenEnables(t *testing.T) {
	fake, home, _ := setup(t)

	result, err := Install(Options{
		Port:    8788,
		APIKey:  "k",
		Env:     map[string]string{"BRIDGE_MODEL": "oc/x"},
		Command: []string{"/opt/ccb/bridge"},
	})
	require.NoError(t, err)

	file := unitFile(home)
	assert.Equal(t, file, result.Path)
	assert.Equal(t, KindSystemd, result.Kind)
	assert.Equal(t, []string{"systemctl --user enable --now 已完成"}, result.Notes)

	// daemon-reload 必须在 enable 之前：不然 systemd 还用着旧 unit
	assert.Equal(t, [][]string{
		{"--user", "daemon-reload"},
		{"--user", "enable", "--now", ServiceLabel + ".service"},
	}, fake.calls)

	content, err := os.ReadFile(file)
	require.NoError(t, err)
	assert.Contains(t, string(content), "ExecStart=/opt/ccb/bridge")
	assert.Contains(t, string(content), "Environment=BRIDGE_PORT=8788")
	assert.Contains(t, string(content), "Environment=BRIDGE_MODEL=oc/x")
	assert.Contains(t, string(content), "Restart=always")
	assert.Contains(t, string(content), "RestartSec=3")
	assert.Contains(t, string(content), "WantedBy=default.target")
	info, err := os.Stat(file)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	record, recorded := Record()
	require.True(t, recorded)
	assert.Equal(t, KindSystemd, record.Kind)
	assert.Equal(t, "/opt/ccb/bridge", record.CLIPath)
	assert.Equal(t, "/opt/ccb/bridge", CLIPath())

	state, err := Inspect()
	require.NoError(t, err)
	assert.True(t, state.Installed)
	assert.True(t, state.Supported)
	assert.Equal(t, KindSystemd, state.Kind)
}

func TestInstallOnLinuxHonorsXDGConfigHome(t *testing.T) {
	_, _, _ = setup(t)
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	assert.FileExists(t, filepath.Join(base, "systemd", "user", ServiceLabel+".service"))
}

func TestInstallOnLinuxStopsWhenDaemonReloadFails(t *testing.T) {
	fake, home, _ := setup(t)
	fake.failReload = true

	_, err := Install(Options{Port: 8788, APIKey: "secret", Command: []string{"/opt/ccb/bridge"}})
	require.Error(t, err)
	assert.Len(t, fake.calls, 1, "daemon-reload 失败就别再 enable 了")
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Contains(t, typed.Message, "但加载失败")
	assert.Contains(t, typed.Hint, "BRIDGE_PORT=8788")
	assert.NotContains(t, typed.Hint, "secret")
	assert.FileExists(t, unitFile(home), "服务文件已经写好，失败的是加载那一步")
}

func TestUninstallOnLinuxDisablesAndForgets(t *testing.T) {
	fake, home, _ := setup(t)
	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	require.NoError(t, RecordChoice(true))

	fake.calls = nil
	result, err := Uninstall()
	require.NoError(t, err)
	assert.False(t, result.Skipped)
	assert.Equal(t, [][]string{{"--user", "disable", "--now", ServiceLabel + ".service"}}, fake.calls)
	assert.NoFileExists(t, unitFile(home))
	_, recorded := Record()
	assert.False(t, recorded)
	_, asked := LastChoice()
	assert.False(t, asked)
}

func TestUninstallOnLinuxKeepsGoingWhenDisableFails(t *testing.T) {
	fake, home, _ := setup(t)
	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	fake.failDisable = true

	result, err := Uninstall()
	require.NoError(t, err, "没在跑就算了，文件还是要删掉")
	assert.False(t, result.Skipped)
	assert.NoFileExists(t, unitFile(home))
}

func TestUninstallOnLinuxWithoutServiceSkips(t *testing.T) {
	fake, _, _ := setup(t)
	result, err := Uninstall()
	require.NoError(t, err)
	assert.True(t, result.Skipped)
	assert.Contains(t, result.Reason, "没有装过后台服务")
	assert.Empty(t, fake.calls)
}

func TestHintsOnLinux(t *testing.T) {
	setup(t)
	assert.Equal(t, "journalctl --user -u "+ServiceLabel, LogHint())
	assert.Equal(t, "systemctl --user restart "+ServiceLabel+".service", RestartHint())
}
