// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

const (
	// storeFileMode / storeDirMode 是凭据与数据目录的权限，macOS 与 Linux 一致。
	storeFileMode = 0o600
	storeDirMode  = 0o700
)

// Token 是一次登录（或续期）拿到的令牌。
//
// 字段名与 Node 版的 credentials.json 逐字保持一致：Go 版与 Node 版会读同一份
// 文件，改名等于把用户已有的登录状态作废。
type Token struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	TokenType    string `json:"tokenType"`
	Domain       string `json:"domain"`
	// ExpiresAt 是绝对毫秒时刻；0 表示服务端没下发。
	ExpiresAt int64 `json:"expiresAt,omitempty"`
	// RefreshExpiresAt 同上，针对 refresh token。
	RefreshExpiresAt int64 `json:"refreshExpiresAt,omitempty"`
}

// Account 是账号展示信息；其中的企业 id 会进对话请求头。
type Account struct {
	UID          string `json:"uid"`
	Nickname     string `json:"nickname"`
	EnterpriseID string `json:"enterpriseId"`
	AccountType  string `json:"accountType"`
}

// Credential 是落盘的一条凭据（按来源 id 分条目）。
type Credential struct {
	Token
	Account *Account `json:"account,omitempty"`
}

// Status 供 `status` 子命令展示；不发起任何网络请求。
type Status struct {
	Product     string `json:"product"`
	Label       string `json:"label"`
	LoggedIn    bool   `json:"loggedIn"`
	Nickname    string `json:"nickname,omitempty"`
	ExpiresAt   int64  `json:"expiresAt,omitempty"`
	ExpiresInMs int64  `json:"expiresInMs,omitempty"`
	Refreshable bool   `json:"refreshable"`
}

// Store 是 credentials.json 的句柄。Path 为空时按 BRIDGE_HOME / 家目录解析。
type Store struct {
	Path string
}

// storeMu 串行化「读整表 → 改一条 → 写回」。
//
// Node 版是单线程的，Go 版会有多个请求同时走到续期；没有这把锁，两次 Save 会互相
// 盖掉（后写的那次带着先写之前读到的旧表）。锁只保护本进程，跨进程并发不在承诺内。
var storeMu sync.Mutex

// File 返回凭据文件路径。
func (s Store) File() (string, error) {
	if strings.TrimSpace(s.Path) != "" {
		return filepath.Abs(s.Path)
	}
	return StorePath()
}

// Read 读出整张表（来源 id → 凭据原文）。
//
// 文件缺失、读不动或不是对象时返回空表 —— 与 Node 版一致：凭据文件坏了不该让
// 进程连「重新登录」都进不去。
func (s Store) Read() map[string]json.RawMessage {
	file, err := s.File()
	if err != nil {
		return map[string]json.RawMessage{}
	}
	payload, err := os.ReadFile(file)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	var table map[string]json.RawMessage
	if err := json.Unmarshal(payload, &table); err != nil || table == nil {
		return map[string]json.RawMessage{}
	}
	return table
}

// Get 读一条凭据。
func (s Store) Get(id string) (Credential, bool) {
	raw, ok := s.Read()[id]
	if !ok {
		return Credential{}, false
	}
	var credential Credential
	if err := json.Unmarshal(raw, &credential); err != nil {
		return Credential{}, false
	}
	return credential, true
}

// Save 写入一条凭据，表里别的来源原样保留（cn / intl / ocg 共用一份文件）。
func (s Store) Save(id string, credential Credential) error {
	return s.update(func(table map[string]json.RawMessage) error {
		payload, err := json.Marshal(credential)
		if err != nil {
			return errs.InternalFrom(err)
		}
		table[id] = payload
		return nil
	})
}

// Drop 删掉一条凭据，别的来源原样保留。
func (s Store) Drop(id string) error {
	return s.update(func(table map[string]json.RawMessage) error {
		delete(table, id)
		return nil
	})
}

// update 是唯一写入口：先写临时文件（0600）再 rename，读到的一半凭据不会出现。
func (s Store) update(change func(map[string]json.RawMessage) error) error {
	storeMu.Lock()
	defer storeMu.Unlock()

	file, err := s.File()
	if err != nil {
		return err
	}
	// 坏文件走「先备份再重写」：凭据文件里躺着腾讯两条线的登录态，静默整表重写会把
	// 还能手工救回来的内容（比如多了一个逗号）一起毁掉；但直接拒绝写又会让人连
	// 「重新登录」都做不了。备份一份再写，两个诉求都满足 —— 与 claude.Install 同策略。
	table := s.Read()
	if raw, readErr := os.ReadFile(file); readErr == nil {
		var probe map[string]json.RawMessage
		if jsonErr := json.Unmarshal(raw, &probe); jsonErr != nil {
			backup := fmt.Sprintf("%s.bak-%s", file, time.Now().UTC().Format("2006-01-02T15-04-05-000Z"))
			if writeErr := os.WriteFile(backup, raw, 0o600); writeErr != nil {
				return errs.InternalFrom(writeErr)
			}
		}
	}
	if err := change(table); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(table, "", "  ")
	if err != nil {
		return errs.InternalFrom(err)
	}

	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, storeDirMode); err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "创建数据目录失败："+dir).
			WithHint("检查该目录的权限，或用 BRIDGE_HOME 换一个可写目录")
	}
	temp, err := os.CreateTemp(dir, filepath.Base(file)+".*.tmp")
	if err != nil {
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "创建临时凭据文件失败："+dir)
	}
	name := temp.Name()
	if err := temp.Chmod(storeFileMode); err != nil {
		temp.Close()
		os.Remove(name)
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "设置凭据文件权限失败："+name)
	}
	if _, err := temp.Write(payload); err != nil {
		temp.Close()
		os.Remove(name)
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "写入凭据失败："+name)
	}
	if err := temp.Close(); err != nil {
		os.Remove(name)
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "关闭凭据临时文件失败："+name)
	}
	if err := os.Rename(name, file); err != nil {
		os.Remove(name)
		return errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "替换凭据文件失败："+file)
	}
	return nil
}
