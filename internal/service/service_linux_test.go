// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

//go:build linux

package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/9Ashwin/flow-one/errs"
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
	// 默认「问不出来」：用例不该去问本机的 logind
	lingerState = func() (bool, bool) { return false, false }
	t.Cleanup(func() {
		systemctl = runSystemctl
		lingerState = queryLinger
	})
	return fake, home, bridgeHome
}

// withLinger 让 loadService 里的 lingering 探测返回指定的结果。
func withLinger(enabled bool, known bool) {
	lingerState = func() (bool, bool) { return enabled, known }
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

func TestInstallOnLinuxHintsLingerOnlyWhenNeeded(t *testing.T) {
	_, _, _ = setup(t)

	// 没开 lingering：这正是「装了自启但注销就停」的坑，装完第一次要说一句
	withLinger(false, true)
	t.Setenv("USER", "ashwin")
	result, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	require.Len(t, result.Notes, 2)
	assert.Equal(t, "systemctl --user enable --now 已完成", result.Notes[0])
	assert.Contains(t, result.Notes[1], "loginctl enable-linger ashwin")

	// 已经开了：不打扰
	withLinger(true, true)
	result, err = Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	assert.Len(t, result.Notes, 1, "开了 lingering 就别刷提示")

	// 问不出来（没有 loginctl / 输出不认识）：不猜，什么都不说
	withLinger(false, false)
	result, err = Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	assert.Len(t, result.Notes, 1)
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

// ── XDG_RUNTIME_DIR：无头 ubuntu 上真踩过的坑 ────────────────────────────────

func TestXdgRuntimeDirFallback(t *testing.T) {
	yes := func(string) bool { return true }
	no := func(string) bool { return false }

	// 空 → 补 /run/user/<uid>（dbus 一直在这儿，只是没人指出来）
	dir, ok := xdgRuntimeDirFor("", 1000, yes)
	require.True(t, ok)
	assert.Equal(t, "/run/user/1000", dir)

	// 只有空白也算空（SSH 里各种奇怪取值的常见形态）
	dir, ok = xdgRuntimeDirFor("   ", 1000, yes)
	require.True(t, ok)
	assert.Equal(t, "/run/user/1000", dir)

	// 显式给了就照用，哪怕目录这会儿不在（可能是自定义位置）
	dir, ok = xdgRuntimeDirFor("/custom/run", 1000, no)
	require.True(t, ok)
	assert.Equal(t, "/custom/run", dir)

	// 变量空 + 目录不存在 → 不补。这台机器没有用户会话（容器里常见），
	// 瞎凑一个路径只会让报错更难懂。
	_, ok = xdgRuntimeDirFor("", 1000, no)
	assert.False(t, ok)
}

func TestRuntimeDirEnvReplacesInsteadOfAppending(t *testing.T) {
	// 同名变量出现两次时 getenv 取第一个，所以追加是无效的 —— 必须摘掉旧的。
	env := runtimeDirEnv([]string{"PATH=/bin", "XDG_RUNTIME_DIR=/stale", "HOME=/root"}, "", 1000,
		func(string) bool { return true })
	assert.Equal(t, []string{"PATH=/bin", "HOME=/root", "XDG_RUNTIME_DIR=/run/user/1000"}, env)

	// 拿不到会话时不要留一个假的 XDG_RUNTIME_DIR
	env = runtimeDirEnv([]string{"PATH=/bin", "XDG_RUNTIME_DIR=/stale"}, "", 1000,
		func(string) bool { return false })
	assert.Equal(t, []string{"PATH=/bin"}, env)
}

func TestSystemctlFailureExplainsMissingUserSession(t *testing.T) {
	// 「连不上 bus」必须给两条可执行的路，而不是泛化成 internal 错误 ——
	// 上一个版本就是在这里把人带去查模型、查密钥的。
	bus := "Failed to connect to bus: No medium found"
	failure := systemctlFailure([]string{"--user", "daemon-reload"}, bus, errors.New("exit status 1"))
	require.NotNil(t, failure)
	assert.Equal(t, errs.CategoryConfig, failure.Category)
	assert.Equal(t, errs.SubtypeSessionUnavailable, failure.Subtype)
	assert.Contains(t, failure.Error(), "bus", "上游原话要带出来")
	assert.Contains(t, failure.Hint, "enable-linger")
	assert.Contains(t, failure.Hint, "前台跑")

	// 其他失败原样带出，不掩盖真因
	other := systemctlFailure([]string{"--user", "enable", "--now", "x.service"}, "Unit x.service not found.", errors.New("exit status 1"))
	assert.Equal(t, errs.CategoryInternal, other.Category)
	assert.Contains(t, other.Error(), "Unit x.service not found.")
}

func TestIsSessionUnavailable(t *testing.T) {
	for _, text := range []string{
		"Failed to connect to bus: No medium found",
		"failed to connect to bus",
		"no medium found",
		"Failed to connect to system scope bus via local transport: Connection refused",
	} {
		assert.True(t, isSessionUnavailable(text), text)
	}
	for _, text := range []string{"Unit not found.", "Access denied", ""} {
		assert.False(t, isSessionUnavailable(text), text)
	}
}

func TestInstallOnLinuxCleansUpLegacyUnitFromBeforeRename(t *testing.T) {
	// 改名后旧 unit 如果还在，会和新的抢同一个端口 —— 装新的之前先清旧的。
	fake, _, _ := setup(t)
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	legacyFile := filepath.Join(configHome, "systemd", "user", LegacyServiceLabel+".service")
	require.NoError(t, os.MkdirAll(filepath.Dir(legacyFile), 0o700))
	require.NoError(t, os.WriteFile(legacyFile, []byte("[Unit]\n"), 0o600))

	result, err := Install(Options{Port: 8788, Command: []string{"/opt/flow-one"}})
	require.NoError(t, err)

	assert.NoFileExists(t, legacyFile, "改名前的旧 unit 要被清掉")
	assert.Contains(t, strings.Join(result.Notes, " "), "改名前的旧服务")
	// 旧 unit 必须先 disable --now，后面才轮到 daemon-reload
	require.NotEmpty(t, fake.calls)
	assert.Contains(t, strings.Join(fake.calls[0], " "), LegacyServiceLabel)
	assert.Contains(t, strings.Join(fake.calls[0], " "), "disable")
}

func TestInstallOnLinuxWithoutLegacyUnitStaysQuiet(t *testing.T) {
	fake, _, _ := setup(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	result, err := Install(Options{Port: 8788, Command: []string{"/opt/flow-one"}})
	require.NoError(t, err)
	assert.NotContains(t, strings.Join(result.Notes, " "), "旧服务")
	for _, call := range fake.calls {
		assert.NotContains(t, strings.Join(call, " "), LegacyServiceLabel)
	}
}
