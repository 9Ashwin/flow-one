// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package sse

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
)

// chunkedReader 每次只吐 at 个字节，用来确认跨读边界的缓冲与切行是对的。
type chunkedReader struct {
	data string
	at   int
}

func (r *chunkedReader) Read(into []byte) (int, error) {
	if r.data == "" {
		return 0, io.EOF
	}
	size := r.at
	if size > len(r.data) {
		size = len(r.data)
	}
	if size > len(into) {
		size = len(into)
	}
	copy(into, r.data[:size])
	r.data = r.data[size:]
	return size, nil
}

// closable 记下 Close 被调了几次。
type closable struct {
	io.Reader
	closes int
}

func (c *closable) Close() error {
	c.closes++
	return nil
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

// drain 把整个流读完。
func drain(t *testing.T, reader *Reader) []string {
	t.Helper()
	payloads := []string{}
	for {
		payload, ok, err := reader.Next()
		require.NoError(t, err)
		if !ok {
			return payloads
		}
		payloads = append(payloads, string(payload))
	}
}

// TestReaderMatchesSourceStream 钉住冻结接口：sse.Reader 就是上游流的那一份实现。
var _ source.Stream = (*Reader)(nil)

func TestReaderYieldsDataPayloads(t *testing.T) {
	stream := "event: message_start\n" +
		"data: {\"a\":1}\n" +
		"\n" +
		": 这是注释行\n" +
		"data: [DONE]\n" +
		"\n" +
		"data: {坏帧\n" +
		"\n" +
		"data:{\"b\":2}\r\n" +
		"data:   \n" +
		"retry: 1000\n" +
		"data: [1,2]\n" + // 合法 JSON 但不是对象：本层不管，交给翻译层忽略
		"\n" +
		"data: 半截没有换行"

	// 每次只喂 3 个字节：切行逻辑必须跨读边界也成立。
	reader := NewReader(&chunkedReader{data: stream, at: 3})
	assert.Equal(t, []string{`{"a":1}`, `{"b":2}`, `[1,2]`}, drain(t, reader))
}

func TestReaderDropsTrailingFrameWithoutNewline(t *testing.T) {
	// SSE 的帧一定以空行收尾；半截帧本来也解析不出东西，与 Node 版一致地丢掉。
	reader := NewReader(strings.NewReader("data: {\"a\":1}\n\ndata: {\"b\":2}"))
	assert.Equal(t, []string{`{"a":1}`}, drain(t, reader))
}

func TestReaderCloseIsIdempotentAndStopsTheStream(t *testing.T) {
	body := &closable{Reader: strings.NewReader("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n")}
	reader := NewReader(body)

	payload, ok, err := reader.Next()
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, `{"a":1}`, string(payload))

	require.NoError(t, reader.Close())
	require.NoError(t, reader.Close())
	assert.Equal(t, 1, body.closes, "重复 Close 不该把连接关两次")

	_, ok, err = reader.Next()
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestReaderReportsReadFailureAsNetwork(t *testing.T) {
	_, _, err := NewReader(failingReader{}).Next()
	require.Error(t, err)
	typed, ok := errs.As(err)
	require.True(t, ok, "读流失败也要是类型化错误")
	assert.Equal(t, errs.CategoryNetwork, typed.Category)
	assert.Equal(t, errs.SubtypeConnectFailed, typed.Subtype)
	assert.Contains(t, typed.Message, "connection reset")
}

func TestFailureKeepsUpstreamReason(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"error.message 优先", `{"error":{"message":"boom","type":"ignored"}}`, "boom"},
		{"其次 error.type", `{"error":{"type":"invalid_request_error"}}`, "invalid_request_error"},
		{"再是 msg", `{"msg":"没有额度了"}`, "没有额度了"},
		{"再是 message", `{"message":"nope"}`, "nope"},
		{"error 是字符串也认", `{"error":"内容被拦截"}`, "内容被拦截"},
		{"有细节就带上细节", `{"error":{"code":11140,"displayMsg":"拦截"}}`, `{"code":11140,"displayMsg":"拦截"}`},
		{"认不出字段就退回正文", `{"foo":"bar"}`, `{"foo":"bar"}`},
		{"不是 JSON 就用原文", `Bad Gateway`, "Bad Gateway"},
		{"空正文只有状态码", ``, "上游返回 400"},
		{"全空白的正文同样只有状态码", "  \n ", "上游返回 400"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			failure := Failure(&http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(tc.body))})
			assert.Equal(t, tc.want, failure.Message)
			assert.Equal(t, errs.CategoryUpstream, failure.Category)
			assert.Equal(t, errs.SubtypeBadStatus, failure.Subtype)
			assert.Equal(t, 400, failure.Code, "HTTP 状态码要落在 Code 上，调用方据此分支")
		})
	}
}

func TestFailureTruncatesByRunes(t *testing.T) {
	// 中文按字节切会劈出半个 UTF-8 序列 —— 计量口径要与 Node 的 slice 对齐到字符。
	failure := Failure(&http.Response{
		StatusCode: 500,
		Body:       io.NopCloser(strings.NewReader(strings.Repeat("拦", 2000))),
	})
	assert.Len(t, []rune(failure.Message), failureMessageLimit)
	assert.Equal(t, strings.Repeat("拦", failureMessageLimit), failure.Message)
	assert.Equal(t, 500, failure.Code)
}
