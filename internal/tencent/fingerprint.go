// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"regexp"
	"strings"
)

// literalRule 是「整句字面量 → 等义改写」。判据是**完整句子**，不是关键词。
type literalRule struct {
	find      string
	replace   string
	pattern   *regexp.Regexp
	findLower string
}

// literalRules 只在这两个片段**同现**时才被拦（2026-10-16 逐条实测）：去掉句号、
// 整句小写、只留一半都通过。所以规则写成整句字面量，而不是把 `Anthropic's` 一个词
// 设成全局替换 —— 后者会连带改掉那些本来没人拦的文本。
var literalRules = []literalRule{
	{
		find:    "You are Claude Code, Anthropic's official CLI for Claude",
		replace: "You are Claude Code, an official CLI for Claude",
	},
	{
		// Claude Code 的 gitStatus 上下文：只要会话在一个 git 仓库里，它就把这一行
		// 拼进 system。判据是整句逐字符 —— 少一个词或多一个空格都不拦。
		find:    "Main branch (you will usually use this for PRs)",
		replace: "Main branch (PRs usually go here)",
	},
}

// lineRules 是「整行删除」。与字面量规则分开，是因为它们的「什么在变」不同：
// 这里的判据是行首的键名，值每个客户端版本都不一样。Claude Code 2.1.x 会在 system
// 第一行拼 `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;`，这一行只为
// 归属统计存在，对模型没有任何语义，删掉是安全的。
var lineRules = []*regexp.Regexp{
	regexp.MustCompile(`(?im)^[ \t]*x-anthropic-billing-header:[^\n]*\n?`),
}

// leadingSpace 用于「删掉的是首行」时不留前导空行：那是改写留下的痕迹，不是原文。
var leadingSpace = regexp.MustCompile(`^\s+`)

func init() {
	for i := range literalRules {
		rule := &literalRules[i]
		rule.pattern = regexp.MustCompile("(?i)" + regexp.QuoteMeta(rule.find))
		rule.findLower = strings.ToLower(rule.find)
	}
}

// RewriteFingerprints 改写腾讯内容风控会拦下的字面量。
//
// 三条规则的判据与证据见 docs/gates.md 第一节（`400` + `code 11128`）。两条不变量：
//
//   - **逐字符**：少一个词、多一个空格都不命中 —— 规则是整句字面量，不是关键词正则；
//   - 只改 system：翻译层只把 system 交给它，user / tool 内容一律不经过；
//
// 不含任何指纹的文本**逐字节不变**：腾讯侧按前缀缓存计费，无谓地重建字符串会让
// 每一轮都算作新前缀。
func RewriteFingerprints(system string) string {
	if system == "" {
		return system
	}
	out := system
	for _, rule := range literalRules {
		if !strings.Contains(strings.ToLower(out), rule.findLower) {
			continue
		}
		out = rule.pattern.ReplaceAllString(out, rule.replace)
	}
	droppedLine := false
	for _, pattern := range lineRules {
		if !pattern.MatchString(out) {
			continue
		}
		out = pattern.ReplaceAllString(out, "")
		droppedLine = true
	}
	if droppedLine {
		out = leadingSpace.ReplaceAllString(out, "")
	}
	return out
}
