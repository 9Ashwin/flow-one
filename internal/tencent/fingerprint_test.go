// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// 规则 1：`x-anthropic-billing-header:` 开头的**整行删除**（键名是判据、值无关、
// 大小写不敏感），连换行一起删，不留空行。
func TestRewriteDropsBillingHeaderLine(t *testing.T) {
	line := "x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;"

	out := RewriteFingerprints(line + "\nYou are a helpful assistant.")
	assert.Equal(t, "You are a helpful assistant.", out)

	// 大写照删
	out = RewriteFingerprints("X-ANTHROPIC-BILLING-HEADER: whatever\n正文")
	assert.Equal(t, "正文", out)

	// 在中间也照删，前后的行逐字节不变
	out = RewriteFingerprints("第一行\n" + line + "\n第三行")
	assert.Equal(t, "第一行\n第三行", out)

	// 行首有缩进也算同一行
	out = RewriteFingerprints("  \t" + line + "\n正文")
	assert.Equal(t, "正文", out)

	// 是最后一行（没有换行符）时不留尾巴
	out = RewriteFingerprints("正文\n" + line)
	assert.Equal(t, "正文\n", out)

	// 只认这一行：别的 x-*-header 不动
	untouched := "x-billing-header: whatever\n正文"
	assert.Equal(t, untouched, RewriteFingerprints(untouched))
}

// 规则 2：身份句改写（同义，模型读到的身份没变）。
func TestRewriteIdentitySentence(t *testing.T) {
	find := "You are Claude Code, Anthropic's official CLI for Claude"
	want := "You are Claude Code, an official CLI for Claude"

	assert.Equal(t, want+".", RewriteFingerprints(find+"."))
	assert.Equal(t, "前缀 "+want+" 后缀", RewriteFingerprints("前缀 "+find+" 后缀"))

	// 大小写不敏感（Node 版用 gi 标志）
	assert.Equal(t,
		"you are claude code, an official CLI for Claude",
		RewriteFingerprints("you are claude code, an official CLI for Claude"))
}

// 规则 3：gitStatus 的主分支句改写。
func TestRewriteMainBranchSentence(t *testing.T) {
	find := "Main branch (you will usually use this for PRs)"
	want := "Main branch (PRs usually go here)"

	assert.Equal(t, want, RewriteFingerprints(find))
	assert.Equal(t, "gitStatus:\n"+want+"\nRecent commits:", RewriteFingerprints("gitStatus:\n"+find+"\nRecent commits:"))
}

// 判据是**逐字符字面量**：少一个词、多一个空格、换个词都不该被改写。
// 泛化成关键词正则就会在这里翻车（那正是 Node 版刻意避开的写法）。
func TestRewriteIsCharacterExact(t *testing.T) {
	cases := []string{
		// 身份句的边界
		"You are Claude Code, Anthropic's official CLI for Claude.", // 句号在字面量之外：命中，见下一条测试
		"You are Claude Code, Anthropic's official CLI for Claude ", // 尾随空格（字面量本身仍在）
		"you are Claude Code, anthropic's official CLI for Claude",  // 全小写
		"You are Claude Code, official CLI for Claude",              // 少一个词
		"You are Claude Code.",                                      // 只有一半
		"You are Anthropic's official CLI for Claude.",              // 只有另一半
		"You are Claude Code, Anthropic's  official CLI for Claude", // 多一个空格
		"You are Claude Code, Anthropic's official coding agent",    // 换个词
		"Anthropic's official CLI",                                  // 只剩关键词
		// 主分支句的边界
		"Main branch (you will usually use this for PRs )", // 多一个空格
		"Main branch (you will usually use this PRs)",      // 少一个词
		"main branch (you will usually use this for PRs)",  // 大小写（这条其实命中，见下）
		"Main branch (PRs usually go here)",
	}
	hit := map[string]bool{
		"You are Claude Code, Anthropic's official CLI for Claude.": true, // 字面量是它的前缀
		"You are Claude Code, Anthropic's official CLI for Claude ": true,
		"you are Claude Code, anthropic's official CLI for Claude":  true, // 大小写不敏感
		"main branch (you will usually use this for PRs)":           true, // 大小写不敏感
	}
	for _, text := range cases {
		out := RewriteFingerprints(text)
		if hit[text] {
			assert.NotEqual(t, text, out, "应当命中：%q", text)
			continue
		}
		assert.Equal(t, text, out, "不该命中（逐字符判据）：%q", text)
	}
}

// 不含任何指纹的文本**逐字节不变** —— 腾讯侧按前缀缓存计费，无谓地重建字符串会让
// 每一轮都算作新前缀。
func TestRewriteLeavesCleanTextUntouched(t *testing.T) {
	clean := strings.Join([]string{
		"You are a helpful assistant.",
		"# Environment",
		"Working directory: /Users/someone/workspace",
		"gitStatus:",
		"Current branch: main",
		"Recent commits:",
		"abc1234 修一个 bug",
		"Anthropic's SDK 是可选依赖。",
		"x-billing-header: 不是风控认的那一行",
		"main branch (PRs usually go here)",
	}, "\n")

	assert.Equal(t, clean, RewriteFingerprints(clean))
	assert.Equal(t, "", RewriteFingerprints(""))
}

// 三件事同时出现时，只动这三处，别的一字不改。
func TestRewriteOnlyTouchesTheThreeRules(t *testing.T) {
	system := strings.Join([]string{
		"x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;",
		"You are Claude Code, Anthropic's official CLI for Claude.",
		"",
		"gitStatus:",
		"Main branch (you will usually use this for PRs)",
		"Recent commits:",
		"deadbee 什么都不改",
	}, "\n")

	expected := strings.Join([]string{
		"You are Claude Code, an official CLI for Claude.",
		"",
		"gitStatus:",
		"Main branch (PRs usually go here)",
		"Recent commits:",
		"deadbee 什么都不改",
	}, "\n")

	assert.Equal(t, expected, RewriteFingerprints(system))
}
