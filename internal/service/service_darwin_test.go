// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

//go:build darwin

package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeLaunchd 把 launchctl / launchctl print / sleep 全换成假的：平台断言必须能
// 离线跑，绝不真去动本机的 launchd。
type fakeLaunchd struct {
	calls             [][]string
	sleeps            []time.Duration
	loaded            []bool // 依次回答「label 是否已加载」，用完就一直是 false
	at                int
	bootstraps        int
	bootstrapFailures int
}

func (f *fakeLaunchd) run(args ...string) error {
	f.calls = append(f.calls, args)
	if len(args) > 0 && args[0] == "bootstrap" {
		f.bootstraps++
		if f.bootstraps <= f.bootstrapFailures {
			return errs.Internal(errs.SubtypeUnexpected, "Bootstrap failed: 5: Input/output error")
		}
	}
	return nil
}

func (f *fakeLaunchd) isLoaded(string) bool {
	if f.at >= len(f.loaded) {
		return false
	}
	value := f.loaded[f.at]
	f.at++
	return value
}

func (f *fakeLaunchd) rest(duration time.Duration) { f.sleeps = append(f.sleeps, duration) }

// setup 把 HOME 与 BRIDGE_HOME 都指到临时目录：服务文件写到假家目录下，
// 不碰真实 ~/Library/LaunchAgents。
func setup(t *testing.T) (*fakeLaunchd, string, string) {
	t.Helper()
	home := t.TempDir()
	bridgeHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BRIDGE_HOME", bridgeHome)
	fake := &fakeLaunchd{}
	launchctl, launchdLoaded, sleep = fake.run, fake.isLoaded, fake.rest
	t.Cleanup(func() { launchctl, launchdLoaded, sleep = runLaunchctl, loadedInLaunchd, time.Sleep })
	return fake, home, bridgeHome
}

func serviceFile(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", ServiceLabel+".plist")
}

func domain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func TestInstallOnDarwinWaitsForBootoutBeforeBootstrap(t *testing.T) {
	fake, home, bridgeHome := setup(t)
	// bootout 是异步的：头几次查询它还在，最后一次才消失
	fake.loaded = []bool{true, true, true, true, false}

	result, err := Install(Options{
		Port:    8788,
		APIKey:  "k",
		Env:     map[string]string{"BRIDGE_MODEL": "oc/x"},
		Command: []string{"/opt/ccb/bridge"},
	})
	require.NoError(t, err)

	file := serviceFile(home)
	assert.Equal(t, file, result.Path)
	assert.Equal(t, KindLaunchd, result.Kind)
	assert.Equal(t, []string{"launchctl bootstrap 已加载"}, result.Notes)

	content, err := os.ReadFile(file)
	require.NoError(t, err)
	assert.Contains(t, string(content), "<string>/opt/ccb/bridge</string>")
	assert.Contains(t, string(content), filepath.Join(bridgeHome, "bridge.err.log"))
	assert.Contains(t, string(content), "<key>KeepAlive</key>")
	info, err := os.Stat(file)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	// 顺序必须是「先 bootout 并等到卸载，再 bootstrap」——反了就是
	// Bootstrap failed: 5: Input/output error
	assert.Equal(t, [][]string{
		{"bootout", domain() + "/" + ServiceLabel},
		{"bootstrap", domain(), file},
	}, fake.calls)
	assert.Equal(t, []time.Duration{
		250 * time.Millisecond, 250 * time.Millisecond, 250 * time.Millisecond,
	}, fake.sleeps, "要轮询到 label 真的卸载")

	// 账本：记住装了哪一份代码、服务环境是什么，供 status / doctor 对比
	record, recorded := Record()
	require.True(t, recorded)
	assert.Equal(t, KindLaunchd, record.Kind)
	assert.Equal(t, file, record.Path)
	assert.Equal(t, 8788, record.Port)
	assert.Equal(t, "/opt/ccb/bridge", record.CLIPath)
	assert.Equal(t, "8788", record.Env["BRIDGE_PORT"])
	assert.Equal(t, "k", record.Env["BRIDGE_API_KEY"], "doctor 要靠它对出「密钥与服务不一致」")
	assert.Equal(t, "oc/x", record.Env["BRIDGE_MODEL"])

	state, err := Inspect()
	require.NoError(t, err)
	assert.True(t, state.Installed)
	assert.True(t, state.Supported)
	assert.Equal(t, KindLaunchd, state.Kind)
	assert.Equal(t, file, state.Path)
	assert.Equal(t, "/opt/ccb/bridge", CLIPath(), "服务文件里的 CLI 路径要读得出来")
}

