// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/config"
)

// goEntry 是凭据文件里的条目名（与腾讯两条线共用同一份 credentials.json）。
const goEntry = "opencode-go"

// savedAtLayout 对齐 Node 版 `new Date().toISOString()`（毫秒精度的 UTC）。
const savedAtLayout = "2006-01-02T15:04:05.000Z"

// GoKey 是 Go 套餐的 key 与会话 id。
type GoKey struct {
	APIKey  string `json:"apiKey"`
	Session string `json:"session"`
}

// ReadGoKey 读出已配置的 Go 套餐凭据。没配（或文件坏掉）时 ok=false。
//
// 会话 id 是**必填**的 `x-opencode-session`：条目里没有（老版本写的凭据）就铸一个
// UUID —— 值本身无所谓（只用于服务端路由亲和），但每次都不带会被上游 400 MissingSessionID。
// 这条路要**复用**同一个值：GoTier 会在进程内把它粘住。
func ReadGoKey() (GoKey, bool) {
	file, err := credentialPath()
	if err != nil {
		return GoKey{}, false
	}
	key, configured := storedGoKey(file)
	if !configured {
		return GoKey{}, false
	}
	if key.Session == "" {
		key.Session = uuidV4()
	}
	return key, true
}

// HasGoKey 报告是否已配 key。向导据此只报状态，不再重复问（AGENTS.md「别重复问同一件事」）。
func HasGoKey() bool {
	_, configured := ReadGoKey()
	return configured
}

// GoKeyTail 是已配 key 的末四位（展示用：凭据里只存末四位，不落全量明文）。
func GoKeyTail() string {
	file, err := credentialPath()
	if err != nil {
		return ""
	}
	entry, found := readStore(file)[goEntry].(map[string]any)
	if !found {
		return ""
	}
	tail, _ := entry["tail"].(string)
	return tail
}

// SaveGoKey 存下 Go 套餐的 key 并返回生效的凭据。
//
// 会话 id 在这里生成一次并落盘复用：它只影响服务端路由亲和，但每次换一个会让同一台
// 机器被看成很多独立客户端（DSH 桌面端那边就是固定写死一个 UUID 的）。
//
// 凭据文件坏掉时**先备份再重写**（与 internal/auth 的 Store 同一套策略）：备份里有原文，
// 用户不会丢东西，也不会因为一个逗号卡住配不了 key。
func SaveGoKey(apiKey string) (GoKey, error) {
	file, err := credentialPath()
	if err != nil {
		return GoKey{}, err
	}
	trimmed := strings.TrimSpace(apiKey)
	if trimmed == "" {
		return GoKey{}, errs.Validation(errs.SubtypeMissingArgument, "key 不能为空").WithParam("apiKey")
	}
	store, broken, err := loadStore(file)
	if err != nil {
		return GoKey{}, err
	}
	if broken != nil {
		if err := backupBrokenStore(file, broken); err != nil {
			return GoKey{}, err
		}
		store = map[string]any{}
	}
	existing, _ := store[goEntry].(map[string]any)
	session, _ := existing["session"].(string)
	if session == "" {
		session = uuidV4()
	}
	store[goEntry] = map[string]any{
		"apiKey":  trimmed,
		"session": session,
		"tail":    trimmed[max(0, len(trimmed)-4):],
		"savedAt": time.Now().UTC().Format(savedAtLayout),
	}
	if err := writeStore(file, store); err != nil {
		return GoKey{}, err
	}
	return GoKey{APIKey: trimmed, Session: session}, nil
}

// storedGoKey 读凭据条目原文；session 可能为空（老版本或手写的凭据里没有）。
func storedGoKey(file string) (GoKey, bool) {
	entry, found := readStore(file)[goEntry].(map[string]any)
	if !found {
		return GoKey{}, false
	}
	apiKey, _ := entry["apiKey"].(string)
	if apiKey == "" {
		return GoKey{}, false
	}
	session, _ := entry["session"].(string)
	return GoKey{APIKey: apiKey, Session: session}, true
}

func credentialPath() (string, error) {
	home, err := config.Home()
	if err != nil {
		return "", err
	}
	return config.CredentialPath(home), nil
}

// readStore 读整份凭据文件；不存在或坏掉都当空表，且**不写任何东西**（读路径不该有副作用：
// HasGoKey / GoKeyTail 会被向导和 status 频繁调用）。
func readStore(file string) map[string]any {
	store, _, _ := loadStore(file)
	return store
}

// loadStore 读凭据表。broken 非 nil 表示文件存在但不是合法 JSON，内容是原文 ——
// 调用方要写它之前得先备份（见 SaveGoKey）。
func loadStore(file string) (store map[string]any, broken []byte, err error) {
	payload, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil, nil
		}
		return nil, nil, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("读不到凭据文件 %s", file))
	}
	if len(bytes.TrimSpace(payload)) == 0 {
		return map[string]any{}, nil, nil
	}
	table := map[string]any{}
	if err := json.Unmarshal(payload, &table); err != nil || table == nil {
		return map[string]any{}, payload, nil
	}
	return table, nil, nil
}

// backupBrokenStore 把坏掉的凭据文件复制成 `credentials.json.bak-<时间戳>`。
//
// 策略与 internal/auth 的 Store.update 一致（**先备份再重写**，不是拒绝写）：
// 凭据文件里躺着腾讯两条线的登录态，静默整表重写会把还能手工救回来的内容（比如多了一个
// 逗号）一起毁掉；但直接拒绝写又会让人连「重新配 key / 重新登录」都做不了。
func backupBrokenStore(file string, payload []byte) error {
	backup := fmt.Sprintf("%s.bak-%s", file, time.Now().UTC().Format("2006-01-02T15-04-05-000Z"))
	if err := os.WriteFile(backup, payload, 0o600); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "备份坏掉的凭据文件失败："+backup).
			WithHint("先手工把 credentials.json 修成合法 JSON，或把它挪走")
	}
	return nil
}

// writeStore 原子写回凭据文件：目录 0700、文件 0600，两边平台一致。
func writeStore(file string, store map[string]any) error {
	payload, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return errs.InternalFrom(err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("建不了目录 %s", filepath.Dir(file)))
	}
	temporary := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("写不了凭据文件 %s", temporary))
	}
	if err := os.Rename(temporary, file); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("换不了凭据文件 %s", file))
	}
	return nil
}
