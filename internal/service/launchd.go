// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package service

import (
	"path/filepath"
	"regexp"
	"strings"
)

// LaunchAgentPlist 渲染 launchd 的 plist 文本。
//
// 纯函数（不碰文件系统、也不调 launchctl），所以 macOS 与 Linux 上都能断言它。
// plist 里必须写全环境变量：服务是不带参数启动的，少了 BRIDGE_PORT / BRIDGE_MODEL
// 这些就会退回默认配置，与用户刚选的配置不一致。
func LaunchAgentPlist(opts Options) (string, error) {
	command, err := commandOf(opts)
	if err != nil {
		return "", err
	}
	logDir, err := logDirOf(opts)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	out.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	out.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	out.WriteString("<plist version=\"1.0\">\n<dict>\n")
	out.WriteString("  <key>Label</key>\n  <string>" + ServiceLabel + "</string>\n")
	out.WriteString("  <key>ProgramArguments</key>\n  <array>\n")
	for _, argument := range command {
		out.WriteString("    <string>" + xmlEscape(argument) + "</string>\n")
	}
	out.WriteString("  </array>\n")
	out.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
	for _, pair := range serviceEnv(opts) {
		out.WriteString("    <key>" + xmlEscape(pair.Key) + "</key>\n")
		out.WriteString("    <string>" + xmlEscape(pair.Value) + "</string>\n")
	}
	out.WriteString("  </dict>\n")
	out.WriteString("  <key>RunAtLoad</key>\n  <true/>\n")
	out.WriteString("  <key>KeepAlive</key>\n  <true/>\n")
	out.WriteString("  <key>StandardOutPath</key>\n  <string>" + xmlEscape(filepath.Join(logDir, "bridge.log")) + "</string>\n")
	out.WriteString("  <key>StandardErrorPath</key>\n  <string>" + xmlEscape(filepath.Join(logDir, "bridge.err.log")) + "</string>\n")
	out.WriteString("</dict>\n</plist>\n")
	return out.String(), nil
}

// xmlEscape 转义 plist 里有特殊含义的三个字符（与 Node 版一致：不动引号）。
func xmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(value)
}

var (
	programArgumentsPattern = regexp.MustCompile(`(?s)<key>\s*ProgramArguments\s*</key>\s*<array>(.*?)</array>`)
	plistStringPattern      = regexp.MustCompile(`(?s)<string>(.*?)</string>`)
)

// parseLaunchdCommand 从 plist 文本里取出 ProgramArguments。
func parseLaunchdCommand(text string) []string {
	block := programArgumentsPattern.FindStringSubmatch(text)
	if block == nil {
		return nil
	}
	matches := plistStringPattern.FindAllStringSubmatch(block[1], -1)
	command := make([]string, 0, len(matches))
	for _, match := range matches {
		command = append(command, match[1])
	}
	return command
}