func TestInstallOnDarwinBootstrapsWhenNotLoaded(t *testing.T) {
	fake, _, _ := setup(t)
	fake.loaded = []bool{false}

	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	require.Len(t, fake.calls, 1)
	assert.Equal(t, "bootstrap", fake.calls[0][0], "没加载过就直接 bootstrap，不必先 bootout")
	assert.Empty(t, fake.sleeps)
}

func TestInstallOnDarwinRetriesBootstrap(t *testing.T) {
	fake, _, _ := setup(t)
	fake.loaded = []bool{false}
	fake.bootstrapFailures = 2

	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err, "bootstrap 头两次失败要重试，别直接放弃")
	assert.Equal(t, 3, fake.bootstraps)
	assert.Equal(t, []time.Duration{400 * time.Millisecond, 400 * time.Millisecond}, fake.sleeps)
}

func TestInstallOnDarwinGivesUpAfterFiveBootstraps(t *testing.T) {
	fake, home, _ := setup(t)
	fake.loaded = []bool{false}
	fake.bootstrapFailures = launchdBootstrapAttempts

	_, err := Install(Options{Port: 8788, APIKey: "secret", Command: []string{"/opt/ccb/bridge"}})
	require.Error(t, err)
	assert.Equal(t, launchdBootstrapAttempts, fake.bootstraps)

	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Contains(t, typed.Message, "服务文件已写入 "+serviceFile(home), "失败也要说清文件已经写好了")
	assert.Contains(t, typed.Hint, "先手动跑起来：")
	assert.Contains(t, typed.Hint, "BRIDGE_PORT=8788")
	assert.NotContains(t, typed.Hint, "secret", "补救提示里不能把令牌打出来")
	assert.FileExists(t, serviceFile(home))
}

func TestUninstallOnDarwinBootsOutAndForgets(t *testing.T) {
	fake, home, _ := setup(t)
	fake.loaded = []bool{false}
	_, err := Install(Options{Port: 8788, Command: []string{"/opt/ccb/bridge"}})
	require.NoError(t, err)
	require.NoError(t, RecordChoice(true))

	fake.calls = nil
	result, err := Uninstall()
	require.NoError(t, err)
	assert.False(t, result.Skipped)
	assert.Equal(t, KindLaunchd, result.Kind)
	assert.Equal(t, [][]string{{"bootout", domain() + "/" + ServiceLabel}}, fake.calls)
	assert.NoFileExists(t, serviceFile(home))

	// 卸载之后账本与「那一问」都要清掉：下次配置该重新问一遍
	_, recorded := Record()
	assert.False(t, recorded)
	_, asked := LastChoice()
	assert.False(t, asked)
	state, err := Inspect()
	require.NoError(t, err)
	assert.False(t, state.Installed)
}

func TestUninstallOnDarwinWithoutServiceSkips(t *testing.T) {
	fake, _, _ := setup(t)
	result, err := Uninstall()
	require.NoError(t, err)
	assert.True(t, result.Skipped)
	assert.Contains(t, result.Reason, "没有装过后台服务")
	assert.Empty(t, fake.calls, "没装过就不该去动 launchd")
}

func TestHintsOnDarwin(t *testing.T) {
	_, _, bridgeHome := setup(t)
	assert.Equal(t, filepath.Join(bridgeHome, "bridge.err.log"), LogHint())
	assert.True(t, strings.HasPrefix(RestartHint(), "launchctl kickstart -k gui/"))
	assert.Contains(t, RestartHint(), ServiceLabel)
}

