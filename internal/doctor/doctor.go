// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package doctor 是自检：把两条门禁的**事实**变成可执行的验证，而不是只写在文档里。
//
// 这个项目的功能内核压在别人家的规则上，它们都可能变：
//
//   - 腾讯的内容风控（逐字符字面量）→ 失效表现是 400 + code 11128；
//   - OpenCode 免费档的报文形状门禁 → 失效表现是 FreeTierError；
//   - OpenCode Go 套餐的认证通道 → 要求 x-opencode-session，但没有形状门禁。
//
// 所以这里不是「打个 /health 看活着没」，而是**主动重推一遍门禁**、并逐项去掉一个
// 要件确认它确实还是必填。上游一改，用户自己就能看出是哪一条失效。
//
// 探针都是普通函数 + 可注入的 http.Client 与端点，能离线测。
package doctor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/auth"
	"github.com/9Ashwin/flow-one/internal/claude"
	"github.com/9Ashwin/flow-one/internal/config"
	"github.com/9Ashwin/flow-one/internal/opencode"
	"github.com/9Ashwin/flow-one/internal/service"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/9Ashwin/flow-one/internal/tencent"
)

// Verdict 是探针每一行的判定。
type Verdict string

const (
	// VerdictPass：该过的过了、该被拒的被拒了 —— 这条事实成立。
	VerdictPass Verdict = "pass"
	// VerdictRelaxed：该被拒的却被放行 —— 这一条已不再是必填项（上游放松了）。
	VerdictRelaxed Verdict = "relaxed"
	// VerdictFail：该过的没过 —— 上游收紧了或规则变了。
	VerdictFail Verdict = "fail"
	// VerdictInconclusive：限流、网络不通，这一轮判不出来。
	VerdictInconclusive Verdict = "inconclusive"
)

// Row 是一行探针结果。
type Row struct {
	Label   string
	Verdict Verdict
	Status  int
	Detail  string
}

// ── 本地体检（不发网络）──────────────────────────────────────────────────────

// LocalCheck 是一条本地体检结论。
type LocalCheck struct {
	Level  Verdict // pass / fail（warn 用 VerdictRelaxed，表示「能跑但不理想」）
	Text   string
	Fix    string
	Detail string
}

