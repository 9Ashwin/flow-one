// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package anthropic 是 Anthropic Messages ⇄ OpenAI Chat Completions 的纯翻译层。
//
// 这里只做数据变换：Anthropic 请求体进、OpenAI 请求体出；OpenAI 分片进、Anthropic
// SSE 帧出。没有 socket、没有定时器、没有文件系统 —— 所以整层可以脱离服务器直接测。
//
// # 套餐分离（本项目最容易写错的一条）
//
// 内容风控改写只对 WorkBuddy 那两条线做。本包因此**只看 Rewriter 是不是 nil**，
// 绝不按模型名前缀猜来源：Rewriter 为 nil 时出站 system 与 flattenSystem 的结果
// 逐字节相同。任何「模型名像腾讯就顺手改写」的旁路，都会让 OpenCode 的流量被白白
// 改写，还会打掉上游的前缀缓存。
//
// # 请求侧映射
//
//	system（字符串或块数组）→ 首条 {role:"system"} 消息
//	text 块                 → {type:"text"} 部分（全是文本时收敛成裸字符串）
//	image 块（base64/url）  → {type:"image_url"} 部分
//	tool_use 块             → 助手消息上的 tool_calls[]
//	tool_result 块          → {role:"tool", tool_call_id} 独立消息
//	tools[].input_schema    → tools[].function.parameters
//	thinking.budget_tokens  → reasoning_effort
//	stop_sequences          → stop
//
// 响应侧的 stop_reason：本轮出现过工具调用就是 tool_use，否则 length → max_tokens、
// 其余 → end_turn；响应头已经发出去之后才失败，只能走流内 error 事件。
package anthropic

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// 本地 token 估算的三个常数。本桥不自带分词器：按 4 字符 ≈ 1 token 折，
// 图片与工具帧各记一笔固定开销 —— 估得准不如估得稳。
const (
	imageTokens   = 1024
	charsPerToken = 4
	baseTokens    = 16
)

// stopReasons 把上游的 finish_reason 折成 Anthropic 的 stop_reason。
// content_filter 归 end_turn：Anthropic 没有对应取值，而这一轮确实正常结束了。
var stopReasons = map[string]string{
	"stop":           "end_turn",
	"length":         "max_tokens",
	"tool_calls":     "tool_use",
	"function_call":  "tool_use",
	"content_filter": "end_turn",
}

// mappedStopReason 只做表查询：认得的映射过去，不认得的当 end_turn。
func mappedStopReason(finishReason string) string {
	if mapped, ok := stopReasons[finishReason]; ok {
		return mapped
	}
	return "end_turn"
}

// stopReasonFor 是响应侧的收尾判据：本轮出现过工具调用就是 tool_use，
// 否则才轮到上游的 finish_reason。
func stopReasonFor(outcome *Outcome) string {
	if len(outcome.ToolCalls) > 0 {
		return "tool_use"
	}
	return mappedStopReason(outcome.FinishReason)
}

// ── 出站 JSON ───────────────────────────────────────────────────────────────

// marshal 序列化出站 JSON。关掉 HTML 转义：Go 默认会把 <、>、& 写成 \u003c 之类，
// 语义虽然没变，但会让日志和逐字节断言都难读。
func marshal(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		// 出站结构全是本包自己拼的可序列化类型，走到这里只可能是代码 bug。
		return []byte("null")
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
}

// jsonText 把已经解析过的 JSON 值重新序列化回文本（Node 的 JSON.stringify）。
func jsonText(value any) string {
	return string(marshal(value))
}

// ── 形状判定 ───────────────────────────────────────────────────────────────
//
// 上游报文是别人给的，形状只能靠运行时检查，不能靠类型断言硬拆；
// 下面这组 as* 就是 Node 里 isObject / Array.isArray / typeof / Number.isFinite 的对应物。

// parseObject 解析一帧上游报文；不是 JSON 对象（坏帧、数组、标量）时返回 nil。
func parseObject(payload []byte) map[string]any {
	var parsed any
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil
	}
	object, _ := asObject(parsed)
	return object
}

func asObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

func asArray(value any) ([]any, bool) {
	items, ok := value.([]any)
	return items, ok
}

// asArrayOrNil 给「遍历一个可能不是数组的字段」用：非数组时返回 nil，
// range 上去就是空循环，等价于 Node 的 `Array.isArray(x) ? x : []`。
func asArrayOrNil(value any) []any {
	items, _ := asArray(value)
	return items
}

func asString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// asNumber 对应 Node 的 Number() + Number.isFinite()：JSON 数字与数字字符串都认，
// 其余（null、布尔、对象、非数字字符串）一律当「没给」。
//
// 与 Node 的一处刻意分歧：Number(null) 是 0，这里不会把 null 变成 0 ——
// 「没设温度」和「温度是 0」在出站报文里不是一个意思。
func asNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	}
	return 0, false
}

// asInteger 对应 Number.isInteger：工具调用的 index 只有整数才算下标。
func asInteger(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || math.Trunc(number) != number || math.IsInf(number, 0) {
		return 0, false
	}
	return int(number), true
}

// utf16Len 是字符串的 UTF-16 码元数。Node 的 String.length 就是这个口径；
// token 估算与它对齐，同一段带 emoji 的上下文才不会算出两个数。
func utf16Len(text string) int {
	units := 0
	for _, r := range text {
		if r > 0xFFFF {
			units += 2
			continue
		}
		units++
	}
	return units
}

// ── 共用的内容块形状 ────────────────────────────────────────────────────────

// thinkingBlock 是推理块。流式开场时 thinking 是空串，非流式消息体里是一次性给全。
type thinkingBlock struct {
	Type     string `json:"type"`
	Thinking string `json:"thinking"`
}

// textBlock 是文本块，同上。
type textBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ── 错误信封 ───────────────────────────────────────────────────────────────

// errorEnvelope 与 errorBody 是 Anthropic 的错误信封：
// HTTP 层的 4xx/5xx 与流内的 error 事件共用同一个形状。
type errorEnvelope struct {
	Type  string    `json:"type"`
	Error errorBody `json:"error"`
}

type errorBody struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// ErrorBody 渲染一个可直写的 Anthropic 错误信封（服务端在发不出成功响应时用它）。
func ErrorBody(kind, message string) []byte {
	return marshal(errorEnvelope{Type: "error", Error: errorBody{Type: kind, Message: message}})
}
