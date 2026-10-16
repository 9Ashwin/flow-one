// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package auth

import "testing"

// macOS 上打开链接用 open。
func TestBrowserCommandOnDarwin(t *testing.T) {
	if browserCommand != "open" {
		t.Fatalf("macOS 上应当用 open，实际是 %q", browserCommand)
	}
}
