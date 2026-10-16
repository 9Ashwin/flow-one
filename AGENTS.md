# AGENTS.md

## Purpose

`claude-code-openai-bridge` 让 Claude Code CLI 用上 WorkBuddy（国内版 / 国际版）与
OpenCode（免费档 / Go 套餐）。它同时服务两类使用者：**人**（交互式菜单、能看懂的
报错）与 **agent / 脚本**（稳定的 JSON 输出、可分支的错误分类、确定的退出码）。
两者冲突时，优先保住机器可读的那一侧，但不要为此牺牲人的体验。

工程规范参考 [larksuite/cli](https://github.com/larksuite/cli)：**cobra 命令骨架、
类型化错误契约、stdout/stderr 分工、Makefile 门禁、每个行为变更配一条回归测试**。

一个 PR 只做一件事：CLI 体验、可靠性、更简单的显式代码，或一道有用的门禁。做完的
含义是：实现面正确、既有契约未被破坏（除非明确要求破坏）、并且把跑过的检查报出来。

## 硬契约

- **stdout 只放成功数据**（模型清单、状态、版本）；**stderr 放错误、进度、警告、提示**。
- 命令边界的失败一律用 `errs.*` 类型化错误，**不要**裸 `fmt.Errorf` / `errors.New`；
  不要自己拼错误信封。`errs.Error` 的 Category + Subtype 是线上稳定标识。
- 退出码**只由 Category 推导**（`errs.ExitCode`），不按消息文本判断。
- `RewriteContent` / `Rewriter()` 只对腾讯两条线生效。**非 WorkBuddy 来源绝不经过
  腾讯内容风控改写**（见下）。这是硬不变式，有回归测试盯着。
- 已接受的输入要**原样透传**，不要静默替换成另一种行为。

## 套餐分离（本项目最容易写错的一条）

四条来源的规矩完全不同，别把它们的处理混在一起：

| 来源 | 认证 | 端点 | 内容风控改写 | 报文形状门禁 |
| --- | --- | --- | --- | --- |
| `cn` | 浏览器授权 | `copilot.tencent.com/v2/chat/completions` | **要** | 无 |
| `intl` | 浏览器授权 | `www.workbuddy.ai/v2/chat/completions` | **要** | 无 |
| `oc` | 匿名 `Bearer public` | `opencode.ai/inference/v1` | **不要** | **要**（5 头 + `ses_` 形状 + 四个小写工具 + `stream:true`） |
| `ocg` | `oc_sk_…` + 会话头 | `opencode.ai/zen/go/v1` | **不要** | 不要（但 `x-opencode-session` 必填） |

判据不是「模型名前缀长什么样」，而是**这条来源是谁**：`Rewriter()` 为 nil 就是不
改写。任何「按前缀猜是不是腾讯系」的旁路都算 bug。

## 代码落点

| 需要 | 写在哪 | 规矩 |
| --- | --- | --- |
| 命令、flag、help | `cmd/` | 只做接线：解析 → 调 internal → 渲染。业务逻辑不放这里 |
| Anthropic ⇄ OpenAI 翻译、SSE 折叠 | `internal/anthropic/`、`internal/sse/` | 纯函数，不碰网络 |
| 上游来源实现 | `internal/tencent/`、`internal/opencode/` | 实现 `source.Source`；形状与风控都在自家包内闭环 |
| 腾讯登录、凭据存取与续期 | `internal/auth/` | 落盘 0600；刷新失败要能区分「过期」与「被吊销」 |
| 跨命令不变式（来源注册表、前缀路由） | `internal/source/` | 只认接口，不 import 具体来源实现 |
| Claude Code 配置读写 | `internal/claude/` | 只碰自己写过的键；写前备份 |
| launchd / systemd 常驻 | `internal/service/` | 安装、卸载、报告「服务跑的是哪份代码」 |
| HTTP 服务（`/v1/messages` 等） | `internal/server/` | 只依赖 `source.Registry` 与翻译层 |
| 交互式界面（banner/菜单/转圈/密钥输入） | `internal/ui/` | 无 TTY 时必须能降级（别把管道喂死） |
| 自检探针 | `internal/doctor/` | 探针是纯函数 + 可注入的 http.Client，能离线测 |

## 依赖

保持小。目前只有 cobra / pflag / testify / x/term。新增依赖要在 PR 里说明为什么
标准库不够 —— 「顺手引一个」不是理由。

## 测试

- 每个行为变更都要有一条**回退即失败**的用例，直接断言字段、请求头、类型化错误或副作用。
- 用例不得依赖开发者的家目录、真实凭据或执行顺序：需要时用 `t.Setenv("BRIDGE_HOME", t.TempDir())`。
- 上游交互一律对着 `httptest.Server` 断言**出站请求**（URL、头、体），不打真网络。
- 真机端到端（真 Claude Code、真上游）不算单测，写进 PR 描述作为证据。

## 验证

| 改动 | 跑什么 |
| --- | --- |
| 单个包 | `go test ./internal/<包>/...` |
| 跨包 / 收尾 | `make test`（vet + gofmt 检查 + 全部单测） |
| 提交前 | `make build` 并真跑一次 `./claude-code-bridge doctor` |

## 提交

- 中文提交信息，说明**为什么**（现象 → 根因 → 改法），不要只写「改了 X」。
- 一次提交一件事；不要把无关清理混进来。
