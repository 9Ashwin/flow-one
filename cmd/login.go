// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/auth"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/opencode"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/tencent"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/ui"
	"github.com/spf13/cobra"
)

var loginCmd = &cobra.Command{
	Use:   "login [cn|intl|ocg]",
	Short: "登录（腾讯两条线走浏览器授权；ocg 填 API key）",
	Long: `不带参数时把需要凭据的来源都过一遍：
腾讯两条线走浏览器授权轮询，OpenCode Go 套餐则提示粘贴 API key（不回显）。`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		names := args
		if len(names) == 0 {
			names = []string{"cn", "intl"}
			if opencode.HasGoKey() {
				names = append(names, "ocg")
			}
		}
		for _, name := range names {
			switch name {
			case "cn", "intl", "buddy", "codebuddy", "workbuddy":
				product, ok := tencent.ProductByName(name)
				if !ok {
					return unknownSource(name)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "登录 %s …\n", product.Label)
				client := auth.NewClient()
				client.File = cfg.CredentialFile
				credential, err := client.Login(cmd.Context(), product)
				if err != nil {
					return err
				}
				// 账号信息可能拿不到（账号端点 404 或超时）：Node 版是 `account?.nickname`，
				// 这里同样不能假定非 nil —— 登录本身是成功的，别因此 panic。
				nickname := ""
				if credential.Account != nil {
					nickname = credential.Account.Nickname
				}
				if nickname == "" {
					fmt.Fprintf(cmd.OutOrStdout(), "✔ %s 已登录\n", product.Label)
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "✔ %s 已登录（%s）\n", product.Label, nickname)
				}
			case "ocg", "opencode-go", "go":
				value, err := ui.Password("OpenCode API key")
				if err != nil {
					return err
				}
				if len(value) < 20 {
					return errs.Validation(errs.SubtypeMissingAPIKey, "看起来不像一个 key").
						WithParam("--api-key").
						WithHint("在 opencode.ai 控制台复制 Go 套餐的 API key（oc_sk_…）")
				}
				saved, err := opencode.SaveGoKey(value)
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "✔ 已保存（末四位 %s），会话 id %s…\n", saved.APIKey[len(saved.APIKey)-4:], saved.Session[:8])
			default:
				return unknownSource(name)
			}
		}
		return nil
	},
}