func TestInstallCleansUpLegacyServiceFromBeforeRename(t *testing.T) {
	// 改名后如果不管旧服务，会出现「旧服务还在跑、新服务又装一个」——
	// 两个进程抢同一个端口，界面上完全看不出来。
	fake, home, _ := setup(t)
	fake.loaded = []bool{false}

	legacyFile := filepath.Join(home, "Library", "LaunchAgents", LegacyServiceLabel+".plist")
	require.NoError(t, os.MkdirAll(filepath.Dir(legacyFile), 0o700))
	require.NoError(t, os.WriteFile(legacyFile, []byte("<plist/>"), 0o600))

	result, err := Install(Options{Port: 8788, Command: []string{"/opt/flow-one"}})
	require.NoError(t, err)

	// 旧服务文件必须没了
	_, statErr := os.Stat(legacyFile)
	assert.True(t, os.IsNotExist(statErr), "改名前的旧服务文件要被清掉")
	// 先从 launchd 退出来，再 bootstrap 新的
	require.GreaterOrEqual(t, len(fake.calls), 2)
	assert.Equal(t, "bootout", fake.calls[0][0])
	assert.Contains(t, strings.Join(fake.calls[0], " "), LegacyServiceLabel)
	// 并且要告诉用户做过这件事
	assert.Contains(t, strings.Join(result.Notes, " "), "改名前的旧服务")
	// 新服务照常装好
	assert.FileExists(t, serviceFile(home))
}

func TestInstallWithoutLegacyServiceStaysQuiet(t *testing.T) {
	// 全新机器上不该多出任何「已清理旧服务」的噪音
	fake, _, _ := setup(t)
	fake.loaded = []bool{false}
	result, err := Install(Options{Port: 8788, Command: []string{"/opt/flow-one"}})
	require.NoError(t, err)
	assert.NotContains(t, strings.Join(result.Notes, " "), "旧服务")
	for _, call := range fake.calls {
		assert.NotContains(t, strings.Join(call, " "), LegacyServiceLabel,
			"没有旧服务就不该为它调 launchctl")
	}
}

func TestUninstallAlsoRemovesLegacyService(t *testing.T) {
	// 卸载就该什么都不剩：改名前的旧服务也要带走
	fake, home, _ := setup(t)
	fake.loaded = []bool{false}
	require.NoError(t, os.MkdirAll(filepath.Dir(serviceFile(home)), 0o700))
	require.NoError(t, os.WriteFile(serviceFile(home), []byte("<plist/>"), 0o600))
	legacyFile := filepath.Join(home, "Library", "LaunchAgents", LegacyServiceLabel+".plist")
	require.NoError(t, os.WriteFile(legacyFile, []byte("<plist/>"), 0o600))

	_, err := Uninstall()
	require.NoError(t, err)
	assert.NoFileExists(t, serviceFile(home))
	assert.NoFileExists(t, legacyFile, "旧服务文件也要被卸载带走")
}

func TestInspectReportsLegacyServiceStillInstalled(t *testing.T) {
	// 这个状态最容易被误读：新名字的服务文件不存在（界面上「未安装」），
	// 可改名前的旧服务其实正在跑、占着端口。必须分开报。
	_, home, _ := setup(t)
	assert.False(t, mustInspect(t).LegacyInstalled, "干净机器上不该报旧服务")

	legacyFile := filepath.Join(home, "Library", "LaunchAgents", LegacyServiceLabel+".plist")
	require.NoError(t, os.MkdirAll(filepath.Dir(legacyFile), 0o700))
	require.NoError(t, os.WriteFile(legacyFile, []byte("<plist/>"), 0o600))

	state := mustInspect(t)
	assert.True(t, state.LegacyInstalled)
	assert.False(t, state.Installed, "新名字的服务确实还没装")
}

func mustInspect(t *testing.T) State {
	t.Helper()
	state, err := Inspect()
	require.NoError(t, err)
	return state
}
