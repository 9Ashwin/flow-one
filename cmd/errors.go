// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"encoding/json"
	"os"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/claude"
)

// sourceErrNoModels 是「一条来源的模型都没拿到」时的类型化错误。
func sourceErrNoModels() *errs.Error {
	return errs.Upstream(errs.SubtypeModelUnavailable, "没有拿到任何模型").
		WithHint("先跑一次「一键配置」确认登录状态，或用 `flow-one models` 看哪条来源不可用")
}

// existingAPIKey 从现有配置里读回访问令牌。
//
// 换模型时**必须复用**原来的令牌：换一个新的会让正在跑的 Claude Code 立刻 401。
func existingAPIKey() string {
	path, err := claude.SettingsPath()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return ""
	}
	return settings.Env["ANTHROPIC_AUTH_TOKEN"]
}

var _ = json.Marshal
