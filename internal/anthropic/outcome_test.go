// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// foldAll 把若干分片折进一个新的 outcome。
func foldAll(chunks ...string) *Outcome {
	outcome := NewOutcome()
	for _, chunk := range chunks {
		FoldChunk(outcome, []byte(chunk))
	}
	return outcome
}

// messageOf 渲染非流式消息体并解回通用 map。
func messageOf(t *testing.T, outcome *Outcome, opts MessageOptions) map[string]any {
	t.Helper()
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(AnthropicMessage(outcome, opts), &parsed))
	return parsed
}

func TestFoldChunkMergesUsageAndToolCalls(t *testing.T) {
	// 非流式：一份带 message 的完整答复。
	outcome := foldAll(`{
		"choices": [{
			"message": {
				"content": "读到了",
				"tool_calls": [{"id": "c1", "function": {"name": "Read", "arguments": "{\"p\":1}"}}]
			},
			"finish_reason": "tool_calls"
		}],
		"usage": {"prompt_tokens": 11, "completion_tokens": 5}
	}`)

	message := messageOf(t, outcome, MessageOptions{Model: "cn/x", ID: "msg_5", InputTokens: 3})
	assert.Equal(t, "tool_use", message["stop_reason"])
	assert.Equal(t, float64(11), message["usage"].(map[string]any)["input_tokens"], "上游给的计数优先于本地估算")
	assert.Equal(t, float64(5), message["usage"].(map[string]any)["output_tokens"])
	assert.Nil(t, message["stop_sequence"])

	content := message["content"].([]any)
	require.Len(t, content, 2)
	assert.Equal(t, map[string]any{"type": "text", "text": "读到了"}, content[0])
	assert.Equal(t, map[string]any{
		"type": "tool_use", "id": "c1", "name": "Read", "input": map[string]any{"p": float64(1)},
	}, content[1])
}

func TestFoldChunkMergesStreamingDeltasAndToolArgumentPieces(t *testing.T) {
	outcome := foldAll(
		`{"choices":[{"delta":{"reasoning_content":"先想","content":"你"}}]}`,
		`{"choices":[{"delta":{"content":"好"}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{\"p\""}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}`,
	)

	assert.Equal(t, "你好", outcome.Text)
	assert.Equal(t, "先想", outcome.Thinking)
	require.Len(t, outcome.ToolCalls, 1)
	assert.Equal(t, `{"p":1}`, outcome.ToolCalls[0].Arguments)

	message := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1", ShowThinking: true})
	content := message["content"].([]any)
	require.Len(t, content, 3)
	assert.Equal(t, map[string]any{"type": "thinking", "thinking": "先想"}, content[0])
	assert.Equal(t, map[string]any{"type": "text", "text": "你好"}, content[1])
	assert.Equal(t, map[string]any{"type": "tool_use", "id": "c1", "name": "Read", "input": map[string]any{"p": float64(1)}}, content[2])
	// 有工具调用就是 tool_use，上游的 finish_reason 靠边站。
	assert.Equal(t, "tool_use", message["stop_reason"])
}

func TestFoldChunkKeepsThinkingOutOfTheMessageUnlessAsked(t *testing.T) {
	outcome := foldAll(`{"choices":[{"delta":{"reasoning_content":"推理","content":"答案"}}]}`)
	message := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1"})
	content := message["content"].([]any)
	require.Len(t, content, 1)
	assert.Equal(t, map[string]any{"type": "text", "text": "答案"}, content[0])
}

func TestFoldChunkTracksContentPartsAndFinishReasons(t *testing.T) {
	// content 也可能是部分数组（有些网关只给这种形状）。
	outcome := foldAll(`{"choices":[{"delta":{"content":[{"type":"text","text":"甲"},{"type":"text","text":"乙"}]},"finish_reason":"length"}]}`)
	assert.Equal(t, "甲乙", outcome.Text)
	assert.Equal(t, "length", outcome.FinishReason)

	message := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1"})
	assert.Equal(t, "max_tokens", message["stop_reason"])
}

