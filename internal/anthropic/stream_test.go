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

// recorder 收帧。断言直接盯着写出去的 SSE 字节 —— 成帧错了，Claude Code 就整轮读不动。
type recorder struct {
	frames []string
}

func (r *recorder) write(frame []byte) { r.frames = append(r.frames, string(frame)) }

// events 取出帧序列里的事件名（每帧的第一行）。
func (r *recorder) events() []string {
	events := make([]string, 0, len(r.frames))
	for _, frame := range r.frames {
		line, _, _ := strings.Cut(frame, "\n")
		events = append(events, strings.TrimPrefix(line, "event: "))
	}
	return events
}

// joined 把所有帧拼起来，方便做「某个形状出现过/没出现过」的断言。
func (r *recorder) joined() string { return strings.Join(r.frames, "") }

// payloadAt 解析第 at 帧的 data 部分。
func (r *recorder) payloadAt(t *testing.T, at int) map[string]any {
	t.Helper()
	require.Greater(t, len(r.frames), at)
	_, data, ok := strings.Cut(r.frames[at], "\ndata: ")
	require.True(t, ok, "第 %d 帧没有 data 行", at)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal([]byte(strings.TrimSuffix(data, "\n\n")), &parsed))
	return parsed
}

// payloadWhere 找出第一条内容里含 substr 的帧，并解析它的 data。
func (r *recorder) payloadWhere(t *testing.T, substr string) map[string]any {
	t.Helper()
	for at, frame := range r.frames {
		if strings.Contains(frame, substr) {
			return r.payloadAt(t, at)
		}
	}
	t.Fatalf("没有任何一帧包含 %q；实际帧序列：%v", substr, r.events())
	return nil
}

// newStream 造一个渲染器与它的收帧器。
func newStream(opts StreamOptions) (*StreamTranslator, *recorder) {
	sink := &recorder{}
	opts.Write = sink.write
	return NewStreamTranslator(opts), sink
}

func TestStreamTextFrames(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_1"})

	assert.True(t, stream.Push([]byte(`{"choices":[{"delta":{"content":"你"}}]}`)))
	assert.True(t, stream.Push([]byte(`{"choices":[{"delta":{"content":"好"}}]}`)))
	assert.True(t, stream.Push([]byte(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}`)))
	stream.End()

	assert.Equal(t, []string{
		"message_start", "content_block_start", "content_block_delta", "content_block_delta",
		"content_block_stop", "message_delta", "message_stop",
	}, frames.events())

	// 第一帧逐字节固定：Claude Code 就靠这个形状认流。
	assert.Equal(t, `event: message_start`+"\n"+`data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}`+"\n\n",
		frames.frames[0])

	delta := frames.payloadAt(t, 2)
	assert.Equal(t, "content_block_delta", delta["type"])
	assert.Equal(t, float64(0), delta["index"])
	assert.Equal(t, map[string]any{"type": "text_delta", "text": "你"}, delta["delta"])

	final := frames.payloadAt(t, 5)
	assert.Equal(t, "message_delta", final["type"])
	assert.Equal(t, map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, final["delta"])
	assert.Equal(t, map[string]any{"input_tokens": float64(7), "output_tokens": float64(2)}, final["usage"])
	assert.Equal(t, map[string]any{"type": "message_stop"}, frames.payloadAt(t, 6))
}

func TestStreamToolCallFrames(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_2"})

	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Read","arguments":"{\"file"}}]}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\":\"/a\"}"}}]}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`))
	stream.End()

	start := frames.payloadWhere(t, `"tool_use"`)
	assert.Equal(t, map[string]any{"type": "tool_use", "id": "call_a", "name": "Read", "input": map[string]any{}}, start["content_block"])

	arguments := frames.payloadWhere(t, "input_json_delta")
	assert.Equal(t, `{"file`, arguments["delta"].(map[string]any)["partial_json"])
	assert.Contains(t, frames.joined(), `_path\":\"/a\"}`, "参数分片要一片片往外吐")

	final := frames.payloadWhere(t, "message_delta")
	assert.Equal(t, "tool_use", final["delta"].(map[string]any)["stop_reason"])
}

