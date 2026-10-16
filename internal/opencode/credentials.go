// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
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
// 会话 id 是**必填**的 `x-opencode-session`：条目里没有就现场铸一个 UUID ——
// 值本身无所谓（只用于服务端路由亲和），但每次都不带会被上游 400 MissingSessionID。
func ReadGoKey() (GoKey, bool) {
	file, err := credentialPath()
	if err != nil {
		return GoKey{}, false
	}
	return readGoKey(file)
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
func SaveGoKey(apiKey string) (GoKey, error) {
	file, err := credentialPath()
	if err != nil {
		return GoKey{}, err
	}
	trimmed := strings.TrimSpace(apiKey)
	if trimmed == "" {
		return GoKey{}, errs.Validation(errs.SubtypeMissingArgument, "key 不能为空").WithParam("apiKey")
	}
	store, err := readStoreStrict(file)
	if err != nil {
		return GoKey{}, err
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

func readGoKey(file string) (GoKey, bool) {
	entry, found := readStore(file)[goEntry].(map[string]any)
	if !found {
		return GoKey{}, false
	}
	apiKey, _ := entry["apiKey"].(string)
	if apiKey == "" {
		return GoKey{}, false
	}
	session, _ := entry["session"].(string)
	if session == "" {
		session = uuidV4()
	}
	return GoKey{APIKey: apiKey, Session: session}, true
}

func credentialPath() (string, error) {
	home, err := config.Home()
	if err != nil {
		return "", err
	}
	return config.CredentialPath(home), nil
}

// readStore 读整份凭据文件；不存在或坏掉都当空表（读不到不该挡住写入）。
func readStore(file string) map[string]any {
	store, _ := readStoreStrict(file)
	return store
}

// readStoreStrict 与 readStore 的区别：文件存在但**不是合法 JSON** 时报错。
//
// Node 版在同样的情况下会把坏文件当成空表，然后把整份凭据覆盖掉 —— 那会顺手毁掉
// 腾讯两条线已经登录好的凭据。宁可报错让用户修，也不静默吃掉别人的登录态。
func readStoreStrict(file string) (map[string]any, error) {
	payload, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, fmt.Sprintf("读不到凭据文件 %s", file))
	}
	store := map[string]any{}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(payload, &store); err != nil || store == nil {
		return nil, errs.Internal(errs.SubtypeParseFailed, fmt.Sprintf("凭据文件不是合法 JSON：%s", file)).
			WithHint("修好或删掉它再重试（不会覆盖坏文件）")
	}
	return store, nil
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
