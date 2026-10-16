// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/9Ashwin/flow-one/errs"
)

// Home 返回数据目录：`BRIDGE_HOME` 优先（相对路径按当前目录展开），否则
// `~/.flow-one`。
//
// 与 internal/config.Home 语义一致，这里自带一份是为了**不让底层包 import 上层包**：
// internal/tencent 会 import 本包，而 config 迟早要 import 来源实现（解析产品名）。
// 路径一律 filepath.Join + os.UserHomeDir()，两边不出现写死的 /Users/... 字面量。
func Home() (string, error) {
	if override := strings.TrimSpace(os.Getenv("BRIDGE_HOME")); override != "" {
		return filepath.Abs(override)
	}
	base, err := os.UserHomeDir()
	if err != nil {
		return "", errs.InternalFrom(err).WithHint("设置 BRIDGE_HOME 指定数据目录")
	}
	return filepath.Join(base, ".flow-one"), nil
}

// StorePath 是凭据文件位置：`<Home>/credentials.json`。
func StorePath() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "credentials.json"), nil
}
