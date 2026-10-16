// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
)

// 卸载与加载的重试节奏。bootout 是异步的，等它落地要轮询；bootstrap 也可能因为
// 上一个实例还没退干净而失败，所以要给它留几次重试。
const (
	launchdUnloadAttempts    = 40
	launchdUnloadInterval    = 250 * time.Millisecond
	launchdBootstrapAttempts = 5
	launchdBootstrapInterval = 400 * time.Millisecond
)

// launchctl、launchdLoaded、sleep 都是包级变量：平台测试里换成假的，
// 免得真去动本机的 launchd（公共用例不得调用 launchctl）。
var (
	launchctl     = runLaunchctl
	launchdLoaded = loadedInLaunchd
	sleep         = time.Sleep
)

func platformKind() Kind { return KindLaunchd }

// platformServicePath 是 launchd 的 agent 文件位置。
func platformServicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errs.InternalFrom(err).WithHint("设置 HOME 或改用 Linux 侧的 systemd")
	}
	return filepath.Join(home, "Library", "LaunchAgents", ServiceLabel+".plist"), nil
}

func renderServiceFile(opts Options) (string, error) { return LaunchAgentPlist(opts) }

// launchdDomain 是当前用户的 launchd 域。
func launchdDomain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

// loadService 把服务加载进 launchd。
//
// ⚠️ **重启路径必须等 bootout 落地**：`launchctl bootout` 是异步的，紧接着
// `bootstrap` 同一个 label 会失败成 `Bootstrap failed: 5: Input/output error`
// —— 用户在菜单里第二次点「一键配置」时必然撞上。所以先轮询到它真的卸干净，
// 再 bootstrap，并给 bootstrap 留几次重试。
func loadService(file string) ([]string, error) {
	if launchdLoaded(ServiceLabel) {
		// 已经没了也算成功：我们要的是「最终处于卸载状态」
		_ = launchctl("bootout", launchdDomain()+"/"+ServiceLabel)
		for attempt := 0; attempt < launchdUnloadAttempts && launchdLoaded(ServiceLabel); attempt++ {
			sleep(launchdUnloadInterval)
		}
	}
	var lastErr error
	for attempt := 0; attempt < launchdBootstrapAttempts; attempt++ {
		err := launchctl("bootstrap", launchdDomain(), file)
		if err == nil {
			return []string{"launchctl bootstrap 已加载"}, nil
		}
		lastErr = err
		if attempt < launchdBootstrapAttempts-1 {
			sleep(launchdBootstrapInterval)
		}
	}
	return nil, lastErr
}

// unloadService 把服务从 launchd 卸下来。没在跑就算了（卸载的语义是「最终不在」）。
func unloadService(string) error {
	_ = launchctl("bootout", launchdDomain()+"/"+ServiceLabel)
	return nil
}

// LogHint 是给人看的日志位置：macOS 下是文件。
func LogHint() string {
	if dir, err := config.Home(); err == nil {
		return filepath.Join(dir, "bridge.err.log")
	}
	return "~/.claude-code-openai-bridge/bridge.err.log"
}

// RestartHint 是手动重启服务的命令。
func RestartHint() string {
	return fmt.Sprintf("launchctl kickstart -k %s/%s", launchdDomain(), ServiceLabel)
}

// runLaunchctl 跑一次 launchctl，失败时把它的输出带回来（那才是真正有用的信息）。
func runLaunchctl(args ...string) error {
	output, err := exec.Command("launchctl", args...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return errs.Internal(errs.SubtypeUnexpected, "launchctl "+strings.Join(args, " ")+" 失败："+message)
	}
	return nil
}

// loadedInLaunchd 报告 label 是否已加载（`launchctl print` 成功就是已加载）。
func loadedInLaunchd(label string) bool {
	return exec.Command("launchctl", "print", launchdDomain()+"/"+label).Run() == nil
}
