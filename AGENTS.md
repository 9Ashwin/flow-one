# AGENTS.md — 这个仓库的章程

给**改这个仓库的人（和 agent）**看的。规范写在这里，门禁写成命令（`make verify`），
两者对不上时以命令为准。

面向用户的输出一律中文；代码、命令、标识符、日志原文保持原样。

---

## 1. 先想清楚再动手

- 不确定就问，别猜；有多种解释就摆出来，别默默选一个。
- **最小实现**：能 50 行解决的不写 200 行。不加没要求的功能、不做「以后可能用得上」的抽象。
- 只动该动的：不顺手改相邻代码、不重构没坏的东西；发现无关的死代码**指出来，不要删**。
- 判据：**每一行改动都能追溯到用户的请求**。

## 2. 错误契约（`src/errors.mjs`）

命令边界的**任何**失败都必须是一个类型化错误。裸 `throw new Error('...')` 让调用方只能
靠消息文本分支，那等于没有契约。

| 字段 | 含义 | 谁用 |
| --- | --- | --- |
| `category` | **闭集**：`validation` / `auth` / `config` / `network` / `upstream` / `internal` | 脚本分支、退出码 |
| `subtype` | 小写下划线，来自闭集；构造未声明的 subtype 直接抛 | 脚本分支、测试断言 |
| `code` | **上游**的数字码（腾讯 `11128`、HTTP 状态码） | 排查上游问题 |
| `param` | **只**说明哪一项用户输入不合法（`--port`、`BRIDGE_PORT`） | 提示改哪个参数 |
| `hint` | **恢复动作**。修法写这里，**不要塞进 message** | 人读输出 |
| `message` | 一句话说明发生了什么（可含上游原文） | 人读输出 |

**退出码只由 category 推导**，不看 subtype、不看 message：

| category | 退出码 | 什么时候用 |
| --- | --- | --- |
| `validation` | 2 | 用户输入不合法（flag、参数、模型名） |
| `auth` | 3 | 没登录、凭据失效、缺 key |
| `config` | 4 | 配置缺失或自相矛盾（settings.json、服务文件、账本） |
| `network` | 5 | 连不上、超时、读流出错 |
| `upstream` | 6 | 上游明确拒绝：内容风控、门禁、额度、模型不可用 |
| `internal` | 1 | 本程序自己的 bug（不该发生） |

`validation` 与 `config` 的分界是「谁给的」：命令行给的算 validation，文件里读出来的算 config。
`network` 与 `upstream` 的分界是「有没有拿到应答」。

### 输出分工

- **stdout 只放成功数据**（模型清单、`status --as-json`）；进度、告警、错误一律 stderr。
  这样 `fo models --as-json | jq` 永远不会被日志污染。
- 默认（人读，stderr）：`Error: <message>`，有 hint 时另起一行 `  → <hint>`。
- `--json`（一行信封，stderr）：
  `{"ok":false,"error":{"type":<category>,"subtype":…,"code"?,"param"?,"hint"?,"message":…}}`

## 3. 代码落点表

先找对文件，再动手。**依赖方向只能由下层指向上层**（数字小的可被数字大的依赖）：

| 层 | 文件 | 负责什么 |
| --- | --- | --- |
| 0 | `src/home.mjs` | 数据目录与凭据路径。**故意什么都不 import** —— 它存在的意义就是打断循环依赖 |
| 0 | `src/errors.mjs` | 错误契约、退出码、信封渲染 |
| 0 | `src/sse.mjs` | SSE 切帧与「非 2xx → 类型化错误」 |
| 0 | `src/products.mjs` | 两条腾讯产品线的常量与 UA 规则 |
| 0 | `src/anthropic.mjs` | Anthropic ⇄ OpenAI 的请求翻译、流式翻译、非流式归并、token 估算 |
| 0 | `src/fingerprint.mjs` | 内容风控改写（三条字面量规则） |
| 0 | `src/prompt.mjs` | 终端交互：菜单、方向键选择、编号直选、密钥输入、转圈 |
| 1 | `src/auth.mjs` | 腾讯两条线的登录、凭据读写、静默续期 |
| 1 | `src/buddy.mjs` | 腾讯对话面的出站请求形状 |
| 1 | `src/opencode.mjs` | OpenCode 免费档（形状门禁）与 Go 套餐（会话头） |
| 2 | `src/sources.mjs` | 来源表：前缀、标签、默认模型、是否要登录 |
| 2 | `src/config.mjs` | flag/env/默认值的解析与校验 |
| 3 | `src/install.mjs` | 写/还原 Claude Code settings、launchd 与 systemd 服务、账本 `install.json` |
| 3 | `src/upstreams.mjs` | 来源工厂与聊天入口（前缀解析、改写器选择） |
| 3 | `src/server.mjs` | 本地反代：路由、鉴权、心跳、上游状态透传 |
| 4 | `src/doctor.mjs` | 自检：本地体检 + **逐项重推两条门禁**的探针 |
| 5 | `src/wizard.mjs` | 交互向导：一键配置、切换模型、状态、还原 |
| 6 | `cli.mjs` | 命令入口：解析参数、在边界渲染类型化错误、推导退出码 |

