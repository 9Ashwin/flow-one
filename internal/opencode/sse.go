// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
)

// sseStream 把上游的 SSE 响应体读成 source.Stream：每帧是 `data:` 之后那段 JSON。
//
// 语义与腾讯那条路用的读法一致：`[DONE]`、空帧、注释行与坏 JSON 都跳过（坏帧丢掉
// 比打断整轮更划算）。本包自带这一份是为了让两条路自洽，不再依赖别的包。
type sseStream struct {
	body   io.ReadCloser
	reader *bufio.Reader
}

func newSSEStream(body io.ReadCloser) *sseStream {
	return &sseStream{body: body, reader: bufio.NewReader(body)}
}

// Next 返回下一帧。ok=false 表示正常结束（EOF 或 [DONE]）。
func (s *sseStream) Next() ([]byte, bool, error) {
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil && line == "" {
			if errors.Is(err, io.EOF) {
				return nil, false, nil
			}
			return nil, false, err
		}
		if payload, found := ssePayload(line); found {
			return payload, true, nil
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, false, nil
			}
			return nil, false, err
		}
	}
}

// Close 释放连接。重复调用是允许的（source.Stream 的约定）。
func (s *sseStream) Close() error {
	if s.body == nil {
		return nil
	}
	body := s.body
	s.body = nil
	return body.Close()
}

// ssePayload 取出一行 SSE 里的数据帧。不是 data 行、空帧、[DONE]、坏 JSON 都返回 false。
func ssePayload(line string) ([]byte, bool) {
	text := strings.TrimRight(line, "\r\n")
	rest, isData := strings.CutPrefix(text, "data:")
	if !isData {
		return nil, false
	}
	payload := strings.TrimSpace(rest)
	if payload == "" || payload == "[DONE]" || !json.Valid([]byte(payload)) {
		return nil, false
	}
	return []byte(payload), true
}

// source.Stream 的编译期断言：两条路的分片都必须能直接喂给翻译层。
var _ source.Stream = (*sseStream)(nil)
