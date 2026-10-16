// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package errs

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Problem 是一份类型化错误的线上形状。
//
// 字段含义分工明确，别混用：
//
//   - Category / Subtype：稳定标识，消费方可以据此分支；
//   - Code：上游的数字码（腾讯 11128、HTTP 状态码等），不承载本程序内部含义；
//   - Param：**只**用来说明哪一项用户输入不合法；
//   - Hint：恢复动作。修法写这里，不要写进 Message。
type Problem struct {
	Category Category `json:"type"`
	Subtype  string   `json:"subtype"`
	Code     int      `json:"code,omitempty"`
	Param    string   `json:"param,omitempty"`
	Hint     string   `json:"hint,omitempty"`
	Message  string   `json:"message"`
}

// Error 是带分类的错误。所有面向命令边界的失败都应该是它。
type Error struct {
	Problem
	cause error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Message != "" {
		return e.Message
	}
	return string(e.Category) + "/" + e.Subtype
}

// Unwrap 保留原因链：包装是幂等的（重复包装已类型化的错误会原样返回）。
func (e *Error) Unwrap() error { return e.cause }

// Is 让 errors.Is 能按 Category + Subtype 比较，而不必比消息文本。
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	if !ok || other == nil || e == nil {
		return false
	}
	return e.Category == other.Category && e.Subtype == other.Subtype
}

// Envelope 是 stderr 上每个进程退出一行的 JSON 对象。
type Envelope struct {
	OK    bool     `json:"ok"`
	Error *Problem `json:"error,omitempty"`
}

// JSON 渲染成一行信封（不换行，便于脚本逐行读取）。
func (e *Error) JSON() []byte {
	payload, err := json.Marshal(Envelope{OK: false, Error: &e.Problem})
	if err != nil {
		return []byte(`{"ok":false,"error":{"type":"internal","subtype":"unexpected","message":"error envelope failed to marshal"}}`)
	}
	return payload
}

// Human 渲染成给人看的一行（含 hint，不含 JSON）。
func (e *Error) Human() string {
	if e == nil {
		return ""
	}
	text := e.Error()
	if e.Hint != "" {
		text += "\n  → " + e.Hint
	}
	return text
}

// New 构造一个类型化错误。Subtype 必须是 subtypes.go 里声明过的常量，
// 否则 panic —— 拼错一个 subtype 会让消费方的分支静默失效。
func New(category Category, subtype string, message string) *Error {
	if !IsDeclared(subtype) {
		panic("errs: 未声明的 subtype: " + subtype)
	}
	return &Error{Problem: Problem{Category: category, Subtype: subtype, Message: message}}
}

// Wrap 在保留原因的同时补上分类。
func Wrap(cause error, category Category, subtype string, message string) *Error {
	if cause == nil {
		return New(category, subtype, message)
	}
	// 幂等：已经是类型化错误就原样返回，避免把上游原因埋进第二层
	var existing *Error
	if errors.As(cause, &existing) && message == "" {
		return existing
	}
	err := New(category, subtype, message)
	err.cause = cause
	return err
}

// As 取出类型化错误。
func As(err error) (*Error, bool) {
	var typed *Error
	if errors.As(err, &typed) {
		return typed, true
	}
	return nil, false
}

// ── 链式补充（返回副本，不改原对象）────────────────────────────────────────

// WithCode 记下上游的数字码。
func (e *Error) WithCode(code int) *Error {
	next := *e
	next.Code = code
	return &next
}

// WithParam 指明是哪一项输入不合法。
func (e *Error) WithParam(param string) *Error {
	next := *e
	next.Param = param
	return &next
}

// WithHint 给出恢复动作。
func (e *Error) WithHint(hint string) *Error {
	next := *e
	next.Hint = hint
	return &next
}

// WithCause 保留底层原因（不改变分类）。
func (e *Error) WithCause(cause error) *Error {
	next := *e
	next.cause = cause
	return &next
}

// ── 分类构造器：命令边界应当用这些，而不是裸 fmt.Errorf ──────────────────────

func Validation(subtype, message string) *Error { return New(CategoryValidation, subtype, message) }
func Auth(subtype, message string) *Error       { return New(CategoryAuth, subtype, message) }
func Config(subtype, message string) *Error     { return New(CategoryConfig, subtype, message) }
func Network(subtype, message string) *Error    { return New(CategoryNetwork, subtype, message) }
func Upstream(subtype, message string) *Error   { return New(CategoryUpstream, subtype, message) }
func Internal(subtype, message string) *Error   { return New(CategoryInternal, subtype, message) }

// InternalFrom 把「不该发生的错误」收敛成 internal，同时保留原因。
func InternalFrom(cause error) *Error {
	return Wrap(cause, CategoryInternal, SubtypeUnexpected, fmt.Sprintf("内部错误：%v", cause))
}
