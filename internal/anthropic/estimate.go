// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"encoding/json"
	"math"
)

// EstimateInputTokens 是 `count_tokens` 用的本地估算。
//
// 本桥不自带分词器，也不想为一次估算去要上游的额度：按 4 字符 ≈ 1 token 折，
// 图片记一个固定值，每条工具帧再加一点结构开销。估得准不如估得稳。
//
// 解析不了的 body 按空请求处理（返回 baseTokens）：这是估算，不值得为它搭一条
// 错误通道 —— 真正的校验在 ToOpenAIRequest 那一侧。
func EstimateInputTokens(body []byte) int {
	var parsed any
	if len(body) > 0 {
		_ = json.Unmarshal(body, &parsed)
	}
	request, _ := asObject(parsed)

	chars := utf16Len(flattenSystem(request["system"]))
	images := 0
	frames := 0

	// walk 递归处理 tool_result 里嵌的块：工具结果同样可以带图片。
	var walk func(content any)
	walk = func(content any) {
		for _, block := range blocksOf(content) {
			switch kind, _ := asString(block["type"]); kind {
			case "text":
				if text, ok := asString(block["text"]); ok {
					chars += utf16Len(text)
				}
			case "image":
				images++
			case "tool_result":
				frames += 4
				walk(block["content"])
			case "tool_use":
				frames += 4
				chars += utf16Len(jsonText(inputOf(block)))
			}
		}
	}
	for _, rowValue := range asArrayOrNil(request["messages"]) {
		if row, ok := asObject(rowValue); ok {
			walk(row["content"])
		}
	}

	// 工具清单要重新序列化一次：JSON 里的空白不算 token。
	toolChars := 0
	if tools, ok := asArray(request["tools"]); ok {
		toolChars = utf16Len(jsonText(tools))
	}

	estimate := int(math.Round(float64(chars+toolChars) / charsPerToken))
	total := estimate + images*imageTokens + frames + baseTokens
	if total < 1 {
		return 1
	}
	return total
}