// Local 检查配置与服务状态。纯读，不发网络。
func Local(cfg config.Config) []LocalCheck {
	checks := []LocalCheck{}
	settingsPath, err := claude.SettingsPath()
	if err != nil {
		checks = append(checks, LocalCheck{Level: VerdictFail, Text: "读不到 Claude Code 配置目录", Fix: "设置 CLAUDE_CONFIG_DIR 或检查家目录权限"})
		return checks
	}
	raw, readErr := os.ReadFile(settingsPath)
	if readErr != nil {
		checks = append(checks, LocalCheck{
			Level: VerdictFail, Text: "还没写过 Claude Code 配置：" + settingsPath,
			Fix: "跑一次「一键配置」（flow-one setup）",
		})
		return checks
	}
	var settings struct {
		Env   map[string]string `json:"env"`
		Model string            `json:"model"`
	}
	if jsonErr := json.Unmarshal(raw, &settings); jsonErr != nil {
		checks = append(checks, LocalCheck{Level: VerdictFail, Text: "settings.json 不是合法 JSON（Claude Code 也会读不了）", Fix: "从 settings.json.bak-* 里恢复一份"})
		return checks
	}
	baseURL := settings.Env["ANTHROPIC_BASE_URL"]
	if baseURL == "" {
		checks = append(checks, LocalCheck{
			Level: VerdictFail, Text: "配置里没有 ANTHROPIC_BASE_URL —— Claude Code 不会走本桥",
			Fix: "跑一次「一键配置」重写",
		})
	} else {
		checks = append(checks, LocalCheck{Level: VerdictPass, Text: "反代地址 " + baseURL})
	}
	model := settings.Env["ANTHROPIC_MODEL"]
	if model != "" {
		checks = append(checks, LocalCheck{Level: VerdictPass, Text: "模型 " + model})
		if settings.Model != "" && settings.Model != model {
			// 真踩过：两个字段说法不一致时，Claude Code 会静默跑成另一个模型
			checks = append(checks, LocalCheck{
				Level: VerdictFail,
				Text:  fmt.Sprintf("顶层 model（%s）与 ANTHROPIC_MODEL（%s）不一致，可能静默跑成另一个模型", settings.Model, model),
				Fix:   "跑一次「一键配置」重写（两个字段会写成同一个值）",
			})
		}
	}

	if state, err := service.Inspect(); err == nil {
		if state.LegacyInstalled && !state.Installed {
			checks = append(checks, LocalCheck{
				Level: VerdictRelaxed,
				Text:  "改名前的旧服务 " + service.LegacyServiceLabel + " 还装着（占着端口，新服务没装）",
				Fix:   "跑一次「一键配置」装成新名字并顺手清掉旧服务；只想清旧的：fo uninstall",
			})
		}
		if !state.Supported {
			checks = append(checks, LocalCheck{Level: VerdictRelaxed, Text: "本平台没有实现后台常驻", Fix: "前台跑：flow-one serve"})
		} else if !state.Installed {
			checks = append(checks, LocalCheck{
				Level: VerdictRelaxed, Text: "没有装后台服务（Claude Code 只能在你手动开着终端时用）",
				Fix: "flow-one setup --service",
			})
		} else {
			checks = append(checks, LocalCheck{Level: VerdictPass, Text: fmt.Sprintf("服务文件 %s（%s）", state.Path, state.Kind)})
			if running := service.CLIPath(); running != "" && running != service.CurrentCLIPath() {
				checks = append(checks, LocalCheck{
					Level: VerdictFail,
					Text:  "服务跑的不是当前这份代码：" + running,
					Fix:   "用当前这份代码重跑「一键配置」（全局安装是一份快照，git pull 不会更新它）",
				})
			} else if running != "" {
				checks = append(checks, LocalCheck{Level: VerdictPass, Text: "服务与当前命令是同一份代码"})
			}
		}
	}

	if config.LegacyHomeInUse() {
		checks = append(checks, LocalCheck{
			Level: VerdictRelaxed,
			Text:  "数据目录还是改名前的 ~/.claude-code-openai-bridge（照常用，登录态在里面）",
			Fix:   "想搬到新名字：mv ~/.claude-code-openai-bridge ~/.flow-one",
		})
	}

	client := auth.NewClient()
	client.File = cfg.CredentialFile
	for _, item := range []struct{ id, label string }{{"cn", "WorkBuddy 国内版"}, {"intl", "WorkBuddy 国际版"}} {
		product, ok := tencent.ProductByName(item.id)
		if !ok {
			continue
		}
		status := client.Status(product)
		if !status.LoggedIn {
			checks = append(checks, LocalCheck{
				Level: VerdictFail, Text: item.label + " 未登录",
				Fix: "flow-one login " + item.id,
			})
			continue
		}
		detail := item.label + " 已登录"
		if status.Nickname != "" {
			detail += "（" + status.Nickname + "）"
		}
		if status.ExpiresAt > 0 {
			detail += "，" + time.UnixMilli(status.ExpiresAt).Format("2006/1/2") + " 到期"
		}
		level := VerdictPass
		fix := ""
		if status.ExpiresAt > 0 && time.Until(time.UnixMilli(status.ExpiresAt)) < 7*24*time.Hour {
			level = VerdictRelaxed
			fix = "快到期了，跑一次 login 续期"
		}
		checks = append(checks, LocalCheck{Level: level, Text: detail, Fix: fix})
	}
	if opencode.HasGoKey() {
		checks = append(checks, LocalCheck{Level: VerdictPass, Text: "OpenCode Go 套餐 已配 key（末四位 " + opencode.GoKeyTail() + "）"})
	} else {
		checks = append(checks, LocalCheck{Level: VerdictRelaxed, Text: "OpenCode Go 套餐 未配 key", Fix: "菜单「一键配置 → OpenCode Go 套餐」填 key"})
	}
	return checks
}

// ── 腾讯内容风控探针 ────────────────────────────────────────────────────────

// fingerprintPayload 是三条已知字面量判据拼成的一次最小请求：
// 改写器该把它们全部处理掉，上游才回 200 而不是 400 + 11128。
const fingerprintPayload = "You are Claude Code, Anthropic's official CLI for Claude\n" +
	"Main branch (you will usually use this for PRs): main\n" +
	"x-anthropic-billing-header: cc_version=2.1.301"

