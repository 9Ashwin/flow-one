// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/spf13/cobra"
)

var modelsCmd = &cobra.Command{
	Use:   "models",
	Short: "列出可用模型（带来源前缀）",
	Long: `列出所有已挂来源的模型。

成功数据走 stdout（脚本可以直接解析）；拿不到清单的来源走 stderr 提示，
但不影响其余来源 —— 一条产品线没登录，不该让另外三条也用不了。`,
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
			fmt.Fprintln(os.Stderr, "! "+failure.Error())
		}
		if asJSON {
			payload, err := json.MarshalIndent(map[string]any{"data": models, "count": len(models)}, "", "  ")
			if err != nil {
				return err
			}
			fmt.Fprintln(os.Stdout, string(payload))
			return nil
		}
		for _, model := range models {
			bits := []string{}
			if model.Free {
				bits = append(bits, "免费")
			}
			if model.ContextWindow > 0 {
				bits = append(bits, fmt.Sprintf("窗口 %s", humanTokens(model.ContextWindow)))
			}
			if model.MaxOutputTokens > 0 {
				bits = append(bits, fmt.Sprintf("输出 %s", humanTokens(model.MaxOutputTokens)))
			}
			suffix := ""
			if len(bits) > 0 {
				suffix = "  " + strings.Join(bits, " · ")
			}
			fmt.Fprintf(os.Stdout, "%s%s\n", model.ID, suffix)
		}
		fmt.Fprintf(os.Stderr, "%d 个模型\n", len(models))
		return nil
	},
}

var asJSON bool

// humanTokens 把 1000000 写成 1M —— 模型清单里可读性比精确更重要。
func humanTokens(value int) string {
	switch {
	case value >= 1_000_000 && value%1_000_000 == 0:
		return fmt.Sprintf("%dM", value/1_000_000)
	case value >= 1000 && value%1000 == 0:
		return fmt.Sprintf("%dk", value/1000)
	default:
		return fmt.Sprint(value)
	}
}

var _ source.Model

func init() {
	modelsCmd.Flags().BoolVar(&asJSON, "as-json", false, "以 JSON 输出（默认人读格式）")
}
