// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package config 把「命令行 flag + 环境变量 + 默认值」收敛成一份 Config。
//
// 优先级固定为 flag > 环境变量 > 默认值；来源（BRIDGE_PRODUCTS）是唯一需要
// 知道「挂了哪几条上游」的地方，别的包只认 source.Registry。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
)

// Mode 是上游接法。
type Mode string

const (
	// ModeDirect：自己登录各家官方接口（腾讯两条线 + OpenCode 两条路）。
	ModeDirect Mode = "direct"
	// ModeGateway：转发给一个已有的 OpenAI 兼容网关。
	ModeGateway Mode = "gateway"
)

// Config 是一次运行的全部配置。
type Config struct {
	Mode           Mode
	Host           string
	Port           int
	Model          string
	APIKey         string
	Products       []string
	Upstream       string
	UpstreamKey    string
	ShowThinking   bool
	MaxTokensCap   int
	RewriteContent bool
	HeartbeatMs    int
	Home           string
	CredentialFile string
}

// Defaults 是没有任何输入时的取值。
func Defaults() Config {
	return Config{
		Mode:           ModeDirect,
		Host:           "127.0.0.1",
		Port:           8788,
		ShowThinking:   false,
		MaxTokensCap:   0,
		RewriteContent: true,
		HeartbeatMs:    5000,
	}
}

// Home 返回数据目录：`BRIDGE_HOME` 优先，否则 `~/.claude-code-openai-bridge`。
func Home() (string, error) {
	if override := strings.TrimSpace(os.Getenv("BRIDGE_HOME")); override != "" {
		return filepath.Abs(override)
	}
	base, err := os.UserHomeDir()
	if err != nil {
		return "", errs.InternalFrom(err).WithHint("设置 BRIDGE_HOME 指定数据目录")
	}
	return filepath.Join(base, ".claude-code-openai-bridge"), nil
}

// CredentialPath 是凭据文件位置（腾讯两条线与 OpenCode Go 共用一份）。
func CredentialPath(home string) string {
	return filepath.Join(home, "credentials.json")
}

// Load 把环境变量铺到 Defaults 上。flag 由 cmd 层覆盖，所以这里只读环境。
func Load() (Config, error) {
	cfg := Defaults()
	home, err := Home()
	if err != nil {
		return cfg, err
	}
	cfg.Home = home
	cfg.CredentialFile = CredentialPath(home)

	if raw := os.Getenv("BRIDGE_MODE"); raw != "" {
		mode := Mode(strings.ToLower(strings.TrimSpace(raw)))
		if mode != ModeDirect && mode != ModeGateway {
			return cfg, errs.Validation(errs.SubtypeInvalidFlag, fmt.Sprintf("BRIDGE_MODE 只能是 direct 或 gateway，收到 %q", raw)).
				WithParam("BRIDGE_MODE")
		}
		cfg.Mode = mode
	}
	if raw := os.Getenv("BRIDGE_HOST"); raw != "" {
		cfg.Host = strings.TrimSpace(raw)
	}
	if raw := strings.TrimSpace(os.Getenv("BRIDGE_PORT")); raw != "" {
		port, convErr := strconv.Atoi(raw)
		if convErr != nil || port < 0 || port > 65535 {
			return cfg, errs.Validation(errs.SubtypeInvalidPort, fmt.Sprintf("BRIDGE_PORT 不是合法端口：%q", raw)).
				WithParam("BRIDGE_PORT")
		}
		cfg.Port = port
	}
	cfg.Model = strings.TrimSpace(os.Getenv("BRIDGE_MODEL"))
	cfg.APIKey = strings.TrimSpace(os.Getenv("BRIDGE_API_KEY"))
	cfg.Upstream = strings.TrimSpace(os.Getenv("UPSTREAM_BASE_URL"))
	cfg.UpstreamKey = strings.TrimSpace(os.Getenv("UPSTREAM_API_KEY"))
	if raw := os.Getenv("BRIDGE_PRODUCTS"); strings.TrimSpace(raw) != "" {
		for _, name := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				cfg.Products = append(cfg.Products, trimmed)
			}
		}
	}
	if raw := strings.TrimSpace(os.Getenv("BRIDGE_SHOW_THINKING")); raw != "" {
		cfg.ShowThinking = raw == "1" || strings.EqualFold(raw, "true")
	}
	if raw := strings.TrimSpace(os.Getenv("BRIDGE_FINGERPRINT_REWRITE")); raw != "" {
		cfg.RewriteContent = !(raw == "0" || strings.EqualFold(raw, "false"))
	}
	if raw := strings.TrimSpace(os.Getenv("BRIDGE_MAX_TOKENS_CAP")); raw != "" {
		cap, convErr := strconv.Atoi(raw)
		if convErr != nil || cap < 0 {
			return cfg, errs.Validation(errs.SubtypeInvalidFlag, fmt.Sprintf("BRIDGE_MAX_TOKENS_CAP 不是合法数字：%q", raw)).
				WithParam("BRIDGE_MAX_TOKENS_CAP")
		}
		cfg.MaxTokensCap = cap
	}
	if raw := strings.TrimSpace(os.Getenv("BRIDGE_HEARTBEAT_MS")); raw != "" {
		ms, convErr := strconv.Atoi(raw)
		if convErr != nil || ms < 0 {
			return cfg, errs.Validation(errs.SubtypeInvalidFlag, fmt.Sprintf("BRIDGE_HEARTBEAT_MS 不是合法数字：%q", raw)).
				WithParam("BRIDGE_HEARTBEAT_MS")
		}
		cfg.HeartbeatMs = ms
	}
	return cfg, nil
}

// Validate 在起服务前检查必要项。缺失时给的是「怎么办」而不是「哪里错了」。
func (c Config) Validate() error {
	if c.Mode == ModeGateway {
		if c.Upstream == "" {
			return errs.Config(errs.SubtypeSettingsMissing, "网关模式没给上游地址").
				WithHint("加 --upstream http://127.0.0.1:8326，或设 UPSTREAM_BASE_URL")
		}
		if !strings.HasPrefix(c.Upstream, "http://") && !strings.HasPrefix(c.Upstream, "https://") {
			return errs.Validation(errs.SubtypeInvalidURL, fmt.Sprintf("上游地址只支持 http/https：%s", c.Upstream)).
				WithParam("upstream")
		}
	}
	if len(c.Products) == 0 && c.Mode == ModeDirect {
		return errs.Config(errs.SubtypeNoSources, "直连模式没有任何来源").
			WithHint("菜单里跑一次「一键配置」，或加 --product cn")
	}
	return nil
}

// ListenAddr 是 http.Server 的监听地址。
func (c Config) ListenAddr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// StripModelSuffix 去掉 Claude Code 贴在模型名后的方括号标记（如 `[1m]`）。
//
// Claude Code 发请求前**理论上**会自己剥掉，但实测某些路径会留着，所以两边都兜。
func StripModelSuffix(model string) string {
	trimmed := strings.TrimSpace(model)
	if !strings.HasSuffix(trimmed, "]") {
		return trimmed
	}
	if at := strings.LastIndex(trimmed, "["); at > 0 {
		return strings.TrimSpace(trimmed[:at])
	}
	return trimmed
}
