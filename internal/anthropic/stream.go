// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"sort"
	"strconv"
)

// StreamOptions 是流式渲染器的参数。
type StreamOptions struct {
	// Model 是回给客户端的模型名。
	Model string
	// ID 是消息 id（msg_…），由调用方生成。
	ID string
	// InputTokens 是本地估算的输入计数，上游没给 usage 时用它兜底。
	InputTokens int
	// ShowThinking 决定推理内容要不要作为 thinking 块吐出去。
	ShowThinking bool
	// Write 收到的是**完整的 SSE 帧**（`event: …\ndata: …\n\n`）。
	// 传函数而不是返回帧切片，是为了让「成帧对不对」能在没有网络的地方断言。
	Write func(frame []byte)
}

// StreamTranslator 把 OpenAI 的分片流写成 Anthropic 的具名事件流。
//
// 帧序列（Claude Code 认的就是这个顺序）：
//
//	message_start → content_block_start|delta|stop … → message_delta → message_stop
//
// 上游在流里报错时走 `event: error` 收尾，且**不再发 message_delta** ——
// 那会让客户端把一轮失败当成正常结束。
type StreamTranslator struct {
	model        string
	id           string
	write        func(frame []byte)
	showThinking bool

	nextIndex     int
	textIndex     int // -1 表示文本块还没开场
	thinkingIndex int // -1 表示推理块还没开场
	// slots 按**到达顺序**保存工具槽。Node 的 Map 也是插入序，而收尾补开场时
	// 顺序决定块下标，所以这里不能换成 map（Go 的 map 遍历是随机的）。
	slots []*toolSlot

	usage      Usage
	stopReason string
	started    bool
	finished   bool
	failure    *Failure
}

// toolSlot 是一个工具调用块在渲染过程中的状态。
type toolSlot struct {
	// key 是上游给的 tool_calls 下标；没有下标时用「当前槽数」，与 Node 版一致。
	key    int
	block  int // 开场时分配的内容块下标；未开场是 -1
	id     string
	name   string
	open   bool
	buffer string
}

// NewStreamTranslator 造一个流式渲染器。Write 必须非 nil。
func NewStreamTranslator(opts StreamOptions) *StreamTranslator {
	return &StreamTranslator{
		model:         opts.Model,
		id:            opts.ID,
		write:         opts.Write,
		showThinking:  opts.ShowThinking,
		textIndex:     -1,
		thinkingIndex: -1,
		usage:         Usage{InputTokens: opts.InputTokens},
	}
}

// Push 消费一个 OpenAI 分片。返回 false 表示这一分片宣告了本轮失败，
// 调用方应当停止读取并改用 Fail 收尾。
func (t *StreamTranslator) Push(payload []byte) bool {
	if t.finished {
		return true
	}
	chunk := parseObject(payload)
	if chunk == nil {
		return true
	}
	if raw, ok := asObject(chunk["error"]); ok {
		t.failure = failureFrom(raw)
		return false
	}
	if usage, ok := asObject(chunk["usage"]); ok {
		if tokens, ok := asNumber(usage["prompt_tokens"]); ok {
			t.usage.InputTokens = int(tokens)
		}
		if tokens, ok := asNumber(usage["completion_tokens"]); ok {
			t.usage.OutputTokens = int(tokens)
		}
	}
	t.start()
	for _, item := range asArrayOrNil(chunk["choices"]) {
		choice, ok := asObject(item)
		if !ok {
			continue
		}
		if reason, ok := asString(choice["finish_reason"]); ok {
			t.stopReason = mappedStopReason(reason)
		}
		delta, _ := asObject(choice["delta"])
		if reasoning, ok := asString(delta["reasoning_content"]); ok {
			t.thinkingDelta(reasoning)
		} else if reasoning, ok := asString(delta["reasoning"]); ok {
			t.thinkingDelta(reasoning)
		}
		if text, ok := asString(delta["content"]); ok {
			t.textDelta(text)
		} else {
			for _, partValue := range asArrayOrNil(delta["content"]) {
				part, ok := asObject(partValue)
				if !ok {
					continue
				}
				if text, ok := asString(part["text"]); ok {
					t.textDelta(text)
				}
			}
		}
		for _, callValue := range asArrayOrNil(delta["tool_calls"]) {
			if call, ok := asObject(callValue); ok {
				t.toolDelta(call)
			}
		}
	}
	return true
}

