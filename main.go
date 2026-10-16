// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// flow-one：让 Claude Code CLI 用上 WorkBuddy（国内版 / 国际版）与
// OpenCode（免费档 / Go 套餐）的本地反代。
package main

import (
	"os"

	"github.com/9Ashwin/flow-one/cmd"
)

func main() {
	os.Exit(cmd.Execute())
}
