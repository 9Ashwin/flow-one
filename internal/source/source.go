// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package source 定义「上游来源」这一层的**冻结接口**与注册表。
//
// 一个进程可以同时挂多个来源，模型 ID 一律带来源前缀（cn/… intl/… oc/… ocg/…），
// 于是「换个模型」就等于换个来源。注册表只认接口，不 import 任何具体来源实现 ——
// 具体实现在 internal/tencent 与 internal/opencode，接线在 cmd 层完成。
//
// # 套餐分离（本项目的一条硬不变式）
//
// 腾讯的内容风控改写**只对 WorkBuddy 两条线做**。OpenCode 的两条路（免费档与 Go
// 套餐）走的是别人家的网关，既不认那套指纹、也不该被改写。因此：
//
//   - Rewriter() 只有腾讯系来源返回非 nil；
//   - 翻译层拿到的 Rewriter 为 nil 时，出站 system 必须**逐字节不变**；
//   - 有回归测试盯着这条不变式（internal/server 的 TestNonTencentSourcesAreNotRewritten）。
package source

import "context"

// AuthMode 决定这条来源怎么拿凭据。
type AuthMode string

const (
	// AuthOAuth：浏览器授权轮询（腾讯两条线）。
	AuthOAuth AuthMode = "oauth"
	// AuthNone：匿名可用（OpenCode 免费档）。
	AuthNone AuthMode = "none"
	// AuthKey：填 API key（OpenCode Go 套餐）。
	AuthKey AuthMode = "key"
)

// Model 是一个来源里可用的模型（ID 不含来源前缀）。
type Model struct {
	ID              string
	Name            string
	ContextWindow   int
	MaxOutputTokens int
	SupportsImages  bool
	Free            bool
	// Efforts 是上游接受的 reasoning 档位（可空）。
	Efforts []string
}

// Stream 是上游 SSE 数据帧的序列：每帧是 `data:` 之后那段 JSON。
//
// 四条来源都归一到这里（OpenAI 的 chat.completion.chunk 形状），于是 Anthropic
// 翻译层完全不必知道上游是谁 —— 包括 OpenCode 免费档的工具名回改、以及腾讯的
// 流内拦截翻转，都在各自来源内部完成。
type Stream interface {
	// Next 返回下一帧。ok=false 表示正常结束（EOF 或 [DONE]）。
	Next() (payload []byte, ok bool, err error)
	// Close 释放连接。必须可重复调用。
	Close() error
}

// ChatRequest 是一次出站对话。
type ChatRequest struct {
	// Body 是 OpenAI 形状的请求体（由 internal/anthropic 生成，已按 Rewriter 处理过 system）。
	Body []byte
	// Model 是**裸**模型 ID（不含来源前缀）。
	Model string
	// Meta 是该模型的能力元数据，来源可据此裁剪 max_tokens / 档位。可为 nil。
	Meta *Model
}

// Rewriter 改写出站 system 文本。nil 表示不改写。
type Rewriter func(system string) string

// Source 是一条上游来源。
//
// 实现必须并发安全：模型清单会被多个请求同时读取。
type Source interface {
	// ID 是前缀，必须是小写短名（cn / intl / oc / ocg）。
	ID() string
	// Label 是给人看的名字。
	Label() string
	// Auth 决定要不要凭据、以及怎么拿。
	Auth() AuthMode
	// DefaultModel 是没有指定模型时的兜底（裸 ID）。
	DefaultModel() string
	// ListModels 列出可用模型。没有凭据时应返回 errs.Auth 错误，而不是空列表。
	ListModels(ctx context.Context) ([]Model, error)
	// Chat 发起一次对话。失败时错误应当是 errs 类型化错误。
	Chat(ctx context.Context, req ChatRequest) (Stream, error)
	// Rewriter 返回内容风控改写器。**只有腾讯系来源返回非 nil**（套餐分离不变式）。
	Rewriter() Rewriter
}
