# Go 全量重构：移植规范

分支 `go-rewrite`。目标是把 Node 版（5757 行 .mjs，零依赖 ESM）全量移植成 Go，
工程规范照 [larksuite/cli](https://github.com/larksuite/cli)（参考副本在 `/tmp/lark-cli-read`）。

Node 版在移植期间**留在仓库里当规格**（它就是行为定义），等 Go 版拿到对等证据后
（单测 + 真机端到端）再由 Lead 在最后一个提交里删掉。

## 一、Node → Go 落点对照

| Node | 行数 | Go 落点 | 归属 |
| --- | --- | --- | --- |
| `src/anthropic.mjs` | 488 | `internal/anthropic/` | T1 |
| `src/upstreams.mjs`（readSse/failureOf） | 164 | `internal/sse/` | T1 |
| `src/auth.mjs` | 377 | `internal/auth/` | T2 |
| `src/products.mjs` + `src/buddy.mjs` | 249+ | `internal/tencent/` | T2 |
| `src/fingerprint.mjs` | 140 | `internal/tencent/fingerprint.go` | T2 |
| `src/opencode.mjs` | 430 | `internal/opencode/` | T3 |
| `src/install.mjs`（settings 部分） | 362 | `internal/claude/` | T3 |
| `src/install.mjs`（launchd/systemd 部分） | 同上 | `internal/service/` | T3 |
| `src/config.mjs` | 238 | `internal/config/` | Lead |
| `src/server.mjs` | 252 | `internal/server/` | Lead |
| `src/prompt.mjs` | 449 | `internal/ui/` | Lead |
| `src/wizard.mjs` | 666 | `cmd/`（setup/status/switch/login/uninstall） | Lead |
| `src/doctor.mjs` | 328 | `internal/doctor/` | Lead |
| `cli.mjs` | 161 | `main.go` + `cmd/root.go` | Lead |
| 测试 24→42 条 | — | 每包 `*_test.go`（testify） | 各自 |

## 二、冻结接口（先改这里，再改实现）

`internal/source/source.go`：`Source`、`Model`、`Stream`、`ChatRequest`、`Rewriter`、`AuthMode`。
`internal/source/registry.go`：`Registry`（前缀路由 + 汇总清单）。
`errs/`：`Category`、`Subtype`（封闭集合）、`Error`、构造器、`ExitCode`。

**这三个包由 Lead 独占**。队友如果需要新方法/新 subtype：
先在 PR 描述或消息里说明用途，由 Lead 加，**不要自己改** —— 它们是所有包的公共面。

## 三、行为契约（必须逐条保住）

### 3.1 协议翻译（T1）

- `POST /v1/messages` 的 Anthropic 请求 → OpenAI chat body：
  system 前置、content 块展开、`tool_use`/`tool_result` 映射、`tools` 形状转换。
- `thinking.budget_tokens` → `reasoning_effort`：`>=8192 → high`、`>=2048 → medium`、否则 `low`；
  **永不发 `off`**（OpenCode Go 对 `off` 回 422）。
- 流式输出必须与 Claude Code 的期望一致：
  `message_start` → `content_block_start|delta|stop`（含 `input_json_delta` 拼工具参数、
  `thinking_delta` 拼推理）→ `message_delta`（带 `stop_reason` 与 usage）→ `message_stop`。
- 工具调用分片乱序（参数先到、名字后到）时必须**先攒着**，名字到齐再开场。
- 上游流内错误帧 → `event: error`，且**不再发** `message_delta`。
- 非流式归并：usage 与 tool_calls 都要落到 Anthropic 消息体。
- 本地 token 估算（`count_tokens` 用）：随内容增长，空请求不为 0。

### 3.2 腾讯两条线（T2）

- 登录：`POST /v2/plugin/auth/state?platform=<ide|workbuddy-ai>` → 轮询
  `GET /v2/plugin/auth/token?state=`（`code == 11217` 表示还没好）→
  账号信息 `GET /v2/plugin/login/account?state=`（`code == 12151`）。
  刷新：`POST /v2/plugin/auth/token/refresh` 带 `X-Refresh-Token`。
- 国际版的登录 URL 还要带 `version` 与 `loginSessionId`；UA 按产品与模型分档。
- 出站对话体（`toBuddyBody`）：`messages[0]` 必须是 `system`（否则 400 + 11128）、
  带 `prompt_cache_key`（前缀缓存，计费差约 17 倍）、丢掉 `tool_choice` / `top_p`、
  按模型上限裁 `max_tokens`、deepseek 族要同时带 `thinking:{type:"enabled"}` 与 `reasoning_effort`。
- 401 / 403 → 用 refresh token 静默续期并**重试一次**。
- 内容风控改写（`fingerprint.go`）三条**逐字符字面量**规则：
  1. `x-anthropic-billing-header:` 开头的**整行删除**；
  2. `You are Claude Code, Anthropic's official CLI for Claude` → `…, an official CLI for Claude`；
  3. `Main branch (you will usually use this for PRs)` → `Main branch (PRs usually go here)`。
  只改 system；无关文本**逐字节不变**；**只对腾讯系来源生效**。
- 流内拦截（HTTP 200 + 一帧 `{code,msg}`）要翻成错误，而不是干净收尾。

### 3.3 OpenCode 两条路（T3）

- 免费档（`oc`）：匿名 `Bearer public`，端点 `/inference/v1`；报文必须凑齐
  **5 个 `x-opencode-*` 头**（project 40 hex / session 与 session-id 同值 / request `msg_` 形状 /
  client: cli，外加 `opencode/<版本>` UA）、**会话 id `ses_` + 12 位小写 hex + 14 位 base62**
  （尾段总长 26，写成 38 一律 403）、**`stream:true`** 且 tools 里含
  `bash`/`glob`/`grep`/`read` 四个小写 function（各自 `parameters` 至少一个 property）。
  工具名处理：调用方声明过的出站改小写、响应**改回原名**；没声明的补桩并把模型对桩的调用**整条丢弃**。
- Go 套餐（`ocg`）：端点 `/zen/go/v1`，`Authorization: Bearer oc_sk_…`，
  **`x-opencode-session` 必填**（缺 → 400 `MissingSessionID`；值 UUID 或 `ses_` 都收），
  **不需要**免费档那套形状，也不要把 `x-opencode-client` 发过去。
  会话 id 首次生成后落盘复用。
- 两条路的模型清单都只回 `id/object/created/owned_by`，能力元数据取自
  `https://models.dev/api.json` 的 `opencode.models`（1 小时缓存），失败就退回无元数据。

### 3.4 Claude Code 配置与常驻（T3）

- 合并写 `~/.claude/settings.json` 的 6 个 `ANTHROPIC_*` 键（不是覆盖整个文件），
  写前备份 `settings.json.bak-<时间戳>`；顶层 `model` 与 `ANTHROPIC_MODEL` 必须写成**同一个值**。
- `[1m]` 后缀按**真实窗口**决定：>200k 才加，未知不加。
- 还原时**只删自己写过的、且值没被用户改过**的键，并把顶层 `model` 恢复成安装前的值。
- 服务：launchd plist（macOS）与 systemd unit（Linux），label `dev.flow-one`；
  bootout 是异步的，重装要**轮询到 label 卸载再 bootstrap**（否则 Bootstrap failed: 5）。
- 必须能报告「服务文件里跑的 CLI 路径」与「当前命令的路径」，不一致就警告
  （全局安装是一份快照，`git pull` 不会更新它 —— 这是真踩过的坑）。

### 3.5 服务与 CLI（Lead）

- **后台服务只在需要时问一次**：`装成开机自启的后台服务？` 这个提示不能每次配置都出现。
  规则：读 install.json——
  - 已经装过（服务文件存在）→ **不再问**，直接按当前配置更新，并打一行
    `✔ 后台服务已更新（launchd / systemd）`；
  - 没装过且用户从没表态 → 问一次，把选择记进 install.json（`autoStart`）；
  - 没装过但用户此前明确拒绝过 → 不再问，只提示怎么开启（`fo setup --service`）。
  显式 flag（`--service` / `--no-service`）永远覆盖记忆值，脚本化场景要能用。

- 路由：`POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /health`；
  鉴权用 `x-api-key` 或 `Authorization: Bearer`，比较要**恒定时间**。
- 模型名要剥掉 `[1m]` 这类方括号后缀再解析；未指定时兜底 `config.model`，再兜底第一条来源的默认模型。
- 先把上游响应头拿到再决定发不发 Anthropic 头（上游失败要如实透传状态与消息）。
- 心跳：长思考期间要发 `ping`，别让客户端以为断了。
- 交互式菜单（无 TTY 时直接起服务）：选项是**打印编号 + 输入编号**，不是方向键列表。
- `doctor` 要能重推门禁（逐项去掉一个要件确认它仍必填）并把「风控拦截」与「额度受限」分开报。

## 四、跨平台要求（macOS 与 Linux 都要能用）

Linux 是一等目标，不是「顺便」。移植时容易漏的几处：

1. **常驻服务**：`internal/service` 必须同时给 launchd 与 systemd 两条实现，
   用 build tag 分文件（`service_darwin.go` / `service_linux.go`），公共流程共用。
   Linux 侧：`~/.config/systemd/user/<label>.service` + `systemctl --user daemon-reload /
   enable --now / is-active`；网络与重启策略写进 unit（`Restart=always`、`RestartSec=3`）。
2. **打开浏览器**：macOS `open`、Linux `xdg-open`；两者都没有时**不要静默失败** ——
   把授权链接打印出来让用户自己点（SSH 场景本来就是这样）。
3. **路径与权限**：`filepath.Join` + `os.UserHomeDir()`；凭据 0600、目录 0700 两边一致。
   不要出现 `/Users/` 之类的字面量。
4. **doctor / status 的分平台提示**：日志路径（`bridge.err.log` vs `journalctl --user -u …`）、
   服务未启动时的补救命令，都要按平台给。
5. **CI**：Go 的门禁要跑 ubuntu 与 macos 两套（`go vet`、`gofmt -l`、`go test ./...`、`make build`）。
6. **测试**：平台专有断言放 `_darwin_test.go` / `_linux_test.go`；公共用例不许调用
   `launchctl` / `systemctl`。

## 五、分发（npm 那条路要保住）

用户明确问过：转 Go 之后还能不能像以前一样 `npm i -g`。**能**，但包的性质变了 ——
从「跑 JS 代码」变成「挑一个预编译二进制并转发调用」。三条安装路径都要留：

| 路径 | 做法 | 代价 |
| --- | --- | --- |
| npm（保住现状） | 主包 `flow-one` 只放一个 `bin/cli.js` 转发脚本；**每个平台一个可选依赖包**（`@ashwin99/flow-one-darwin-arm64` 等），主包用 `optionalDependencies` 列出它们，npm 只装匹配当前平台的那一个；转发脚本按 `process.platform` + `process.arch` 找到二进制并 `spawn(..., {stdio: 'inherit'})` | 要发布 1 + N 个包，CI 要交叉编译并上传 |
| `go install` | `go install github.com/9Ashwin/flow-one@latest` | 只对装了 Go 的人可用 |
| 一键脚本 / Releases | GitHub Releases 放 darwin/linux × arm64/amd64 四个二进制，配一个 `install.sh` | 要维护脚本与校验和 |

为什么用 `optionalDependencies` 而不是 `postinstall` 下载：pnpm 与 bun **默认拦掉依赖的
安装脚本**（opencode 自己的文档就写着「Bun 与 pnpm 的命令必须显式允许该脚本」），
而 `optionalDependencies` + 平台包子包不需要跑任何脚本，三种包管理器都稳。

**注意**：Go 版会丢掉 Node 版「零依赖、`npx` 直接跑」的性质 —— 变成「npx 挑一个平台
二进制」。这是为了保住 npm 这条安装路径要付的代价，接受。

Release 工作流（Lead 负责）：GitHub Actions 矩阵构建四个平台 → 上传 Release 资产 →
`npm publish` 主包与平台包（主包的 `optionalDependencies` 版本号要与平台包一致）。

## 六、验收

| 层次 | 标准 |
| --- | --- |
| 包级 | `go test ./internal/<包>/...` 全绿，且每条断言直接盯出站请求或类型化错误 |
| 全量 | `make test`（vet + gofmt + 全部单测） |
| 真机 | 真 Claude Code 分别走通腾讯一条线与 OpenCode 一条线（Go 套餐或免费档）；`doctor` 全绿 |
| 不变式 | 非腾讯来源的 system 文本**逐字节不变**（专门的回归测试） |
