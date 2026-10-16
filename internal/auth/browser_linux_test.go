// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import "testing"

// Linux 上打开链接用 xdg-open（没有它时只打印链接，不静默失败）。
func TestBrowserCommandOnLinux(t *testing.T) {
	if browserCommand != "xdg-open" {
		t.Fatalf("Linux 上应当用 xdg-open，实际是 %q", browserCommand)
	}
}
