// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package anthropic

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/source"
)

// Options 是请求翻译的可调项。
type Options struct {
	// Model 是出站用的**裸**模型 ID（来源前缀由调用方解析掉，翻译层不认前缀）。
	Model string
	// MaxTokensCap > 0 时把 max_tokens 裁到它 —— 上游按模型真实上限拒绝超额请求。
	MaxTokensCap int
	// RewriteSystem 只对 WorkBuddy 那两条线非 nil。nil 表示不改写：
	// 此时出站 system 与 flattenSystem 的结果逐字节相同（套餐分离不变式）。
	RewriteSystem source.Rewriter
}

// outBody 是出站的 OpenAI chat 请求体。字段顺序与 Node 版一致，便于逐行对照。
//
// 可省字段一律 omitempty：上游对多余的空字段并不宽容，免费档尤其会拿形状做门禁。
type outBody struct {
	Model       string       `json:"model"`
	Messages    []outMessage `json:"messages"`
	Tools       []outTool    `json:"tools,omitempty"`
	ToolChoice  any          `json:"tool_choice,omitempty"`
	Stream      bool         `json:"stream,omitempty"`
	MaxTokens   *int64       `json:"max_tokens,omitempty"`
	Temperature *float64     `json:"temperature,omitempty"`
	TopP        *float64     `json:"top_p,omitempty"`
	// Stop 用指针：stop_sequences 给了、但里面一个字符串都没有时，要发空数组而不是
	// 省略这个键 —— 上游两边都收，这里与 Node 版逐键对齐。
	Stop            *[]string `json:"stop,omitempty"`
	ReasoningEffort string    `json:"reasoning_effort,omitempty"`
}

type outMessage struct {
	Role       string        `json:"role"`
	Content    any           `json:"content"`
	ToolCalls  []outToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

// outToolCall 是助手消息上的一个工具调用。arguments 是 JSON **文本**而不是对象 ——
// OpenAI 的形状如此，上游的流式分片也是按文本一片片吐出来的。
type outToolCall struct {
	ID       string      `json:"id"`
	Type     string      `json:"type"`
	Function outCallBody `json:"function"`
}

type outCallBody struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// outTool 是 tools[] 里的一项；description 为空时整个键都不发。
type outTool struct {
	Type     string      `json:"type"`
	Function outToolBody `json:"function"`
}

type outToolBody struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters"`
}

// contentPart 是 content 数组里的一项：文本或图片，两种形状互斥。
type contentPart struct {
	Type     string       `json:"type"`
	Text     string       `json:"text,omitempty"`
	ImageURL *outImageURL `json:"image_url,omitempty"`
}

type outImageURL struct {
	URL string `json:"url"`
}

// outToolChoice 是 `{type:"function", function:{name}}` 形状的 tool_choice。
type outToolChoice struct {
	Type     string              `json:"type"`
	Function outToolChoiceTarget `json:"function"`
}

type outToolChoiceTarget struct {
	Name string `json:"name"`
}

