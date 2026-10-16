// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/anthropic"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/server"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/spf13/cobra"
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "起本地反代（Claude Code 连它）",
	Long: `监听 127.0.0.1，接收 Anthropic 的 Messages 请求，翻成 OpenAI 形状发给上游，
再把回答翻回 Anthropic 事件。

无 TTY 时（systemd / launchd / 管道）不带子命令直接运行也走这条路。`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		return runServe(cmd.Context(), cfg)
	},
}

// runServe 起服务并等到信号。
func runServe(ctx context.Context, cfg config.Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	registry, err := buildRegistry(cfg, logf)
	if err != nil {
		return err
	}
	address := cfg.ListenAddr()
	logf(fmt.Sprintf("监听 http://%s，来源：%s", address, describeSources(registry)))
	if cfg.Model != "" {
		logf("默认模型：" + cfg.Model)
	}

	bridge := server.New(server.Options{
		Host: cfg.Host, Port: cfg.Port, APIKey: cfg.APIKey, Model: cfg.Model,
		HeartbeatMs: cfg.HeartbeatMs, ShowThinking: cfg.ShowThinking,
		MaxTokensCap: cfg.MaxTokensCap, Registry: registry, Hooks: anthropicHooks(cfg), Log: logff(logf),
	})
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := bridge.ListenAndServe(ctx); err != nil {
		return errs.Network(errs.SubtypeConnectFailed, fmt.Sprintf("起服务失败：%v", err)).
			WithHint(fmt.Sprintf("端口 %d 可能被占用：lsof -nP -iTCP:%d -sTCP:LISTEN", cfg.Port, cfg.Port))
	}
	return nil
}

func describeSources(registry *source.Registry) string {
	names := make([]string, 0, len(registry.Sources()))
	for _, item := range registry.Sources() {
		names = append(names, item.Label())
	}
	return fmt.Sprint(names)
}

// anthropicHooks 把翻译层的纯函数接到服务端。
//
// 这里是「套餐分离」的最后一环：RewriteSystem 直接来自来源的 Rewriter()，
// 为 nil 时翻译层保证出站 system 逐字节不变。
func anthropicHooks(cfg config.Config) server.Hooks {
	return server.Hooks{
		ToOpenAI: func(body []byte, opts server.TranslateOptions) ([]byte, error) {
			return anthropic.ToOpenAIRequest(body, anthropic.Options{
				Model:         opts.Model,
				MaxTokensCap:  opts.MaxTokensCap,
				RewriteSystem: opts.Rewriter,
			})
		},
		Stream: func(w io.Writer, stream source.Stream, opts server.TranslateOptions) error {
			translator := anthropic.NewStreamTranslator(anthropic.StreamOptions{
				Model: opts.Model, ID: newMessageID(), InputTokens: opts.InputTokens,
				ShowThinking: opts.ShowThinking,
				Write:        func(frame []byte) { _, _ = w.Write(frame) },
			})
			for {
				payload, ok, err := stream.Next()
				if err != nil {
					// 中途断流要如实告诉客户端，而不是干净收尾（那是另一个坑）
					translator.Fail(err.Error())
					return nil
				}
				if !ok {
					break
				}
				translator.Push(payload)
			}
			translator.End()
			return nil
		},
		Message: func(stream source.Stream, opts server.TranslateOptions) ([]byte, error) {
			outcome := anthropic.NewOutcome()
			for {
				payload, ok, err := stream.Next()
				if err != nil {
					return nil, errs.Network(errs.SubtypeConnectFailed, err.Error())
				}
				if !ok {
					break
				}
				anthropic.FoldChunk(outcome, payload)
			}
			if outcome.Failure != nil {
				return nil, errs.Upstream(errs.SubtypeBadStatus, outcome.Failure.Message)
			}
			return anthropic.AnthropicMessage(outcome, anthropic.MessageOptions{
				Model: opts.Model, ID: newMessageID(), InputTokens: opts.InputTokens,
				ShowThinking: opts.ShowThinking,
			}), nil
		},
		EstimateTokens: anthropic.EstimateInputTokens,
	}
}

// newMessageID 生成 Anthropic 形状的消息 id（msg_ + 24 位 hex）。
func newMessageID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "msg_000000000000000000000000"
	}
	return "msg_" + hex.EncodeToString(buffer)
}
