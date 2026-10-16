// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

// UARule 是「模型前缀 → User-Agent」的一条分档规则，按声明顺序匹配。
type UARule struct {
	Prefix    string
	UserAgent string
}

// Product 是一条腾讯产品线的客户端身份。
//
// 两条产品线共用同一套 `/plugin` 协议，差异全在这张表里：域名、platform、
// X-Product-Code、User-Agent、登录 URL 是否需要附加参数。常量值取自对官方客户端
// （CodeBuddy IDE 1.106.1 / WorkBuddy AI 5.5.2）出站报文的实测，表在
// internal/tencent/products.go。
type Product struct {
	// ID 是来源前缀（cn / intl），也是凭据文件里的条目名。
	ID string
	// Label 是给人看的名字。
	Label string
	// Platform 是 /v2/plugin/auth/state 的 platform 参数。
	Platform string
	// Endpoint 是站点根，例如 https://copilot.tencent.com。
	Endpoint string
	// APIDomain 是 X-Domain 头的值。
	APIDomain string
	// ProductCode 是 X-Product-Code 头的值（cn 是 codebuddy，intl 是 workbuddy）。
	ProductCode string
	// AttributionName 是 X-IDE-Name / X-IDE-Type 的值（后台据此归因「使用端」）。
	AttributionName string
	// ClientVersion 是 X-IDE-Version 的值。
	ClientVersion string
	// UserAgent 是默认档的 User-Agent。
	UserAgent string
	// UserAgentByModel 是按模型族分档的 User-Agent 规则（可为空）。
	UserAgentByModel []UARule
	// SessionParams 决定登录 URL 是否要补 version 与 loginSessionId（国际版要）。
	SessionParams bool
	// PluginVersion 是登录 URL 上 version 参数的值（仅国际版有）。
	PluginVersion string
	// FallbackModels 是远端目录拿不到时的内置兜底清单。
	FallbackModels []string
}
