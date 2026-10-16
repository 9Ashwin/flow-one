// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/9Ashwin/flow-one/errs"
)

// capability 是一个模型的能力元数据。
//
// 这张表**必须看**：`/v1/models` 只回 id/object/created/owned_by，没有任何能力信息，
// 而「窗口多大」直接决定要不要给 Claude Code 加 `[1m]` 后缀 —— 免费档的
// `deepseek-v4.1-flash-free` 实测是 200k（不是 1M），加错后缀会让它到 1M 才压缩上下文。
type capability struct {
	Name            string
	ContextWindow   int
	MaxOutputTokens int
	SupportsImages  bool
}

// capabilityCache 是能力表的 1 小时缓存，两条路共用一份（Node 版也是模块级一份）。
type capabilityCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	at   time.Time
	byID map[string]capability
}

// capabilities 是进程级的那一份缓存：同一台机器上免费档与 Go 套餐共用一个上游表。
var capabilities = newCapabilityCache(modelsDevTTL)

func newCapabilityCache(ttl time.Duration) *capabilityCache {
	return &capabilityCache{ttl: ttl, byID: map[string]capability{}}
}

// get 返回能力表。缓存新鲜就直接用；否则取一次 models.dev —— **拿不到就退回上一次的
// 结果（可能是空表）**，绝不因为能力表挂了就让模型清单也用不了。
func (c *capabilityCache) get(ctx context.Context, conn client) map[string]capability {
	c.mu.Lock()
	fresh := len(c.byID) > 0 && time.Since(c.at) < c.ttl
	cached := c.byID
	c.mu.Unlock()
	if fresh {
		return cached
	}
	rows, err := fetchCapabilities(ctx, conn)
	if err != nil {
		return cached
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = time.Now()
	c.byID = rows
	return rows
}

// fetchCapabilities 取 `https://models.dev/api.json` 的 `opencode.models`。
func fetchCapabilities(ctx context.Context, conn client) (map[string]capability, error) {
	ctx, cancel := withTimeout(ctx, modelsTimeout)
	defer cancel()
	rows := map[string]capability{}
	err := conn.getJSON(ctx, "models.dev", conn.modelsDevURL, nil, func(body io.Reader) error {
		payload, err := io.ReadAll(io.LimitReader(body, modelsDevLimit))
		if err != nil {
			return err
		}
		var document struct {
			Opencode struct {
				Models map[string]struct {
					Name       string `json:"name"`
					Attachment bool   `json:"attachment"`
					Limit      struct {
						Context *int `json:"context"`
						Output  *int `json:"output"`
					} `json:"limit"`
				} `json:"models"`
			} `json:"opencode"`
		}
		if err := json.Unmarshal(payload, &document); err != nil {
			return err
		}
		if document.Opencode.Models == nil {
			return errs.Internal(errs.SubtypeParseFailed, "models.dev 报文里没有 opencode.models")
		}
		for id, meta := range document.Opencode.Models {
			row := capability{Name: meta.Name, SupportsImages: meta.Attachment}
			if meta.Limit.Context != nil {
				row.ContextWindow = *meta.Limit.Context
			}
			if meta.Limit.Output != nil {
				row.MaxOutputTokens = *meta.Limit.Output
			}
			rows[id] = row
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// withTimeout 给请求加一个上限；调用方的 ctx 更早结束就按调用方的来。
func withTimeout(ctx context.Context, limit time.Duration) (context.Context, context.CancelFunc) {
	if deadline, set := ctx.Deadline(); set && time.Until(deadline) < limit {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, limit)
}
