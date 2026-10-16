// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/auth"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/claude"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/gateway"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/opencode"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/service"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/tencent"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/ui"
	"github.com/spf13/cobra"
)

// serviceFlag 让脚本能明确表态；nil 表示「按记忆与现状自动决定」。
var serviceFlag *bool

// runSetup 是「一次配一家」的向导。
//
// 三处刻意的设计（都有用户反馈背书）：
//   - **一次只配一家**，配完回菜单再进来配下一家（像 zcf 那样一项一项来）；
//   - **后台服务问过就不再问**：装过就直接更新，拒绝过就只提示怎么开启；
//   - 选模型只列这一家的模型，支持边打边筛（上百条时靠敲字缩小范围）。
func runSetup(cmd *cobra.Command, cfg config.Config) error {
	ui.Heading("一键配置")
	ui.Note(ui.Dim("  一次配一家：接哪一家 → 登录 → 选模型 → 写配置并常驻"))
	ui.Note(ui.Dim("  想再挂一家，配完再跑一次（不会顶掉先前的）"))

	ui.Section("第 1 步 · 接哪一家")
	target, err := ui.Select("接哪一家？", []ui.Option{
		{Label: "WorkBuddy 国内版（CodeBuddy）", Hint: loginHint("cn", cfg), Value: "cn"},
		{Label: "WorkBuddy 国际版", Hint: loginHint("intl", cfg), Value: "intl"},
		{Label: "OpenCode 免费档", Hint: "oc 无需登录，免费模型", Value: "oc"},
		{Label: "OpenCode Go 套餐", Hint: goHint(), Value: "ocg"},
		{Label: "转发给已有的 OpenAI 兼容网关", Hint: "自建网关 / LiteLLM / Ollama", Value: "gw"},
	}, ui.SelectOptions{})
	if err != nil {
		return err
	}

	ui.Section("第 2 步 · 登录")
	built, serviceEnv, err := prepareSource(cmd.Context(), target, cfg)
	if err != nil {
		return err
	}

	ui.Section("第 3 步 · 模型")
	models, err := built.ListModels(cmd.Context())
	if err != nil {
		return err
	}
	if len(models) == 0 {
		return errs.Upstream(errs.SubtypeModelUnavailable, "这家没有可用模型").
			WithHint("确认这条来源的登录状态，或换一家再试")
	}
	ui.Success(fmt.Sprintf("%d 个模型可用", len(models)))
	picked, err := pickModel(models)
	if err != nil {
		return err
	}

	ui.Section("第 4 步 · 写入并常驻")
	port, err := choosePort(cfg)
	if err != nil {
		return err
	}
	apiKey, err := randomAPIKey()
	if err != nil {
		return err
	}
	applied, err := claude.Install(claude.InstallOptions{
		BaseURL:       fmt.Sprintf("http://127.0.0.1:%d", port),
		APIKey:        apiKey,
		Model:         picked.ID,
		ContextWindow: picked.ContextWindow,
	})
	if err != nil {
		return err
	}
	ui.Success("已写入 " + applied.File)
	if applied.Backup != "" {
		ui.Note("  " + ui.Gray("原文件已备份："+applied.Backup))
	}

	wantsService, err := decideService(cfg)
	if err != nil {
		return err
	}
	health := false
	if wantsService {
		result, err := service.Install(service.Options{
			Port: port, APIKey: apiKey,
			Env:     serviceEnv,
			Command: []string{service.CurrentCLIPath(), "serve"},
		})
		if err != nil {
			// 服务装不上必须说清下一步：错误自带的 hint 才是可执行的那条路
			// （无头 Linux 上最常见的就是「没有用户会话」，那时唯一的出路是前台跑）。
			ui.Fail(err.Error())
			if typed, ok := errs.As(err); ok && typed.Hint != "" {
				ui.Note("  " + ui.Gray("→ "+typed.Hint))
			}
			ui.Warn("先用前台方式跑起来：")
			ui.Note("  " + ui.Gray(fmt.Sprintf("BRIDGE_PORT=%d BRIDGE_API_KEY=%s claude-code-bridge serve", port, apiKey)))
		} else {
			ui.Success(fmt.Sprintf("后台服务已更新（%s）", result.Kind))
			for _, note := range result.Notes {
				ui.Note("  " + ui.Gray(note))
			}
			health = waitHealthy(port)
			if !health {
				ui.Warn("12 秒内没等到 /health 应答。看日志：")
				ui.Note("  " + ui.Gray(service.LogHint()))
			}
		}
	}

	ui.Blank()
	ui.Box([]string{
		"配置完成",
		fmt.Sprintf("%s  %s", ui.Gray("本次"), target),
		fmt.Sprintf("%s  %s", ui.Gray("模型"), picked.ID),
		fmt.Sprintf("%s  http://127.0.0.1:%d", ui.Gray("监听"), port),
		fmt.Sprintf("%s  %s", ui.Gray("服务"), serviceSummary(wantsService, health)),
	}, ui.Green)
	ui.Blank()
	ui.Info("现在直接在任意目录运行 " + ui.Bold("claude") + " 即可")
	ui.Note(ui.Dim("  再挂一家：菜单里再选一次「一键配置」   改模型：「切换模型」   还原：「还原配置」"))
	return nil
}

