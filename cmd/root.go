// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package cmd 只做接线：解析 flag → 调 internal/* → 渲染结果。
// 业务逻辑不放这里（见 AGENTS.md 的「代码落点」）。
package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/build"
	"github.com/spf13/cobra"
)

// jsonOut 决定错误是渲染成给人看的一行，还是 stderr 上的 JSON 信封。
var jsonOut bool

var rootCmd = &cobra.Command{
	Use:   "claude-code-bridge",
	Short: "让 Claude Code CLI 用上 WorkBuddy 与 OpenCode",
	Long: `把 WorkBuddy（国内版 CodeBuddy / 国际版）与 OpenCode（免费档 / Go 套餐）
接进 Claude Code CLI 的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，这几家的接口都是 OpenAI 风格，
本工具负责翻译、登录、续期、模型目录与常驻。`,
	// 失败时不要打印整篇 usage：错误信息 + hint 已经够了
	SilenceUsage:  true,
	SilenceErrors: true,
	Version:       build.String(),
}

// Execute 跑根命令并返回进程退出码。
func Execute() int {
	if err := rootCmd.Execute(); err != nil {
		return fail(err)
	}
	return 0
}

// fail 渲染错误并推导退出码。退出码只由 Category 决定（见 errs.ExitCode），
// 不看消息文本 —— 脚本据此分支才可靠。
func fail(err error) int {
	var typed *errs.Error
	if !errors.As(err, &typed) {
		typed = errs.InternalFrom(err)
	}
	if jsonOut {
		fmt.Fprintln(os.Stderr, string(typed.JSON()))
	} else {
		fmt.Fprintln(os.Stderr, "Error:", typed.Human())
	}
	return errs.ExitCode(typed.Category)
}

func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOut, "json", false, "错误以 JSON 信封输出到 stderr")
}
