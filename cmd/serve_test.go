// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"bytes"
	"context"
	"testing"

<<<<<<< Updated upstream
	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/anthropic"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
=======
	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/anthropic"
	"github.com/9Ashwin/flow-one/internal/config"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/spf13/cobra"
>>>>>>> Stashed changes
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// scriptedStream 按脚本吐分片：先给若干帧，最后给一个 err（若设了）。
type scriptedStream struct {
	frames [][]byte
	err    error
	closed bool
}

func (s *scriptedStream) Next() ([]byte, bool, error) {
	if len(s.frames) == 0 {
		if s.err != nil {
			err := s.err
			s.err = nil
			return nil, false, err
		}
		return nil, false, nil
	}
	frame := s.frames[0]
	s.frames = s.frames[1:]
	return frame, true, nil
}

func (s *scriptedStream) Close() error { s.closed = true; return nil }

func newTranslator(buffer *bytes.Buffer) *anthropic.StreamTranslator {
	return anthropic.NewStreamTranslator(anthropic.StreamOptions{
		Model: "oc/x", ID: "msg_test", InputTokens: 7,
		Write: func(frame []byte) { buffer.Write(frame) },
	})
}

func TestPumpStreamReportsErrorFrameAsStreamError(t *testing.T) {
	// 上游用 error 帧报错（OpenAI 风格的流内错误）时，必须发 event: error。
	// 早先漏了这一步：只发 message_delta + message_stop，客户端把被拦的一轮当成正常结束。
	stream := &scriptedStream{frames: [][]byte{
		[]byte(`{"choices":[{"delta":{"content":"部分"}}]}`),
		[]byte(`{"error":{"message":"请求被拦截，Illegal API invocation from an unapproved channel"}}`),
	}}
	var out bytes.Buffer
	pumpStream(stream, newTranslator(&out))
	text := out.String()

	assert.Contains(t, text, "event: error", "流内失败必须发 error 事件")
	assert.Contains(t, text, "请求被拦截", "错误理由要原样带给客户端")
	assert.NotContains(t, text, "message_delta", "报错之后不能再发 message_delta，否则客户端以为正常结束")
	assert.Contains(t, text, "message_stop", "仍要给一个收尾，客户端才不会一直等")
}

func TestPumpStreamReportsTypedSourceFailure(t *testing.T) {
	// 腾讯的流内拦截在来源层就已经变成类型化错误（带 code 11128），
	// 由 Next() 返回 —— 这条路同样必须发 event: error，而不是干净收尾。
	stream := &scriptedStream{
		frames: [][]byte{[]byte(`{"choices":[{"delta":{"content":"部分"}}]}`)},
		err: errs.Upstream(errs.SubtypeContentBlocked, "WorkBuddy 国际版：请求被拦截，Illegal API invocation from an unapproved channel").
			WithCode(11128),
	}
	var out bytes.Buffer
	pumpStream(stream, newTranslator(&out))
	text := out.String()
	assert.Contains(t, text, "event: error")
	assert.Contains(t, text, "请求被拦截")
	assert.NotContains(t, text, "message_delta")
}

func TestPumpStreamReportsReadFailure(t *testing.T) {
	// 连接中途断掉（读流出错）也要如实上报，而不是干净收尾
	stream := &scriptedStream{
		frames: [][]byte{[]byte(`{"choices":[{"delta":{"content":"半句"}}]}`)},
		err:    assert.AnError,
	}
	var out bytes.Buffer
	pumpStream(stream, newTranslator(&out))
	assert.Contains(t, out.String(), "event: error")
	assert.NotContains(t, out.String(), "message_delta")
}

func TestPumpStreamEndsNormallyOnCleanStream(t *testing.T) {
	stream := &scriptedStream{frames: [][]byte{
		[]byte(`{"choices":[{"delta":{"content":"好"}}]}`),
		[]byte(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1}}`),
	}}
	var out bytes.Buffer
	pumpStream(stream, newTranslator(&out))
	text := out.String()
	assert.NotContains(t, text, "event: error")
	assert.Contains(t, text, "event: message_delta")
	assert.Contains(t, text, "event: message_stop")
	assert.Contains(t, text, "好")
}

func TestRegistryStopsUnknownProduct(t *testing.T) {
	// 不认识的来源名要给可操作的错误，而不是静默少挂一条
	_, err := buildRegistry(configWithProducts("不存在的来源"), logf)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "不认识的来源")
}

func configWithProducts(names ...string) config.Config {
	cfg := config.Defaults()
	cfg.Products = names
	cfg.Home = "/tmp/ccb-test-home"
	cfg.CredentialFile = "/tmp/ccb-test-home/credentials.json"
	return cfg
}

var _ source.Stream = (*scriptedStream)(nil)

func TestRunFromMenuProvidesContext(t *testing.T) {
	// cobra 只在 Execute 里设置 ctx；从菜单直接调 RunE 时它是 nil，
	// 一路传到上游客户端就是 context.WithTimeout(nil, …) —— 真机上直接段错误。
	parent := &cobra.Command{}
	seen := false
	target := &cobra.Command{RunE: func(c *cobra.Command, _ []string) error {
		seen = true
		require.NotNil(t, c.Context(), "菜单里直接调 RunE 时必须补上 context")
		return nil
	}}
	require.NoError(t, runFromMenu(parent, target))
	assert.True(t, seen, "目标命令要真的被执行")

	// 父命令已经有 context 时（正常走 cobra 的路径）应当照传
	type key struct{}
	parent.SetContext(context.WithValue(context.Background(), key{}, "v"))
	require.NoError(t, runFromMenu(parent, target))
}