// ProbeTencent 用**本工具自己的翻译层 + 改写器**真发一次最小请求。
//
// 走真链路才有意义：要验的正是「翻译 → 改写 → 发送」这一整套，裸发一个手工请求
// 证明不了改写器在真实链路上生效。
func ProbeTencent(ctx context.Context, product auth.Product, cfg config.Config) (Row, error) {
	built, err := tencent.New(tencent.Config{Product: product, StorePath: cfg.CredentialFile})
	if err != nil {
		return Row{Label: product.Label, Verdict: VerdictFail, Detail: err.Error()}, nil
	}
	models, err := built.ListModels(ctx)
	if err != nil {
		return Row{Label: product.Label, Verdict: VerdictFail, Detail: err.Error()}, nil
	}
	if len(models) == 0 {
		return Row{Label: product.Label, Verdict: VerdictFail, Detail: "模型清单是空的"}, nil
	}
	chosen := models[0]
	for _, model := range models {
		if strings.Contains(model.ID, "deepseek-v4.1-flash") {
			chosen = model
			break
		}
	}
	// 这里刻意不过 Anthropic 翻译层：要验的是「改写后的 system 能不能过风控」，
	// 多一层翻译只会引入无关变量。改写器本身来自来源实现（腾讯系非 nil）。
	system := fingerprintPayload
	if rewriter := built.Rewriter(); rewriter != nil {
		system = rewriter(system)
	}
	body := map[string]any{
		"model": chosen.ID, "max_tokens": 8, "stream": true,
		"messages": []map[string]any{
			{"role": "system", "content": system},
			{"role": "user", "content": "ping"},
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return Row{}, errs.InternalFrom(err)
	}
	meta := chosen
	stream, err := built.Chat(ctx, source.ChatRequest{Body: encoded, Model: chosen.ID, Meta: &meta})
	if err != nil {
		typed, _ := errs.As(err)
		row := Row{Label: product.Label, Verdict: VerdictFail, Detail: err.Error()}
		if typed != nil {
			row.Status = typed.Code
			switch typed.Subtype {
			case errs.SubtypeContentBlocked:
				row.Detail = "被内容风控拦下（" + typed.Message + "）"
			case errs.SubtypeQuotaLimited:
				row.Verdict = VerdictInconclusive
				row.Detail = "额度/频率受限，这一轮验不到改写器（不是门禁问题）"
			}
		}
		return row, nil
	}
	defer stream.Close()
	// 读第一帧就够：能出帧说明风控放行了
	if _, ok, err := stream.Next(); err != nil {
		typed, _ := errs.As(err)
		if typed != nil && typed.Subtype == errs.SubtypeContentBlocked {
			return Row{Label: product.Label, Verdict: VerdictFail, Detail: "流内被拦截：" + typed.Message}, nil
		}
		return Row{Label: product.Label, Verdict: VerdictInconclusive, Detail: err.Error()}, nil
	} else if !ok {
		return Row{Label: product.Label, Verdict: VerdictInconclusive, Detail: "上游没有返回任何内容帧"}, nil
	}
	return Row{Label: product.Label, Verdict: VerdictPass, Status: http.StatusOK, Detail: "改写器生效，内容风控放行"}, nil
}

// ── OpenCode 免费档门禁探针 ─────────────────────────────────────────────────

// GateDeps 是重推门禁需要的注入项。
//
// 会话 / 请求 / 项目 id 的生成器由 internal/opencode 提供（形状是那条门禁的判据），
// 这里用函数注入，于是探针能在没有真上游的地方测。
type GateDeps struct {
	BaseURL    string
	Client     *http.Client
	NewSession func() string
	NewRequest func() string
	Project    string
	// ShapeHeaders 拼「完整形状」的头集；去掉别名那一项由探针自己做。
	ShapeHeaders func(project, session, request string) http.Header
}

const (
	freeChatPath = "/v1/chat/completions"
	// wrongSessionShape 是**尾段 26 位**的错形状（总长 38）。这正是文档里警告过的坑：
	// 官方 LENGTH = 26 是尾段总长（12 hex + 14 base62），当成随机段长度就会多出 12 位。
	// 注意别拿 `ses_` + 26 个 0 当反例 —— `0` 既是 hex 也是 base62，那串形状是对的。
	wrongSessionTail = "000000000000AAAAAAAAAAAAAAAAAA"
)

func gateProbeBody() map[string]any {
	gate := func(name string) map[string]any {
		return map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        name,
				"description": "Reserved for the host runtime; do not call it.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"input": map[string]any{"type": "string", "description": "Unavailable; do not use."}},
				},
			},
		}
	}
	return map[string]any{
		"model": "deepseek-v4.1-flash-free", "stream": true, "max_tokens": 8,
		"messages": []map[string]any{{"role": "user", "content": "ping"}},
		"tools":    []any{gate("bash"), gate("glob"), gate("grep"), gate("read")},
	}
}

