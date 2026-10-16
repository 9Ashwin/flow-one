// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// translate 翻译一段请求体并把结果解回通用 map —— 断言盯着出站 JSON 本身，
// 而不是中间结构。
func translate(t *testing.T, body string, opts Options) map[string]any {
	t.Helper()
	out, err := ToOpenAIRequest([]byte(body), opts)
	require.NoError(t, err)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(out, &parsed))
	return parsed
}

// messagesOf 取出出站 messages 数组。
func messagesOf(t *testing.T, body map[string]any) []any {
	t.Helper()
	messages, ok := body["messages"].([]any)
	require.True(t, ok, "messages 必须是数组")
	return messages
}

// messageAt 取出第 at 条出站消息。
func messageAt(t *testing.T, body map[string]any, at int) map[string]any {
	t.Helper()
	messages := messagesOf(t, body)
	require.Greater(t, len(messages), at, "出站消息不够 %d 条", at+1)
	message, ok := messages[at].(map[string]any)
	require.True(t, ok)
	return message
}

func TestToOpenAIRequestMapsSystemBlocksAndToolFlow(t *testing.T) {
	body := translate(t, `{
		"system": [{"type": "text", "text": "你是助手"}],
		"messages": [
			{"role": "user", "content": [
				{"type": "text", "text": "看看这个"},
				{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
			]},
			{"role": "assistant", "content": [
				{"type": "thinking", "thinking": "忽略我"},
				{"type": "text", "text": "我来读"},
				{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "/tmp/a"}}
			]},
			{"role": "user", "content": [
				{"type": "tool_result", "tool_use_id": "toolu_1", "content": "hello"},
				{"type": "text", "text": "继续"}
			]}
		],
		"tools": [{"name": "Read", "description": "读文件", "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}}}],
		"max_tokens": 1024,
		"temperature": 0.2,
		"stop_sequences": ["STOP"]
	}`, Options{Model: "cn/deepseek-v4.1-flash"})

	assert.Equal(t, "cn/deepseek-v4.1-flash", body["model"])

	// system 是首条消息，块数组折成纯文本。
	system := messageAt(t, body, 0)
	assert.Equal(t, "system", system["role"])
	assert.Equal(t, "你是助手", system["content"])

	// 文本 + 图片同轮：content 是部分数组，图片走 data URL。
	user := messageAt(t, body, 1)
	assert.Equal(t, "user", user["role"])
	parts, ok := user["content"].([]any)
	require.True(t, ok, "带图片时必须给部分数组")
	require.Len(t, parts, 2)
	assert.Equal(t, map[string]any{"type": "text", "text": "看看这个"}, parts[0])
	assert.Equal(t, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AAAA"}}, parts[1])

	// thinking 块被丢掉（OpenAI 的输入侧没有它的位置），tool_use 变成 tool_calls。
	assistant := messageAt(t, body, 2)
	assert.Equal(t, "assistant", assistant["role"])
	assert.Equal(t, "我来读", assistant["content"])
	calls, ok := assistant["tool_calls"].([]any)
	require.True(t, ok)
	require.Len(t, calls, 1)
	call := calls[0].(map[string]any)
	assert.Equal(t, "toolu_1", call["id"])
	assert.Equal(t, "function", call["type"])
	function := call["function"].(map[string]any)
	assert.Equal(t, "Read", function["name"])
	assert.JSONEq(t, `{"file_path":"/tmp/a"}`, function["arguments"].(string))

	// 工具结果先落地，同轮文本紧随其后。
	tool := messageAt(t, body, 3)
	assert.Equal(t, "tool", tool["role"])
	assert.Equal(t, "toolu_1", tool["tool_call_id"])
	assert.Equal(t, "hello", tool["content"])
	assert.Equal(t, "继续", messageAt(t, body, 4)["content"])

	// tools 折成 function 形状，input_schema 原样进 parameters。
	tools, ok := body["tools"].([]any)
	require.True(t, ok)
	require.Len(t, tools, 1)
	tool0 := tools[0].(map[string]any)
	assert.Equal(t, "function", tool0["type"])
	function0 := tool0["function"].(map[string]any)
	assert.Equal(t, "Read", function0["name"])
	assert.Equal(t, "读文件", function0["description"])
	assert.Equal(t, "object", function0["parameters"].(map[string]any)["type"])

	assert.Equal(t, float64(1024), body["max_tokens"])
	assert.Equal(t, 0.2, body["temperature"])
	assert.Equal(t, []any{"STOP"}, body["stop"])
}

func TestToOpenAIRequestDropsToolsWhenChoiceIsNone(t *testing.T) {
	// 上游把「tool_choice: none 且带 tools」判为不可表达并直接 400，所以连工具一起摘掉。
	body := translate(t, `{
		"messages": [{"role": "user", "content": "hi"}],
		"tools": [{"name": "Read", "input_schema": {"type": "object"}}],
		"tool_choice": {"type": "none"}
	}`, Options{Model: "m"})

	assert.NotContains(t, body, "tools")
	assert.Equal(t, "none", body["tool_choice"])
}

func TestToolChoiceShapes(t *testing.T) {
	cases := []struct {
		name   string
		choice string
		want   any
	}{
		{"auto", `{"type":"auto"}`, "auto"},
		{"any 变成 required", `{"type":"any"}`, "required"},
		{"指定工具", `{"type":"tool","name":"Read"}`, map[string]any{"type": "function", "function": map[string]any{"name": "Read"}}},
		{"目录式 tool 无名字时退回 auto", `{"type":"tool"}`, "auto"},
		{"认不出的形状也退回 auto", `{"type":"weird"}`, "auto"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := translate(t, fmt.Sprintf(`{
				"messages": [{"role": "user", "content": "hi"}],
				"tools": [{"name": "Read", "input_schema": {"type": "object"}}],
				"tool_choice": %s
			}`, tc.choice), Options{Model: "m"})
			assert.Equal(t, tc.want, body["tool_choice"])
		})
	}
}

