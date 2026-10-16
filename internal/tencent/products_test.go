// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 产品常量取自对官方客户端出站报文的实测，改一个字符后台就会把归属记成 `-`
// 或者直接拒绝，所以逐项钉住。
func TestProductConstants(t *testing.T) {
	assert.Equal(t, "cn", CN.ID)
	assert.Equal(t, "ide", CN.Platform)
	assert.Equal(t, "https://copilot.tencent.com", CN.Endpoint)
	assert.Equal(t, "copilot.tencent.com", CN.APIDomain)
	assert.Equal(t, "codebuddy", CN.ProductCode)
	assert.Equal(t, "CodeBuddy", CN.AttributionName)
	assert.Equal(t, "1.106.1", CN.ClientVersion)
	assert.Equal(t, "CodeBuddyIDE/1.106.1", CN.UserAgent)
	assert.False(t, CN.SessionParams, "国内版登录链接不附加参数")
	assert.Empty(t, CN.UserAgentByModel)

	assert.Equal(t, "intl", INTL.ID)
	assert.Equal(t, "workbuddy-ai", INTL.Platform)
	assert.Equal(t, "https://www.workbuddy.ai", INTL.Endpoint)
	assert.Equal(t, "www.workbuddy.ai", INTL.APIDomain)
	assert.Equal(t, "workbuddy", INTL.ProductCode)
	assert.Equal(t, "WorkBuddy", INTL.AttributionName)
	assert.Equal(t, "5.5.2", INTL.ClientVersion)
	assert.Equal(t, UAIntl, INTL.UserAgent)
	assert.True(t, INTL.SessionParams, "国际版登录链接要带 version 与 loginSessionId")
	assert.Equal(t, "5.5.2", INTL.PluginVersion)
	assert.Equal(t, []string{"cn", "intl"}, []string{Products[0].ID, Products[1].ID})
}

// UA 按产品与模型分档：国际版域名下的国内模型线要用国内客户端形态发，
// 否则后台的「使用端」归因会显示成 `-`。
func TestUserAgentForModelFamilies(t *testing.T) {
	for _, model := range []string{"glm-5.3", "hy4-preview-f", "hy3", "kimi-k2", "minimax-m2"} {
		assert.Equal(t, UACNLine, UserAgentFor(INTL, model), model)
	}
	for _, model := range []string{"gpt-5", "gemini-3-pro", "claude-sonnet-4"} {
		assert.Equal(t, UAIntl, UserAgentFor(INTL, model), model)
	}
	// 没命中任何规则时用产品默认档
	assert.Equal(t, UAIntl, UserAgentFor(INTL, "deepseek-v4.1-flash"))
	assert.Equal(t, "CodeBuddyIDE/1.106.1", UserAgentFor(CN, "glm-5.3"))
}

func TestProductByName(t *testing.T) {
	for _, name := range []string{"cn", "CN", " buddy ", "codebuddy", "国内", "国内版"} {
		product, ok := ProductByName(name)
		require.True(t, ok, name)
		assert.Equal(t, "cn", product.ID, name)
	}
	for _, name := range []string{"intl", "WorkBuddy", "workbuddy-ai", "国际", "国际版"} {
		product, ok := ProductByName(name)
		require.True(t, ok, name)
		assert.Equal(t, "intl", product.ID, name)
	}
	_, ok := ProductByName("ocg")
	assert.False(t, ok, "腾讯的产品表不认 OpenCode 的名字")
	_, ok = ProductByName("  ")
	assert.False(t, ok)
}
