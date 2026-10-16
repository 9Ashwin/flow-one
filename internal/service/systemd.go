// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"regexp"
	"strings"
)

// SystemdUnit 渲染 systemd user unit 的文本。
//
// 纯函数（不碰文件系统、也不调 systemctl），所以两个平台上都能断言它。
// Restart=always + RestartSec=3 是常驻的关键：反代崩了要能自己起来。
func SystemdUnit(opts Options) (string, error) {
	command, err := commandOf(opts)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	out.WriteString("[Unit]\n")
	out.WriteString("Description=claude-code-openai-bridge（Claude Code 的 WorkBuddy 反代）\n")
	out.WriteString("After=network-online.target\n\n")
	out.WriteString("[Service]\n")
	out.WriteString("ExecStart=" + systemdCommand(command) + "\n")
	for _, pair := range serviceEnv(opts) {
		out.WriteString("Environment=" + pair.Key + "=" + systemdQuote(pair.Value) + "\n")
	}
	out.WriteString("Restart=always\n")
	out.WriteString("RestartSec=3\n\n")
	out.WriteString("[Install]\n")
	out.WriteString("WantedBy=default.target\n")
	return out.String(), nil
}

// systemdCommand 把命令行拼成 ExecStart 的形式。
func systemdCommand(command []string) string {
	quoted := make([]string, 0, len(command))
	for _, argument := range command {
		quoted = append(quoted, systemdQuote(argument))
	}
	return strings.Join(quoted, " ")
}

// systemdQuote 给含空白或引号的参数加引号。
//
// systemd 按空白切分 ExecStart 与 Environment，所以路径里带空格时（macOS 的家目录很常见，
// 容器与 CI 里也有）不加引号会被当成两个参数，服务直接起不来。
func systemdQuote(value string) string {
	if !strings.ContainsAny(value, " \t\"'\\") {
		return value
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

var execStartPattern = regexp.MustCompile(`(?m)^ExecStart=(.+)$`)

// parseSystemdExecStart 从 unit 文本里取出 ExecStart 的第一个参数（服务的可执行文件）。
func parseSystemdExecStart(text string) string {
	match := execStartPattern.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return firstSystemdArgument(strings.TrimSpace(match[1]))
}

// firstSystemdArgument 取第一个参数：去掉 systemd 允许的前缀标记（`-`/`+`/`!`/`@`），
// 含引号时按引号取。
func firstSystemdArgument(value string) string {
	value = strings.TrimLeft(value, "-+!@")
	if rest, quoted := strings.CutPrefix(value, `"`); quoted {
		if end := strings.Index(rest, `"`); end >= 0 {
			return rest[:end]
		}
		return rest
	}
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