func TestStreamBuffersArgumentsUntilNameArrives(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_3"})

	// 有的上游把 arguments 先于 name 发出来。块必须带着名字开场，所以先攒着。
	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":1}"}}]}}]}`))
	assert.NotContains(t, frames.joined(), "tool_use", "名字没到之前不该开场")
	assert.Equal(t, []string{"message_start"}, frames.events())

	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"Glob"}}]}}]}`))
	stream.End()

	joined := frames.joined()
	assert.Contains(t, joined, `"name":"Glob"`)
	arguments := frames.payloadWhere(t, "input_json_delta")
	assert.Equal(t, `{"a":1}`, arguments["delta"].(map[string]any)["partial_json"], "攒下的参数要在开场后补齐")
	assert.Equal(t, []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}, frames.events())
}

func TestStreamInStreamErrorSkipsMessageDelta(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_4"})

	assert.False(t, stream.Push([]byte(`{"error":{"message":"内容被安全策略拦截"}}`)), "错误帧要让调用方停下来")
	require.NotNil(t, stream.Failure())
	assert.Equal(t, "内容被安全策略拦截", stream.Failure().Message)
	stream.Fail(stream.Failure().Message)

	joined := frames.joined()
	assert.Contains(t, joined, "event: error")
	assert.Contains(t, joined, `"type":"api_error"`)
	assert.Contains(t, joined, "内容被安全策略拦截")
	assert.NotContains(t, joined, "message_delta", "失败的一轮不能发 message_delta：客户端会当成正常结束")
	assert.Contains(t, joined, "event: message_stop")
	assert.Equal(t, []string{"message_start", "error", "message_stop"}, frames.events())

	// 收尾之后再来的帧一律无视，别把已经关掉的流又写脏。
	stream.End()
	stream.Fail("再来一次")
	stream.Push([]byte(`{"choices":[{"delta":{"content":"晚了"}}]}`))
	assert.Equal(t, []string{"message_start", "error", "message_stop"}, frames.events())
}

func TestStreamThinkingFramesFollowShowThinking(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_5", ShowThinking: true})

	stream.Push([]byte(`{"choices":[{"delta":{"reasoning_content":"先想"}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{"reasoning":"再想"}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{"content":"说"}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{"reasoning_content":"又想"}}]}`))
	stream.End()

	assert.Equal(t, []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // 推理块
		"content_block_start", "content_block_delta", "content_block_stop", // 文本块
		"content_block_start", "content_block_delta", "content_block_stop", // 推理块又开一个
		"message_delta", "message_stop",
	}, frames.events())

	thinking := frames.payloadAt(t, 1)
	assert.Equal(t, map[string]any{"type": "thinking", "thinking": ""}, thinking["content_block"])
	delta := frames.payloadAt(t, 2)
	assert.Equal(t, map[string]any{"type": "thinking_delta", "thinking": "先想"}, delta["delta"])

	// 没开开关时推理一个字都不该出去。
	quiet, quietFrames := newStream(StreamOptions{Model: "m", ID: "msg_6"})
	quiet.Push([]byte(`{"choices":[{"delta":{"reasoning_content":"先想","content":"说"}}]}`))
	quiet.End()
	assert.NotContains(t, quietFrames.joined(), "thinking")
}

