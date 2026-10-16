// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestEstimateInputTokensGrowsWithContent(t *testing.T) {
	small := EstimateInputTokens([]byte(`{"messages":[{"role":"user","content":"hi"}]}`))
	big := EstimateInputTokens([]byte(`{"messages":[{"role":"user","content":"` + strings.Repeat("x", 4000) + `"}]}`))

	assert.Greater(t, small, 0)
	assert.Greater(t, big, small+900)
}

func TestEstimateInputTokensNeverReturnsZero(t *testing.T) {
	// 空请求也要给一个非零底座：调用方（Claude Code）拿 0 会以为估算坏了。
	assert.Equal(t, baseTokens, EstimateInputTokens([]byte(`{}`)))
	assert.Equal(t, baseTokens, EstimateInputTokens(nil))
	assert.Equal(t, baseTokens, EstimateInputTokens([]byte(`不是 JSON`)))
}

func TestEstimateInputTokensCountsImagesToolsAndToolFrames(t *testing.T) {
	base := EstimateInputTokens([]byte(`{"system":"你是助手","messages":[{"role":"user","content":"hi"}]}`))

	withImage := EstimateInputTokens([]byte(`{"system":"你是助手","messages":[{"role":"user","content":[
		{"type":"text","text":"hi"},
		{"type":"image","source":{"type":"base64","data":"AAAA"}}
	]}]}`))
	assert.Equal(t, base+imageTokens, withImage, "图片按固定值记一笔")

	withTools := EstimateInputTokens([]byte(`{"system":"你是助手","messages":[{"role":"user","content":"hi"}],
		"tools":[{"name":"Read","description":"读文件","input_schema":{"type":"object"}}]}`))
	assert.Greater(t, withTools, base, "工具清单也要算进去")

	// tool_use / tool_result 各记一点结构开销：光看文本会低估带工具的一轮。
	withFrame := EstimateInputTokens([]byte(`{"messages":[{"role":"assistant","content":[
		{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}
	]}]}`))
	assert.GreaterOrEqual(t, withFrame, baseTokens+4)
}

func TestEstimateInputTokensCountsUTF16Units(t *testing.T) {
	// Node 的 String.length 是 UTF-16 码元数：emoji 占两个。口径对了，
	// 同一段上下文在 Node 版与 Go 版才会估出同一个数。
	assert.Equal(t, 3, utf16Len("abc"))
	assert.Equal(t, 1, utf16Len("我"))
	assert.Equal(t, 2, utf16Len("🙂"))
}
