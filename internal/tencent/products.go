// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package tencent 是腾讯两条线（国内版 CodeBuddy / 国际版 WorkBuddy）的来源实现：
// 模型目录、对话报文，以及腾讯侧独有的内容风控改写。
//
// 套餐分离（本项目最容易写错的一条）：内容风控改写**只**对这两条线生效，所以本包
// 的 Rewriter() 是整个注册表里唯一返回非 nil 的实现。判据是「这条来源是谁」，不是
// 「模型名长什么样」—— 任何按前缀猜的旁路都算 bug。
package tencent

import (
	"strings"

	"github.com/9Ashwin/flow-one/internal/auth"
)

// User-Agent 不是装饰：国际版后台按模型族分列「使用端」，glm-* / hy* / kimi-* /
// minimax-* 这几条国内模型线要用国内客户端形态发，否则归属显示为 `-`。
const (
	// UAIntl 是国际版的 WorkBuddy 自家形态。
	UAIntl = "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2"
	// UACNLine 是国内模型线在国际版域名下使用的客户端形态。
	UACNLine = "WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2"
)

// CN 是国内版 = CodeBuddy（copilot.tencent.com）。
//
// 注意品牌：这一条在国内被叫作「WorkBuddy 国内版」，协议里的 X-Product-Code
// 仍是 `codebuddy`。取名 cn 是为了让命令行参数一眼分得清国内与国际。
var CN = auth.Product{
	ID:              "cn",
	Label:           "WorkBuddy 国内版（CodeBuddy）",
	Platform:        "ide",
	Endpoint:        "https://copilot.tencent.com",
	APIDomain:       "copilot.tencent.com",
	ProductCode:     "codebuddy",
	AttributionName: "CodeBuddy",
	ClientVersion:   "1.106.1",
	UserAgent:       "CodeBuddyIDE/1.106.1",
	// 国内版只有一条产品线，无需按模型分档。
	UserAgentByModel: nil,
	SessionParams:    false,
	FallbackModels:   []string{"deepseek-v4.1-flash", "hy4-preview-f", "glm-5.3"},
}

// INTL 是国际版 = WorkBuddy（www.workbuddy.ai）。
var INTL = auth.Product{
	ID:              "intl",
	Label:           "WorkBuddy 国际版",
	Platform:        "workbuddy-ai",
	Endpoint:        "https://www.workbuddy.ai",
	APIDomain:       "www.workbuddy.ai",
	ProductCode:     "workbuddy",
	AttributionName: "WorkBuddy",
	ClientVersion:   "5.5.2",
	UserAgent:       UAIntl,
	UserAgentByModel: []auth.UARule{
		{Prefix: "gpt-", UserAgent: UAIntl},
		{Prefix: "gemini-", UserAgent: UAIntl},
		{Prefix: "claude-", UserAgent: UAIntl},
		{Prefix: "glm-", UserAgent: UACNLine},
		{Prefix: "hy", UserAgent: UACNLine},
		{Prefix: "kimi-", UserAgent: UACNLine},
		{Prefix: "minimax-", UserAgent: UACNLine},
	},
	SessionParams:  true,
	PluginVersion:  "5.5.2",
	FallbackModels: []string{"default-model", "fast-model", "hy4-preview-f", "deepseek-v4.1-flash"},
}

// Products 是两条产品线，顺序即「没有前缀时的兜底顺序」。
var Products = []auth.Product{CN, INTL}

// aliases 是命令行与模型前缀都认的别名，免得用户去猜我们内部的叫法。
var aliases = map[string]auth.Product{
	"cn": CN, "buddy": CN, "codebuddy": CN, "国内": CN, "国内版": CN,
	"intl": INTL, "workbuddy": INTL, "workbuddy-ai": INTL, "国际": INTL, "国际版": INTL,
}

// ProductByName 按命令行里写的名字取产品线；未知名字返回 false，
// 由调用方列出可选值报错。
func ProductByName(name string) (auth.Product, bool) {
	raw := strings.TrimSpace(name)
	if raw == "" {
		return auth.Product{}, false
	}
	product, ok := aliases[strings.ToLower(raw)]
	if !ok {
		product, ok = aliases[raw]
	}
	return product, ok
}

// UserAgentFor 按模型族挑 User-Agent；没有命中规则时用产品默认档。
//
// 前缀匹配是有意的：规则表里的 `hy` 要能同时命中 `hy3` / `hy4-preview-f`。
func UserAgentFor(product auth.Product, model string) string {
	for _, rule := range product.UserAgentByModel {
		if strings.HasPrefix(model, rule.Prefix) {
			return rule.UserAgent
		}
	}
	return product.UserAgent
}
