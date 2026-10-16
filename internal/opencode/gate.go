// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"strings"

	"github.com/9Ashwin/flow-one/internal/source"
)

// GateTools 是门禁要求的四个小写工具名。顺序固定：补桩按这个顺序追加，文本才可断言。
var GateTools = []string{"bash", "glob", "grep", "read"}

// Gate 描述一次门禁改写的结果。
type Gate struct {
	// Rename 是「出站小写名 → 调用方原名」：响应里要据此改回去，否则 Claude Code
	// 认不出 `bash` 这个工具。
	Rename map[string]string
	// Stubs 是只存在于桩里的名字：调用方没有这个工具，模型对它的调用必须**整条丢弃**，
	// 转发过去只会变成一条无从处理的错误。
	Stubs map[string]bool
}

// ApplyFreeTierGate 给请求体套上免费档要求的形状：
//
//   - `stream` 强制为 true；
//   - tools 里必须有 bash/glob/grep/read 四个小写 function，各自 parameters 至少一个 property；
//   - 调用方声明过的门禁工具（不分大小写）出站改小写，其余工具原样保留（大小写也不动）。
//
// 返回的 Gate 供响应侧把工具名改回去、并丢弃对桩的调用。入参不被修改。
func ApplyFreeTierGate(body map[string]any) (map[string]any, Gate) {
	tools, _ := body["tools"].([]any)
	rewritten := make([]any, 0, len(tools)+len(GateTools))
	rename := map[string]string{}
	declared := map[string]bool{}
	for _, item := range tools {
		tool, isTool := item.(map[string]any)
		if !isTool {
			rewritten = append(rewritten, item)
			continue
		}
		function, hasFunction := tool["function"].(map[string]any)
		if !hasFunction {
			rewritten = append(rewritten, item)
			continue
		}
		name, isName := function["name"].(string)
		if !isName || name == "" {
			rewritten = append(rewritten, item)
			continue
		}
		lower := strings.ToLower(name)
		if !isGateTool(lower) {
			rewritten = append(rewritten, item)
			continue
		}
		declared[lower] = true
		if lower == name {
			rewritten = append(rewritten, item)
			continue
		}
		rename[lower] = name
		rewritten = append(rewritten, renameTool(tool, function, lower))
	}
	stubs := map[string]bool{}
	for _, gate := range GateTools {
		if declared[gate] {
			continue
		}
		stubs[gate] = true
		rewritten = append(rewritten, stubTool(gate))
	}
	gated := make(map[string]any, len(body)+2)
	for key, value := range body {
		gated[key] = value
	}
	gated["stream"] = true
	gated["tools"] = rewritten
	return gated, Gate{Rename: rename, Stubs: stubs}
}

// renameTool 复制一份工具并把名字换成小写（不改调用方的 map）。
func renameTool(tool map[string]any, function map[string]any, name string) map[string]any {
	renamedFunction := make(map[string]any, len(function))
	for key, value := range function {
		renamedFunction[key] = value
	}
	renamedFunction["name"] = name
	renamed := make(map[string]any, len(tool))
	for key, value := range tool {
		renamed[key] = value
	}
	renamed["function"] = renamedFunction
	return renamed
}

// stubTool 是给门禁看的「摆设」：调用方没声明这个工具，所以我们补一个占位，
// 并在响应里把模型对它的调用整条丢掉。parameters 仍要声明一个 property —— 门禁查这个。
func stubTool(name string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": "Reserved for the host runtime; do not call it.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"input": map[string]any{"type": "string", "description": "Unavailable; do not use."},
				},
			},
		},
	}
}

func isGateTool(name string) bool {
	for _, gate := range GateTools {
		if gate == name {
			return true
		}
	}
	return false
}

// restoreStream 改写上游分片里的工具名：改回调用方原名，桩工具的调用整条丢弃。
//
// 丢弃要按 `index` 记住：一个工具调用的名字在首片，参数在后面几片跟着到，
// 只丢首片会让后续参数片段变成一条没有名字的孤儿调用。
type restoreStream struct {
	inner   source.Stream
	gate    Gate
	dropped map[int]bool
}