// ToOpenAIRequest 把 Anthropic 的 Messages 请求体翻译成 OpenAI 的 chat 请求体。
//
// 返回的是**要写进上游的 JSON 字节**：调用方直接塞进 source.ChatRequest.Body。
// 校验失败（不是 JSON 对象、messages 缺失或为空）返回 errs 的 validation 错误，
// 由服务端翻成 400 —— 这是 Claude Code 唯一看得到的理由，所以写得具体些。
func ToOpenAIRequest(body []byte, opts Options) ([]byte, error) {
	var parsed any
	if len(body) == 0 {
		// 空请求体当 `{}`：与 Node 版 readBody 的处理一致。
		parsed = map[string]any{}
	} else {
		// 解析不了就交给下面的「必须是 JSON 对象」分支，不另造一条错误：
		// 对调用方来说「不是合法 JSON」与「不是对象」是同一件事。
		_ = json.Unmarshal(body, &parsed)
	}
	request, ok := asObject(parsed)
	if !ok {
		return nil, errs.Validation(errs.SubtypeInvalidRequest, "请求体必须是 JSON 对象").WithParam("body")
	}
	rows, ok := asArray(request["messages"])
	if !ok || len(rows) == 0 {
		return nil, errs.Validation(errs.SubtypeInvalidRequest, "`messages` 必须是非空数组").WithParam("messages")
	}

	messages := []outMessage{}
	// system 在 Anthropic 里是一等公民，OpenAI 里只是第一条消息。
	// 只改 system：用户内容原样透传（上游的风控拦的是自称，不是用户的话）。
	rawSystem := flattenSystem(request["system"])
	system := rawSystem
	if rawSystem != "" && opts.RewriteSystem != nil {
		system = opts.RewriteSystem(rawSystem)
	}
	if system != "" {
		messages = append(messages, outMessage{Role: "system", Content: system})
	}

	for _, rowValue := range rows {
		row, ok := asObject(rowValue)
		if !ok {
			continue
		}
		blocks := blocksOf(row["content"])

		if role, _ := asString(row["role"]); role == "assistant" {
			text := textOf(blocks)
			toolCalls := toolCallsOf(blocks)
			if text == "" && len(toolCalls) == 0 {
				continue
			}
			message := outMessage{Role: "assistant", Content: text}
			if len(toolCalls) > 0 {
				message.ToolCalls = toolCalls
			}
			messages = append(messages, message)
			continue
		}

		// 其余角色（user、缺省）都按用户侧处理。工具结果必须先落地：OpenAI 要求
		// role:"tool" 紧跟在那条带 tool_calls 的助手消息之后，同一轮里的文本排在
		// 它后面不影响语义。
		pending := []map[string]any{}
		for _, block := range blocks {
			kind, _ := asString(block["type"])
			if kind == "tool_result" {
				callID, _ := asString(block["tool_use_id"])
				if callID == "" {
					continue
				}
				messages = append(messages, outMessage{
					Role:       "tool",
					ToolCallID: callID,
					Content:    toolResultContent(block["content"]),
				})
				continue
			}
			if kind == "text" {
				if text, ok := asString(block["text"]); ok && text != "" {
					pending = append(pending, block)
				}
				continue
			}
			if kind == "image" {
				pending = append(pending, block)
			}
		}
		if len(pending) > 0 {
			content := contentParts(pending)
			if hasContent(content) {
				messages = append(messages, outMessage{Role: "user", Content: content})
			}
		}
	}

	tools := []outTool{}
	for _, toolValue := range asArrayOrNil(request["tools"]) {
		tool, ok := asObject(toolValue)
		if !ok {
			continue
		}
		name, ok := asString(tool["name"])
		if !ok || name == "" {
			continue
		}
		function := outToolBody{Name: name, Parameters: schemaOf(tool["input_schema"])}
		if description, ok := asString(tool["description"]); ok && description != "" {
			function.Description = description
		}
		tools = append(tools, outTool{Type: "function", Function: function})
	}

	// 上游把「tool_choice: none 且带 tools」判为不可表达并直接 400，这里就地拆掉：
	// 工具清单不发，但 none 这个意图要留着。
	choice := toolChoiceFor(request["tool_choice"], len(tools) > 0)
	dropTools := false
	if name, ok := choice.(string); ok && name == "none" {
		dropTools = true
	}

	translated := outBody{Model: opts.Model, Messages: messages}
	if len(tools) > 0 && !dropTools {
		translated.Tools = tools
	}
	if choice != nil {
		translated.ToolChoice = choice
	}
	if stream, ok := request["stream"].(bool); ok && stream {
		translated.Stream = true
	}
	if maxTokens, ok := asNumber(request["max_tokens"]); ok && maxTokens > 0 {
		value := int64(math.Trunc(maxTokens))
		if opts.MaxTokensCap > 0 && value > int64(opts.MaxTokensCap) {
			value = int64(opts.MaxTokensCap)
		}
		translated.MaxTokens = &value
	}
	if temperature, ok := asNumber(request["temperature"]); ok {
		translated.Temperature = &temperature
	}
	if topP, ok := asNumber(request["top_p"]); ok {
		translated.TopP = &topP
	}
	if items, ok := asArray(request["stop_sequences"]); ok && len(items) > 0 {
		stop := []string{}
		for _, item := range items {
			if text, ok := asString(item); ok {
				stop = append(stop, text)
			}
		}
		translated.Stop = &stop
	}
	if effort, ok := effortFor(request["thinking"]); ok {
		translated.ReasoningEffort = effort
	}

	return marshal(translated), nil
}