func TestEffortMappingNeverSendsOff(t *testing.T) {
	cases := []struct {
		budget string
		want   string
	}{
		{"20000", "high"},
		{"8192", "high"},
		{"8191", "medium"},
		{"2048", "medium"},
		{"2047", "low"},
		{"1", "low"},
	}
	for _, tc := range cases {
		body := translate(t, fmt.Sprintf(
			`{"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":%s}}`, tc.budget),
			Options{Model: "m"})
		assert.Equal(t, tc.want, body["reasoning_effort"], "budget=%s", tc.budget)
	}

	// 「没开 thinking」的正确表达是压根不带这个字段：OpenCode Go 对 off 回 422。
	for _, thinking := range []string{
		`{"type":"enabled","budget_tokens":0}`,
		`{"type":"disabled","budget_tokens":9000}`,
		`{"type":"enabled"}`,
		`{"type":"enabled","budget_tokens":"abc"}`,
		`null`,
	} {
		out, err := ToOpenAIRequest([]byte(fmt.Sprintf(
			`{"messages":[{"role":"user","content":"hi"}],"thinking":%s}`, thinking)), Options{Model: "m"})
		require.NoError(t, err)
		assert.NotContains(t, string(out), "reasoning_effort", "thinking=%s", thinking)
		assert.NotContains(t, string(out), `"off"`)
	}
}

func TestMaxTokensCapTruncates(t *testing.T) {
	body := translate(t, `{"messages":[{"role":"user","content":"hi"}],"max_tokens":99999}`,
		Options{Model: "m", MaxTokensCap: 32000})
	assert.Equal(t, float64(32000), body["max_tokens"])

	// 上限不生效时不该被抬高，也不该把非数字塞进报文。
	body = translate(t, `{"messages":[{"role":"user","content":"hi"}],"max_tokens":100}`,
		Options{Model: "m", MaxTokensCap: 32000})
	assert.Equal(t, float64(100), body["max_tokens"])

	body = translate(t, `{"messages":[{"role":"user","content":"hi"}],"max_tokens":"abc"}`,
		Options{Model: "m", MaxTokensCap: 32000})
	assert.NotContains(t, body, "max_tokens")
}

