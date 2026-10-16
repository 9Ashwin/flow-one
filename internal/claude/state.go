// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// 安装账本 BRIDGE_HOME/install.json。
//
// 它记的是「本工具改过这台机器的什么」：claudeSettings（我们对 settings.json 写的键与
// 值）与 service / autoStart / autoStartAsked（后台服务那一节）。**claude 与
// internal/service 共用这一份**，各自只碰自己那一节，互不覆盖。
//
// 与 credentials.json 同目录（BRIDGE_HOME），目录 0700、文件 0600、原子写。
const settingsKey = "claudeSettings"

// InstallStatePath 是安装账本的位置。
func InstallStatePath(home string) string {
	return filepath.Join(home, "install.json")
}

// ReadInstallState 读安装账本。不存在、读不到、坏掉都返回空账本 —— 坏账本不该挡住
// 安装，而且下次写入会把它整个换掉。
func ReadInstallState(home string) map[string]any {
	payload, err := os.ReadFile(InstallStatePath(home))
	if err != nil {
		return map[string]any{}
	}
	state := map[string]any{}
	if err := decodeJSON(payload, &state); err != nil || state == nil {
		return map[string]any{}
	}
	return state
}

// WriteInstallState 原子写安装账本（0600）。调用方读到 map、改自己那一节、再写回来。
func WriteInstallState(home string, state map[string]any) error {
	return writeJSON(InstallStatePath(home), state, 0o600)
}

// settingsRecord 是账本里「我们往 settings.json 写了什么」那一节。
type settingsRecord struct {
	File   string            `json:"file"`
	Backup *string           `json:"backup"`
	Env    map[string]string `json:"env"`
	// PreviousModel 是安装前顶层 `model` 的值（当时没有就是 nil，还原时删掉它）。
	PreviousModel any `json:"previousModel"`
}

// recordOf 从账本里取出 claudeSettings 那一节。
func recordOf(state map[string]any) (settingsRecord, bool) {
	raw, found := state[settingsKey]
	if !found {
		return settingsRecord{}, false
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return settingsRecord{}, false
	}
	var record settingsRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return settingsRecord{}, false
	}
	return record, true
}