// prepareSource 处理第 2 步，并返回「这次要用来列模型的那条来源」。
//
// 网关模式特殊：它没有固定模型清单，只能问地址与密钥，然后直接落配置。
func prepareSource(ctx context.Context, target string, cfg config.Config) (source.Source, map[string]string, error) {
	switch target {
	case "cn", "intl":
		product, ok := tencent.ProductByName(target)
		if !ok {
			return nil, nil, unknownSource(target)
		}
		client := auth.NewClient()
		client.File = cfg.CredentialFile
		status := client.Status(product)
		if status.LoggedIn {
			ui.Success(fmt.Sprintf("%s 已登录%s", product.Label, nicknameSuffix(status.Nickname)))
		} else {
			ui.Note(ui.Dim("  浏览器会打开授权页；终端里也会打印链接，SSH 环境下复制粘贴即可。"))
			if _, err := client.Login(ctx, product); err != nil {
				return nil, nil, err
			}
			ui.Success(product.Label + " 已登录")
		}
		built, err := tencent.New(tencent.Config{Product: product, StorePath: cfg.CredentialFile, Log: logf})
		if err != nil {
			return nil, nil, err
		}
		return built, map[string]string{"BRIDGE_MODE": "direct", "BRIDGE_PRODUCTS": mergeProducts(cfg, target)}, nil

	case "oc":
		ui.Success("OpenCode 免费模型 无需登录，直接可用")
		built, err := opencode.NewFreeTier(opencode.Options{Home: cfg.Home, CredentialFile: cfg.CredentialFile})
		if err != nil {
			return nil, nil, err
		}
		return built, map[string]string{"BRIDGE_MODE": "direct", "BRIDGE_PRODUCTS": mergeProducts(cfg, target)}, nil

	case "ocg":
		if opencode.HasGoKey() {
			ui.Success("OpenCode Go 套餐 已配 key（末四位 " + opencode.GoKeyTail() + "）")
		} else {
			ui.Note(ui.Dim("  在 opencode.ai 控制台复制 Go 套餐的 API key，粘贴到这里（不回显）。"))
			value, err := ui.Password("OpenCode API key")
			if err != nil {
				return nil, nil, err
			}
			if len(strings.TrimSpace(value)) < 20 {
				return nil, nil, errs.Validation(errs.SubtypeMissingAPIKey, "看起来不像一个 key").
					WithParam("--api-key").WithHint("Go 套餐的 key 形如 oc_sk_…")
			}
			saved, err := opencode.SaveGoKey(value)
			if err != nil {
				return nil, nil, err
			}
			ui.Success(fmt.Sprintf("已保存（末四位 %s）", saved.APIKey[len(saved.APIKey)-4:]))
		}
		built, err := opencode.NewGoTier(opencode.Options{Home: cfg.Home, CredentialFile: cfg.CredentialFile})
		if err != nil {
			return nil, nil, err
		}
		return built, map[string]string{"BRIDGE_MODE": "direct", "BRIDGE_PRODUCTS": mergeProducts(cfg, target)}, nil

	case "gw":
		base, err := ui.Input("上游地址", "http://127.0.0.1:8326")
		if err != nil {
			return nil, nil, err
		}
		key, err := ui.Input("上游密钥（没有就直接回车）", "")
		if err != nil {
			return nil, nil, err
		}
		built, err := gateway.New(gateway.Config{BaseURL: base, APIKey: key})
		if err != nil {
			return nil, nil, err
		}
		ui.Success("网关来源已就绪：" + built.Label())
		return built, map[string]string{
			"BRIDGE_MODE": "gateway", "UPSTREAM_BASE_URL": strings.TrimRight(base, "/"),
		}, nil
	}
	return nil, nil, unknownSource(target)
}

