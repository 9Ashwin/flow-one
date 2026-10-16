// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func decodeWire(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var wire map[string]any
	require.NoError(t, json.Unmarshal(payload, &wire))
	return wire
}

func wireMessages(t *testing.T, wire map[string]any) []map[string]any {
	t.Helper()
	raw, ok := wire["messages"].([]any)
	require.True(t, ok, "messages 必须是数组")
	messages := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		message, ok := item.(map[string]any)
		require.True(t, ok)
		messages = append(messages, message)
	}
	return messages
}

// 国际版网关对首条不是 system 的请求回 400 + 11128，所以**无条件**补一条。
func TestToBuddyBodyPrependsSystem(t *testing.T) {
	wire := decodeWire(t, mustBody(t, `{"model":"x","messages":[{"role":"user","content":"你好"}]}`, "deepseek-v4.1-flash", modelMeta{}))

	messages := wireMessages(t, wire)
	require.Len(t, messages, 2)
	assert.Equal(t, "system", messages[0]["role"])
	assert.Equal(t, defaultSystem, messages[0]["content"])
	assert.Equal(t, "user", messages[1]["role"])
	assert.Equal(t, "你好", messages[1]["content"])

	// 空 messages 也要补一条 system
	wire = decodeWire(t, mustBody(t, `{"model":"x"}`, "deepseek-v4.1-flash", modelMeta{}))
	messages = wireMessages(t, wire)
	require.Len(t, messages, 1)
	assert.Equal(t, "system", messages[0]["role"])
}

// 客户端已经给了 system 就别再插一条。
func TestToBuddyBodyKeepsExistingSystem(t *testing.T) {
	payload := `{"model":"x","messages":[{"role":"system","content":"自己写的"},{"role":"user","content":"hi"}]}`
	wire := decodeWire(t, mustBody(t, payload, "deepseek-v4.1-flash", modelMeta{}))

	messages := wireMessages(t, wire)
	require.Len(t, messages, 2)
	assert.Equal(t, "自己写的", messages[0]["content"])
}

// 官方客户端从不发 tool_choice 与 top_p，转发一个没被验证过的参数只会换来 400。
func TestToBuddyBodyDropsUnverifiedFields(t *testing.T) {
	payload := `{"model":"x","messages":[{"role":"system","content":"s"}],"tool_choice":"auto","top_p":0.9,"frequency_penalty":0.5,"n":2}`
	wire := decodeWire(t, mustBody(t, payload, "glm-5.3", modelMeta{}))

	for _, key := range []string{"tool_choice", "top_p", "frequency_penalty", "n"} {
		assert.NotContains(t, wire, key, key)
	}
	assert.Equal(t, "glm-5.3", wire["model"], "model 用裸 ID")
	assert.Equal(t, true, wire["stream"], "这条上游没有非流式接口")
}

// 透传的是被验证过的那几个字段，空数组按「没给」处理。
func TestToBuddyBodyPassesThroughSupportedFields(t *testing.T) {
	payload := `{"messages":[{"role":"system","content":"s"}],
		"tools":[{"type":"function","function":{"name":"Bash"}}],
		"temperature":0.3,"stop":["\n\n"],"max_tokens":512}`
	wire := decodeWire(t, mustBody(t, payload, "glm-5.3", modelMeta{maxOutputTokens: 8192}))

	assert.Len(t, wire["tools"].([]any), 1)
	assert.Equal(t, 0.3, wire["temperature"])
	assert.Len(t, wire["stop"].([]any), 1)
	assert.Equal(t, float64(512), wire["max_tokens"])

	empty := decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}],"tools":[],"stop":[]}`, "glm-5.3", modelMeta{}))
	assert.NotContains(t, empty, "tools")
	assert.NotContains(t, empty, "stop")
}

// 按模型上限裁 max_tokens：调用方要得再多也不能超。
func TestToBuddyBodyClampsMaxTokens(t *testing.T) {
	cases := []struct {
		name     string
		fields   string // 拼在 system 消息之后的字段，自带前导逗号
		meta     modelMeta
		expected any
	}{
		{"超上限就裁到上限", `,"max_tokens":999999`, modelMeta{maxOutputTokens: 8192}, float64(8192)},
		{"没超就照原样", `,"max_tokens":512`, modelMeta{maxOutputTokens: 8192}, float64(512)},
		{"调用方没给但有上限", ``, modelMeta{maxOutputTokens: 8192}, float64(8192)},
		{"没给也没上限就不发", ``, modelMeta{}, nil},
		{"小数按 Node 版取整", `,"max_tokens":100.9`, modelMeta{}, float64(100)},
		{"数字串也算（Number(x) 的语义）", `,"max_tokens":"512"`, modelMeta{maxOutputTokens: 8192}, float64(512)},
		{"0 当没给", `,"max_tokens":0`, modelMeta{}, nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := `{"messages":[{"role":"system","content":"s"}]` + testCase.fields + `}`
			wire := decodeWire(t, mustBody(t, payload, "glm-5.3", testCase.meta))
			if testCase.expected == nil {
				assert.NotContains(t, wire, "max_tokens")
				return
			}
			assert.Equal(t, testCase.expected, wire["max_tokens"])
		})
	}
}

// deepseek 族要同时带 thinking 与 reasoning_effort：只有 reasoning_effort 能打开
// 思考，thinking 单独不生效。
func TestToBuddyBodyDeepSeekThinking(t *testing.T) {
	meta := modelMeta{efforts: []string{"low", "high"}}

	wire := decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}],"reasoning_effort":"low"}`, "deepseek-v4.1-flash", meta))
	assert.Equal(t, map[string]any{"type": "enabled"}, wire["thinking"])
	assert.Equal(t, "low", wire["reasoning_effort"])

	// 调用方没给档位时用默认（没有 defaultEffort 时优先 high）
	wire = decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}]}`, "deepseek-v4.1-flash", meta))
	assert.Equal(t, "high", wire["reasoning_effort"])

	// 上游声明的 defaultEffort 说了算
	wire = decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}]}`, "deepseek-v4.1-flash",
		modelMeta{efforts: []string{"low", "medium", "high"}, defaultEffort: "medium"}))
	assert.Equal(t, "medium", wire["reasoning_effort"])

	// 一个档位都没声明时只带 thinking
	wire = decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}]}`, "deepseek-v4.1-flash", modelMeta{}))
	assert.Equal(t, map[string]any{"type": "enabled"}, wire["thinking"])
	assert.NotContains(t, wire, "reasoning_effort")

	// 非 deepseek 族不带 thinking
	wire = decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}],"reasoning_effort":"low"}`, "glm-5.3", meta))
	assert.NotContains(t, wire, "thinking")
	assert.Equal(t, "low", wire["reasoning_effort"])
}

