// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package claude 负责读写 Claude Code 的 settings.json。
//
// 两条纪律：
//
//  1. **只碰自己要碰的键**。settings.json 是用户自己的地盘：里面可能已经有别的网关、
//     hooks、权限规则。这里只合并 env 下的 6 个 ANTHROPIC_* 键与顶层 model，其余原样
//     保留，并且写前先备份成 settings.json.bak-<时间戳>。
//  2. **卸载要认账**。写入时把「写了哪些键、写成什么值」记在 BRIDGE_HOME/install.json
//     （见 state.go，与 internal/service 共用一份）；还原只删**值仍然等于我们写的那个**
//     的键 —— 用户之后自己改过的就不动，免得把他的手工配置吃掉。
//
// 配置目录认 `CLAUDE_CONFIG_DIR`（macOS 与 Linux 同一条规则），没设就是 `~/.claude`。
package claude

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/config"
)

// suffix1M 是 Claude Code 的「按 1M 上下文登记」标记。
const suffix1M = "[1m]"

// oneMThreshold 是加 `[1m]` 后缀的门槛：**超过** 200k 才加。
const oneMThreshold = 200_000

// anthropicKeys 是我们会写进去的 6 个键。模型那几个必须同值，
// 否则 Claude Code 会按不同场景各取一个，静默跑成另一个模型。
var anthropicKeys = []string{
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
}

// ConfigDir 返回 Claude Code 的配置目录：`CLAUDE_CONFIG_DIR` 优先，否则 `~/.claude`。
func ConfigDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); override != "" {
		absolute, err := filepath.Abs(override)
		if err != nil {
			return "", errs.InternalFrom(err)
		}
		return absolute, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errs.InternalFrom(err).WithHint("设置 CLAUDE_CONFIG_DIR 指定 Claude Code 配置目录")
	}
	return filepath.Join(home, ".claude"), nil
}

// SettingsPath 返回 settings.json 的位置。
func SettingsPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// InstallOptions 是写入接入参数需要的输入。
type InstallOptions struct {
	// File 覆盖 settings.json 的位置；空则用 SettingsPath()。
	File string
	// BaseURL 是本机反代地址（写进 ANTHROPIC_BASE_URL）。
	BaseURL string
	// APIKey 是反代的访问令牌（写进 ANTHROPIC_AUTH_TOKEN）。
	APIKey string
	// Model 是模型 ID（带来源前缀）。顶层 model 与 ANTHROPIC_MODEL 都写它。
	Model string
	// ContextWindow 是模型的真实窗口。**>200k 才加 `[1m]`**，未知（0）不加。
	ContextWindow int
}

// InstallResult 如实报告这次写了什么、备份到哪。
type InstallResult struct {
	File   string
	Backup string // 空表示原文件不存在、没有备份
	Env    map[string]string
}

// Install 把反代的接入参数合并进 Claude Code 的 settings.json。
//
// 顶层 `model` 字段也要一起钉住：它和 env.ANTHROPIC_MODEL 谁优先由 Claude Code 自己的
// 版本决定，两个字段说法不一致时就会静默跑成另一个模型（真实隐患：从网关模式切到直连后，
// 这里还留着旧网关的 ID，而直连清单里没有它）。只留一个真相源：两个字段始终同值。
//
// 不写 `modelOverrides`：官方给的消诊断办法是把键写成 Claude 自己的模型 ID（等于让
// Claude Code 以为自己在跑 Opus），代价是它随之套用那个模型的窗口与行为，不值。
func Install(opts InstallOptions) (InstallResult, error) {
	file := opts.File
	if file == "" {
		resolved, err := SettingsPath()
		if err != nil {
			return InstallResult{}, err
		}
		file = resolved
	}
	settings, err := readSettings(file)
	if err != nil {
		return InstallResult{}, err
	}
	backupPath, err := backup(file)
	if err != nil {
		return InstallResult{}, err
	}
	sized := sizedModel(opts.Model, opts.ContextWindow)
	env := map[string]string{
		"ANTHROPIC_BASE_URL":             opts.BaseURL,
		"ANTHROPIC_AUTH_TOKEN":           opts.APIKey,
		"ANTHROPIC_MODEL":                sized,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  sized,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": sized,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   sized,
	}
	mergeEnv(settings, env)
	previous, hadPrevious := settings["model"]
	settings["model"] = sized
	if err := writeJSON(file, settings, 0o644); err != nil {
		return InstallResult{}, err
	}
	home, err := config.Home()
	if err != nil {
		return InstallResult{}, err
	}
	state := ReadInstallState(home)
	record := settingsRecord{File: file, Env: env}
	if backupPath != "" {
		record.Backup = &backupPath
	}
	if hadPrevious {
		record.PreviousModel = previous
	}
	state[settingsKey] = record
	if err := WriteInstallState(home, state); err != nil {
		return InstallResult{}, err
	}
	return InstallResult{File: file, Backup: backupPath, Env: env}, nil
}

// UninstallResult 如实报告这次删了什么、备份到哪。
type UninstallResult struct {
	// Skipped 表示没什么可还原的（没记录过、或目标文件已经不在）。
	Skipped bool
	Reason  string
	File    string
	Removed []string
	Backup  string
}

