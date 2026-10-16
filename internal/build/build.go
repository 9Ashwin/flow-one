// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package build 承载版本信息。值由 Makefile 通过 -ldflags 注入，
// 源码里的默认值只在 `go run` 时出现。
package build

var (
	// Version 形如 v0.2.0 或 git describe 的结果。
	Version = "dev"
	// Date 是构建日期（YYYY-MM-DD）。
	Date = ""
)

// String 是给 banner 与 `--version` 用的一行版本号。
func String() string {
	if Date == "" {
		return Version
	}
	return Version + " (" + Date + ")"
}
