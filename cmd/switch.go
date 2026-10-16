// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"

	"github.com/9Ashwin/flow-one/internal/claude"
	"github.com/9Ashwin/flow-one/internal/service"
	"github.com/9Ashwin/flow-one/internal/ui"
	"github.com/spf13/cobra"
)

var switchCmd = &cobra.Command{
	Use:   "switch",
	Short: "换模型（改配置，必要时重启服务）",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		registry, err := buildRegistry(cfg, logf)
		if err != nil {
			return err
		}
		models, failures := registry.ListModels(cmd.Context())
		for _, failure := range failures {
			ui.Warn(failure.Error())
		}
		if len(models) == 0 {
			return sourceErrNoModels()
		}
		picked, err := pickModel(models)
		if err != nil {
			return err
		}

		port := configuredPort()
		if port == 0 {
			port = cfg.Port
		}
		apiKey := existingAPIKey()
		if _, err := claude.Install(claude.InstallOptions{
			BaseURL:       fmt.Sprintf("http://127.0.0.1:%d", port),
			APIKey:        apiKey,
			Model:         picked.ID,
			ContextWindow: picked.ContextWindow,
		}); err != nil {
			return err
		}
		ui.Success("配置已更新：" + picked.ID)

		// 服务是不带参数启动的，模型走环境变量 —— 换了模型必须重装服务才生效
		if state, err := service.Inspect(); err == nil && state.Installed {
			result, err := service.Install(service.Options{
				Port: port, APIKey: apiKey,
				Env:     map[string]string{"BRIDGE_MODE": "direct", "BRIDGE_MODEL": picked.ID},
				Command: []string{service.CurrentCLIPath(), "serve"},
			})
			if err != nil {
				ui.Warn("服务没重装成功：" + err.Error())
				ui.Note("  " + ui.Gray("手动重启："+service.RestartHint()))
				return nil
			}
			ui.Success(fmt.Sprintf("后台服务已重启（%s）", result.Kind))
		} else {
			ui.Note(ui.Dim("  没有后台服务在跑：前台运行时用 --model " + picked.ID))
		}
		return nil
	},
}

func init() { rootCmd.AddCommand(switchCmd) }
