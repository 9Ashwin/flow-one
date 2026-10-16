// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"fmt"
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

// ── 用户会话环境（XDG_RUNTIME_DIR）──────────────────────────────────────────
//
// 2026-10-16 在无头 ubuntu 上真踩过：SSH 或非登录壳里 `XDG_RUNTIME_DIR` 常常是空的，
// 于是 `systemctl --user` 一律报 `Failed to connect to bus: No medium found`。
// 表现极具误导性 —— 向导说「配置已写入」，单元文件却从没落地，8788 上没人听，
// 回到 Claude Code 只看到 ECONNREFUSED，人就去查模型、查密钥了。
// dbus 其实一直在 `/run/user/<uid>/bus`，只是没人把这个路径指出来。

// xdgRuntimeDirFor 算出 `systemctl --user` 该用的 XDG_RUNTIME_DIR。纯函数。
//
// 显式给了值就照用（可能是自定义位置）；空则补 `/run/user/<uid>`，但**目录不存在就
// 不补** —— 那说明这台机器根本没有用户会话（容器里很常见），瞎凑一个路径只会让
// 报错更难懂。
func xdgRuntimeDirFor(current string, uid int, dirExists func(string) bool) (string, bool) {
	if value := strings.TrimSpace(current); value != "" {
		return value, true
	}
	fallback := fmt.Sprintf("/run/user/%d", uid)
	if !dirExists(fallback) {
		return "", false
	}
	return fallback, true
}

// runtimeDirEnv 在环境表里**替换** XDG_RUNTIME_DIR，而不是追加。
//
// 同名变量出现两次时 getenv 取第一个，所以追加是无效的 —— 必须先把旧条目摘掉。
func runtimeDirEnv(env []string, current string, uid int, dirExists func(string) bool) []string {
	dir, ok := xdgRuntimeDirFor(current, uid, dirExists)
	filtered := make([]string, 0, len(env)+1)
	for _, item := range env {
		if strings.HasPrefix(item, "XDG_RUNTIME_DIR=") {
			continue
		}
		filtered = append(filtered, item)
	}
	if ok {
		filtered = append(filtered, "XDG_RUNTIME_DIR="+dir)
	}
	return filtered
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// isSessionUnavailable 认「连不上用户 bus」这一类说法。
func isSessionUnavailable(message string) bool {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "failed to connect to bus"):
		return true
	case strings.Contains(lower, "no medium found"):
		return true
	case strings.Contains(lower, "failed to connect to system scope bus"):
		return true
	case strings.Contains(lower, "connection refused") && strings.Contains(lower, "bus"):
		return true
	default:
		return false
	}
}

// systemctlFailure 把 systemctl 的失败翻成类型化错误。
//
// 重点是把「连不上 bus」单独挑出来：它不是 systemd 坏了，而是当前这个壳里没有用户
// 会话。这类错误必须给出**两条可执行的路**，否则人会被带到查模型、查密钥上去。
func systemctlFailure(args []string, output string, cause error) *errs.Error {
	message := strings.TrimSpace(output)
	if message == "" && cause != nil {
		message = cause.Error()
	}
	detail := "systemctl " + strings.Join(args, " ") + " 失败：" + message
	if isSessionUnavailable(message) {
		return errs.Config(errs.SubtypeSessionUnavailable, detail).
			WithCause(cause).
			WithHint("当前这个壳里没有用户会话（SSH / 非登录壳常见）。两条路：loginctl enable-linger $USER 之后重进登录壳再装，或者直接前台跑 claude-code-bridge")
	}
	return errs.Internal(errs.SubtypeUnexpected, detail).WithCause(cause)
}

// runSystemctl 跑一次 systemctl，失败时把它的输出带回来。
func runSystemctl(args ...string) error {
	command := exec.Command("systemctl", args...)
	// 补上 XDG_RUNTIME_DIR：SSH / 非登录壳里它是空的，systemctl --user 会连不上 bus
	command.Env = runtimeDirEnv(os.Environ(), os.Getenv("XDG_RUNTIME_DIR"), os.Getuid(), dirExists)
	output, err := command.CombinedOutput()
	if err != nil {
		return systemctlFailure(args, string(output), err)
	}
	return nil
}
