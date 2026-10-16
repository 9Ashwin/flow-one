// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"fmt"
	"io"
	"sync"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/sse"
)

// codeContentBlocked 是腾讯内容风控的业务码：既可能出现在 400 响应里，
// 也可能以「HTTP 200 + 一帧 {code,msg}」的形式混在流里。
const codeContentBlocked = 11128

// stream 是腾讯上游 SSE 数据帧的序列：每帧是 `data:` 之后那段 JSON。
//
// 帧的切分交给 internal/sse（网关与 OpenCode 两条路读的是同一份），本包只做
// 腾讯特有的那一件事：把流内的策略拦截翻成错误。
type stream struct {
	reader  *sse.Reader
	label   string
	release func()
	finish  sync.Once
}

func newStream(body io.ReadCloser, label string, release func()) *stream {
	return &stream{reader: sse.NewReader(body), label: label, release: release}
}

// Next 返回下一帧。ok=false 表示正常结束（EOF 或 [DONE]）。
//
// 流内的策略拦截是「HTTP 200 + 一帧 {code,msg}」：那种帧没有 choices，混在正常
// 分片里会被翻译层当成空帧丢掉，最后表现为「干净地收尾了但什么都没答」。
func (s *stream) Next() ([]byte, bool, error) {
	payload, ok, err := s.reader.Next()
	if err != nil {
		s.Close()
		return nil, false, err
	}
	if !ok {
		s.Close()
		return nil, false, nil
	}
	object := decodeObject(payload)
	if object == nil {
		return payload, true, nil
	}
	if _, hasChoices := object["choices"]; hasChoices {
		return payload, true, nil
	}
	code, hasCode := numberOf(object["code"])
	if _, hasMessage := stringOf(object["msg"]); !hasCode && !hasMessage {
		return payload, true, nil
	}
	s.Close()
	return nil, false, inStreamError(s.label, object, code, hasCode)
}

// Close 释放连接并解掉「等响应头」的超时。可重复调用（source.Stream 的约定）。
func (s *stream) Close() error {
	var err error
	s.finish.Do(func() {
		err = s.reader.Close()
		if s.release != nil {
			s.release()
		}
	})
	return err
}

// inStreamError 把流内拦截帧转成类型化错误。
//
// 文案取 msg / message / displayMsg 里第一个非 null 的值，都没有就用 `code N`
// （与 Node 版的 `??` 链一致）。Code 放**帧里的业务码**：这一层没有 HTTP 状态码
// 可用，风控的 11128 就是这里最有信息量的那个数。
func inStreamError(label string, object map[string]any, code float64, hasCode bool) *errs.Error {
	text := ""
	if value, ok := firstNonNull(object, "msg", "message", "displayMsg"); ok {
		switch typed := value.(type) {
		case string:
			text = typed
		case fmt.Stringer:
			// json.Number 能还原成上游原本写的数字；对象 / 数组没法还原成原话，
			// 留给下面的 code 兜底。
			text = typed.String()
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