func TestToOpenAIRequestRejectsUnusableBodies(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		param string
	}{
		{"messages 为空", `{"messages":[]}`, "messages"},
		{"messages 缺失", `{"system":"hi"}`, "messages"},
		{"请求体是 null", `null`, "body"},
		{"请求体不是对象", `[1,2]`, "body"},
		{"请求体不是 JSON", `not json`, "body"},
		{"请求体是空的", ``, "messages"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ToOpenAIRequest([]byte(tc.body), Options{Model: "m"})
			require.Error(t, err)
			typed, ok := errs.As(err)
			require.True(t, ok, "必须是类型化错误，服务端靠 Category 定 HTTP 状态")
			assert.Equal(t, errs.CategoryValidation, typed.Category)
			assert.Equal(t, errs.SubtypeMissingArgument, typed.Subtype)
			assert.Equal(t, tc.param, typed.Param)
		})
	}
}

// TestNilRewriterLeavesSystemByteIdentical 是套餐分离不变式的回归测试：
// Rewriter 为 nil 就是不改写，与模型名长什么样无关。
func TestNilRewriterLeavesSystemByteIdentical(t *testing.T) {
	const fingerprints = "x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;\n\n" +
		"You are Claude Code, Anthropic's official CLI for Claude.\n\n" +
		"Main branch (you will usually use this for PRs): main"
	request, err := json.Marshal(map[string]any{
		"system":   fingerprints,
		"messages": []any{map[string]any{"role": "user", "content": fingerprints}},
	})
	require.NoError(t, err)

	// 同样的输入、不同的模型名：只要没有 Rewriter，出站 messages 必须一模一样。
	var baseline []any
	for _, model := range []string{"cn/deepseek-v4.1-flash", "intl/hunyuan-t1", "oc/deepseek-v4.1-flash-free", "ocg/gpt-5"} {
		body := translate(t, string(request), Options{Model: model})
		messages := messagesOf(t, body)
		require.Len(t, messages, 2)
		system := messages[0].(map[string]any)
		assert.Equal(t, "system", system["role"])
		assert.Equal(t, fingerprints, system["content"], "Rewriter 为 nil 时 system 必须逐字节不变（%s）", model)
		assert.Equal(t, fingerprints, messages[1].(map[string]any)["content"], "用户内容同样不该被动（%s）", model)
		if baseline == nil {
			baseline = messages
			continue
		}
		assert.Equal(t, baseline, messages, "出站 messages 不该随模型名变化（%s）", model)
	}

	// 反过来：给了 Rewriter 就必须生效，否则「腾讯那两条线要改写」会静默失效。
	rewritten := translate(t, string(request), Options{
		Model:         "cn/deepseek-v4.1-flash",
		RewriteSystem: func(system string) string { return "REWRITTEN" },
	})
	assert.Equal(t, "REWRITTEN", messageAt(t, rewritten, 0)["content"])
	assert.Equal(t, fingerprints, messageAt(t, rewritten, 1)["content"], "改写只碰 system")

	// 改写器把 system 抹成空串时，那条 system 消息整个不落地。
	emptied := translate(t, string(request), Options{
		Model:         "cn/deepseek-v4.1-flash",
		RewriteSystem: func(string) string { return "" },
	})
	assert.Equal(t, "user", messageAt(t, emptied, 0)["role"])
}

// TestRewriterIsNotCalledForEmptySystem 保证「空 system」不会被无谓地交给改写器：
// 改写器是来源侧的实现，调用它的次数也算行为。
func TestRewriterIsNotCalledForEmptySystem(t *testing.T) {
	called := 0
	translate(t, `{"messages":[{"role":"user","content":"hi"}]}`, Options{
		Model:         "cn/x",
		RewriteSystem: func(system string) string { called++; return system },
	})
	assert.Zero(t, called)
}

func TestUserRowsWithNoUsableContentAreDropped(t *testing.T) {
	body := translate(t, `{
		"messages": [
			{"role": "user", "content": [{"type": "text", "text": ""}]},
			{"role": "user", "content": [{"type": "thinking", "thinking": "不算内容"}]},
			{"role": "assistant", "content": [{"type": "thinking", "thinking": "只剩推理"}]},
			{"role": "user", "content": "真的内容"}
		]
	}`, Options{Model: "m"})

	messages := messagesOf(t, body)
	require.Len(t, messages, 1)
	assert.Equal(t, "真的内容", messages[0].(map[string]any)["content"])
}

