// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package errs

// Subtype 是稳定的「小写加下划线」标识。消费方可以据此分支，所以**改名即破坏兼容**。
//
// 声明在这里的常量才允许被 New 使用；拼错的 subtype 会在构造时 panic（见 New），
// 而不是等到线上才发现分支匹配不上。
const (
	// ── validation：用户输入 ──
	SubtypeInvalidFlag     = "invalid_flag"
	SubtypeInvalidModel    = "invalid_model"
	SubtypeInvalidPort     = "invalid_port"
	SubtypeInvalidURL      = "invalid_upstream_url"
	SubtypeUnknownSource   = "unknown_source"
	SubtypeMissingArgument = "missing_argument"
	SubtypeInvalidRequest  = "invalid_request"

	// ── authentication ──
	SubtypeNotLoggedIn   = "not_logged_in"
	SubtypeLoginFailed   = "login_failed"
	SubtypeLoginTimeout  = "login_timeout"
	SubtypeMissingAPIKey = "missing_api_key"
	SubtypeRefreshFailed = "refresh_failed"

	// ── config ──
	SubtypeSettingsMissing      = "settings_missing"
	SubtypeSettingsInconsistent = "settings_inconsistent"
	SubtypeServiceCodeMismatch  = "service_code_mismatch"
	SubtypeNoSources            = "no_sources"
	SubtypeServiceUnsupported   = "service_unsupported"
	SubtypeSessionUnavailable   = "session_unavailable"

	// ── network ──
	SubtypeConnectFailed = "connect_failed"
	SubtypeTimeout       = "timeout"

	// ── upstream ──
	SubtypeBadStatus        = "bad_status"
	SubtypeContentBlocked   = "content_blocked" // 腾讯内容风控：400 + code 11128
	SubtypeShapeRejected    = "shape_rejected"  // OpenCode 免费档门禁：FreeTierError
	SubtypeMissingSession   = "missing_session" // OpenCode Go：缺 x-opencode-session
	SubtypeQuotaLimited     = "quota_limited"   // 额度 / 频率受限（不是门禁问题）
	SubtypeModelUnavailable = "model_unavailable"

	// ── internal ──
	SubtypeUnexpected  = "unexpected"
	SubtypeIOFailed    = "io_failed"
	SubtypeParseFailed = "parse_failed"
)

// declared 是 subtype 的封闭集合。
var declared = map[string]struct{}{
	SubtypeInvalidFlag: {}, SubtypeInvalidModel: {}, SubtypeInvalidPort: {},
	SubtypeInvalidURL: {}, SubtypeUnknownSource: {}, SubtypeMissingArgument: {}, SubtypeInvalidRequest: {},

	SubtypeNotLoggedIn: {}, SubtypeLoginFailed: {}, SubtypeLoginTimeout: {},
	SubtypeMissingAPIKey: {}, SubtypeRefreshFailed: {},

	SubtypeSettingsMissing: {}, SubtypeSettingsInconsistent: {}, SubtypeSessionUnavailable: {},
	SubtypeServiceCodeMismatch: {}, SubtypeNoSources: {}, SubtypeServiceUnsupported: {},

	SubtypeConnectFailed: {}, SubtypeTimeout: {},

	SubtypeBadStatus: {}, SubtypeContentBlocked: {}, SubtypeShapeRejected: {},
	SubtypeMissingSession: {}, SubtypeQuotaLimited: {}, SubtypeModelUnavailable: {},

	SubtypeUnexpected: {}, SubtypeIOFailed: {}, SubtypeParseFailed: {},
}

// IsDeclared 报告某个 subtype 是否在封闭集合里。
func IsDeclared(subtype string) bool {
	_, ok := declared[subtype]
	return ok
}
