# flow-one（Go）

让 **Claude Code CLI** 用上 **WorkBuddy（国内版 CodeBuddy / 国际版）** 与
**OpenCode（免费档 / Go 套餐）** 的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，而这几家的接口都是 OpenAI 风格
（WorkBuddy 的 `/v2/chat/completions`、OpenCode 的 `/inference/v1` 与 `/zen/go/v1`）。
这个桥就干这一件事：**进门说 Anthropic，出门说 OpenAI**，顺手把登录、续期、模型目录、
免费档的形状门禁、常驻与自检都办了。

> 这是 `go-rewrite` 分支：把原先的 Node 版（零依赖 ESM）全量重构为 Go。
> 工程规范参考 [larksuite/cli](https://github.com/larksuite/cli)：cobra 命令骨架、
> 类型化错误契约、stdout/stderr 分工、Makefile 门禁、每个行为变更配回归测试。
> 规范本身见 [AGENTS.md](AGENTS.md)，移植对照见 [docs/PORT-SPEC.md](docs/PORT-SPEC.md)。

```
Claude Code CLI ──► 本桥 127.0.0.1:8788 ──► WorkBuddy 国内版   cn/…
   (Anthropic            /v1/messages            (OpenAI 形状 SSE)      intl/…
    Messages)            ⇄ 翻译             ──► OpenCode 免费档    oc/…
                                          ──► OpenCode Go 套餐   ocg/…
```

## 安装

**1. 一行安装（推荐：macOS / Linux，arm64 / x64，不需要 Go，也不需要 npm）**

```bash
curl -fsSL https://github.com/9Ashwin/flow-one/releases/latest/download/install.sh | sh
```

装到 `~/.local/bin`（不在 PATH 里它会告诉你怎么加）。想要别的目录：`INSTALL_DIR=/usr/local/bin sh -s`。
装完有两个命令：`flow-one` 与短命令 `fo`。

**2. 用 Go 装**

```bash
go install github.com/9Ashwin/flow-one@latest
```

**3. 从 npm 装**（`flow-one` 与 `fo` 两个命令）

```bash
npm install -g flow-one
```

npm 包里只有个转发脚本，真正的二进制来自四个平台包（`flow-one-darwin-arm64`、
`flow-one-linux-x64` …，走 `optionalDependencies`，npm 只装匹配当前平台那一个）。
**不用 postinstall**，所以 pnpm 与 bun 也不需要额外放行安装脚本。

> ⚠️ **npm 这条目前还没发布出去**：npm 现在不允许凭据直接发布新包，只能先 stage
> 再由维护者带 2FA 批准（`E_STAGE_REQUIRED`）。5 个版本已经 stage 好，等维护者批准。
> 在那之前请用上面第 1 或第 2 种方式。

**4. 自己编**

```bash
git clone https://github.com/9Ashwin/flow-one.git
cd flow-one && make build          # 产出 ./flow-one
```

支持 **macOS 与 Linux**（arm64 / amd64）。常驻在 macOS 上走 launchd、Linux 上走 systemd
用户级 unit；两边都是第一公民。

## 快速开始

```bash
flow-one            # 有终端 → 交互式菜单；无终端 → 直接起服务
```

菜单是**打印编号 + 输入编号**，不是方向键列表：

```
请选择要做什么：
  1. 一键配置  接哪一家 → 选模型 → 写 Claude Code 配置 → 后台常驻
  2. 切换模型  改完自动重启服务
  3. 查看状态  登录有效期 / 服务 / 文件位置
  4. 起服务    前台运行，Claude Code 连它

  ──────── 维护 ────────
  5. 重新登录（换账号）  腾讯走浏览器授权，Go 套餐填 key
  6. 自检      配置 / 登录 / 两条门禁，会真发请求
  7. 列出模型  带来源前缀，看清哪些是免费档
  0. 还原配置  移除本工具写入的键并卸载后台服务
  Q. 退出
```

选 `1` 走完四步：**接哪一家 → 登录 → 选模型 → 写配置并常驻**。

- **一次只配一家**，配完回菜单；想再挂一家就再选一次（挂载清单是**叠加**的，
  先前配好的不会被顶掉）；
- 选模型只列**这一家**的模型，清单全部列出并支持**边打边筛**（敲 `glm`、`oc/deep`
  立刻缩小范围；免费档单独成组排在最前）；
- `后台服务` 只在需要时问一次：**装过就直接更新**，拒绝过就只提示怎么开启
  （`setup --service` / `--no-service` 可显式覆盖）—— 不必每次配置都重答一遍。

## 命令

| 命令 | 说明 |
| --- | --- |
| `flow-one` | 有终端进菜单；无 TTY（launchd / systemd / 管道）直接起服务 |
| `serve` | 起本地反代 |
| `setup` | 交互式一键配置（`--service` / `--no-service` 表态后台常驻） |
| `switch` | 换模型（改配置并按需重启服务） |
| `status` | 登录状态、服务与配置位置；`--as-json` 给脚本用 |
| `models` | 列出可用模型；`--as-json` |
| `login [cn\|intl\|ocg]` | 腾讯两条线走浏览器授权；Go 套餐提示粘贴 key（不回显） |
| `doctor` | 自检：配置 / 登录 / 两条门禁（会真发几个请求） |
| `uninstall` | 还原配置并卸载后台服务 |

环境变量一律 `BRIDGE_*`（`BRIDGE_HOME` / `BRIDGE_PORT` / `BRIDGE_MODEL` /
`BRIDGE_PRODUCTS` / `BRIDGE_MODE` / `UPSTREAM_BASE_URL` …），优先级是
**flag > 环境变量 > 默认值**。成功数据走 stdout、错误与进度走 stderr；
`--json` 时错误是一行 JSON 信封；退出码只由错误分类推导（见 [errs/ERROR_CONTRACT.md](errs/ERROR_CONTRACT.md)）。

## 四条来源，规矩各不相同

| 前缀 | 来源 | 认证 | 内容风控改写 | 报文形状门禁 |
| --- | --- | --- | --- | --- |
| `cn/` | WorkBuddy 国内版（CodeBuddy） | 浏览器授权 | **要** | 无 |
| `intl/` | WorkBuddy 国际版 | 浏览器授权 | **要** | 无 |
| `oc/` | OpenCode 免费档 | 匿名 `Bearer public` | 不要 | **要** |
| `ocg/` | OpenCode Go 套餐 | `oc_sk_…` + 会话头 | 不要 | 不要 |
| `gw/` | 已有的 OpenAI 兼容网关 | 由你给 | 不要 | 不要 |

**套餐分离是一条硬不变式**：判据不是「模型名前缀像不像腾讯」，而是**这条来源是谁** ——
`Source.Rewriter()` 返回 nil 就是不改写出站 system；翻译层拿到 nil 时保证 system
**逐字节不变**，并有专门的回归测试盯着（[cmd/serve_test.go](cmd/serve_test.go) 的
`TestNonTencentSourceGetsNoRewriter`）。

腾讯那三条字面量规则、OpenCode 那套形状门禁的完整事实与证据在
**[docs/gates.md](docs/gates.md)**。

## 自检

```bash
flow-one doctor
```

它不是「打个 `/health` 看活着没」，而是**主动重推一遍门禁**：

- 先发一次**完整形状**确认免费档能过；
- 再**逐项去掉一个要件**（session-id 别名头 / 会话形状 / 四个门禁工具 / `stream`），
  确认它**确实还是必填项** —— 上游放松或收紧都会当场显形：完整形状过不了 → 收紧；
  某个变体不再被拒 → 那一条已放松；
- 腾讯那侧真发一次带三条字面量的最小请求（走自己的改写器），并把
  **风控拦截（400 + 11128）与额度受限分开报** —— 后者根本不是门禁问题；
- Go 套餐那侧验三条：模型清单要 key、会话头必填、带上能出字；
- 本地部分不联网：配置、`model` 与 `ANTHROPIC_MODEL` 是否一致、服务代码是不是当前这份。

## 开发

```bash
make test      # vet + gofmt 检查 + 全部单测
make build     # 写 ./flow-one（注入版本号）
make fmt       # gofmt -w .
```

- 规范（错误契约、代码落点、跨平台、测试与验证门禁）：[AGENTS.md](AGENTS.md)
- 移植对照与行为契约：[docs/PORT-SPEC.md](docs/PORT-SPEC.md)
- 两条门禁的事实与复验：[docs/gates.md](docs/gates.md)
- 单测全部离线（`httptest` 假上游）；真机端到端单独跑：真 Claude Code 分别走通
  腾讯一条线与 OpenCode 一条线。

## 已知限制

- **OpenCode 免费档靠报文形状过门禁**，官方收紧形状就会失效（那时 `doctor` 会明确报
  出来，不会静默降级）；`-free` 结尾以外的模型要 Go 套餐订阅。
- **额度**：腾讯侧的额度/频率限制会如实报成「不是门禁问题」；`cn` 撞到限额时
  `doctor` 会把它标成无法判定，而不是失败。
- **服务跑的是「哪份代码」要看安装来源**：全局安装（`npm i -g` / `go install`）是一份
  快照，`git pull` 不会更新它。`status` 与 `doctor` 都会打出服务代码路径并在不一致时
  告警 —— 这是真踩过的坑。
- Linux 用户级 systemd unit 在注销后会停，除非 `loginctl enable-linger $USER`。
- 只覆盖对话与模型目录；**每日签到领积分不在范围内**。

## License

MIT
