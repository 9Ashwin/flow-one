// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// base62 是官方 id 模块的字母表（0-9A-Za-z，顺序就是这一串）。
const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// idSequence 是「同一毫秒内递增」的计数器，对齐官方 id 模块的 sequence。
var idSequence struct {
	sync.Mutex
	stamp   int64
	counter int64
}

// SessionID 生成免费档要求的会话 id：`ses_` + 12 位小写 hex + 14 位 base62。
//
// 尾段总长 26（12 hex + 14 base62）来自官方 id 模块的 `LENGTH = 26`；把 26 当成
// 随机段长度会得到 38 字符，门禁一律 403 —— 这是最容易写错的一点。
func SessionID() string {
	stamp := time.Now().UnixMilli()
	return "ses_" + timeHex(^(stamp*0x1000 + nextSequence(stamp))) + randomBase62(14)
}

// RequestID 是每请求一个的 id，用网关同样接受的 `msg_` 铸造形状。
func RequestID() string {
	return "msg_" + timeHex(time.Now().UnixMilli()*0x1000+1) + randomBase62(14)
}

// ProjectID 返回 40 位小写 hex 的项目 id，并把它落在 `home/opencode.json` 里复用。
//
// 与官方 CLI 的 `sha1("git-remote:" + …)` 同形。本机身份必须重启后不变 —— 每次换一个
// 会让同一台机器在服务端被看成很多独立客户端。落盘失败不影响本次请求。
func ProjectID(home string) string {
	file := filepath.Join(home, "opencode.json")
	if payload, err := os.ReadFile(file); err == nil {
		var stored struct {
			ProjectID string `json:"projectId"`
		}
		if json.Unmarshal(payload, &stored) == nil && isProjectID(stored.ProjectID) {
			return stored.ProjectID
		}
	}
	identity := make([]byte, 16)
	_, _ = rand.Read(identity)
	sum := sha1.Sum([]byte("git-remote:opencode/" + hex.EncodeToString(identity)))
	value := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(home, 0o700); err == nil {
		if payload, err := json.MarshalIndent(map[string]string{"projectId": value}, "", "  "); err == nil {
			_ = os.WriteFile(file, payload, 0o600)
		}
	}
	return value
}

// nextSequence 返回当前毫秒内的递增序号（换了一毫秒就从头数）。
func nextSequence(stamp int64) int64 {
	idSequence.Lock()
	defer idSequence.Unlock()
	if stamp != idSequence.stamp {
		idSequence.stamp = stamp
		idSequence.counter = 0
	}
	idSequence.counter++
	return idSequence.counter
}

// timeHex 把时间戳铸成 12 位小写 hex：对齐官方 id 模块的 timeBytes（取 6 个字节）。
func timeHex(value int64) string {
	var out strings.Builder
	out.Grow(12)
	for index := range 6 {
		fmt.Fprintf(&out, "%02x", byte(value>>(40-8*index)))
	}
	return out.String()
}

// randomBase62 生成指定长度的 base62 随机段（与官方一样按字节取模，不做拒绝采样）。
func randomBase62(length int) string {
	buffer := make([]byte, length)
	// Go 1.24 起 crypto/rand 不会失败（失败即 panic），所以这里没有可处理的错误。
	_, _ = rand.Read(buffer)
	var out strings.Builder
	out.Grow(length)
	for _, value := range buffer {
		out.WriteByte(base62[int(value)%len(base62)])
	}
	return out.String()
}

// uuidV4 生成 RFC 4122 v4 UUID：Go 套餐的会话头收 UUID，也收 `ses_` 形状。
func uuidV4() string {
	var buffer [16]byte
	_, _ = rand.Read(buffer[:])
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16])
}

// isProjectID 判断一个字符串是不是 40 位小写 hex（落盘值被手改过就重新生成）。
func isProjectID(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
