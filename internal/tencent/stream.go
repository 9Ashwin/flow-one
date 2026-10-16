// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// codeContentBlocked 是腾讯内容风控的业务码：既可能出现在 400 响应里，
// 也可能以「HTTP 200 + 一帧 {code,msg}」的形式混在流里。
const codeContentBlocked = 11128

// doneFrame 是 SSE 的结束帧。
const doneFrame = "[DONE]"

// stream 是腾讯上游 SSE 数据帧的序列：每帧是 `data:` 之后那段 JSON。
//
// 只做两件事：逐行切帧、把流内的策略拦截翻成错误。工具名回改那类来源特有的
// 报文处理不属于这条线。
type stream struct {
	body    io.ReadCloser
	reader  *bufio.Reader
	label   string
	release func()
	finish  sync.Once
}

func newStream(body io.ReadCloser, label string, release func()) *stream {
	return &stream{body: body, reader: bufio.NewReader(body), label: label, release: release}
}

// Next 返回下一帧。ok=false 表示正常结束（EOF 或 [DONE]）。
func (s *stream) Next() ([]byte, bool, error) {
	for {
		line, eof, err := s.readLine()
		if err != nil {
			s.Close()
			return nil, false, errs.Wrap(err, errs.CategoryNetwork, errs.SubtypeConnectFailed, s.label+"：读取上游响应失败")
		}
		payload, ok := ssePayload(line)
		if ok {
			if payload == doneFrame {
				s.Close()
				return nil, false, nil
			}
			frame, err := s.decode(payload)
			if err != nil {
				s.Close()
				return nil, false, err
			}
			if frame != nil {
				return frame, true, nil
			}
		}
		if eof {
			s.Close()
			return nil, false, nil
		}
	}
}

// Close 释放连接。可重复调用（source.Stream 的约定）。
func (s *stream) Close() error {
	var err error
	s.finish.Do(func() {
		err = s.body.Close()
		if s.release != nil {
			s.release()
		}
	})
	return err
}

// readLine 读一行；第二个返回值表示「读到的是最后一行（之后没有换行符了）」。
func (s *stream) readLine() (string, bool, error) {
	line, err := s.reader.ReadString('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			return line, true, nil
		}
		return line, false, err
	}
	return line, false, nil
}

// decode 判断这一帧是数据还是流内拦截。
//
// 流内的策略拦截是「HTTP 200 + 一帧 {code,msg}」：没有 choices，混在正常分片里会被
// 翻译层当成空帧丢掉，最后表现为「干净地收尾了但什么都没答」—— 所以在这里就翻成错误。
// 解析不了的帧丢掉而不是打断整轮（上游偶尔会发半截帧）。
func (s *stream) decode(payload string) ([]byte, error) {
	object := decodeObject([]byte(payload))
	if object == nil {
		return nil, nil
	}
	if _, ok := object["choices"]; ok {
		return []byte(payload), nil
	}
	code, hasCode := numberOf(object["code"])
	_, hasMessage := stringOf(object["msg"])
	if !hasCode && !hasMessage {
		return []byte(payload), nil
	}
	return nil, inStreamError(s.label, object, code, hasCode)
}

// ssePayload 取 `data:` 之后那段并 trim；其余行（注释、event:、空行）都跳过。
func ssePayload(line string) (string, bool) {
	line = strings.TrimRight(line, "\r\n")
	if !strings.HasPrefix(line, "data:") {
		return "", false
	}
	payload := strings.TrimSpace(line[len("data:"):])
	if payload == "" {
		return "", false
	}
	return payload, true
}

// inStreamError 把流内拦截帧转成类型化错误。
//
// 文案取 msg / message / displayMsg 里第一个非 null 的值，都没有就用 `code N`
// （与 Node 版的 `??` 链一致）。Code 放**帧里的业务码**：这一层没有 HTTP 状态码
// 可用，风控的 11128 就是这里最有信息量的那个数。
func inStreamError(label string, object map[string]any, code float64, hasCode bool) *errs.Error {
	text := ""
	if value, ok := firstNonNull(object, "msg", "message", "displayMsg"); ok {
		// 数字（json.Number）能还原成上游原本的文本；对象 / 数组没法还原成原话，
		// 留给下面的 code 兜底。
		if stringer, ok := value.(fmt.Stringer); ok {
			text = stringer.String()
		}
	}
	if text == "" {
		if hasCode {
			text = fmt.Sprintf("code %d", int(code))
		} else {
			text = "上游返回了一个无法识别的错误帧"
		}
	}
	if hasCode && int(code) == codeContentBlocked {
		return errs.Upstream(errs.SubtypeContentBlocked, label+"："+text).WithCode(int(code))
	}
	failure := errs.Upstream(errs.SubtypeBadStatus, label+"："+text)
	if hasCode {
		failure = failure.WithCode(int(code))
	}
	return failure
}