### 模块规约（`make modules` 会检查）

- **零第三方依赖**：只允许 `node:` 内置模块与相对路径。`dependencies` 必须为空 ——
  这是安装体验的核心（一条 `npm i -g flow-one` 装完就能用，pnpm/bun 也不用放行脚本）。
- **不允许循环依赖**：ESM 下的环路表现为 TDZ 报错（`Cannot access 'X' before initialization`），
  报错点离成因很远。真需要互相引用时，抽出像 `home.mjs` 那样的第三个模块来打断。
- **不靠分包解决规模问题**：单包是刻意的选择。文件超过 500 行（软上限）先拆函数或拆模块。
- 新增模块要同时补进 `scripts/check-modules.mjs` 的 `LAYERS` 表。

## 4. 套餐分离（硬不变式）

**判据是「这条来源是谁」，不是模型名前缀。**

| 前缀 | 来源 | 认证 | 内容风控改写 | 形状门禁 |
| --- | --- | --- | --- | --- |
| `cn/` | WorkBuddy 国内版（CodeBuddy） | 浏览器授权 | **要** | 无 |
| `intl/` | WorkBuddy 国际版 | 浏览器授权 | **要** | 无 |
| `oc/` | OpenCode 免费档 | 匿名 `Bearer public` | 不要 | **要** |
| `ocg/` | OpenCode Go 套餐 | `oc_sk_…` + 会话头 | 不要 | 不要 |

改写器由来源自己给出（`systemRewriterFor` 只认那两条线）；拿不到改写器时，出站 system
必须**逐字节不变**。改动这条路径必须配回归测试。

## 5. 跨平台

- **macOS 与 Linux 都是一等目标**：服务管理（launchd / systemd 用户级 unit）、打开浏览器
  （`open` / `xdg-open`）、日志位置（文件 / `journalctl --user -u`）都必须两条都实现。
- `systemctl --user` 之前必须补 `XDG_RUNTIME_DIR`（SSH / 非登录壳里它是空的，否则报
  `Failed to connect to bus: No medium found`，而向导会误报「配置已写入」）。
  这类「连不上 bus」要单独识别并给出两条路（`loginctl enable-linger` 后重进登录壳，或前台跑）。
- 路径一律 `path.join` + `os.homedir()`，不写死平台路径。
- 平台专有断言分文件或用 `process.platform` 跳过；公共用例不得真去动本机的 launchd/systemd。
- macOS 与 Linux 两边都要亲手验（没有 CI 代跑；只测一边等于没测）。

## 6. 别重复问同一件事

问过并落盘的选择**不要再问**：已装后台服务就直接更新；用户拒绝过就只提示怎么开启
（`fo setup --service`）。选择记在 `install.json` 的 `autoStart` / `autoStartAsked`；
卸载时一并忘掉（下次配置该重新问）。显式 `--service` / `--no-service` 永远优先。

同理，`status` 与向导**不要为不需要登录的来源编造「未登录」的假线索**，也不要把
「没装服务」与「改名前的旧服务还在跑」混为一谈。

## 7. 测试与验证门禁

- **每个行为变更都要有回归测试**，用例名说清「什么坏了会红」。
- 用例**不得碰真实家目录**：一律把 `BRIDGE_HOME`（必要时还有 `HOME` / `CLAUDE_CONFIG_DIR`）
  指到 `fs.mkdtempSync` 出来的临时目录；不得真去调用 launchd/systemd。
- 提交前跑 `make verify`（= `make check` + `make test`）。**没有 CI 兜底**（仓库不带
  `.github/workflows`），门禁只能自己跑。
- 别只信自述：验收要给出**命令与输出**（真机端到端：真 Claude Code 分别走通腾讯一条线与
  OpenCode 一条线）。

## 8. 分发

**发布渠道就是 GitHub 仓库本身**：`npm i -g github:9Ashwin/flow-one`。本项目**不发布到
npm 仓库** —— 零依赖单包不需要仓库中介，而 npm 现在对新包要求维护者带 2FA 批准
（`E_STAGE_REQUIRED`），多一个渠道只是多一处会坏的环节。

发版 = 打 tag（`vX.Y.Z`）+ 更新 `package.json` 的 `version`，两者必须一致；
`v0.2.x` 是被弃用的 Go 实现的 tag，不要复用。

## 9. 提交与沟通

- 提交信息用中文，讲清**为什么**这么改（是什么改了什么，为什么是这条路），别复述 diff。
- 修 bug 的提交要写清「什么症状 → 根因 → 怎么修 → 哪条用例盯着它」。
- 注释讲「为什么」，不复述代码；踩过的坑写进注释，别让下一个人再踩一次。
