// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package errs

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestCategoryDrivesExitCode(t *testing.T) {
	// 退出码只由 Category 推导，与消息文本无关
	cases := []struct {
		category Category
		want     int
	}{
		{CategoryValidation, 2},
		{CategoryAuth, 3},
		{CategoryConfig, 4},
		{CategoryNetwork, 5},
		{CategoryUpstream, 6},
		{CategoryInternal, 1},
	}
	for _, tc := range cases {
		if got := ExitCode(tc.category); got != tc.want {
			t.Fatalf("ExitCode(%s) = %d，期望 %d", tc.category, got, tc.want)
		}
	}
}

func TestNewPanicsOnUndeclaredSubtype(t *testing.T) {
	// 拼错 subtype 会让消费方的分支静默失效，所以在构造时就炸
	defer func() {
		if recover() == nil {
			t.Fatal("未声明的 subtype 应当 panic")
		}
	}()
	New(CategoryUpstream, "typo_not_declared", "x")
}

func TestEnvelopeIsOneLineJSON(t *testing.T) {
	err := Upstream(SubtypeContentBlocked, "请求被拦截").
		WithCode(11128).
		WithHint("检查指纹改写规则")
	payload := err.JSON()
	if got := len(payload); got == 0 {
		t.Fatal("信封不该为空")
	}
	var decoded Envelope
	if jsonErr := json.Unmarshal(payload, &decoded); jsonErr != nil {
		t.Fatalf("信封应当是合法 JSON: %v", jsonErr)
	}
	if decoded.OK {
		t.Fatal("失败信封的 ok 必须是 false")
	}
	if decoded.Error.Subtype != SubtypeContentBlocked || decoded.Error.Code != 11128 {
		t.Fatalf("信封丢了字段: %+v", decoded.Error)
	}
	if decoded.Error.Hint == "" {
		t.Fatal("hint 应当被保留")
	}
}

func TestIsMatchesByCategoryAndSubtype(t *testing.T) {
	// 消费方按 Category+Subtype 分支，所以 errors.Is 必须按这两项匹配
	target := Auth(SubtypeNotLoggedIn, "")
	actual := Auth(SubtypeNotLoggedIn, "国内版尚未登录").WithCode(401)
	if !errors.Is(actual, target) {
		t.Fatal("同类同 subtype 应当匹配")
	}
	if errors.Is(actual, Auth(SubtypeRefreshFailed, "")) {
		t.Fatal("不同 subtype 不该匹配")
	}
	if errors.Is(actual, Upstream(SubtypeNotLoggedIn, "")) {
		t.Fatal("不同 Category 不该匹配")
	}
}

func TestWrapPreservesCauseAndIsIdempotent(t *testing.T) {
	root := errors.New("connection refused")
	wrapped := Wrap(root, CategoryNetwork, SubtypeConnectFailed, "连不上 127.0.0.1:8789")
	if !errors.Is(wrapped, root) {
		t.Fatal("原因链必须保留")
	}
	// 再包一次（不带新消息）应当原样返回，不要把原因埋进第二层
	again := Wrap(wrapped, CategoryNetwork, SubtypeConnectFailed, "")
	if again != wrapped {
		t.Fatal("重复包装应当幂等")
	}
}