// Uninstall 还原：只删「值仍然等于我们写的那份」的键，并把顶层 model 恢复成安装前的值。
func Uninstall() (UninstallResult, error) {
	home, err := config.Home()
	if err != nil {
		return UninstallResult{}, err
	}
	state := ReadInstallState(home)
	record, recorded := recordOf(state)
	if !recorded {
		return UninstallResult{Skipped: true, Reason: "没有本工具写入过的记录"}, nil
	}
	file := record.File
	if file == "" {
		return UninstallResult{Skipped: true, Reason: "账本里没有记录配置文件位置"}, nil
	}
	if _, err := os.Stat(file); err != nil {
		if os.IsNotExist(err) {
			return UninstallResult{Skipped: true, Reason: file + " 不存在"}, nil
		}
		return UninstallResult{}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "读不到 "+file)
	}
	settings, err := readSettings(file)
	if err != nil {
		return UninstallResult{}, err
	}
	removed := []string{}
	if env, isObject := settings["env"].(map[string]any); isObject {
		// 按 key 排序遍历：账本是 map，随机顺序会让输出与 removed 列表不可断言
		for _, key := range slices.Sorted(maps.Keys(record.Env)) {
			current, isText := env[key].(string)
			if !isText || current != record.Env[key] {
				continue // 用户之后自己改过，留着
			}
			delete(env, key)
			removed = append(removed, key)
		}
		if len(env) == 0 {
			delete(settings, "env")
		}
	}
	// 顶层 model 字段：仍是我们写的那个才还原（用户自己改过就留他的）
	if written, hasModel := record.Env["ANTHROPIC_MODEL"]; hasModel {
		if current, isText := settings["model"].(string); isText && current == written {
			if record.PreviousModel == nil {
				delete(settings, "model")
			} else {
				settings["model"] = record.PreviousModel
			}
			removed = append(removed, "model")
		}
	}
	backupPath, err := backup(file)
	if err != nil {
		return UninstallResult{}, err
	}
	if err := writeJSON(file, settings, 0o644); err != nil {
		return UninstallResult{}, err
	}
	delete(state, settingsKey)
	if err := WriteInstallState(home, state); err != nil {
		return UninstallResult{}, err
	}
	return UninstallResult{File: file, Removed: removed, Backup: backupPath}, nil
}

// sizedModel 决定模型名要不要带 `[1m]` 后缀：**按真实窗口**，>200k 才加。
//
// 给一个 200k 的模型加 `[1m]`，会让 Claude Code 到 1M 才压缩上下文，然后撞上模型真实
// 上限（OpenCode 免费档的 `deepseek-v4.1-flash-free` 实测就是 200k，不是 1M）。窗口未知
// 时按不加处理 —— Claude Code 对未识别 ID 的默认假设正是 200k。
func sizedModel(model string, contextWindow int) string {
	bare := strings.TrimSuffix(model, suffix1M)
	if strings.HasSuffix(model, suffix1M) || contextWindow > oneMThreshold {
		return bare + suffix1M
	}
	return bare
}

// mergeEnv 把我们的键合并进 settings.env，其余键一个都不动。
//
// `env` 不是对象时（被手改成字符串之类）直接换成一个干净的对象：那种文件本来就不合法，
// 而我们要写进去的键必须是对象 —— 原内容在备份里还在。
func mergeEnv(settings map[string]any, env map[string]string) {
	existing, _ := settings["env"].(map[string]any)
	merged := make(map[string]any, len(existing)+len(env))
	for key, value := range existing {
		merged[key] = value
	}
	for key, value := range env {
		merged[key] = value
	}
	settings["env"] = merged
}

// readSettings 读 settings.json。文件不存在、读不到、不是 JSON 对象都当空表
// （Node 版同样如此；原文件在写之前会先备份，内容不会丢）。
func readSettings(file string) (map[string]any, error) {
	payload, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "读不到 "+file)
	}
	settings := map[string]any{}
	if len(bytes.TrimSpace(payload)) == 0 {
		return settings, nil
	}
	if err := decodeJSON(payload, &settings); err != nil || settings == nil {
		return map[string]any{}, nil
	}
	return settings, nil
}

// backup 把原文件复制成 `settings.json.bak-<时间戳>`；原文件不存在就不备份。
//
// 备份里含 ANTHROPIC_AUTH_TOKEN，所以给 0600（两边平台一致），不抄原文件的 0644。
func backup(file string) (string, error) {
	payload, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "读不到 "+file)
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	target := file + ".bak-" + stamp
	if err := os.WriteFile(target, payload, 0o600); err != nil {
		return "", errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "写不了备份 "+target)
	}
	return target, nil
}

// writeJSON 原子写：先写同目录的临时文件再 rename，中途不会留下半份配置。
func writeJSON(file string, value any, mode os.FileMode) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return errs.InternalFrom(err)
	}
	payload = append(payload, '\n')
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("建不了目录 %s", dir))
	}
	temporary := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(temporary, payload, mode); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("写不了 %s", temporary))
	}
	if err := os.Rename(temporary, file); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("换不了 %s", file))
	}
	return nil
}

// decodeJSON 解析 JSON 且**保留数字原文**：settings.json 里可能有 30000 这样的整数，
// 走一遍 float64 会把它变成 3e+04 之类，用户下次看到会以为被改了。
func decodeJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	return decoder.Decode(target)
}
