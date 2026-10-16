// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/9Ashwin/flow-one/internal/auth"
	"github.com/9Ashwin/flow-one/internal/claude"
	"github.com/9Ashwin/flow-one/internal/config"
	"github.com/9Ashwin/flow-one/internal/opencode"
	"github.com/9Ashwin/flow-one/internal/service"
	"github.com/9Ashwin/flow-one/internal/tencent"
	"github.com/spf13/cobra"
)

// statusReport 是 `status --as-json` 的线上形状。
type statusReport struct {
	Home       string         `json:"home"`
	Settings   string         `json:"settings"`
	Model      string         `json:"model"`
	BaseURL    string         `json:"baseURL"`
	Sources    []sourceStatus `json:"sources"`
	Service    serviceReport  `json:"service"`
	Credential string         `json:"credentialFile"`
}

type sourceStatus struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	LoggedIn  bool   `json:"loggedIn"`
	Detail    string `json:"detail"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
}

type serviceReport struct {
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	Installed bool   `json:"installed"`
	// LegacyInstalled：改名前的旧服务还在（新文件不存在但旧的在跑）
	LegacyInstalled bool   `json:"legacyInstalled,omitempty"`
	CLIPath         string `json:"cliPath,omitempty"`
	Stale           bool   `json:"stale,omitempty"`
	LogHint         string `json:"logHint,omitempty"`
}

var statusJSON bool

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "查看登录状态、服务与配置文件位置",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		report := collectStatus(cfg)
		if statusJSON {
			payload, err := json.MarshalIndent(report, "", "  ")
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), string(payload))
			return nil
		}
		fmt.Fprintf(cmd.OutOrStdout(), "数据目录  %s\n", report.Home)
		if config.LegacyHomeInUse() {
			// 改名前后目录都还能用，只是名字没跟上；登录态在旧目录里，别让用户以为丢了
			fmt.Fprintln(os.Stderr, "! 数据目录还是改名前的 ~/.claude-code-openai-bridge（登录态就在里面，照常用）")
			fmt.Fprintln(os.Stderr, "  → 想搬到新名字：mv ~/.claude-code-openai-bridge ~/.flow-one")
		}
		fmt.Fprintf(cmd.OutOrStdout(), "配置文件  %s\n", report.Settings)
		if report.Model != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "模型      %s\n", report.Model)
		}
		if report.BaseURL != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "反代地址  %s\n", report.BaseURL)
		}
		for _, item := range report.Sources {
			mark := "○"
			if item.LoggedIn {
				mark = "✔"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s %-6s %s\n", mark, item.ID, item.Detail)
		}
		if report.Service.Installed {
			fmt.Fprintf(cmd.OutOrStdout(), "服务      %s（%s）\n", report.Service.Path, report.Service.Kind)
			if report.Service.Stale {
				fmt.Fprintf(os.Stderr, "! 服务跑的不是当前这份代码：%s\n", report.Service.CLIPath)
				fmt.Fprintln(os.Stderr, "  → 用当前这份代码重跑一次「一键配置」即可对齐（全局安装是一份快照）")
			}
		} else if report.Service.LegacyInstalled {
			fmt.Fprintln(cmd.OutOrStdout(), "服务      未安装（但改名前的旧服务还在）")
			fmt.Fprintln(os.Stderr, "! 改名前的旧服务 "+service.LegacyServiceLabel+" 仍然装着，占着端口")
			fmt.Fprintln(os.Stderr, "  → 跑一次「一键配置」会装成新名字并顺手清掉旧服务；只想清旧的：fo uninstall")
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "服务      未安装")
		}
		return nil
	},
}

// collectStatus 采集状态。**不发网络请求**：status 要能离线跑。
func collectStatus(cfg config.Config) statusReport {
	report := statusReport{Home: cfg.Home, Credential: cfg.CredentialFile}
	if path, err := claude.SettingsPath(); err == nil {
		report.Settings = path
		if raw, err := os.ReadFile(path); err == nil {
			var settings struct {
				Env   map[string]string `json:"env"`
				Model string            `json:"model"`
			}
			if json.Unmarshal(raw, &settings) == nil {
				report.BaseURL = settings.Env["ANTHROPIC_BASE_URL"]
				report.Model = settings.Env["ANTHROPIC_MODEL"]
				if report.Model == "" {
					report.Model = settings.Model
				}
			}
		}
	}
	client := auth.NewClient()
	client.File = cfg.CredentialFile
	for _, id := range []string{"cn", "intl"} {
		product, ok := tencent.ProductByName(id)
		if !ok {
			continue
		}
		status := client.Status(product)
		detail := product.Label + " 未登录"
		if status.LoggedIn {
			detail = product.Label
			if status.Nickname != "" {
				detail += " " + status.Nickname
			}
			if status.ExpiresAt > 0 {
				detail += fmt.Sprintf(" · %s 到期", timeOf(status.ExpiresAt))
			}
		}
		report.Sources = append(report.Sources, sourceStatus{
			ID: id, Label: product.Label, LoggedIn: status.LoggedIn,
			Detail: detail, ExpiresAt: status.ExpiresAt,
		})
	}
	report.Sources = append(report.Sources, sourceStatus{
		ID: "oc", Label: "OpenCode 免费模型", LoggedIn: true, Detail: "OpenCode 免费模型 无需登录",
	})
	if opencode.HasGoKey() {
		report.Sources = append(report.Sources, sourceStatus{
			ID: "ocg", Label: "OpenCode Go 套餐", LoggedIn: true,
			Detail: "OpenCode Go 套餐 已配 key（末四位 " + opencode.GoKeyTail() + "）",
		})
	} else {
		report.Sources = append(report.Sources, sourceStatus{
			ID: "ocg", Label: "OpenCode Go 套餐", LoggedIn: false, Detail: "OpenCode Go 套餐 未配 key",
		})
	}

	state, err := service.Inspect()
	if err == nil {
		report.Service = serviceReport{
			Kind: string(state.Kind), Path: state.Path, Installed: state.Installed,
			LegacyInstalled: state.LegacyInstalled, LogHint: service.LogHint(),
		}
		if state.Installed {
			// 「服务跑的是哪份代码」是真踩过的坑：全局安装是一份快照，
			// git pull 与改仓库都不会更新它，而界面上完全看不出来。
			if running := service.CLIPath(); running != "" {
				report.Service.CLIPath = running
				report.Service.Stale = running != service.CurrentCLIPath()
			}
		}
	}
	return report
}

// timeOf 把毫秒时间戳渲染成日期：状态行里人只关心哪天到期。
func timeOf(milliseconds int64) string {
	return time.UnixMilli(milliseconds).Format("2006/1/2")
}

func init() {
	statusCmd.Flags().BoolVar(&statusJSON, "as-json", false, "以 JSON 输出")
	rootCmd.AddCommand(statusCmd)
}