// pickModel 让用户在这**一家**的模型里挑一个。
//
// 免费档单独成组排最前；清单上百条时靠边打边筛（敲 glm / oc/deep 都能缩范围）。
func pickModel(models []source.Model) (source.Model, error) {
	free := []source.Model{}
	paid := []source.Model{}
	for _, model := range models {
		if model.Free {
			free = append(free, model)
			continue
		}
		paid = append(paid, model)
	}
	options := []ui.Option{}
	if len(free) > 0 {
		options = append(options, ui.Option{Label: fmt.Sprintf("免费模型（%d 个）", len(free)), Separator: true})
		for _, model := range free {
			options = append(options, ui.Option{Label: model.ID, Hint: modelHint(model), Value: model.ID})
		}
	}
	if len(paid) > 0 {
		options = append(options, ui.Option{
			Label: fmt.Sprintf("其余模型（%d 个，按量计费 / 订阅）", len(paid)), Separator: true,
		})
		for _, model := range paid {
			options = append(options, ui.Option{Label: model.ID, Hint: modelHint(model), Value: model.ID})
		}
	}
	chosen, err := ui.Select("用哪个模型？", options, ui.SelectOptions{Filterable: true, Window: 12})
	if err != nil {
		return source.Model{}, err
	}
	for _, model := range models {
		if model.ID == chosen {
			return model, nil
		}
	}
	return source.Model{ID: chosen}, nil
}

func modelHint(model source.Model) string {
	bits := []string{}
	if model.Free {
		bits = append(bits, "免费")
	}
	if model.ContextWindow > 0 {
		bits = append(bits, "窗口 "+humanTokens(model.ContextWindow))
	}
	if model.MaxOutputTokens > 0 {
		bits = append(bits, "输出 "+humanTokens(model.MaxOutputTokens))
	}
	if model.SupportsImages {
		bits = append(bits, "视觉")
	}
	return strings.Join(bits, " · ")
}

// decideService 决定要不要装后台服务，并**只在需要时问一次**。
//
// 用户明确要求过：装过一次就别每次配置都再问。规则：
//   - 显式 flag 最优先（脚本化场景要能用）；
//   - 已经装过 → 直接更新，不问；
//   - 拒绝过 → 不问，只提示怎么开启；
//   - 从没表态 → 问一次，把选择记进 install.json。
func decideService(cfg config.Config) (bool, error) {
	state, err := service.Inspect()
	if err != nil {
		return false, err
	}
	if !state.Supported {
		ui.Warn("这个平台没有实现后台常驻，跳过（服务相关命令在 macOS 与 Linux 上可用）")
		return false, nil
	}
	if serviceFlag != nil {
		return *serviceFlag, nil
	}
	if state.Installed {
		ui.Note(ui.Dim(fmt.Sprintf("  后台服务已装（%s），本次直接更新配置", state.Kind)))
		return true, nil
	}
	if choice, ok := service.LastChoice(); ok && choice.Asked && !choice.AutoStart {
		ui.Note(ui.Dim("  按你上次的选择跳过后台服务；要开启：claude-code-bridge setup --service"))
		return false, nil
	}
	wants, err := ui.Confirm("装成开机自启的后台服务？", true)
	if err != nil {
		return false, err
	}
	if err := service.RecordChoice(wants); err != nil {
		return false, err
	}
	return wants, nil
}

// choosePort 复用已有实例的端口：配置里写哪个端口，就应该在那个端口上服务，
// 否则回到 Claude Code 只会看到 ECONNREFUSED。
func choosePort(cfg config.Config) (int, error) {
	if port := configuredPort(); port != 0 {
		return port, nil
	}
	for port := 8788; port < 8800; port++ {
		if !portInUse(port) {
			return port, nil
		}
	}
	return 0, errs.Config(errs.SubtypeSettingsInconsistent, "8788-8799 都被占用了").
		WithHint("用 --port 指定一个空闲端口")
}

