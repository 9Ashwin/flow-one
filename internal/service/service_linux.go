// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// systemctl 是包级变量：平台测试里换成假的，免得真去动本机的 systemd
// （公共用例不得调用 systemctl）。
var systemctl = runSystemctl

func platformKind() Kind { return KindSystemd }

// platformServicePath 是 systemd user unit 的位置：`~/.config/systemd/user/<label>.service`，
// `XDG_CONFIG_HOME` 设了就按它来。
func platformServicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errs.InternalFrom(err).WithHint("设置 HOME 或 XDG_CONFIG_HOME")
	}
	base := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "systemd", "user", ServiceLabel+".service"), nil
}

func renderServiceFile(opts Options) (string, error) { return SystemdUnit(opts) }

// loadService 让 systemd 重新加载 unit：先 daemon-reload（否则它还用着旧文件），
// 再 enable --now（开机自启 + 立刻起来）。
func loadService(string) ([]string, error) {
	if err := systemctl("--user", "daemon-reload"); err != nil {
		return nil, err
	}
	if err := systemctl("--user", "enable", "--now", ServiceLabel+".service"); err != nil {
		return nil, err
	}
	return []string{"systemctl --user enable --now 已完成"}, nil
}

// unloadService 停掉并取消开机自启。没在跑就算了（卸载的语义是「最终不在」）。
func unloadService(string) error {
	_ = systemctl("--user", "disable", "--now", ServiceLabel+".service")
	return nil
}

// LogHint 是给人看的日志位置：Linux 下走 journalctl，没有日志文件。
func LogHint() string {
	return "journalctl --user -u " + ServiceLabel
}

// RestartHint 是手动重启服务的命令。
func RestartHint() string {
	return "systemctl --user restart " + ServiceLabel + ".service"
}

// runSystemctl 跑一次 systemctl，失败时把它的输出带回来。
func runSystemctl(args ...string) error {
	output, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return errs.Internal(errs.SubtypeUnexpected, "systemctl "+strings.Join(args, " ")+" 失败："+message)
	}
	return nil
}