func TestFoldChunkRecordsInStreamFailure(t *testing.T) {
	outcome := foldAll(
		`{"choices":[{"delta":{"content":"半句"}}]}`,
		`{"error":{"message":"内容被安全策略拦截"}}`,
	)
	require.NotNil(t, outcome.Failure)
	assert.Equal(t, "内容被安全策略拦截", outcome.Failure.Message)
	assert.Equal(t, "半句", outcome.Text, "失败前吐出来的内容要留住")

	// 错误帧不带字符串 message 时，把整个错误对象留下当理由，别只说「失败了」。
	structured := foldAll(`{"error":{"code":11140,"displayMsg":"拦截"}}`)
	require.NotNil(t, structured.Failure)
	assert.Contains(t, structured.Failure.Message, "11140")
}

func TestFoldChunkIgnoresBadFramesAndNonObjects(t *testing.T) {
	outcome := foldAll(
		`不是 JSON`,
		`[1,2,3]`,
		`null`,
		`{"choices":"不是数组"}`,
		`{"choices":[1,{"delta":"不是对象"}]}`,
		`{"choices":[{"delta":{"content":"只剩下我"}}]}`,
	)
	assert.Equal(t, "只剩下我", outcome.Text)
	assert.Nil(t, outcome.Failure)
}

func TestAnthropicMessageFallsBackToLocalTokenEstimate(t *testing.T) {
	outcome := foldAll(`{"choices":[{"message":{"content":"12345678"}}]}`)
	message := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1", InputTokens: 42})
	usage := message["usage"].(map[string]any)
	assert.Equal(t, float64(42), usage["input_tokens"], "上游没给 input_tokens 就用本地估算")
	assert.Equal(t, float64(2), usage["output_tokens"], "上游没给输出计数时按正文长度折")

	// 上游给了 0 就必须是 0：0 与「没给」不是一个意思。
	zero := foldAll(`{"choices":[{"message":{"content":"12345678"}}],"usage":{"prompt_tokens":0,"completion_tokens":0}}`)
	usage = messageOf(t, zero, MessageOptions{Model: "m", ID: "msg_1", InputTokens: 42})["usage"].(map[string]any)
	assert.Equal(t, float64(0), usage["input_tokens"])
	assert.Equal(t, float64(0), usage["output_tokens"])
}

func TestAnthropicMessageFallsBackOnUnparseableToolArguments(t *testing.T) {
	outcome := foldAll(`{"choices":[{"message":{"tool_calls":[{"id":"c1","function":{"name":"Read","arguments":"{\"p\": "}}]}}]}`)
	content := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1"})["content"].([]any)
	require.Len(t, content, 1)
	// 参数拼坏了也要给对象：给 null 会让客户端把整块丢掉。
	assert.Equal(t, map[string]any{"type": "tool_use", "id": "c1", "name": "Read", "input": map[string]any{}}, content[0])
}

func TestAnthropicMessageUsesGoStyleJSONWithoutHTMLEscaping(t *testing.T) {
	outcome := foldAll(`{"choices":[{"message":{"content":"a < b && c > d"}}]}`)
	raw := string(AnthropicMessage(outcome, MessageOptions{Model: "m", ID: "msg_1"}))
	assert.Contains(t, raw, "a < b && c > d", "不该被转义成 \\u003c")
	assert.False(t, strings.Contains(raw, `\u003c`))
}

func TestAnthropicMessageKeepsSkippedToolSlotsSkipped(t *testing.T) {
	// 上游跳号（只发 index 1）时数组里会有个洞：洞要跳过，但槽位数仍然算数。
	outcome := foldAll(`{"choices":[{"message":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"Read","arguments":"{}"}}]}}]}`)
	require.Len(t, outcome.ToolCalls, 2)
	assert.Nil(t, outcome.ToolCalls[0])

	message := messageOf(t, outcome, MessageOptions{Model: "m", ID: "msg_1"})
	assert.Equal(t, "tool_use", message["stop_reason"])
	content := message["content"].([]any)
	require.Len(t, content, 1)
	assert.Equal(t, "c1", content[0].(map[string]any)["id"])
}