// End 是正常收尾：补齐块结束、stop_reason 与 usage，再发 message_stop。
func (t *StreamTranslator) End() {
	if t.finished {
		return
	}
	t.start()
	t.finished = true
	t.closeThinking()
	t.closeText()
	// 收尾时仍未开场的工具块：名字到齐了就补开场，序号按 OpenAI 的下标排。
	for _, slot := range t.sortedSlots() {
		if slot.open || slot.buffer == "" {
			continue
		}
		if slot.name == "" {
			slot.name = "unknown_tool"
		}
		t.openTool(slot)
	}
	t.closeTools()

	reason := "end_turn"
	switch {
	case len(t.slots) > 0:
		reason = "tool_use"
	case t.failure != nil:
		// 失败过的一轮不该说自己正常结束。这里刻意不落 stopReason：
		// 上游的 finish_reason 属于那份已经不成立的答复。
		reason = "end_turn"
	case t.stopReason != "":
		reason = t.stopReason
	}
	t.send("message_delta", messageDeltaFrame{
		Type:  "message_delta",
		Delta: messageDeltaBody{StopReason: reason, StopSequence: nil},
		Usage: t.usage,
	})
	t.send("message_stop", messageStopFrame{Type: "message_stop"})
}

// Fail 是失败收尾：Anthropic 用流内 error 事件表达「响应头已经发出之后才失败」。
func (t *StreamTranslator) Fail(message string) {
	if t.finished {
		return
	}
	t.start()
	t.finished = true
	t.send("error", errorEnvelope{Type: "error", Error: errorBody{Type: "api_error", Message: message}})
	t.send("message_stop", messageStopFrame{Type: "message_stop"})
}

// Failure 返回流内错误帧带出的失败原因；nil 表示这一轮没在流里报过错。
func (t *StreamTranslator) Failure() *Failure { return t.failure }

// Usage 返回当前的计数（上游给了就用上游的，没给就是本地估算 + 已吐出的字符数）。
func (t *StreamTranslator) Usage() Usage { return t.usage }

// start 发 message_start。帧序列的第一帧只能是它，所以每个出口都先调它一次。
func (t *StreamTranslator) start() {
	if t.started {
		return
	}
	t.started = true
	t.send("message_start", messageStartFrame{
		Type: "message_start",
		Message: startMessage{
			ID:           t.id,
			Type:         "message",
			Role:         "assistant",
			Model:        t.model,
			Content:      []any{},
			StopReason:   nil,
			StopSequence: nil,
			Usage:        Usage{InputTokens: t.usage.InputTokens},
		},
	})
}

// closeThinking / closeText / closeTools 三个出口都要能重复调用：
// 收尾路径与正常路径都会碰它们。
func (t *StreamTranslator) closeThinking() {
	if t.thinkingIndex < 0 {
		return
	}
	t.send("content_block_stop", contentBlockStopFrame{Type: "content_block_stop", Index: t.thinkingIndex})
	t.thinkingIndex = -1
}

func (t *StreamTranslator) closeText() {
	if t.textIndex < 0 {
		return
	}
	t.send("content_block_stop", contentBlockStopFrame{Type: "content_block_stop", Index: t.textIndex})
	t.textIndex = -1
}

func (t *StreamTranslator) closeTools() {
	for _, slot := range t.sortedSlots() {
		if !slot.open {
			continue
		}
		t.send("content_block_stop", contentBlockStopFrame{Type: "content_block_stop", Index: slot.block})
		slot.open = false
	}
}

// thinkingDelta 吐一段推理。推理块与文本块互斥：Anthropic 的块顺序就是产生顺序，
// 模型从「想」切到「说」时必须先把前一个块关掉。
func (t *StreamTranslator) thinkingDelta(text string) {
	if !t.showThinking || text == "" {
		return
	}
	t.closeText()
	if t.thinkingIndex < 0 {
		t.thinkingIndex = t.nextIndex
		t.nextIndex++
		t.send("content_block_start", contentBlockStartFrame{
			Type:         "content_block_start",
			Index:        t.thinkingIndex,
			ContentBlock: thinkingBlock{Type: "thinking", Thinking: ""},
		})
	}
	t.send("content_block_delta", contentBlockDeltaFrame{
		Type:  "content_block_delta",
		Index: t.thinkingIndex,
		Delta: thinkingBlock{Type: "thinking_delta", Thinking: text},
	})
}

// textDelta 吐一段正文。
func (t *StreamTranslator) textDelta(text string) {
	if text == "" {
		return
	}
	t.closeThinking()
	if t.textIndex < 0 {
		t.textIndex = t.nextIndex
		t.nextIndex++
		t.send("content_block_start", contentBlockStartFrame{
			Type:         "content_block_start",
			Index:        t.textIndex,
			ContentBlock: textBlock{Type: "text", Text: ""},
		})
	}
	t.send("content_block_delta", contentBlockDeltaFrame{
		Type:  "content_block_delta",
		Index: t.textIndex,
		Delta: textBlock{Type: "text_delta", Text: text},
	})
}

