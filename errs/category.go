// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package errs 定义本 CLI 的类型化错误分类。
//
// 三个使用方依赖它：**解析 stderr JSON 信封的脚本与 agent**、**把错误映射成
// 协议形状的适配层**、以及**产生错误的业务代码**。本文件是这三方的唯一事实来源。
//
// 与上游行为有关的两条约定：
//
//   - `Category` 与 `Subtype` 是**线上稳定标识**，改名字就是破坏兼容；
//   - 进程退出码**只由 Category 推导**（见 ExitCode），不按消息文本判断。
package errs

// Category 是分类的顶层轴。线上 JSON 字段名是 "type"。
type Category string

const (
	// CategoryValidation：用户输入不合法（缺参数、名字不认识、URL 不合法）。
	CategoryValidation Category = "validation"
	// CategoryAuth：缺凭据、凭据过期、登录失败。
	CategoryAuth Category = "authentication"
	// CategoryConfig：配置文件缺失或自相矛盾（密钥与服务不一致等）。
	CategoryConfig Category = "config"
	// CategoryNetwork：连不上、超时、DNS 失败。
	CategoryNetwork Category = "network"
	// CategoryUpstream：上游答复了，但答复是失败 —— 包含腾讯内容风控拦截
	// （400 + 11128）与 OpenCode 免费档门禁拒绝（FreeTierError）。
	CategoryUpstream Category = "upstream"
	// CategoryInternal：本程序的 bug 或本地 I/O 失败。
	CategoryInternal Category = "internal"
)

// Categories 是封闭集合。新增成员要单独评审：一旦上线就不能改名。
var Categories = []Category{
	CategoryValidation,
	CategoryAuth,
	CategoryConfig,
	CategoryNetwork,
	CategoryUpstream,
	CategoryInternal,
}

// ExitCode 把分类映射成进程退出码。这是**唯一**的推导入口。
func ExitCode(c Category) int {
	switch c {
	case CategoryValidation:
		return 2
	case CategoryAuth:
		return 3
	case CategoryConfig:
		return 4
	case CategoryNetwork:
		return 5
	case CategoryUpstream:
		return 6
	case CategoryInternal:
		return 1
	default:
		return 1
	}
}