func TestStreamClosesUnopenedToolAtEnd(t *testing.T) {
	// 参数到齐了但名字一直没来：收尾时补开场，给个占位名字，别让这一轮白丢。
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_7"})
	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`))
	stream.End()

	start := frames.payloadWhere(t, "tool_use")
	assert.Equal(t, "unknown_tool", start["content_block"].(map[string]any)["name"])
	assert.Equal(t, []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}, frames.events())
	assert.Equal(t, "tool_use", frames.payloadWhere(t, "message_delta")["delta"].(map[string]any)["stop_reason"])
}

func TestStreamKeepsParallelToolBlocksInOrder(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_8"})
	stream.Push([]byte(`{"choices":[{"delta":{"tool_calls":[
		{"index":1,"id":"c2","function":{"name":"Glob","arguments":"{}"}},
		{"index":0,"id":"c1","function":{"name":"Read","arguments":"{}"}}
	]}}]}`))
	stream.End()

	// 块下标按到达顺序分配，收尾关块时按块下标排序 —— 与 Node 版的稳定排序一致。
	var indexes []float64
	for _, frame := range frames.frames {
		if !strings.Contains(frame, "content_block_start") {
			continue
		}
		var parsed map[string]any
		require.NoError(t, json.Unmarshal([]byte(strings.TrimSuffix(strings.SplitN(frame, "\ndata: ", 2)[1], "\n\n")), &parsed))
		indexes = append(indexes, parsed["index"].(float64))
	}
	assert.Equal(t, []float64{0, 1}, indexes)
	assert.Equal(t, []string{"message_start", "content_block_start", "content_block_delta", "content_block_start", "content_block_delta", "content_block_stop", "content_block_stop", "message_delta", "message_stop"}, frames.events())
}

func TestStreamEndWithoutChunksStillEmitsAFullTurn(t *testing.T) {
	// 上游一个字都没吐就 EOF 了：也得给出完整的空轮次，客户端才不会一直等。
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_9", InputTokens: 5})
	stream.End()

	assert.Equal(t, []string{"message_start", "message_delta", "message_stop"}, frames.events())
	final := frames.payloadAt(t, 1)
	assert.Equal(t, "end_turn", final["delta"].(map[string]any)["stop_reason"])
	assert.Equal(t, map[string]any{"input_tokens": float64(5), "output_tokens": float64(0)}, final["usage"])
	assert.Equal(t, Usage{InputTokens: 5, OutputTokens: 0}, stream.Usage())
}

func TestStreamIgnoresBadFramesButKeepsGoing(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_10"})
	assert.True(t, stream.Push([]byte(`不是 JSON`)))
	assert.True(t, stream.Push([]byte(`[1,2]`)))
	stream.Push([]byte(`{"choices":[{"delta":{"content":"活着"}}]}`))
	stream.End()

	assert.Contains(t, frames.joined(), `"text_delta","text":"活着"`)
	assert.Equal(t, []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}, frames.events())
}

func TestStreamDoesNotEmitEmptyTextOrThinkingBlocks(t *testing.T) {
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_11", ShowThinking: true})
	stream.Push([]byte(`{"choices":[{"delta":{"content":"","reasoning_content":""}}]}`))
	stream.Push([]byte(`{"choices":[{"delta":{"content":[]}}]}`))
	stream.End()

	assert.Equal(t, []string{"message_start", "message_delta", "message_stop"}, frames.events())
}

func TestStreamMessageStartKeepsTheConstructionEstimate(t *testing.T) {
	// 差分跑出来的一个真 bug：usage 帧可能先于第一个 delta 到达，而 message_start
	// 那时已经写出去了。第一帧报的是构造时的本地估算，收尾帧才报上游的计数。
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_1", InputTokens: 9})

	stream.Push([]byte(`{"usage":{"prompt_tokens":11,"completion_tokens":3}}`))
	stream.End()

	start := frames.payloadAt(t, 0)["message"].(map[string]any)["usage"].(map[string]any)
	assert.Equal(t, float64(9), start["input_tokens"], "第一帧报本地估算")
	final := frames.payloadAt(t, 1)["usage"].(map[string]any)
	assert.Equal(t, float64(11), final["input_tokens"], "收尾帧报上游计数")
	assert.Equal(t, float64(3), final["output_tokens"])
}

func TestStreamIgnoresFramesAfterAFailure(t *testing.T) {
	// 调用方本该在 false 之后停手；万一它继续喂帧，也不能把错误之后的内容
	// 当成正文发给客户端。
	stream, frames := newStream(StreamOptions{Model: "m", ID: "msg_1"})

	assert.False(t, stream.Push([]byte(`{"error":{"message":"内容被安全策略拦截"}}`)))
	assert.False(t, stream.Push([]byte(`{"choices":[{"delta":{"content":"不该出现"}}]}`)))
	assert.NotContains(t, frames.joined(), "不该出现", "错误之后的帧不能再变成正文")
	assert.Empty(t, frames.events(), "这一轮的内容一个块都不该开场")

	// 收尾只能走 Fail：错的是这一轮，不是这一帧。
	stream.Fail(stream.Failure().Message)
	assert.Equal(t, []string{"message_start", "error", "message_stop"}, frames.events())
	assert.NotContains(t, frames.joined(), "message_delta")
}