func newRestoreStream(inner source.Stream, gate Gate) *restoreStream {
	return &restoreStream{inner: inner, gate: gate, dropped: map[int]bool{}}
}

func (s *restoreStream) Next() ([]byte, bool, error) {
	payload, more, err := s.inner.Next()
	if !more || err != nil {
		return payload, more, err
	}
	rewritten, touched := s.rewrite(payload)
	if !touched {
		// 没动过的帧必须原样透传（逐字节），别为了统一格式重排一遍 JSON。
		return payload, true, nil
	}
	return rewritten, true, nil
}

func (s *restoreStream) Close() error { return s.inner.Close() }

// rewrite 处理一帧。touched=false 表示这帧与门禁无关，调用方应原样透传。
func (s *restoreStream) rewrite(payload []byte) ([]byte, bool) {
	chunk, err := decodeBody(payload)
	if err != nil {
		return payload, false
	}
	choices, isList := chunk["choices"].([]any)
	if !isList {
		return payload, false
	}
	touched := false
	next := make([]any, len(choices))
	for position, item := range choices {
		choice, isChoice := item.(map[string]any)
		if !isChoice {
			next[position] = item
			continue
		}
		delta, hasDelta := choice["delta"].(map[string]any)
		if !hasDelta {
			next[position] = item
			continue
		}
		calls, hasCalls := delta["tool_calls"].([]any)
		if !hasCalls || len(calls) == 0 {
			next[position] = item
			continue
		}
		kept := make([]any, 0, len(calls))
		for _, raw := range calls {
			call, isCall := raw.(map[string]any)
			if !isCall {
				kept = append(kept, raw)
				continue
			}
			index := callIndex(call)
			if s.dropped[index] {
				touched = true
				continue
			}
			name := callName(call)
			if name != "" && s.gate.Stubs[strings.ToLower(name)] {
				s.dropped[index] = true
				touched = true
				continue
			}
			original, mustRename := "", false
			if name != "" {
				original, mustRename = s.gate.Rename[strings.ToLower(name)]
			}
			if !mustRename {
				kept = append(kept, call)
				continue
			}
			touched = true
			kept = append(kept, renameCall(call, original))
		}
		if touched {
			next[position] = withToolCalls(choice, delta, kept)
		} else {
			next[position] = item
		}
	}
	if !touched {
		return payload, false
	}
	chunk["choices"] = next
	encoded, err := json.Marshal(chunk)
	if err != nil {
		return payload, false
	}
	return encoded, true
}

// callIndex 取工具调用的分片序号；缺失时按 0 处理（与 Node 版一致）。
func callIndex(call map[string]any) int {
	number, isNumber := call["index"].(json.Number)
	if !isNumber {
		return 0
	}
	value, err := number.Int64()
	if err != nil {
		return 0
	}
	return int(value)
}

func callName(call map[string]any) string {
	function, isFunction := call["function"].(map[string]any)
	if !isFunction {
		return ""
	}
	name, _ := function["name"].(string)
	return name
}

// renameCall 复制一份调用并把 function.name 换成调用方的原名。
func renameCall(call map[string]any, name string) map[string]any {
	renamed := make(map[string]any, len(call))
	for key, value := range call {
		renamed[key] = value
	}
	function, isFunction := call["function"].(map[string]any)
	if !isFunction {
		return renamed
	}
	renamedFunction := make(map[string]any, len(function))
	for key, value := range function {
		renamedFunction[key] = value
	}
	renamedFunction["name"] = name
	renamed["function"] = renamedFunction
	return renamed
}

// withToolCalls 复制一份 choice 并替换 delta.tool_calls。
// 全被丢弃时留一个空数组（不是删掉字段）：翻译层据此知道这一段没有工具调用。
func withToolCalls(choice map[string]any, delta map[string]any, kept []any) map[string]any {
	nextDelta := make(map[string]any, len(delta))
	for key, value := range delta {
		nextDelta[key] = value
	}
	nextDelta["tool_calls"] = kept
	next := make(map[string]any, len(choice))
	for key, value := range choice {
		next[key] = value
	}
	next["delta"] = nextDelta
	return next
}
