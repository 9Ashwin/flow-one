// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"github.com/9Ashwin/flow-one/internal/claude"
	"github.com/9Ashwin/flow-one/internal/service"
	"github.com/9Ashwin/flow-one/internal/ui"
	"github.com/spf13/cobra"
)

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "还原本工具写过的配置并卸载后台服务",
	Long: `只动自己写过的东西：settings.json 里那些键如果被用户改过就留着，
顶层 model 恢复成安装前的值；服务文件与 install.json 记录一并清掉。`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		result, err := claude.Uninstall()
		if err != nil {
			return err
		}
		if result.Skipped {
			ui.Warn("没什么可还原的：" + result.Reason)
		} else {
			ui.Success("已还原 " + result.File)
			for _, key := range result.Removed {
				ui.Note("  " + ui.Gray("移除 "+key))
			}
			if result.Backup != "" {
				ui.Note("  " + ui.Gray("还原前备份："+result.Backup))
			}
		}
		serviceResult, err := service.Uninstall()
		if err != nil {
			ui.Warn("卸载服务时出错：" + err.Error())
			return nil
		}
		if serviceResult.Skipped {
			ui.Note(ui.Dim("  没有装过后台服务"))
		} else {
			ui.Success("后台服务已卸载（" + string(serviceResult.Kind) + "）")
		}
		return nil
	},
}

func init() { rootCmd.AddCommand(uninstallCmd) }
