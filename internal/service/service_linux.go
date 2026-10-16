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

// lingerState 报告当前用户有没有开 lingering。做成可替换的变量是为了让平台用例离线跑，
// 不去问本机的 logind。
var lingerState = queryLinger

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
	notes := []string{"systemctl --user enable --now 已完成"}
	if hint := lingerHint(); hint != "" {
		notes = append(notes, hint)
	}
	return notes, nil
}

// lingerHint 在**没开 lingering** 时给一句补救。
//
// systemd 的用户级 unit 默认跟着会话走：用户一注销，服务就停 —— 用户会以为「装了开机自启」
// 却在下次登录前发现服务没跑。只有确实问到「没开」才提示（问不出来就什么都不说，不猜）。
func lingerHint() string {
	user := currentUser()
	if user == "" {
		return ""
	}
	enabled, known := lingerState()
	if !known || enabled {
		return ""
	}
	return "注销后仍要运行（只需一次）：loginctl enable-linger " + user
}

// currentUser 取当前用户名，只用于生成上面那句命令。
func currentUser() string {
	for _, name := range []string{"USER", "LOGNAME"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

// queryLinger 问 logind：`loginctl show-user <user> --property=Linger --value` → yes/no。
// 命令不在、用户查不到、输出不认识都算「不知道」。
func queryLinger() (enabled bool, known bool) {
	user := currentUser()
	if user == "" {
		return false, false
	}
	output, err := exec.Command("loginctl", "show-user", user, "--property=Linger", "--value").Output()
	if err != nil {
		return false, false
	}
	switch strings.TrimSpace(string(output)) {
	case "yes":
		return true, true
	case "no":
		return false, true
	default:
		return false, false
	}
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
