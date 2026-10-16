// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"
	"os"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/build"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/opencode"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/tencent"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/ui"
	"github.com/spf13/cobra"
)

// runMenu 是交互式主菜单：打印编号清单 + 输入编号（不是方向键列表 —— 用户已经习惯这个形态）。
func runMenu(cmd *cobra.Command, cfg config.Config) error {
	ui.Banner("Claude Code ← WorkBuddy / OpenCode 本地反代", build.String())
	ui.Note("  " + ui.Gray(fmt.Sprintf("数据目录 %s", cfg.Home)))
	ui.Note("  " + ui.Gray(fmt.Sprintf("已挂来源 %s", describeConfiguredSources(cfg))))
	for {
		key, err := ui.Menu("请选择要做什么：", []ui.MenuGroup{
			{Items: []ui.MenuItem{
				{Key: "1", Label: "起服务", Hint: "前台运行，Claude Code 连它"},
				{Key: "2", Label: "列出模型", Hint: "带来源前缀，看清哪些是免费档"},
			}},
			{Title: "维护", Items: []ui.MenuItem{
				{Key: "3", Label: "登录 / 换号", Hint: "腾讯两条线走浏览器，Go 套餐填 key"},
				{Key: "Q", Label: "退出"},
			}},
		})
		if err != nil {
			return err
		}
		switch key {
		case "1":
			return runServe(cmd.Context(), cfg)
		case "2":
			return modelsCmd.RunE(modelsCmd, nil)
		case "3":
			return loginCmd.RunE(loginCmd, nil)
		case "Q":
			return nil
		}
	}
}

// describeConfiguredSources 给菜单题头用：一眼看出这次会挂哪几条。
func describeConfiguredSources(cfg config.Config) string {
	if cfg.Mode == config.ModeGateway {
		return "网关模式 → " + cfg.Upstream
	}
	if len(cfg.Products) == 0 {
		return "（按已配置的凭据自动挑：cn / intl / oc，配了 Go key 再加 ocg）"
	}
	names := ""
	for index, name := range cfg.Products {
		if index > 0 {
			names += " · "
		}
		if product, ok := tencent.ProductByName(name); ok {
			names += product.Label
			continue
		}
		names += name
	}
	if opencode.HasGoKey() {
		names += " · OpenCode Go 套餐"
	}
	return names
}

var _ = os.Stdout
