// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package config

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadPrefersEnvOverDefaults(t *testing.T) {
	home := t.TempDir()
	t.Setenv("BRIDGE_HOME", home)
	t.Setenv("BRIDGE_PORT", "9999")
	t.Setenv("BRIDGE_MODEL", "ocg/deepseek-v4.1-flash")
	t.Setenv("BRIDGE_PRODUCTS", "cn, oc")
	t.Setenv("BRIDGE_FINGERPRINT_REWRITE", "0")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, 9999, cfg.Port)
	assert.Equal(t, "ocg/deepseek-v4.1-flash", cfg.Model)
	// 逗号分隔要去空白，否则 sourceByName 找不到 " oc"
	assert.Equal(t, []string{"cn", "oc"}, cfg.Products)
	assert.False(t, cfg.RewriteContent, "显式关闭改写必须生效")
	assert.Equal(t, filepath.Join(home, "credentials.json"), cfg.CredentialFile)
	assert.Equal(t, ModeDirect, cfg.Mode)
}

func TestLoadRejectsBadPortWithParam(t *testing.T) {
	t.Setenv("BRIDGE_HOME", t.TempDir())
	t.Setenv("BRIDGE_PORT", "abc")
	_, err := Load()
	require.Error(t, err)
	typed, ok := errs.As(err)
	require.True(t, ok, "必须是类型化错误，脚本要按 subtype 分支")
	assert.Equal(t, errs.SubtypeInvalidPort, typed.Subtype)
	assert.Equal(t, "BRIDGE_PORT", typed.Param, "param 只用来指明哪一项输入不合法")
	assert.Equal(t, 2, errs.ExitCode(typed.Category))
}

func TestValidateGatewayRequiresUpstream(t *testing.T) {
	cfg := Defaults()
	cfg.Mode = ModeGateway
	err := cfg.Validate()
	require.Error(t, err)
	var typed *errs.Error
	require.True(t, errors.As(err, &typed))
	assert.Equal(t, errs.SubtypeSettingsMissing, typed.Subtype)
	assert.NotEmpty(t, typed.Hint, "缺上游地址要告诉用户加什么参数")
}

func TestValidateDirectRequiresSources(t *testing.T) {
	cfg := Defaults()
	err := cfg.Validate()
	require.Error(t, err)
	var typed *errs.Error
	require.True(t, errors.As(err, &typed))
	assert.Equal(t, errs.SubtypeNoSources, typed.Subtype)
}

func TestStripModelSuffix(t *testing.T) {
	// Claude Code 的 [1m] 标记可能留在模型名上，两边都要兜
	for input, want := range map[string]string{
		"intl/deepseek-v4.1-flash[1m]": "intl/deepseek-v4.1-flash",
		"ocg/deepseek-v4.1-flash":      "ocg/deepseek-v4.1-flash",
		"  cn/hy4-preview  ":           "cn/hy4-preview",
		"[1m]":                         "[1m]", // 全是后缀时不剥，避免剥成空串
	} {
		assert.Equal(t, want, StripModelSuffix(input), input)
	}
}