// blocksOf 读 Anthropic 的 content：块数组与裸字符串都要能读，
// 其它形状（数字、对象、null）一律当空 —— 两边都可能塞进没想到的东西。
func blocksOf(content any) []map[string]any {
	if items, ok := asArray(content); ok {
		blocks := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if block, ok := asObject(item); ok {
				blocks = append(blocks, block)
			}
		}
		return blocks
	}
	if text, ok := asString(content); ok && text != "" {
		return []map[string]any{{"type": "text", "text": text}}
	}
	return nil
}

// textOf 把块数组里的文本拼起来（不加分隔符）。推理块之类的直接丢掉 ——
// OpenAI 的**输入**侧没有推理块的位置。
func textOf(blocks []map[string]any) string {
	var builder strings.Builder
	for _, block := range blocks {
		if kind, _ := asString(block["type"]); kind != "text" {
			continue
		}
		if text, ok := asString(block["text"]); ok && text != "" {
			builder.WriteString(text)
		}
	}
	return builder.String()
}

// flattenSystem 把 system 折成 OpenAI 认识的一条纯文本。
//
// Anthropic 的 system 可以是块数组；多块之间用空行隔开 —— 那本来就是它们在提示词里
// 的间距。这里刻意只看 `text` 字段、不看块类型：system 里没有别的合法块。
func flattenSystem(system any) string {
	if text, ok := asString(system); ok {
		return strings.TrimSpace(text)
	}
	texts := []string{}
	for _, block := range blocksOf(system) {
		if text, ok := asString(block["text"]); ok && text != "" {
			texts = append(texts, text)
		}
	}
	return strings.TrimSpace(strings.Join(texts, "\n\n"))
}

// imagePart 把图片块折成 OpenAI 的 image_url；认不出来就丢弃 ——
// 丢一张图比让整轮 400 划算。
func imagePart(block map[string]any) (contentPart, bool) {
	source, ok := asObject(block["source"])
	if !ok {
		return contentPart{}, false
	}
	switch kind, _ := asString(source["type"]); kind {
	case "base64":
		data, ok := asString(source["data"])
		if !ok || data == "" {
			return contentPart{}, false
		}
		mediaType, ok := asString(source["media_type"])
		if !ok || mediaType == "" {
			mediaType = "image/png"
		}
		return contentPart{Type: "image_url", ImageURL: &outImageURL{URL: "data:" + mediaType + ";base64," + data}}, true
	case "url":
		url, ok := asString(source["url"])
		if !ok || url == "" {
			return contentPart{}, false
		}
		return contentPart{Type: "image_url", ImageURL: &outImageURL{URL: url}}, true
	}
	return contentPart{}, false
}

