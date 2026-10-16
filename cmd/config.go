// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/spf13/cobra"
)

// flags 是与 config.Config 对应的命令行开关。
//
// 优先级固定为 **flag > 环境变量 > 默认值**：先 Load 环境再让 flag 覆盖，
// 于是 `BRIDGE_PORT=9000 ccb serve --port 9100` 的语义是明确的。
type flags struct {
	mode         string
	host         string
	port         int
	model        string
	apiKey       string
	products     []string
	upstream     string
	upstreamKey  string
	showThinking bool
	maxTokensCap int
	rewrite      bool
	noRewrite    bool
	heartbeatMs  int
}

var cliFlags flags

func init() {
	persistent := rootCmd.PersistentFlags()
	persistent.StringVar(&cliFlags.mode, "mode", "", "上游接法：direct（自己登录）| gateway（转发给已有网关）")
	persistent.StringVar(&cliFlags.host, "host", "", "监听地址（默认 127.0.0.1）")
	persistent.IntVar(&cliFlags.port, "port", 0, "监听端口（默认 8788）")
	persistent.StringVar(&cliFlags.model, "model", "", "默认模型，带来源前缀，如 cn/deepseek-v4.1-flash")
	persistent.StringVar(&cliFlags.apiKey, "api-key", "", "本桥的访问密钥（Claude Code 用它换 token）")
	persistent.StringSliceVar(&cliFlags.products, "product", nil, "挂哪几个来源，可重复：cn / intl / oc / ocg")
	persistent.StringVar(&cliFlags.upstream, "upstream", "", "网关模式的上游地址")
	persistent.StringVar(&cliFlags.upstreamKey, "upstream-key", "", "网关模式的上游密钥")
	persistent.BoolVar(&cliFlags.showThinking, "show-thinking", false, "把模型的推理内容也翻给客户端")
	persistent.IntVar(&cliFlags.maxTokensCap, "max-tokens-cap", 0, "统一限制 max_tokens（0 表示不限制）")
	persistent.BoolVar(&cliFlags.rewrite, "fingerprint-rewrite", false, "强制打开腾讯内容风控改写")
	persistent.BoolVar(&cliFlags.noRewrite, "no-fingerprint-rewrite", false, "关闭腾讯内容风控改写（只影响腾讯两条线）")
	persistent.IntVar(&cliFlags.heartbeatMs, "heartbeat-ms", 0, "流式心跳间隔（毫秒，默认 5000）")
}

// loadConfig 读环境变量，再用显式 flag 覆盖。
func loadConfig(cmd *cobra.Command) (config.Config, error) {
	cfg, err := config.Load()
	if err != nil {
		return cfg, err
	}
	set := cmd.Flags().Changed
	if set("mode") {
		cfg.Mode = config.Mode(cliFlags.mode)
	}
	if set("host") {
		cfg.Host = cliFlags.host
	}
	if set("port") {
		cfg.Port = cliFlags.port
	}
	if set("model") {
		cfg.Model = cliFlags.model
	}
	if set("api-key") {
		cfg.APIKey = cliFlags.apiKey
	}
	if len(cliFlags.products) > 0 {
		cfg.Products = cliFlags.products
	}
	if set("upstream") {
		cfg.Upstream = cliFlags.upstream
	}
	if set("upstream-key") {
		cfg.UpstreamKey = cliFlags.upstreamKey
	}
	if set("show-thinking") {
		cfg.ShowThinking = cliFlags.showThinking
	}
	if set("max-tokens-cap") {
		cfg.MaxTokensCap = cliFlags.maxTokensCap
	}
	if set("heartbeat-ms") {
		cfg.HeartbeatMs = cliFlags.heartbeatMs
	}
	// 两个方向显式给过才改：--no-fingerprint-rewrite 优先
	if set("fingerprint-rewrite") {
		cfg.RewriteContent = cliFlags.rewrite
	}
	if set("no-fingerprint-rewrite") && cliFlags.noRewrite {
		cfg.RewriteContent = false
	}
	return cfg, nil
}
