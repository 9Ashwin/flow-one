// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/build"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/tencent"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/ui"
	"github.com/spf13/cobra"
)

// runMenu 是交互式主菜单：打印编号清单 + 输入编号。
//
// 形态与 Node 版一致（用户已经习惯编号直选，不是方向键列表）；
// 每一项都回到菜单，所以「配完一家再配一家」是自然动作。
func runMenu(cmd *cobra.Command, cfg config.Config) error {
	ui.Banner("Claude Code ← WorkBuddy / OpenCode 本地反代", build.String())
	ui.Note("  " + ui.Gray(fmt.Sprintf("数据目录 %s", cfg.Home)))
	ui.Note("  " + ui.Gray(fmt.Sprintf("已挂来源 %s", describeConfiguredSources(cfg))))
	for {
		key, err := ui.Menu("请选择要做什么：", []ui.MenuGroup{
			{Items: []ui.MenuItem{
				{Key: "1", Label: "一键配置", Hint: "接哪一家 → 选模型 → 写 Claude Code 配置 → 后台常驻"},
				{Key: "2", Label: "切换模型", Hint: "改完自动重启服务"},
				{Key: "3", Label: "查看状态", Hint: "登录有效期 / 服务 / 文件位置"},
				{Key: "4", Label: "起服务", Hint: "前台运行，Claude Code 连它"},
			}},
			{Title: "维护", Items: []ui.MenuItem{
				{Key: "5", Label: "重新登录（换账号）", Hint: "腾讯走浏览器授权，Go 套餐填 key"},
				{Key: "6", Label: "自检", Hint: "配置 / 登录 / 两条门禁，会真发请求"},
				{Key: "7", Label: "列出模型", Hint: "带来源前缀，看清哪些是免费档"},
				{Key: "0", Label: "还原配置", Hint: "移除本工具写入的键并卸载后台服务"},
				{Key: "Q", Label: "退出"},
			}},
		})
		if err != nil {
			return err
		}
		switch key {
		case "1":
			err = setupCmd.RunE(setupCmd, nil)
		case "2":
			err = switchCmd.RunE(switchCmd, nil)
		case "3":
			err = statusCmd.RunE(statusCmd, nil)
		case "4":
			return runServe(cmd.Context(), cfg)
		case "5":
			err = loginCmd.RunE(loginCmd, nil)
		case "6":
			err = doctorCmd.RunE(doctorCmd, nil)
		case "7":
			err = modelsCmd.RunE(modelsCmd, nil)
		case "0":
			err = uninstallCmd.RunE(uninstallCmd, nil)
		case "Q":
			return nil
		}
		if err != nil {
			// 菜单里的一项失败不该把整个会话带走：报出来，让用户继续选
			ui.Fail(err.Error())
			if typed, ok := errs.As(err); ok && typed.Hint != "" {
				ui.Note("  " + ui.Gray("→ "+typed.Hint))
			}
		}
		ui.Blank()
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
	labels := []string{}
	for _, name := range cfg.Products {
		if product, ok := tencent.ProductByName(name); ok {
			labels = append(labels, product.Label)
			continue
		}
		switch name {
		case "oc":
			labels = append(labels, "OpenCode 免费模型")
		case "ocg":
			labels = append(labels, "OpenCode Go 套餐")
		default:
			labels = append(labels, name)
		}
	}
	return strings.Join(labels, " · ")
}