// contentParts 把块数组折成 OpenAI 的 content。
//
// 全是文本时收敛成裸字符串：相当一部分网关只认字符串形态，而纯文本轮次占绝大多数。
// 没有可用部分时返回空字符串，由调用方决定这条消息要不要落地。
func contentParts(blocks []map[string]any) any {
	parts := []contentPart{}
	allText := true
	for _, block := range blocks {
		switch kind, _ := asString(block["type"]); kind {
		case "text":
			text, ok := asString(block["text"])
			if !ok || text == "" {
				continue
			}
			parts = append(parts, contentPart{Type: "text", Text: text})
		case "image":
			part, ok := imagePart(block)
			if !ok {
				continue
			}
			allText = false
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	if allText {
		var builder strings.Builder
		for _, part := range parts {
			builder.WriteString(part.Text)
		}
		return builder.String()
	}
	return parts
}

// hasContent 报告折出来的 content 值不值得发：空串与空数组都当作「这条消息没内容」。
func hasContent(content any) bool {
	if text, ok := content.(string); ok {
		return text != ""
	}
	if parts, ok := content.([]contentPart); ok {
		return len(parts) > 0
	}
	return content != nil
}

// toolResultContent 是工具结果的 content：可以是裸字符串，也可以是带图片的块数组。
func toolResultContent(content any) any {
	if text, ok := asString(content); ok {
		return text
	}
	return contentParts(blocksOf(content))
}

// schemaOf 取工具入参 schema；缺失或不是对象时给一个空 object schema ——
// 上游普遍要求 parameters 得是个对象。
func schemaOf(schema any) any {
	if object, ok := asObject(schema); ok {
		return object
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// inputOf 取 tool_use 的入参；缺失或 null 时给空对象（Node 的 `block.input ?? {}`）。
func inputOf(block map[string]any) any {
	if input, ok := block["input"]; ok && input != nil {
		return input
	}
	return map[string]any{}
}

// toolCallsOf 把助手消息里的 tool_use 块折成 OpenAI 的 tool_calls[]。
// 没有名字的块直接丢掉：OpenAI 侧的工具调用必须有名字。
func toolCallsOf(blocks []map[string]any) []outToolCall {
	calls := []outToolCall{}
	for _, block := range blocks {
		if kind, _ := asString(block["type"]); kind != "tool_use" {
			continue
		}
		name, ok := asString(block["name"])
		if !ok || name == "" {
			continue
		}
		id, ok := asString(block["id"])
		if !ok || id == "" {
			// 客户端没给 id 时自己编一个：下一轮 tool_result 要靠它对上号。
			id = "toolu_" + strconv.Itoa(len(calls))
		}
		calls = append(calls, outToolCall{
			ID:       id,
			Type:     "function",
			Function: outCallBody{Name: name, Arguments: jsonText(inputOf(block))},
		})
	}
	return calls
}

// effortFor 把 thinking.budget_tokens 折成 reasoning_effort 档位。
//
// 上游（例如渠道网关）会把档位就近归一化到模型真正声明的那一档，所以给大中小三档
// 就够，不必先知道模型支持什么。**永不发 off**：OpenCode Go 对 `off` 回 422，
// 而「没开 thinking」的正确表达就是压根不带这个字段。
func effortFor(thinking any) (string, bool) {
	object, ok := asObject(thinking)
	if !ok {
		return "", false
	}
	if kind, _ := asString(object["type"]); kind != "enabled" {
		return "", false
	}
	budget, ok := asNumber(object["budget_tokens"])
	if !ok || budget <= 0 {
		return "", false
	}
	switch {
	case budget >= 8192:
		return "high", true
	case budget >= 2048:
		return "medium", true
	default:
		return "low", true
	}
}

// toolChoiceFor 折 tool_choice。上游只认字符串形态，目录式的 `{type:"tool"}` 没有
// 名字时退回自动 —— 与其让上游 400，不如让它自己挑一个工具。
func toolChoiceFor(choice any, hasTools bool) any {
	object, ok := asObject(choice)
	if !ok {
		return nil
	}
	switch kind, _ := asString(object["type"]); kind {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		if name, ok := asString(object["name"]); ok && name != "" {
			return outToolChoice{Type: "function", Function: outToolChoiceTarget{Name: name}}
		}
	}
	if hasTools {
		return "auto"
	}
	return nil
}
