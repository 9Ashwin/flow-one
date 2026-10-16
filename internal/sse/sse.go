// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package sse 读 OpenAI 形状的 SSE 流，并把上游的失败响应归一成类型化错误。
//
// 单独成包是为了打断循环依赖：网关上游与 OpenCode 免费档都要读 SSE，而前者又要
// import 后者。这里不认识任何具体上游 —— 只认 `data:` 行与 HTTP 状态码。
package sse

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// readChunk 是每次从 body 里读的字节数。SSE 帧都很小，攒到一个缓冲区里再切行，
// 与 Node 版 `buffer += chunk` 的做法一致。
const readChunk = 32 * 1024

// maxFailureBody 限制失败响应正文的读取量。正文最终只会取 500 个字符，
// 但上游可能不按套路地一直吐 —— 错误路径上不该被它牵着走。
const maxFailureBody = 64 * 1024

// failureMessageLimit 是失败理由的截断长度（Node 版是 500）。
const failureMessageLimit = 500

// Reader 把上游的 SSE 字节流拆成一帧帧 JSON 载荷。
//
// 帧的判定与 Node 版逐条对齐：只认 `data:` 开头的行，跳过空载荷与 `[DONE]`，
// 注释行（`:` 开头）与非 data 行直接忽略，坏 JSON 丢掉而不是打断整轮。
type Reader struct {
	body   io.Reader
	closer io.Closer
	buffer []byte
	chunk  [readChunk]byte
	done   bool
	closed bool
}

// NewReader 读一个响应体。body 同时实现 io.Closer 时，Close 会一并关掉它
// —— http.Response.Body 正是这种情况。
func NewReader(body io.Reader) *Reader {
	reader := &Reader{body: body}
	if closer, ok := body.(io.Closer); ok {
		reader.closer = closer
	}
	return reader
}

// Next 返回下一帧的 JSON 载荷。ok=false 表示流结束（正常 EOF 或已 Close）。
//
// 与 Node 版一致：末尾没换行的残帧会被丢掉 —— SSE 的帧一定以空行收尾，
// 半截帧本来也解析不出东西。
func (r *Reader) Next() ([]byte, bool, error) {
	if r.closed {
		return nil, false, nil
	}
	for {
		if at := bytes.IndexByte(r.buffer, '\n'); at >= 0 {
			line := r.buffer[:at]
			r.buffer = r.buffer[at+1:]
			if payload, ok := framePayload(line); ok {
				// 复制一份再交出去：调用方会一直拿着它，而缓冲区还会被复用。
				out := make([]byte, len(payload))
				copy(out, payload)
				return out, true, nil
			}
			continue
		}
		if r.done {
			return nil, false, nil
		}
		if err := r.fill(); err != nil {
			return nil, false, err
		}
	}
}

// Close 释放连接，可重复调用。关闭之后连缓冲区里剩下的行也不再交出去 ——
// 调用方说「不要了」就是不要了，再吐半帧只会让它写到已经关掉的响应上。
func (r *Reader) Close() error {
	r.closed = true
	r.done = true
	if r.closer == nil {
		return nil
	}
	closer := r.closer
	r.closer = nil
	return closer.Close()
}

// fill 从 body 里再读一段。读失败是**网络**问题而不是本地 I/O：
// 上游在流中途断开时，调用方要能按「连不上」分类。
func (r *Reader) fill() error {
	read, err := r.body.Read(r.chunk[:])
	if read > 0 {
		r.buffer = append(r.buffer, r.chunk[:read]...)
	}
	if err == nil {
		return nil
	}
	if err == io.EOF {
		// 与流结束同时到达的字节仍然要处理，所以这里只打标记、不丢缓冲。
		r.done = true
		return nil
	}
	return errs.Network(errs.SubtypeConnectFailed, "上游流读取失败："+err.Error()).WithCause(err)
}

// framePayload 从一行里取出 JSON 载荷。不是数据行、或者载荷是空/[DONE]/坏 JSON 时
// 返回 ok=false：丢掉一帧比让整轮对话失败划算。
func framePayload(line []byte) ([]byte, bool) {
	// 先判前缀再 trim：` data: …` 这种带缩进的行不算数据行（与 Node 版一致）。
	if !bytes.HasPrefix(line, []byte("data:")) {
		return nil, false
	}
	payload := bytes.TrimSuffix(line, []byte("\r"))
	payload = bytes.TrimSpace(payload[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil, false
	}
	if !json.Valid(payload) {
		return nil, false
	}
	return payload, true
}

// Failure 把上游的非 2xx 响应翻成一条类型化错误：能保住上游原本的理由就保住。
//
// 分类固定是 upstream/bad_status，HTTP 状态码落在 Code 上 —— 具体来源（腾讯风控、
// 免费档门禁）由各自的实现按正文再细分，这里不认识它们。
func Failure(response *http.Response) *errs.Error {
	message := fmt.Sprintf("上游返回 %d", response.StatusCode)
	body, err := io.ReadAll(io.LimitReader(response.Body, maxFailureBody))
	if err == nil {
		if text := strings.TrimSpace(string(body)); text != "" {
			message = failureReason(body, text)
		}
	}
	// 读不到正文时，状态码本身就是信息。
	return errs.Upstream(errs.SubtypeBadStatus, message).WithCode(response.StatusCode)
}

// failureReason 从失败正文里挑出一句人话。
//
// 取值优先级照 Node 版：`error.message` → `error.type` → `msg` → `message` → `error`。
// 最后一级兜底到整个 error 对象（有细节也比只有状态码强）；一个都对不上就退回正文原文。
func failureReason(body []byte, trimmed string) string {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return truncate(trimmed, failureMessageLimit)
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return truncate(compact(payload, trimmed), failureMessageLimit)
	}
	detail, found := failureDetail(object)
	if !found {
		return truncate(compact(payload, trimmed), failureMessageLimit)
	}
	if text, ok := detail.(string); ok && text != "" {
		return text
	}
	return truncate(compact(detail, trimmed), failureMessageLimit)
}

// failureDetail 按优先级取出上游想表达的那句话。
func failureDetail(payload map[string]any) (any, bool) {
	if inner, ok := payload["error"].(map[string]any); ok {
		for _, key := range []string{"message", "type"} {
			if value, ok := inner[key]; ok && value != nil {
				return value, true
			}
		}
	}
	for _, key := range []string{"msg", "message", "error"} {
		if value, ok := payload[key]; ok && value != nil {
			return value, true
		}
	}
	return nil, false
}

// compact 把 JSON 值重新序列化成一行；序列化不了就用正文原文兜底。
//
// 与 Node 版的一处外观差异：Go 的 map 会按 key 排序，JSON.stringify 保持原顺序。
// 语义一样，只是多个字段时的先后不同。
func compact(value any, fallback string) string {
	text, err := json.Marshal(value)
	if err != nil {
		return fallback
	}
	return string(text)
}

// truncate 按**字符**截断（不是字节）：理由里常有中文，按字节切会把最后一个字劈成
// 半个 UTF-8 序列。长度口径与 Node 的 slice 对齐到码点一级即可。
func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
