// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/opencode"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/tencent"
)

// buildRegistry 按配置把来源装起来。
//
// 「要 key 的来源没配 key 就不挂」——挂了也只会每次启动多一条 401 噪声，
// 还容易让人以为服务坏了。
func buildRegistry(cfg config.Config, logf func(string)) (*source.Registry, error) {
	var sources []source.Source
	for _, name := range cfg.Products {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		switch strings.ToLower(trimmed) {
		case "cn", "buddy", "codebuddy", "国内", "国内版",
			"intl", "workbuddy", "workbuddy-ai", "国际", "国际版":
			product, ok := tencent.ProductByName(trimmed)
			if !ok {
				return nil, unknownSource(trimmed)
			}
			built, err := tencent.New(tencent.Config{
				Product:   product,
				StorePath: cfg.CredentialFile,
				Log:       logf,
			})
			if err != nil {
				return nil, err
			}
			sources = append(sources, built)

		case "oc", "opencode", "免费", "免费档":
			built, err := opencode.NewFreeTier(opencode.Options{
				Home:           cfg.Home,
				CredentialFile: cfg.CredentialFile,
				Logf:           logff(logf),
			})
			if err != nil {
				return nil, err
			}
			sources = append(sources, built)

		case "ocg", "opencode-go", "opencodego", "go", "套餐", "go套餐":
			if !opencode.HasGoKey() {
				// 没配 key：不挂这条来源，但要说清怎么配，而不是静默少一条
				logf("OpenCode Go 套餐：还没配置 API key，本次不挂（菜单里「一键配置 → OpenCode Go 套餐」填 key）")
				continue
			}
			built, err := opencode.NewGoTier(opencode.Options{
				Home:           cfg.Home,
				CredentialFile: cfg.CredentialFile,
				Logf:           logff(logf),
			})
			if err != nil {
				return nil, err
			}
			sources = append(sources, built)

		default:
			return nil, unknownSource(trimmed)
		}
	}
	if len(sources) == 0 {
		return nil, source.ErrNoSources()
	}
	return source.NewRegistry(sources...), nil
}

func unknownSource(name string) *errs.Error {
	return errs.Validation(errs.SubtypeUnknownSource, fmt.Sprintf("不认识的来源：%s", name)).
		WithParam("--product").
		WithHint("可选 cn（WorkBuddy 国内版）/ intl（国际版）/ oc（OpenCode 免费档）/ ocg（Go 套餐）")
}

// logf 往 stderr 写一条进度或告警（AGENTS.md：成功数据才进 stdout）。
func logf(message string) {
	fmt.Fprintln(os.Stderr, message)
}

// logff 把 `func(string)` 适配成来源实现要的 Printf 形式。
func logff(fn func(string)) func(string, ...any) {
	return func(format string, args ...any) { fn(fmt.Sprintf(format, args...)) }
}
