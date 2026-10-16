// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package cmd

import (
	"fmt"
	"net/http"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/auth"
	"github.com/9Ashwin/flow-one/internal/doctor"
	"github.com/9Ashwin/flow-one/internal/opencode"
	"github.com/9Ashwin/flow-one/internal/tencent"
	"github.com/9Ashwin/flow-one/internal/ui"
	"github.com/spf13/cobra"
)

// 免费档端点直接用 internal/opencode 导出的常量：
// 这里再写一份字面量迟早会漂移（我第一版就写成 `…/inference/v1`，
// 与探针自己拼的 `/v1/chat/completions` 拼出 `/inference/v1/v1/…`，拿到 404）。

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "自检：配置 / 登录 / 两条门禁（会真发几个请求）",
	Long: `功能内核压在两条别人家的规则上（腾讯的内容风控字面量、OpenCode 免费档的形状门禁），
它们都可能变。这里不只查「活没活着」，而是**主动重推一遍门禁**：
先发一次完整形状确认能过，再逐项去掉一个要件确认它确实还是必填项。

上游一收紧，你就能直接看出是哪一条失效了，不用靠报错文案猜。
本地那部分（配置、登录、服务）不联网也能跑。`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadConfig(cmd)
		if err != nil {
			return err
		}
		failed := false
		notes := verdictCount{}

		ui.Section("配置与服务")
		for _, check := range doctor.Local(cfg) {
			renderCheck(check, &failed)
		}

		ui.Section("腾讯内容风控（真发一次最小请求）")
		ui.Note(ui.Dim("  被拦的表现是 400 + code 11128；额度受限不算门禁问题"))
		client := auth.NewClient()
		client.File = cfg.CredentialFile
		for _, id := range []string{"cn", "intl"} {
			product, ok := tencent.ProductByName(id)
			if !ok {
				continue
			}
			if !client.Status(product).LoggedIn {
				ui.Note("  " + ui.Gray(product.Label+" 未登录，跳过"))
				continue
			}
			spin := ui.StartSpinner("探测 " + product.Label + "…")
			row, probeErr := doctor.ProbeTencent(cmd.Context(), product, cfg)
			spin.Stop()
			if probeErr != nil {
				failed = true
				ui.Fail(probeErr.Error())
				continue
			}
			renderRow(row, &failed, &notes)
		}

		ui.Section("OpenCode 免费档门禁（重推一遍）")
		ui.Note(ui.Dim("  完整形状应 200；逐项去掉一个要件应被 403 拒掉"))
		spin := ui.StartSpinner("探测中…")
		rows, _ := doctor.ProbeOpencodeGate(cmd.Context(), doctor.GateDeps{
			BaseURL:    opencode.FreeBaseURL,
			NewSession: opencode.NewSessionID,
			NewRequest: opencode.NewRequestID,
			Project:    opencode.ProjectID(),
			ShapeHeaders: func(project, session, request string) http.Header {
				return opencode.ShapeHeaders(project, session, request)
			},
		})
		spin.Stop()
		for _, row := range rows {
			renderRow(row, &failed, &notes)
		}

		ui.Section("OpenCode Go 套餐（认证通道）")
		if key, ok := opencode.ReadGoKey(); ok {
			ui.Note(ui.Dim("  key 末四位 " + opencode.GoKeyTail() + "；这条路没有形状门禁，但要求会话头"))
			spin := ui.StartSpinner("探测中…")
			goRows := doctor.ProbeGoTier(cmd.Context(), doctor.GoDeps{APIKey: key.APIKey, Session: key.Session})
			spin.Stop()
			for _, row := range goRows {
				renderRow(row, &failed, &notes)
			}
		} else {
			ui.Note("  " + ui.Gray("未配置 API key，跳过（菜单「一键配置 → OpenCode Go 套餐」）"))
		}

		ui.Blank()
		if failed {
			ui.Box([]string{"自检发现问题（见上）", ui.Gray("上面每一条都带修法")}, ui.Yellow)
			return errs.Upstream(errs.SubtypeBadStatus, "自检发现问题").
				WithHint("按上面每一行给出的修法处理；门禁类问题见 docs/gates.md")
		}
		ui.Box([]string{"自检通过", fmt.Sprintf("%s %d 项通过 · %d 项已放松 · %d 项无法判定", ui.Gray("结果"), notes.pass, notes.relaxed, notes.inconclusive)}, ui.Green)
		return nil
	},
}

// verdictCount 统计各类判定，摘要里给一行数字。
type verdictCount struct{ pass, relaxed, inconclusive int }

func renderCheck(check doctor.LocalCheck, failed *bool) {
	switch check.Level {
	case doctor.VerdictPass:
		ui.Success(check.Text)
	case doctor.VerdictRelaxed:
		ui.Warn(check.Text)
	default:
		*failed = true
		ui.Fail(check.Text)
	}
	if check.Fix != "" {
		ui.Note("  " + ui.Gray("→ "+check.Fix))
	}
}

// renderRow 渲染一行探针结果：该过的没过算失败；「已放松」只提示（不影响使用）。
func renderRow(row doctor.Row, failed *bool, notes *verdictCount) {
	line := row.Label
	if row.Status != 0 {
		line += fmt.Sprintf(" → %d", row.Status)
	}
	if row.Detail != "" {
		line += "（" + row.Detail + "）"
	}
	switch row.Verdict {
	case doctor.VerdictPass:
		notes.pass++
		ui.Success(line)
	case doctor.VerdictRelaxed:
		notes.relaxed++
		ui.Note("  " + ui.Yellow("○") + " " + line)
	case doctor.VerdictInconclusive:
		notes.inconclusive++
		ui.Warn(line)
	default:
		*failed = true
		ui.Fail(line)
	}
}

func init() { rootCmd.AddCommand(doctorCmd) }