// 档位只发上游声明支持的那些。
func TestToBuddyBodyOnlySendsSupportedEfforts(t *testing.T) {
	meta := modelMeta{efforts: []string{"low", "high"}}

	wire := decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}],"reasoning_effort":"max"}`, "glm-5.3", meta))
	assert.NotContains(t, wire, "reasoning_effort")

	// 一个档位都没声明时，任何档位都不发（免得换来 422）
	wire = decodeWire(t, mustBody(t, `{"messages":[{"role":"system","content":"s"}],"reasoning_effort":"low"}`, "glm-5.3", modelMeta{}))
	assert.NotContains(t, wire, "reasoning_effort")
}

// prompt_cache_key：同一段 system 前缀稳定命中（计费差约 17 倍），换 system 或
// 换模型都必须换键。
func TestCacheKeyFor(t *testing.T) {
	messages := []json.RawMessage{
		json.RawMessage(`{"role":"system","content":"你是助手"}`),
		json.RawMessage(`{"role":"user","content":"hi"}`),
	}
	sum := sha256.Sum256([]byte("deepseek-v4.1-flash\x00你是助手"))
	expected := hex.EncodeToString(sum[:])[:32]

	assert.Equal(t, expected, cacheKeyFor(messages, "deepseek-v4.1-flash"))
	assert.Len(t, expected, 32)
	assert.NotEqual(t, expected, cacheKeyFor(messages, "glm-5.3"))
	assert.NotEqual(t, expected, cacheKeyFor([]json.RawMessage{
		json.RawMessage(`{"role":"system","content":"别的提示"}`),
	}, "deepseek-v4.1-flash"))
	// content 不是字符串（数组形状）时按空串算，与 Node 版一致
	assert.Equal(t,
		cacheKeyFor(nil, "glm-5.3"),
		cacheKeyFor([]json.RawMessage{json.RawMessage(`{"role":"system","content":[{"type":"text"}]}`)}, "glm-5.3"))
}

// 出站报文里一定带 prompt_cache_key，且与 messages 里的 system 对得上。
func TestToBuddyBodyCarriesCacheKey(t *testing.T) {
	wire := decodeWire(t, mustBody(t, `{"messages":[{"role":"user","content":"你好"}]}`, "glm-5.3", modelMeta{}))

	key, ok := wire["prompt_cache_key"].(string)
	require.True(t, ok)
	sum := sha256.Sum256([]byte("glm-5.3\x00" + defaultSystem))
	assert.Equal(t, hex.EncodeToString(sum[:])[:32], key)
}

func TestToBuddyBodyRejectsNonJSON(t *testing.T) {
	_, err := toBuddyBody([]byte("not json"), "glm-5.3", modelMeta{})
	require.Error(t, err)
}

// mustBody 跑一遍 toBuddyBody，顺带断言结果是合法 JSON。
func mustBody(t *testing.T, payload string, model string, meta modelMeta) []byte {
	t.Helper()
	wire, err := toBuddyBody([]byte(payload), model, meta)
	require.NoError(t, err)
	return wire
}
