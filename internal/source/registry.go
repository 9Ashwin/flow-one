// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package source

import (
	"context"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// Registry 把带前缀的模型 ID 路由到来源。
type Registry struct {
	sources []Source
}

// NewRegistry 按给定顺序建立注册表；顺序决定「没有前缀的 ID」落在谁身上。
func NewRegistry(sources ...Source) *Registry {
	return &Registry{sources: sources}
}

// Sources 返回已挂载的来源（只读用途）。
func (r *Registry) Sources() []Source { return r.sources }

// Resolve 拆开 `oc/deepseek-v4.1-flash-free` → (oc 来源, 裸 ID)。
//
// 没有前缀、或前缀不是已挂载来源时，落到第一条来源 —— 与 Node 版的兜底一致：
// Claude Code 会剥掉 `[1m]` 之类的后缀，但用户手写裸模型名时也别直接报错。
func (r *Registry) Resolve(id string) (Source, string) {
	if len(r.sources) == 0 {
		return nil, id
	}
	name, model, found := strings.Cut(id, "/")
	if !found {
		return r.sources[0], id
	}
	for _, s := range r.sources {
		if s.ID() == name {
			return s, model
		}
	}
	return r.sources[0], id
}

// ListModels 汇总所有来源的模型，ID 带来源前缀。
//
// 单条来源失败不拖垮整体：把失败的原因收集起来，成功的照常返回 —— 一条产品线
// 没登录，不该让另外三条也用不了。
func (r *Registry) ListModels(ctx context.Context) ([]Model, []error) {
	var models []Model
	var failures []error
	for _, s := range r.sources {
		rows, err := s.ListModels(ctx)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		for _, row := range rows {
			row.ID = s.ID() + "/" + row.ID
			models = append(models, row)
		}
	}
	return models, failures
}

// Find 在已挂载来源里找某个带前缀 ID 的能力元数据。找不到返回 nil。
func (r *Registry) Find(id string) *Model {
	s, bare := r.Resolve(id)
	if s == nil {
		return nil
	}
	rows, err := s.ListModels(context.Background())
	if err != nil {
		return nil
	}
	for i := range rows {
		if rows[i].ID == bare {
			return &rows[i]
		}
	}
	return nil
}

// ErrNoSources 是「一条来源都没挂」时的类型化错误。
func ErrNoSources() *errs.Error {
	return errs.Config(errs.SubtypeNoSources, "没有任何上游来源被挂载").
		WithHint("跑一次「一键配置」，或在命令行加 --product cn --product oc")
}