// ProbeOpencodeGate 重推免费档门禁：完整形状应 200；逐项去掉一个要件应被拒。
//
// 哪一条变体没被拒 → 那一条已不再是必填项（上游放松了）；完整形状被拒 → 上游收紧了。
func ProbeOpencodeGate(ctx context.Context, deps GateDeps) ([]Row, Verdict) {
	client := deps.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	url := strings.TrimRight(deps.BaseURL, "/") + freeChatPath
	session := deps.NewSession()
	full := deps.ShapeHeaders(deps.Project, session, deps.NewRequest())

	call := func(body map[string]any, headers http.Header) (int, string) {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, err.Error()
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(encoded)))
		if err != nil {
			return 0, err.Error()
		}
		for key, values := range headers {
			for _, value := range values {
				request.Header.Add(key, value)
			}
		}
		request.Header.Set("authorization", "Bearer public")
		request.Header.Set("content-type", "application/json")
		request.Header.Set("accept", "text/event-stream")
		response, err := client.Do(request)
		if err != nil {
			return 0, err.Error()
		}
		defer response.Body.Close()
		buffer := make([]byte, 2048)
		read, _ := response.Body.Read(buffer)
		return response.StatusCode, string(buffer[:read])
	}

	rows := []Row{}
	status, text := call(gateProbeBody(), full)
	complete := Row{Label: "完整形状（5 个头 + 会话形状 + 四个门禁工具 + stream）", Status: status}
	switch {
	case status == http.StatusOK:
		complete.Verdict = VerdictPass
	case strings.Contains(text, "FreeTierError"):
		complete.Verdict = VerdictFail
		complete.Detail = "上游收紧了免费档门禁（FreeTierError）—— 规则见 docs/gates.md"
	default:
		complete.Verdict = VerdictInconclusive
		complete.Detail = fmt.Sprintf("没能判定（HTTP %d）：%s", status, firstLine(text))
	}
	rows = append(rows, complete)
	if complete.Verdict != VerdictPass {
		return rows, complete.Verdict
	}

	withoutAlias := http.Header{}
	for key, values := range full {
		if strings.EqualFold(key, "x-opencode-session-id") {
			continue
		}
		withoutAlias[key] = values
	}
	wrongShape := http.Header{}
	for key, values := range full {
		wrongShape[key] = values
	}
	wrongShape.Set("x-opencode-session", "ses_000000000000"+wrongSessionTail)
	wrongShape.Set("x-opencode-session-id", "ses_000000000000"+wrongSessionTail)
	noTools := gateProbeBody()
	delete(noTools, "tools")
	noStream := gateProbeBody()
	noStream["stream"] = false

	variants := []struct {
		label   string
		body    map[string]any
		headers http.Header
	}{
		{"去掉 x-opencode-session-id 别名头", gateProbeBody(), withoutAlias},
		{"会话 id 尾段写成 26 位（总长 38）", gateProbeBody(), wrongShape},
		{"tools 里不带 bash/glob/grep/read", noTools, full},
		{"stream: false", noStream, full},
	}
	for _, variant := range variants {
		variantStatus, variantText := call(variant.body, variant.headers)
		row := Row{Label: variant.label, Status: variantStatus}
		switch {
		case variantStatus == http.StatusOK:
			row.Verdict = VerdictRelaxed
			row.Detail = "上游没拒（这一条已不再是必填项）"
		case strings.Contains(variantText, "FreeTierError"):
			row.Verdict = VerdictPass
			row.Detail = "被拒（必填项仍然成立）"
		default:
			row.Verdict = VerdictInconclusive
			row.Detail = fmt.Sprintf("HTTP %d：%s", variantStatus, firstLine(variantText))
		}
		rows = append(rows, row)
	}
	return rows, VerdictPass
}

func firstLine(text string) string {
	trimmed := strings.TrimSpace(text)
	if at := strings.IndexByte(trimmed, '\n'); at >= 0 {
		trimmed = trimmed[:at]
	}
	if len(trimmed) > 160 {
		trimmed = trimmed[:160]
	}
	return trimmed
}

