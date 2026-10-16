// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestApplyFreeTierGateShapesTools(t *testing.T) {
	body := map[string]any{
		"stream": false,
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{
				"name": "Bash", "parameters": map[string]any{"type": "object", "properties": map[string]any{"command": map[string]any{"type": "string"}}},
			}},
			map[string]any{"type": "function", "function": map[string]any{
				"name": "Read", "parameters": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}},
			}},
			map[string]any{"type": "function", "function": map[string]any{"name": "Edit", "parameters": map[string]any{"type": "object"}}},
		},
	}
	gated, gate := ApplyFreeTierGate(body)

	assert.Equal(t, true, gated["stream"], "门禁要求 stream: true")
	names := toolNames(t, gated)
	for _, want := range GateTools {
		assert.Truef(t, contains(names, want), "缺少门禁工具 %s", want)
	}
	assert.Equal(t, 1, countOf(names, "bash"), "不能重复补桩")
	assert.True(t, contains(names, "Edit"), "非门禁工具原样保留（大小写也不动）")

	// 调用方自己声明过的：出站小写、响应要改回原名
	assert.Equal(t, "Bash", gate.Rename["bash"])
	assert.Equal(t, "Read", gate.Rename["read"])
	// 调用方没声明的：桩，响应里要丢弃
	assert.Equal(t, map[string]bool{"glob": true, "grep": true}, gate.Stubs)

	// 每个门禁工具（含桩）都要声明至少一个 property，否则一样被 403
	tools, _ := gated["tools"].([]any)
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		function, _ := tool["function"].(map[string]any)
		name, _ := function["name"].(string)
		if !isGateTool(name) {
			continue
		}
		parameters, _ := function["parameters"].(map[string]any)
		properties, _ := parameters["properties"].(map[string]any)
		assert.NotEmptyf(t, properties, "门禁工具 %s 至少要有 一个 property", name)
	}

	// 入参不被修改：翻译层复用的 body 不能被我们改坏
	assert.Equal(t, false, body["stream"])
	originalNames := toolNames(t, body)
	assert.True(t, contains(originalNames, "Bash"), "入参里的原名要留着")
	assert.False(t, contains(originalNames, "glob"), "入参里不该多出桩")
}

func TestApplyFreeTierGateKeepsNonFunctionTools(t *testing.T) {
	body := map[string]any{"tools": []any{"not-a-tool", map[string]any{"type": "web_search"}}}
	gated, gate := ApplyFreeTierGate(body)
	tools, isList := gated["tools"].([]any)
	require.True(t, isList)
	require.Len(t, tools, 6)
	// 认不出的工具原样留着（连位置都不动），四个桩补在后面
	assert.Equal(t, "not-a-tool", tools[0])
	assert.Equal(t, map[string]any{"type": "web_search"}, tools[1])
	for index, want := range GateTools {
		tool, _ := tools[index+2].(map[string]any)
		function, _ := tool["function"].(map[string]any)
		assert.Equal(t, want, function["name"])
	}
	assert.Empty(t, gate.Rename)
	assert.Len(t, gate.Stubs, 4)
}

func TestApplyFreeTierGateWithoutToolsAddsFourStubs(t *testing.T) {
	gated, gate := ApplyFreeTierGate(map[string]any{"messages": []any{}})
	assert.Equal(t, []string{"bash", "glob", "grep", "read"}, toolNames(t, gated))
	assert.Len(t, gate.Stubs, 4)
}

// fakeStream 把固定几帧喂进 restoreStream。
type fakeStream struct {
	frames [][]byte
	at     int
}

func (f *fakeStream) Next() ([]byte, bool, error) {
	if f.at >= len(f.frames) {
		return nil, false, nil
	}
	frame := f.frames[f.at]
	f.at++
	return frame, true, nil
}

func (f *fakeStream) Close() error { return nil }

func TestRestoreStreamDropsStubArgumentsToo(t *testing.T) {
	gate := Gate{Rename: map[string]string{"bash": "Bash"}, Stubs: map[string]bool{"glob": true}}
	frames := [][]byte{
		[]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"bash","arguments":"{\"command\":"}}]}}]}`),
		[]byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}`),
		[]byte(`{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"glob","arguments":"{\"pattern\":\"*\"}"}}]}}]}`),
		[]byte(`{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"}"}}]}}]}`),
		[]byte(`{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}`),
	}
	stream := newRestoreStream(&fakeStream{frames: frames}, gate)

	// 第一片：改回原名
	payload, ok, err := stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	var first map[string]any
	require.NoError(t, json.Unmarshal(payload, &first))
	assert.Equal(t, "Bash", firstToolName(t, first))

	// 第二片（同一 index 的纯参数帧）：原样透传，不能被改名逻辑吃掉
	payload, ok, err = stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, string(frames[1]), string(payload))

	// 第三片：桩的首片，整条丢弃
	payload, ok, err = stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	var third map[string]any
	require.NoError(t, json.Unmarshal(payload, &third))
	assert.Equal(t, []any{}, firstChoiceDelta(t, third)["tool_calls"])

	// 第四片：桩的纯参数帧 —— 只丢首片会让它变成一条没有名字的孤儿调用，必须一起丢
	payload, ok, err = stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	var fourth map[string]any
	require.NoError(t, json.Unmarshal(payload, &fourth))
	assert.Equal(t, []any{}, firstChoiceDelta(t, fourth)["tool_calls"])

	// 与工具无关的帧：逐字节原样
	payload, ok, err = stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, string(frames[4]), string(payload))

	_, ok, err = stream.Next()
	require.NoError(t, err)
	assert.False(t, ok)
	require.NoError(t, stream.Close())
	require.NoError(t, stream.Close())
}

func TestRestoreStreamLeavesCleanFramesAlone(t *testing.T) {
	stream := newRestoreStream(&fakeStream{frames: [][]byte{[]byte(`{"choices":[{"delta":{"content":"hi"}}]}`)}}, Gate{})
	payload, ok, err := stream.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, `{"choices":[{"delta":{"content":"hi"}}]}`, string(payload))
}

var _ source.Stream = (*fakeStream)(nil)
