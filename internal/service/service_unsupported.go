// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

//go:build !darwin && !linux

package service

import "github.com/9Ashwin/flow-one/errs"

// 其它平台（Windows、BSD……）如实说「不支持」：宁可让 Install 明确失败，
// 也不要留一条只有 macOS 能走通的路径（AGENTS.md 的跨平台一节）。

func platformKind() Kind { return KindUnsupported }

func platformServicePath() (string, error) { return "", nil }

func legacyServicePath() (string, error) { return "", nil }
func unloadLegacyService(string) error   { return nil }

func renderServiceFile(Options) (string, error) {
	return "", errs.Config(errs.SubtypeServiceUnsupported, "本平台没有常驻服务实现")
}

func loadService(string) ([]string, error) {
	return nil, errs.Config(errs.SubtypeServiceUnsupported, "本平台没有常驻服务实现")
}

func unloadService(string) error { return nil }

// LogHint 在没有常驻实现的平台上没有意义。
func LogHint() string { return "" }

// RestartHint 在没有常驻实现的平台上没有意义。
func RestartHint() string { return "" }