// ── OpenCode Go 套餐（认证通道）探针 ────────────────────────────────────────

const (
	goBaseURL   = "https://opencode.ai/zen/go/v1"
	goChatPath  = "/chat/completions"
	goModels    = "/models"
	goSessionID = "x-opencode-session"
)

// GoDeps 是 Go 套餐探针的注入项。
type GoDeps struct {
	BaseURL string
	Client  *http.Client
	APIKey  string
	Session string
	Model   string
}

// ProbeGoTier 重推认证通道的三条事实：模型清单要 key、会话头必填、带上就能出字。
//
// 与免费档的区别是这里**没有**形状门禁，所以探针短：缺会话头应得
// `400 MissingSessionID`，而不是 FreeTierError。
func ProbeGoTier(ctx context.Context, deps GoDeps) []Row {
	if deps.APIKey == "" {
		return []Row{{Label: "OpenCode Go 套餐", Verdict: VerdictInconclusive, Detail: "未配置 API key，跳过"}}
	}
	client := deps.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	base := deps.BaseURL
	if base == "" {
		base = goBaseURL
	}
	model := deps.Model
	if model == "" {
		model = "deepseek-v4.1-flash"
	}
	rows := []Row{}

	// 1) 模型清单要 key
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+goModels, nil)
	if err == nil {
		request.Header.Set("authorization", "Bearer "+deps.APIKey)
		if response, callErr := client.Do(request); callErr == nil {
			count := 0
			var payload struct {
				Data []struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if json.NewDecoder(response.Body).Decode(&payload) == nil {
				count = len(payload.Data)
			}
			response.Body.Close()
			verdict := VerdictPass
			if response.StatusCode != http.StatusOK {
				verdict = VerdictFail
			}
			rows = append(rows, Row{
				Label: "模型清单要 key", Verdict: verdict, Status: response.StatusCode,
				Detail: fmt.Sprintf("%d 个模型", count),
			})
		} else {
			rows = append(rows, Row{Label: "模型清单要 key", Verdict: VerdictInconclusive, Detail: callErr.Error()})
		}
	}

	// 2) 不带会话头应被拒（这条最容易被上游悄悄放松）
	chat := func(headers map[string]string) (int, string) {
		body, _ := json.Marshal(map[string]any{
			"model": model, "stream": true, "max_tokens": 8,
			"messages": []map[string]any{{"role": "user", "content": "ping"}},
		})
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+goChatPath, strings.NewReader(string(body)))
		if reqErr != nil {
			return 0, reqErr.Error()
		}
		req.Header.Set("authorization", "Bearer "+deps.APIKey)
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "text/event-stream")
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		response, callErr := client.Do(req)
		if callErr != nil {
			return 0, callErr.Error()
		}
		defer response.Body.Close()
		buffer := make([]byte, 1024)
		read, _ := response.Body.Read(buffer)
		return response.StatusCode, string(buffer[:read])
	}

	status, text := chat(map[string]string{goSessionID: deps.Session})
	switch {
	case status == http.StatusOK:
		rows = append(rows, Row{Label: "带 " + goSessionID + " 的一次最小对话", Verdict: VerdictPass, Status: status})
	case strings.Contains(text, "MissingSessionID"):
		rows = append(rows, Row{Label: "带 " + goSessionID + " 的一次最小对话", Verdict: VerdictFail, Status: status, Detail: "带了会话头仍被判缺失"})
	default:
		rows = append(rows, Row{Label: "带 " + goSessionID + " 的一次最小对话", Verdict: VerdictInconclusive, Status: status, Detail: firstLine(text)})
	}

	status, text = chat(nil)
	switch {
	case status != http.StatusOK && strings.Contains(text, "MissingSessionID"):
		rows = append(rows, Row{Label: "不带 " + goSessionID + " 应被拒", Verdict: VerdictPass, Status: status, Detail: "MissingSessionID"})
	case status == http.StatusOK:
		rows = append(rows, Row{Label: "不带 " + goSessionID + " 应被拒", Verdict: VerdictRelaxed, Status: status, Detail: "上游没拒（会话头已不是必填）"})
	default:
		rows = append(rows, Row{Label: "不带 " + goSessionID + " 应被拒", Verdict: VerdictInconclusive, Status: status, Detail: firstLine(text)})
	}
	return rows
}