func TestFlattenSystemJoinsBlocksWithBlankLine(t *testing.T) {
	body := translate(t, `{
		"system": [
			{"type": "text", "text": "第一段"},
			{"type": "text", "text": ""},
			{"type": "text", "text": "第二段   "},
			"不是对象"
		],
		"messages": [{"role": "user", "content": "hi"}]
	}`, Options{Model: "m"})

	assert.Equal(t, "第一段\n\n第二段", messageAt(t, body, 0)["content"])
}

func TestImageBlocksThatCannotBeMappedAreDropped(t *testing.T) {
	body := translate(t, `{
		"messages": [{"role": "user", "content": [
			{"type": "image", "source": {"type": "base64", "data": ""}},
			{"type": "image", "source": {"type": "url", "url": "https://example.test/a.png"}},
			{"type": "image", "source": "不是对象"},
			{"type": "text", "text": "看图"}
		]}]
	}`, Options{Model: "m"})

	parts, ok := messageAt(t, body, 0)["content"].([]any)
	require.True(t, ok)
	require.Len(t, parts, 2, "认不出来的图片块该丢掉，而不是让整轮 400")
	assert.Equal(t, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://example.test/a.png"}}, parts[0])
	assert.Equal(t, map[string]any{"type": "text", "text": "看图"}, parts[1])
}

func TestToolResultsCarryImagesAndCanPrecedeText(t *testing.T) {
	body := translate(t, `{
		"messages": [{"role": "user", "content": [
			{"type": "tool_result", "tool_use_id": "toolu_9", "content": [
				{"type": "text", "text": "截图："},
				{"type": "image", "source": {"type": "base64", "data": "BBBB"}}
			]},
			{"type": "tool_result", "tool_use_id": "", "content": "没有 id，丢掉"}
		]}]
	}`, Options{Model: "m"})

	messages := messagesOf(t, body)
	require.Len(t, messages, 1, "没有 tool_use_id 的结果对不上号，只能丢")
	tool := messages[0].(map[string]any)
	assert.Equal(t, "tool", tool["role"])
	parts, ok := tool["content"].([]any)
	require.True(t, ok)
	assert.Equal(t, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,BBBB"}}, parts[1])
}

func TestToolUsesGetFallbackIDsAndDefaultSchema(t *testing.T) {
	body := translate(t, `{
		"messages": [
			{"role": "assistant", "content": [
				{"type": "tool_use", "name": "Read", "input": null},
				{"type": "tool_use", "name": "Glob"}
			]}
		],
		"tools": [
			{"name": "Read"},
			{"name": ""},
			{"description": "没有名字"},
			"不是对象"
		]
	}`, Options{Model: "m"})

	calls := messageAt(t, body, 0)["tool_calls"].([]any)
	require.Len(t, calls, 2)
	assert.Equal(t, "toolu_0", calls[0].(map[string]any)["id"], "客户端没给 id 时自己编号")
	assert.Equal(t, "toolu_1", calls[1].(map[string]any)["id"])
	assert.Equal(t, "{}", calls[0].(map[string]any)["function"].(map[string]any)["arguments"])

	tools := body["tools"].([]any)
	require.Len(t, tools, 1, "没有名字的工具进不了 OpenAI 的 tools")
	assert.Equal(t, map[string]any{"properties": map[string]any{}, "type": "object"},
		tools[0].(map[string]any)["function"].(map[string]any)["parameters"])
}

func TestStreamFlagIsOnlySetForTrue(t *testing.T) {
	assert.Equal(t, true, translate(t, `{"messages":[{"role":"user","content":"hi"}],"stream":true}`, Options{Model: "m"})["stream"])
	assert.NotContains(t, translate(t, `{"messages":[{"role":"user","content":"hi"}],"stream":false}`, Options{Model: "m"}), "stream")
	assert.NotContains(t, translate(t, `{"messages":[{"role":"user","content":"hi"}]}`, Options{Model: "m"}), "stream")
}

func TestStopSequencesAlwaysProduceAnArrayWhenGiven(t *testing.T) {
	// stop_sequences 给的是一串非字符串时，Node 版发的是空数组而不是省略这个键。
	body := translate(t, `{"messages":[{"role":"user","content":"hi"}],"stop_sequences":[1,2]}`, Options{Model: "m"})
	assert.Equal(t, []any{}, body["stop"])

	// 没给这个键时就不该出现。
	assert.NotContains(t, translate(t, `{"messages":[{"role":"user","content":"hi"}]}`, Options{Model: "m"}), "stop")
}
