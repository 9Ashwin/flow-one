// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
)

// catalogModel 是一条目录条目：对外的部分是 source.Model，defaultEffort 只在组装
// 对话体时用得到（source.Model 里没有这一项，而它只在腾讯这条线上有意义）。
type catalogModel struct {
	model         source.Model
	defaultEffort string
}

// preferredAgents 是主对话 agent 的优先级：命中前一个就不再往后看。
var preferredAgents = []string{"cli", "craft"}

// isAutoAlias：这两个不是真模型，混进清单会让用户选中一个必然跑偏的 ID。
func isAutoAlias(id string) bool { return id == "auto" || id == "default" }

// isChatModel 过滤掉补全 / NES / 文生图这类条目 —— 它们不是对话模型，混进清单
// 会让用户选中一个必然失败的 ID。
func isChatModel(id string, meta map[string]any) bool {
	for _, prefix := range []string{"nes-", "completion-", "codewise-"} {
		if strings.HasPrefix(id, prefix) {
			return false
		}
	}
	if extra, ok := boolOf(meta["supportsExtra"]); ok && extra {
		return false
	}
	if maxOutput, ok := numberOf(meta["maxOutputTokens"]); ok && maxOutput > 0 && maxOutput <= 256 {
		return false
	}
	for _, tag := range arrayOf(meta["tags"]) {
		if text, ok := stringOf(tag); ok && text == "text-to-image" {
			return false
		}
	}
	return true
}

// catalogEntry 把一条 `data.models` 记录收敛成我们认的元数据。
func catalogEntry(id string, meta map[string]any) catalogModel {
	entry := catalogModel{model: source.Model{ID: id, Name: id}}
	if name, ok := stringOf(meta["name"]); ok && name != "" {
		entry.model.Name = name
	}
	if value, ok := numberOf(meta["maxInputTokens"]); ok && value > 0 {
		entry.model.ContextWindow = int(value)
	}
	if value, ok := numberOf(meta["maxOutputTokens"]); ok && value > 0 {
		entry.model.MaxOutputTokens = int(value)
	}
	if value, ok := boolOf(meta["supportsImages"]); ok {
		entry.model.SupportsImages = value
	}
	if reasoning, ok := objectOf(meta["reasoning"]); ok {
		for _, raw := range arrayOf(reasoning["supportedEfforts"]) {
			if effort, ok := stringOf(raw); ok && effort != "" {
				entry.model.Efforts = append(entry.model.Efforts, effort)
			}
		}
		if effort, ok := stringOf(reasoning["defaultEffort"]); ok && effort != "" {
			entry.defaultEffort = effort
		}
	}
	return entry
}

// trialModelIds：试用横幅下发的模型既不在 agent 列表也不在 `data.models` 里，
// 但实测可调用。
func trialModelIds(data map[string]any) []string {
	features, ok := objectOf(data["productFeaturesConfig"])
	if !ok {
		return nil
	}
	banner, ok := objectOf(features["ModelTrialBanner"])
	if !ok {
		return nil
	}
	var ids []string
	for _, raw := range arrayOf(banner["banners"]) {
		item, ok := objectOf(raw)
		if !ok {
			continue
		}
		if id, ok := stringOf(item["targetModelId"]); ok && id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// parseModels 解析 `/v3/config` 与企业模型端点的响应。
//
// 顺序即优先级：主对话 agent（cli 或 craft）引用的模型排最前，其余 `data.models`
// 里的对话模型跟上，最后补试用横幅。两个端点的模型集合**不同**（实测国内版
// `/v3/config` 才有 hy4-preview-f），所以调用方会取并集。
func parseModels(body map[string]any) []catalogModel {
	data, ok := objectOf(dataOf(body))
	if !ok {
		return nil
	}

	// metaById 的值可能被后来的同 id 记录顶掉，但它在清单里的位置保持第一次出现的
	// 顺序（JS Map.set 的语义），所以另存一份有序的 id 列表。
	metaById := map[string]map[string]any{}
	order := make([]string, 0, len(arrayOf(data["models"])))
	for _, raw := range arrayOf(data["models"]) {
		record, ok := objectOf(raw)
		if !ok {
			continue
		}
		id, ok := stringOf(record["id"])
		if !ok {
			continue
		}
		if _, seen := metaById[id]; !seen {
			order = append(order, id)
		}
		metaById[id] = record
	}

	parsed := make([]catalogModel, 0, len(order))
	seen := map[string]bool{}
	push := func(id string) {
		if id == "" || isAutoAlias(id) || seen[id] {
			return
		}
		meta := metaById[id]
		if !isChatModel(id, meta) {
			return
		}
		seen[id] = true
		parsed = append(parsed, catalogEntry(id, meta))
	}

	agents := arrayOf(data["agents"])
	for _, wanted := range preferredAgents {
		found := false
		for _, raw := range agents {
			agent, ok := objectOf(raw)
			if !ok {
				continue
			}
			if name, ok := stringOf(agent["name"]); !ok || name != wanted {
				continue
			}
			for _, item := range arrayOf(agent["models"]) {
				if id, ok := stringOf(item); ok {
					push(id)
				}
			}
			found = true
			break
		}
		if found {
			break
		}
	}
	for _, id := range order {
		push(id)
	}
	for _, id := range trialModelIds(data) {
		push(id)
	}
	return parsed
}

// fallbackCatalog 是远端目录拿不到时的内置兜底清单（不带能力元数据）。
func fallbackCatalog(ids []string) []catalogModel {
	rows := make([]catalogModel, 0, len(ids))
	for _, id := range ids {
		rows = append(rows, catalogModel{model: source.Model{ID: id, Name: id}})
	}
	return rows
}
