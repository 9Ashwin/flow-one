// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"encoding/json"
	"math"
)

// Usage 是 Anthropic 形状的 token 计数：message_start、message_delta 与非流式
// 消息体共用同一个形状。
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// UpstreamUsage 是上游 usage 里本桥真正读的两个计数。
//
// 字段用指针：Anthropic 侧的 input_tokens 在「上游没给」时要退回本地估算，
// 而「上游给了 0」必须原样是 0 —— 0 与缺席在计费口径上不是一个意思。
type UpstreamUsage struct {
	PromptTokens     *int
	CompletionTokens *int
}

// ToolCall 是归并后的一个工具调用槽。
type ToolCall struct {
	// ID 是上游给的调用 id；上游没给时是空串，出站时兜底成 toolu_0。
	ID string
	// Name 是工具名。
	Name string
	// Arguments 是分片拼起来的参数 JSON 文本；可能是空串或非法 JSON。
	Arguments string
}

// Failure 是流内错误帧带出的失败原因。
//
// 用结构体而不是裸字符串，是为了把「上游报了错、但消息是空串」和「没有出错」分开：
// 两者在收尾时走不同分支（前者不再发 message_delta）。
type Failure struct {
	Message string
}

// Outcome 是一轮对话折叠后的结果。流式与非流式共用同一份归并逻辑，
// 于是「分片怎么拼」只有一处实现。
type Outcome struct {
	Text     string
	Thinking string
	// ToolCalls 按下标归并；上游跳号留下的位置是 nil。那些洞在出站时被跳过，
	// 但 stop_reason 的判据看的是**槽位数**（与 Node 版一致）。
	ToolCalls []*ToolCall
	// Usage 是上游最后一帧带的计数；上游一次都没给时是 nil。
	Usage *UpstreamUsage
	// FinishReason 是上游的 finish_reason，认不认得出交给 stopReasonFor。
	FinishReason string
	// Failure 非 nil 表示这一轮以流内错误帧收场。
	Failure *Failure
}

// NewOutcome 造一个空的归并结果。
func NewOutcome() *Outcome {
	return &Outcome{}
}

// FoldChunk 把一个 OpenAI 分片折进 outcome。
//
// payload 是 SSE `data:` 之后那段 JSON。解析不了的帧直接丢掉：上游偶发半截帧时，
// 丢一帧远好过让整轮对话失败。
func FoldChunk(outcome *Outcome, payload []byte) {
	chunk := parseObject(payload)
	if chunk == nil {
		return
	}
	if usage, ok := asObject(chunk["usage"]); ok {
		// 整体替换而不是逐字段合并：usage 只在最后一帧给全，前几帧的残缺计数没有意义。
		outcome.Usage = upstreamUsageOf(usage)
	}
	if raw, ok := asObject(chunk["error"]); ok {
		outcome.Failure = failureFrom(raw)
		return
	}
	for _, item := range asArrayOrNil(chunk["choices"]) {
		choice, ok := asObject(item)
		if !ok {
			continue
		}
		if reason, ok := asString(choice["finish_reason"]); ok {
			outcome.FinishReason = reason
		}
		delta, ok := asObject(choice["delta"])
		if !ok {
			// 非流式响应把同样的内容放在 message 里，两条路共用一个读取逻辑。
			delta, ok = asObject(choice["message"])
		}
		if !ok {
			continue
		}
		appendDeltaText(&outcome.Text, delta["content"])
		if reasoning, ok := asString(delta["reasoning_content"]); ok {
			outcome.Thinking += reasoning
		} else if reasoning, ok := asString(delta["reasoning"]); ok {
			outcome.Thinking += reasoning
		}
		for _, callValue := range asArrayOrNil(delta["tool_calls"]) {
			if call, ok := asObject(callValue); ok {
				foldToolCall(outcome, call)
			}
		}
	}
}

// appendDeltaText 接住 content 的两种形状：裸字符串，或 [{type:"text",text}] 部分数组。
func appendDeltaText(target *string, content any) {
	if text, ok := asString(content); ok {
		*target += text
		return
	}
	for _, item := range asArrayOrNil(content) {
		part, ok := asObject(item)
		if !ok {
			continue
		}
		if text, ok := asString(part["text"]); ok {
			*target += text
		}
	}
}

// upstreamUsageOf 只留本桥要用的两个计数。
func upstreamUsageOf(usage map[string]any) *UpstreamUsage {
	out := &UpstreamUsage{}
	if tokens, ok := asNumber(usage["prompt_tokens"]); ok {
		value := int(tokens)
		out.PromptTokens = &value
	}
	if tokens, ok := asNumber(usage["completion_tokens"]); ok {
		value := int(tokens)
		out.CompletionTokens = &value
	}
	return out
}