// configuredPort 从已有配置里读端口（settings.json → install.json）。
func configuredPort() int {
	if raw, err := os.ReadFile(mustSettingsPath()); err == nil {
		var settings struct {
			Env map[string]string `json:"env"`
		}
		if json.Unmarshal(raw, &settings) == nil {
			if port := portFromURL(settings.Env["ANTHROPIC_BASE_URL"]); port != 0 {
				return port
			}
		}
	}
	if home, err := config.Home(); err == nil {
		state := claude.ReadInstallState(home)
		if service, ok := state["service"].(map[string]any); ok {
			if port, ok := service["port"].(float64); ok && port > 0 {
				return int(port)
			}
		}
	}
	return 0
}

func mustSettingsPath() string {
	path, err := claude.SettingsPath()
	if err != nil {
		return ""
	}
	return path
}

func portFromURL(raw string) int {
	trimmed := strings.TrimSpace(raw)
	at := strings.LastIndex(trimmed, ":")
	if at < 0 {
		return 0
	}
	port := 0
	for _, char := range trimmed[at+1:] {
		if char < '0' || char > '9' {
			return 0
		}
		port = port*10 + int(char-'0')
	}
	return port
}

func portInUse(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return true
	}
	_ = listener.Close()
	return false
}

func randomAPIKey() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", errs.InternalFrom(err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// waitHealthy 等本桥的 /health 应答（最多 12 秒）。
func waitHealthy(port int) bool {
	client := &http.Client{Timeout: 900 * time.Millisecond}
	for attempt := 0; attempt < 24; attempt++ {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
		if err == nil {
			var payload struct {
				Service string `json:"service"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&payload)
			response.Body.Close()
			if decodeErr == nil && payload.Service == "claude-code-bridge" {
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func serviceSummary(wants bool, healthy bool) string {
	switch {
	case !wants:
		return "未常驻"
	case healthy:
		return "运行中"
	default:
		return "已安装（未就绪）"
	}
}

func loginHint(id string, cfg config.Config) string {
	product, ok := tencent.ProductByName(id)
	if !ok {
		return id
	}
	client := auth.NewClient()
	client.File = cfg.CredentialFile
	status := client.Status(product)
	if !status.LoggedIn {
		return id + " 未登录"
	}
	if status.Nickname == "" {
		return id + " 已登录"
	}
	return id + " " + status.Nickname
}

func goHint() string {
	if opencode.HasGoKey() {
		return "ocg 已配 key，付费订阅（DeepSeek V4.1 Pro、GLM、Kimi、Grok…）"
	}
	return "ocg 要填 API key"
}

func nicknameSuffix(nickname string) string {
	if nickname == "" {
		return ""
	}
	return "（" + nickname + "）"
}

// mergeProducts 把这次选的来源并进已挂清单：再配一家不该把先前的顶掉。
func mergeProducts(cfg config.Config, chosen string) string {
	seen := map[string]bool{}
	order := []string{}
	for _, name := range append(append([]string{}, cfg.Products...), chosen) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		order = append(order, trimmed)
	}
	if len(order) == 0 {
		order = append(order, chosen)
	}
	return strings.Join(order, ",")
}

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "交互式一键配置（接一家 → 登录 → 选模型 → 写配置并常驻）",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		return runSetup(cmd, cfg)
	},
}

func init() {
	var enable, disable bool
	setupCmd.Flags().BoolVar(&enable, "service", false, "装成开机自启的后台服务（覆盖上次的选择）")
	setupCmd.Flags().BoolVar(&disable, "no-service", false, "不要后台服务（覆盖上次的选择）")
	setupCmd.PreRunE = func(cmd *cobra.Command, _ []string) error {
		// 显式表态最优先：脚本化场景不该被「上次的选择」挡住
		if cmd.Flags().Changed("service") {
			value := true
			serviceFlag = &value
		}
		if cmd.Flags().Changed("no-service") {
			value := false
			serviceFlag = &value
		}
		return nil
	}
	rootCmd.AddCommand(setupCmd)
}
