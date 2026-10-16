// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/9Ashwin/flow-one/errs"
)

// defaultSystem 是补 system 时的兜底文案。
const defaultSystem = "You are a helpful assistant."

// modelMeta 是裁剪 max_tokens 与挑 reasoning 档位需要的元数据。
type modelMeta struct {
	maxOutputTokens int
	efforts         []string
	defaultEffort   string
}

// systemStub 是补在 messages[0] 的那条（角色是判据，内容是兜底文案）。
var systemStub = json.RawMessage(`{"role":"system","content":"` + defaultSystem + `"}`)

// toBuddyBody 把桥内部的 OpenAI 请求体改写成腾讯上游真正接受的形态。
//
// 三件事必须在这里做对：
//   - `messages[0]` 必须是 system（国际版网关对首条是 user 的请求直接回 400 + 11128），
//     所以无条件补一条，而不是只在客户端给了才带；
//   - 带 `prompt_cache_key`：同一段 system 前缀稳定命中原有缓存，实测同一请求的
//     计费差约 17 倍；
//   - 丢掉 `tool_choice` 与 `top_p`：官方客户端从不发它们，转发一个没被验证过的
//     参数只会换来一个 400。别的未知字段同样不进报文（整个报文在这里重建）。
func toBuddyBody(raw []byte, model string, meta modelMeta) ([]byte, error) {
	envelope := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, errs.Internal(errs.SubtypeParseFailed, "请求体不是合法的 JSON 对象").WithCause(err)
	}
	messages := decodeMessages(envelope["messages"])
	if len(messages) == 0 || !isSystemMessage(messages[0]) {
		messages = append([]json.RawMessage{systemStub}, messages...)
	}

	wire := map[string]any{
		"model":            model,
		"messages":         messages,
		"stream":           true,
		"prompt_cache_key": cacheKeyFor(messages, model),
	}
	if tools, ok := nonEmptyArray(envelope["tools"]); ok {
		wire["tools"] = tools
	}
	if temperature, ok := strictNumber(envelope["temperature"]); ok {
		wire["temperature"] = temperature
	}
	if stop, ok := nonEmptyArray(envelope["stop"]); ok {
		wire["stop"] = stop
	}
	if requested, ok := numericValue(envelope["max_tokens"]); ok && requested > 0 {
		value := int64(math.Trunc(requested))
		if meta.maxOutputTokens > 0 && value > int64(meta.maxOutputTokens) {
			value = int64(meta.maxOutputTokens)
		}
		wire["max_tokens"] = value
	} else if meta.maxOutputTokens > 0 {
		wire["max_tokens"] = meta.maxOutputTokens
	}

	wanted, ok := strictString(envelope["reasoning_effort"])
	if ok && slices.Contains(meta.efforts, wanted) {
		wire["reasoning_effort"] = wanted
	}
	if strings.Contains(strings.ToLower(model), "deepseek") {
		// 实测：这一族模型只有 reasoning_effort 能打开思考，thinking 单独不生效，
		// 两个都带才稳定返回 reasoning_content。
		wire["thinking"] = map[string]string{"type": "enabled"}
		if _, set := wire["reasoning_effort"]; !set && len(meta.efforts) > 0 {
			wire["reasoning_effort"] = defaultEffort(meta)
		}
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return nil, errs.InternalFrom(err)
	}
	return payload, nil
}

// defaultEffort 挑 deepseek 族的默认档位：上游声明的默认值优先，其次 high，
// 最后取第一个 —— 与 Node 版一致。
func defaultEffort(meta modelMeta) string {
	if meta.defaultEffort != "" && slices.Contains(meta.efforts, meta.defaultEffort) {
		return meta.defaultEffort
	}
	if slices.Contains(meta.efforts, "high") {
		return "high"
	}
	return meta.efforts[0]
}

// cacheKeyFor 是前缀缓存键：同一段 system 前缀稳定命中。
//
// 取第一条 role === 'system' 的消息，content 必须是字符串（数组形状的 content
// 不参与计算，当空串），与 Node 版的 find + typeof 判断一致。
func cacheKeyFor(messages []json.RawMessage, model string) string {
	system := ""
	for _, raw := range messages {
		var envelope struct {
			Role    string `json:"role"`
			Content any    `json:"content"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			continue
		}
		if envelope.Role != "system" {
			continue
		}
		if text, ok := envelope.Content.(string); ok {
			system = text
		}
		break
	}
	sum := sha256.Sum256([]byte(model + "\x00" + system))
	return hex.EncodeToString(sum[:])[:32]
}

// decodeMessages 解出消息数组；不是数组时返回 nil（等价于空数组）。
func decodeMessages(raw json.RawMessage) []json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var messages []json.RawMessage
	if err := json.Unmarshal(raw, &messages); err != nil {
		return nil
	}
	return messages
}

// isSystemMessage 判断首条消息的角色是不是 system。
func isSystemMessage(raw json.RawMessage) bool {
	var envelope struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false
	}
	return envelope.Role == "system"
}

// nonEmptyArray 取非空数组字段；空数组与缺失等价（Node 版就不发空数组）。
func nonEmptyArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || len(items) == 0 {
		return nil, false
	}
	return items, true
}

// strictNumber 是严格的数字判断（Node 版的 typeof === 'number'）。
func strictNumber(raw json.RawMessage) (json.Number, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return "", false
	}
	if _, err := number.Float64(); err != nil {
		return "", false
	}
	return number, true
}

// strictString 是严格的字符串判断，空串也算字符串（`includes` 会把它挡掉）。
func strictString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// numericValue 是 Number(x) 的等价物：数字或数字串都算，其它一律不算。
func numericValue(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	if number, ok := strictNumber(raw); ok {
		value, _ := number.Float64()
		return value, true
	}
	if text, ok := strictString(raw); ok {
		value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil || math.IsNaN(value) {
			return 0, false
		}
		return value, true
	}
	return 0, false
}