// failureFrom 把错误帧翻成失败原因：上游给了字符串 message 就用它，否则把整个错误
// 对象序列化出来 —— 丢掉细节比多一层 JSON 更糟。
func failureFrom(raw map[string]any) *Failure {
	if message, ok := asString(raw["message"]); ok {
		return &Failure{Message: message}
	}
	return &Failure{Message: jsonText(raw)}
}

// foldToolCall 把一个 tool_calls 分片折进槽位。
//
// 下标优先用上游给的 index；没有下标时按 id 找回原来的槽。下标跳号会在数组里留下洞，
// 出站时跳过，但槽位数仍然参与 stop_reason 的判定。
func foldToolCall(outcome *Outcome, call map[string]any) {
	at := len(outcome.ToolCalls)
	if index, ok := asInteger(call["index"]); ok {
		if index >= 0 {
			at = index
		}
	} else if id, ok := asString(call["id"]); ok {
		if found := slotByID(outcome.ToolCalls, id); found >= 0 {
			at = found
		}
	}
	for len(outcome.ToolCalls) <= at {
		outcome.ToolCalls = append(outcome.ToolCalls, nil)
	}
	slot := outcome.ToolCalls[at]
	if slot == nil {
		slot = &ToolCall{}
		outcome.ToolCalls[at] = slot
	}
	if id, ok := asString(call["id"]); ok && id != "" {
		slot.ID = id
	}
	function, ok := asObject(call["function"])
	if !ok {
		return
	}
	// 名字只认第一个非空的：后续分片会重复带名字，重复覆盖没有意义。
	if name, ok := asString(function["name"]); ok && name != "" && slot.Name == "" {
		slot.Name = name
	}
	if arguments, ok := asString(function["arguments"]); ok {
		slot.Arguments += arguments
	}
}

// slotByID 按 id 找槽位；没找到返回 -1。
func slotByID(slots []*ToolCall, id string) int {
	for at, slot := range slots {
		if slot != nil && slot.ID == id {
			return at
		}
	}
	return -1
}

// MessageOptions 是非流式消息体的参数。
type MessageOptions struct {
	// Model 是回给客户端的模型名（调用方解析后的那个）。
	Model string
	// ID 是消息 id（msg_…），由调用方生成。
	ID string
	// InputTokens 是本地估算的输入计数，上游没给 usage 时用它兜底。
	InputTokens int
	// ShowThinking 决定推理内容要不要作为 thinking 块回给客户端。
	ShowThinking bool
}

// messageBody 是非流式响应的 Anthropic 消息体。
type messageBody struct {
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	Role         string  `json:"role"`
	Model        string  `json:"model"`
	Content      []any   `json:"content"`
	StopReason   string  `json:"stop_reason"`
	StopSequence *string `json:"stop_sequence"`
	Usage        Usage   `json:"usage"`
}

// outToolUse 是非流式消息体里的工具调用块。
type outToolUse struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Input any    `json:"input"`
}

// AnthropicMessage 把归并结果渲染成非流式消息体，返回可直写的 JSON。
//
// 推理块与流式一样只在显式开启时给出：没要过 thinking 的客户端拿到它会卡住。
func AnthropicMessage(outcome *Outcome, opts MessageOptions) []byte {
	content := []any{}
	if opts.ShowThinking && outcome.Thinking != "" {
		content = append(content, thinkingBlock{Type: "thinking", Thinking: outcome.Thinking})
	}
	if outcome.Text != "" {
		content = append(content, textBlock{Type: "text", Text: outcome.Text})
	}
	for _, call := range outcome.ToolCalls {
		if call == nil {
			continue
		}
		id := call.ID
		if id == "" {
			id = "toolu_0"
		}
		content = append(content, outToolUse{
			Type:  "tool_use",
			ID:    id,
			Name:  call.Name,
			Input: toolInput(call.Arguments),
		})
	}

	inputTokens := opts.InputTokens
	outputTokens := int(math.Round(float64(utf16Len(outcome.Text)) / charsPerToken))
	if outcome.Usage != nil {
		if outcome.Usage.PromptTokens != nil {
			inputTokens = *outcome.Usage.PromptTokens
		}
		if outcome.Usage.CompletionTokens != nil {
			outputTokens = *outcome.Usage.CompletionTokens
		}
	}

	return marshal(messageBody{
		ID:           opts.ID,
		Type:         "message",
		Role:         "assistant",
		Model:        opts.Model,
		Content:      content,
		StopReason:   stopReasonFor(outcome),
		StopSequence: nil,
		Usage:        Usage{InputTokens: inputTokens, OutputTokens: outputTokens},
	})
}

// toolInput 把累积的参数文本还原成对象：解析不了就给空对象 ——
// 工具块的 input 必须是对象，给 null 会让客户端把整块丢掉。
func toolInput(arguments string) any {
	empty := map[string]any{}
	if arguments == "" {
		return empty
	}
	var parsed any
	if err := json.Unmarshal([]byte(arguments), &parsed); err != nil {
		return empty
	}
	return parsed
}