// toolDelta 收一个工具调用分片。
func (t *StreamTranslator) toolDelta(call map[string]any) {
	t.closeThinking()
	t.closeText()

	key := len(t.slots)
	if index, ok := asInteger(call["index"]); ok {
		key = index
	}
	slot := t.slotFor(key)
	if id, ok := asString(call["id"]); ok && id != "" {
		slot.id = id
	}
	function, _ := asObject(call["function"])
	// 名字只认第一个非空的：后续分片重复带名字时不该再覆盖。
	if name, ok := asString(function["name"]); ok && name != "" && slot.name == "" {
		slot.name = name
	}
	if arguments, ok := asString(function["arguments"]); ok && arguments != "" {
		if slot.open {
			t.send("content_block_delta", contentBlockDeltaFrame{
				Type:  "content_block_delta",
				Index: slot.block,
				Delta: inputJSONDelta{Type: "input_json_delta", PartialJSON: arguments},
			})
		} else {
			slot.buffer += arguments
		}
	}
	t.openTool(slot)
}

// slotFor 按下标取槽，没有就新建。同样的下标只会有一个槽 —— 上游会把一个工具调用
// 拆成好几片发过来。
func (t *StreamTranslator) slotFor(key int) *toolSlot {
	for _, slot := range t.slots {
		if slot.key == key {
			return slot
		}
	}
	slot := &toolSlot{key: key, block: -1, id: "toolu_" + strconv.Itoa(key)}
	t.slots = append(t.slots, slot)
	return slot
}

// openTool 把工具块开场。
//
// 块必须带着名字开场（Anthropic 的 content_block_start 里就有 name），所以名字没到
// 之前参数只能先攒着：有的上游会把 arguments 先于 name 发出来，直接开场会得到一个
// Claude Code 无法回传的匿名工具调用。
func (t *StreamTranslator) openTool(slot *toolSlot) {
	if slot.open || slot.name == "" {
		return
	}
	slot.open = true
	slot.block = t.nextIndex
	t.nextIndex++
	t.send("content_block_start", contentBlockStartFrame{
		Type:  "content_block_start",
		Index: slot.block,
		ContentBlock: toolUseBlock{
			Type:  "tool_use",
			ID:    slot.id,
			Name:  slot.name,
			Input: map[string]any{},
		},
	})
	if slot.buffer != "" {
		t.send("content_block_delta", contentBlockDeltaFrame{
			Type:  "content_block_delta",
			Index: slot.block,
			Delta: inputJSONDelta{Type: "input_json_delta", PartialJSON: slot.buffer},
		})
		slot.buffer = ""
	}
}

// sortedSlots 按块下标排序（未开场的是 -1，排在最前）。
//
// 用稳定排序：同一档位里保持到达顺序 —— Node 的 Array.sort 也是稳定的，
// 补开场时块的先后就靠它对齐。
func (t *StreamTranslator) sortedSlots() []*toolSlot {
	sorted := make([]*toolSlot, len(t.slots))
	copy(sorted, t.slots)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].block < sorted[j].block })
	return sorted
}

// send 写一个完整的 SSE 帧。data 里每个载荷都带一个与事件名同名的 type 字段
// （Anthropic 的约定，客户端也确实照着它分支）。
func (t *StreamTranslator) send(event string, payload any) {
	frame := make([]byte, 0, 128)
	frame = append(frame, "event: "...)
	frame = append(frame, event...)
	frame = append(frame, "\ndata: "...)
	frame = append(frame, marshal(payload)...)
	frame = append(frame, "\n\n"...)
	t.write(frame)
}

// ── 帧的载荷形状 ───────────────────────────────────────────────────────────

type messageStartFrame struct {
	Type    string       `json:"type"`
	Message startMessage `json:"message"`
}

type startMessage struct {
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	Role         string  `json:"role"`
	Model        string  `json:"model"`
	Content      []any   `json:"content"`
	StopReason   *string `json:"stop_reason"`
	StopSequence *string `json:"stop_sequence"`
	Usage        Usage   `json:"usage"`
}

type contentBlockStartFrame struct {
	Type         string `json:"type"`
	Index        int    `json:"index"`
	ContentBlock any    `json:"content_block"`
}

type contentBlockDeltaFrame struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Delta any    `json:"delta"`
}

type contentBlockStopFrame struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
}

type messageDeltaFrame struct {
	Type  string           `json:"type"`
	Delta messageDeltaBody `json:"delta"`
	Usage Usage            `json:"usage"`
}

type messageDeltaBody struct {
	StopReason   string  `json:"stop_reason"`
	StopSequence *string `json:"stop_sequence"`
}

type messageStopFrame struct {
	Type string `json:"type"`
}

// toolUseBlock 是 content_block_start 里的工具块；input 固定给空对象，
// 真正的参数随后由 input_json_delta 一片片补上。
type toolUseBlock struct {
	Type  string         `json:"type"`
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

type inputJSONDelta struct {
	Type        string `json:"type"`
	PartialJSON string `json:"partial_json"`
}
