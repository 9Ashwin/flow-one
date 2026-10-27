# flow-one

让 **Claude Code CLI** 用上 **WorkBuddy（CodeBuddy 国内版 / 国际版）** 与 **OpenCode 免费档**
的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，而这几家给的是 OpenAI 形状的接口
（WorkBuddy 的 `/v2/chat/completions`、OpenCode 的 `/inference/v1/chat/completions`）。
本桥只做一件事：**进来是 Anthropic，出去是 OpenAI** —— 顺带把登录、续期、模型清单、
免费档的形状门禁与"别改坏用户已有配置"这几件事做掉。零依赖，只用 Node 内置模块。

```
Claude Code CLI ──► 本桥 127.0.0.1:8788 ──► WorkBuddy 国内版 copilot.tencent.com    cn/…
   (Anthropic            /v1/messages        (OpenAI 形状的 SSE)
    Messages)            ⇄ 翻译            ──► WorkBuddy 国际版 www.workbuddy.ai intl/…
                                          ──► OpenCode 免费档 opencode.ai/inference oc/…
```

英文 README：[README.md](README.md)。

## 安装

**Install directly from GitHub.** The repository includes generated JavaScript, so the
installed program needs no build step or third-party runtime dependencies. Node ≥ 22.18 is required.

```bash
npm i -g --install-links github:9Ashwin/flow-one      # installs flow-one and fo
```

不想全局安装，也可以每次现取：

```bash
npx -y github:9Ashwin/flow-one status
```

To modify the code, clone the repository and run the TypeScript source directly:

```bash
git clone https://github.com/9Ashwin/flow-one.git
cd flow-one && node cli.ts
```

**Updating**: rerun the installation command. To pin this version, use
`npm i -g --install-links github:9Ashwin/flow-one#v0.3.1`.
The existing `v0.3.0` tag predates the JavaScript snapshot and does not work as a global install;
the `v0.2.x` tags are the deprecated Go implementation.

> 为什么不发 npm：npm 现在不允许直接发布新包，必须先 staging 再由维护者用 2FA 批准
> （`E_STAGE_REQUIRED`）。而零依赖单包本来也不需要中间商 —— 从 GitHub 装就是同一条命令。

## 快速开始

```bash
fo               # 终端里直接跑，进交互菜单
```

选 `1` 之后它会自己走四步：**接哪一家 → 登录 → 选模型 → 写配置并常驻**。

一次只配一家（像 zcf 那样一项一项来）。走完**按回车回菜单**；要再接一家就再选一次
「一键配置」—— 挂载清单是**累加**的（`BRIDGE_PRODUCTS` 的并集），先配的不会被顶掉。

配过之后，**切换渠道不用再走这个流程**：

```bash
fo use cn      # 切到国内版
fo use intl    # 切到国际版
fo use ocg     # 切到 OpenCode Go 套餐
```

`fo use` 只做三件事：把客户端配置指向那条来源、把它那条模型前缀加进服务的挂载清单、
重启服务。**不会重新问登录 / 客户端 / 自启** —— 那些已经配好了。它会切到**那条线上次用的模型**
（没有记录时按推荐顺序取第一个），所以来回切不会每次都掉回默认。

菜单是中文的，下面是真实的终端输出。

```
  ──────── 第 1 步 · 接哪一家 ────────
? 接哪一家？  ↑↓ 选择，或直接按编号，回车确认
❯ 1. WorkBuddy 国内版（CodeBuddy）  cn 阿斯温月
  2. WorkBuddy 国际版  intl starry99c@163.com
  3. OpenCode 免费档  oc 无需登录，免费模型
  4. 转发给已有的 OpenAI 兼容网关  自建网关 / LiteLLM / Ollama

✔ 接哪一家？ OpenCode 免费档

  ──────── 第 2 步 · 登录 ────────
✔ OpenCode 免费模型 无需登录，直接可用

  ──────── 第 3 步 · 模型 ────────
? 用哪个模型？  直接敲字筛选，↑↓ 选择，回车确认
  直接敲字筛选 · 共 89 项
  ──── 免费模型（13 个） ────
❯  1. oc/deepseek-v4.1-flash-free  免费 · 窗口 200k · 输出 32k · 视觉
   2. oc/big-pickle  免费 · 窗口 200k · 输出 32k
   3. oc/beam-free  免费 · 窗口 1.0M · 输出 131k
   …
  ──── 其余模型（75 个，按量计费 / 订阅） ────
```

第 2 步只处理你选中的那一家：OpenCode 免费档没有登录步骤，选中后直接跳到选模型；
腾讯两条线在这一步走浏览器授权。

选模型只列**那一家的**模型（一次配一家，不是把全部来源铺在一起挑）。清单**完整、不截断**，
**免费档单独成组排在最前**（OpenCode 的免费模型不消耗额度/配额），按量计费或订阅的排在后面。
分组标题只是标题：不占编号，光标也会跳过它。

列表还支持**打字筛选**：敲 `free`、`glm`、`oc/deep` 会立刻收窄。退格删字、Esc 清空、
↑↓ 移动、回车确认（筛选结果里不再插入分组标题）。超过 12 项时只绘制光标附近那一段。
清单里没有的 ID（自建网关、新模型）走最后一项「手动输入模型 ID」。

列表式选择（模型目录）用 ↑↓ 或**直接按数字**，不需要记空格之类的快捷键，
每行都带着上下文窗口、输出上限与档位。选完会弹一个摘要框。

配好之后，跑 `claude` 即可。想还原：菜单里选「还原配置」，或 `fo uninstall`。

## 两种上游

| | 直连模式（默认） | 网关模式 |
| --- | --- | --- |
| 谁负责登录 | **本工具自己**；OpenCode 免费档完全不用登录 | 上游负责，例如 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |
| 依赖 | 无 | 那个网关得在跑 |
| 模型 ID | `cn/deepseek-v4.1-flash`、`intl/hy4-preview-f`、`oc/deepseek-v4.1-flash-free` | 上游的 ID，例如 `workbuddy/deepseek-v4.1-flash` |
| 适合 | 只装这一个工具 | 已经在跑网关 / 想混用多条上游 |

一条来源一个前缀，因此**一个进程能同时服务三条线**；换 `ANTHROPIC_MODEL` 就换了来源：

| 前缀 | 来源 | 登录 |
| --- | --- | --- |
| `cn/` | WorkBuddy 国内版（CodeBuddy，`copilot.tencent.com`） | 需要 |
| `intl/` | WorkBuddy 国际版（`www.workbuddy.ai`） | 需要 |
| `oc/` | **OpenCode 免费档**（`opencode.ai/inference`） | **不需要**；装完就能用 |
| `ocg/` | **OpenCode Go 套餐**（`opencode.ai/zen/go/v1`） | 需要 API key（`oc_sk_…`） |

### OpenCode Go 套餐（`ocg/`）

买了 Go 套餐（$10/月起）就在菜单里选「一键配置 → OpenCode Go 套餐」并粘贴 `oc_sk_…`
（输入不回显）。配好之后**自动多挂载一条来源**，模型清单里出现 37 个带 `ocg/` 前缀的模型：
DeepSeek V4.1 Flash / Pro、GLM-5.1/5.2/5.3、Kimi K3、Grok 4.6/4.7、Qwen3.8、Claude Haiku 5.5、
Gemini 4 Argon…

这条路与免费档**不是同一条**，规则也不同（2026-10-16 实测；DSH 桌面端的 `cordis.yml`
也是同一套配置）：

| 事实 | 说明 |
| --- | --- |
| 端点 `/zen/go/v1` | 免费档是 `/inference/v1`；两条路暴露的模型清单不同 |
| `Authorization: Bearer oc_sk_…` 必需 | 不带或乱写 key 都是 401 |
| **`x-opencode-session` 必需** | 缺了回 `400 MissingSessionID`（「无法高效路由」）；值是任意会话 id —— UUID 与 `ses_` 形状都收 —— 本桥首次配置时生成一个并落盘复用 |
| **不需要**免费档那套形状 | 裸 OpenAI 报文直接 200；不用补那四个小写工具，也不用发 `x-opencode-client` |

两个实践细节：上游**不接受** `reasoning_effort: "off"`（422，且文案误导成「Endpoint is
unavailable」），所以本桥的档位映射只发 `low/medium/high`；deepseek 家族**默认就思考**，
`max_tokens` 给小了可能被推理吃光、正文为空 —— 用调小的 `max_tokens` 排查时，很容易误判成
「桥坏了」。

### OpenCode 免费档（`oc/`）

`oc/deepseek-v4.1-flash-free` 是官方免费档的 DeepSeek V4.1 Flash，不需要账号。
但它**不是「换个 base URL」那么简单**：一个标准 OpenAI 请求会被拒

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

—— 它按**报文形状**判断调用方。实测（2026-10-16），下面三样齐了才稳定 200：

- 五个 `x-opencode-*` 头：`project`（40 hex）、`session` **与** `session-id`（同一个值）、
  `request`、`client: cli`，外加 `User-Agent: opencode/<版本>`；
- 会话 id 形状 `ses_` + 12 位小写 hex + **14** 位 base62（尾段总长 26；误当成「26 位随机」
  会得到 38 字符，然后一律 403）；
- 请求体 `stream: true`，且 `tools` 里必须有 `bash` / `glob` / `grep` / `read` 四个小写 function 工具。

工具名冲突由本桥抹平：Claude Code 自己的 `Bash` / `Read` 出站时改小写、响应里改回原名；
它没声明的（通常是 `glob` / `grep`）补一个桩，模型对桩的调用**整条丢弃** —— 那些是
Claude Code 执行不了的工具名。

**这两道门禁的完整事实、证据与重推办法在 [docs/gates.md](docs/gates.md)**；`fo doctor`
会**逐项重推**（Go 套餐那条也在内：带会话头的最小对话、去掉它应当被拒、以及要 key 的模型清单）。
它先验证完整形状，再一项一项去掉，确认「这一条确实还是必填」—— 上游放松或收紧会立刻显形，
而不是等用户来报「用不了」。`big-pickle` 这类以 `-free` 结尾的模型同理；
不带 `-free` 的（`deepseek-v4.1-flash`、`deepseek-v4-pro` 等）属于 $10/月的 OpenCode Go 订阅，
用了会报 `AuthError`。

## 命令行

下文的 `fo` 都可用 `flow-one` 等价替换。

| 命令 | 说明 |
| --- | --- |
| `fo` | 终端里跑菜单；没有 TTY（systemd / 管道）时直接起服务 |
| `switch` | 只换模型（菜单里的「切换模型」） |
| `use <cn\|intl\|oc\|ocg>` | 只换渠道：切到已配好的来源、用它上次的模型、重启服务 |
| `doctor` | 自检：配置 / 登录 / 两条门禁（会真发几次请求） |
| `setup` / `--setup` | 交互式一键配置（是否写 Claude Code 与 DSH 配置，**各问一次**） |
| `client` | 打印接入信息（地址 / 令牌 / 模型 ID），自己填到客户端里 |
| `uninstall` / `--uninstall` | 还原 Claude Code 配置并卸载后台服务 |
| `login [cn\|intl]` | 登录；不带参数时两条产品线都登 |
| `status` | 登录状态、令牌有效期、服务与配置文件位置 |
| `models` | 列出可用模型 ID（带上下文窗口 / 输出上限 / 档位） |

不想用向导，每一步都能用 flag 完成：

```bash
node cli.ts --mode gateway --upstream http://127.0.0.1:8326 \
             --model workbuddy/deepseek-v4.1-flash --port 8788 --api-key "$(openssl rand -hex 16)"
```

| 选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--mode` | `BRIDGE_MODE` | `direct` | `direct` 自己登录腾讯产品 / `gateway` 转发给上游 |
| `--product` | `BRIDGE_PRODUCTS` | `cn,intl,oc` | 挂载哪些来源；一键配置会**追加**，可重复 |
| `--host` | `BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `--port` | `BRIDGE_PORT` | `8788` | 监听端口 |
| `--model` | `BRIDGE_MODEL` | 直连模式空 / 网关模式 `workbuddy/deepseek-v4.1-flash` | 兜底模型 ID |
| `--map` | `BRIDGE_MODEL_MAP` | 空 | `A=B,C=D` 形式的模型映射 |
| `--api-key` | `BRIDGE_API_KEY` | 空（不校验） | 本桥自己的门禁密钥；`setup` 首次落固定默认值 `flow-one-local`，之后**一直复用**（客户端长期引用它；随机换钥匙会让 Claude Code 回 401、DSH 报「密钥无效」） |
| `--max-tokens` | `BRIDGE_MAX_TOKENS_CAP` | 0（不限） | 转发前对每轮输出的上限截断 |
| `--heartbeat` | `BRIDGE_HEARTBEAT_MS` | 15000 | 思考期静默时发 ping 帧的间隔；0 关闭 |
| `--upstream-idle` | `BRIDGE_UPSTREAM_IDLE_MS` | 180000 | 上游静默多久算失败并以流内 error 收尾；0 关闭 |
| `--thinking` | `BRIDGE_SHOW_THINKING` | 关 | 把上游的推理增量渲染成 `thinking` 块 |
| — | `BRIDGE_FINGERPRINT_REWRITE` | 开 | 腾讯内容指纹的窄改写（见下） |
| `--upstream` | `UPSTREAM_BASE_URL` | `http://127.0.0.1:8326` | 网关模式的上游 |
| `--upstream-key` | `UPSTREAM_API_KEY` | 读 DSH 网关密钥 | 上游密钥 |
| — | `BRIDGE_HOME` | `~/.flow-one` | 凭据与安装状态目录 |

监听非回环地址必须自带 `--api-key` / `BRIDGE_API_KEY`；空 key 与公开默认值 `flow-one-local`
都会被拒。免鉴权只允许字面量回环 IP（IPv4 `127.0.0.0/8` 或 IPv6 `::1`），主机名即使当前解析到
回环也要求自定义 key —— 免得某次解析变化把口子放大。

## 它到底改了什么

**本工具的职责是提供反代；改你的客户端配置是可选动作。** 向导第 4 步**分两次单独问**：
要不要写 Claude Code 的配置（`~/.claude/settings.json`）、要不要写 DSH 的
（`llm-pi-ai` provider + 凭据引用）—— 两个独立开关，都答 y 就都写。**每次 setup 都会问**
（上一次的选择作为默认值）；两个都答 n 就不写任何客户端配置（包括以前代管过的）。
改过反代端口这类参数之后，没跟着更新的客户端需要手动同步。
`--clients claude,dsh|claude|dsh|none` 可直接表态、跳过提问。
之后随时用 `fo client` 打印连接地址、令牌与模型 ID，自己填进任何 Anthropic 兼容客户端。

选了「写」的话，向导只碰三个地方，全部可还原：

1. **`~/.claude/settings.json`**（只有你选了「写」才动；写前先备份成
   `settings.json.bak-<时间戳>`）—— 只在 `env` 下合并那 6 个 `ANTHROPIC_*` 键；
   已有的 `permissions`、`hooks`、`statusLine`、`ANTHROPIC_CUSTOM_HEADERS` 等原样保留。
   如果你的 `model` 是 `sonnet` 这类别名，它也一并固定成我们的模型，免得 Claude Code 去请求
   一个网关里不存在的别名。
   还原时**只删「值仍等于本工具写进去的那个」的键** —— 你自己改过的值会留着。
2. **后台服务**：macOS 写 `~/Library/LaunchAgents/dev.flow-one.plist` 并 `launchctl bootstrap`；
   Linux 写 `~/.config/systemd/user/` 下的 unit 并 `systemctl --user enable` + `restart`。
   模式、上游、模型都写进服务环境，所以服务不带参数启动也拿到同一份配置。
3. **`~/.flow-one/`**：登录凭据（0600）、`install.json`（记录写过哪些键、装过哪个服务，
   供还原用）、服务日志。

### 模型 ID 后面的 `[1m]`

`[1m]` 是 Claude Code 的标记，意思是「这个模型按 1M 上下文登记」。
**本工具按模型真实窗口决定加不加**：超过 200k 才加，窗口未知时不加（Claude Code 对未识别
ID 的默认假设正是 200k）。

这不是抠细节：OpenCode 免费档的 `deepseek-v4.1-flash-free` 实测窗口是 **200k**
（能力数据来自 models.dev；官方 `/v1/models` 里没有任何能力字段）。按 1M 登记会让
Claude Code 到 1M 才压缩上下文，然后撞上模型真实上限。腾讯两条线确实是 1M 窗口，所以保留后缀。
Claude Code 发请求前会把后缀剥掉，上游收到的是干净的 ID。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages，流式与非流式（`?beta=true` 也认） |
| POST | `/v1/messages/count_tokens` | 本地估算；不打上游 |
| GET | `/v1/models` | 上游模型清单（直连模式带产品前缀） |
| GET | `/health` | 存活探测；**不需要密钥** |

鉴权同时接受 `x-api-key` 与 `Authorization: Bearer`，定长比较；`--api-key` 为空时不校验
（这种情况只监听回环 —— 不要改成 `0.0.0.0`）。

流式响应在上游返回 200 后**立刻**发 `message_start`（推理模型可以先想很久不吐字），
静默期按 `--heartbeat` 发 `ping` 帧，按 `--upstream-idle` 判定上游卡死。

用量按 Anthropic 的口径上报：上游的 `prompt_tokens` 把缓存读**算在里面**，而 Anthropic
把 `cache_read_input_tokens` / `cache_creation_input_tokens` 列在外面，本桥据此拆开，
所以 Claude Code 下能看到真实的缓存命中。

## 翻译规则

| Anthropic | OpenAI |
| --- | --- |
| `system`（字符串或块数组） | 首条 `{role:'system'}` 消息 |
| `text` / `image` 块 | `{type:'text'}` / `{type:'image_url'}` 部分 |
| `tool_use` 块 | 助手消息上的 `tool_calls[]` |
| `tool_result` 块 | 独立的 `{role:'tool', tool_call_id}` 消息（排在同轮文本之前） |
| `tools[].input_schema` | `tools[].function.parameters` |
| `thinking.budget_tokens` | `reasoning_effort`（≥12288 → high，≥4096 → medium，否则 low） |
| `stop_sequences` | `stop` |

响应侧的 `stop_reason` 由本轮有没有工具调用决定（有则 `tool_use`）；否则
`length → max_tokens`、`content_filter → refusal`，其余 `end_turn`。流式按
`message_start → content_block_start → content_block_delta → content_block_stop →
message_delta → message_stop` 成帧，工具参数走 `input_json_delta`，
响应头发出去之后的失败走流内 `error` 事件。

直连模式额外做几件官方客户端才做的事：

1. **首条消息必须是 `system`** —— 国际版网关对首条是 user 的请求直接回
   `400 + code 11128`，缺了就补一条。
2. **`prompt_cache_key`** —— 同一个 system 前缀稳定命中服务端前缀缓存
   （官方客户端实测同一请求开了缓存计费差约 17 倍）。
3. **按模型族选 `User-Agent`** —— 国际版后台按这组分列「使用端」，`glm-*` /
   `hy*` / `kimi-*` / `minimax-*` 这几条国内模型线要用国内客户端形态发。
4. **DeepSeek 系要显式开思考** —— 这一族只有 `reasoning_effort` 生效，
   `thinking` 字段单独不生效，两个都带才稳定返回 `reasoning_content`。

## 腾讯侧内容风控的窄改写

腾讯后端会拦下「自称是别的客户端」的请求。本桥对**腾讯系模型**（`cn/`、`intl/`、
`buddy/`、`workbuddy/` 前缀）做五条**各有实测依据**的窄改写，其余文本逐字符不动
（腾讯按前缀缓存，无谓地重建字符串会让每轮都算新前缀）：

| 命中的字面量 | 处理 | 实测依据 |
| --- | --- | --- |
| `You are Claude Code, Anthropic's official CLI for Claude` | 改成 `…, an official CLI for Claude` | 原句 `400 + 11128`；只有一半时不拦，所以规则要求两个片段同现 |
| `Main branch (you will usually use this for PRs)` | 改成 `Main branch (PRs usually go here)` | Claude Code 只在 git 仓库里拼这句；整句被拦，改写后 200 |
| `You are an AI agent powered by DeepSeek Harness` | 改成 `… powered by a DeepSeek harness` | DSH 的 persona 首句；拆成片段不拦，所以判据是整句 |
| `through the DeepSeek Harness Web GUI` | 改成 `through the harness Web GUI` | 与上一条**同现**时才拦 |
| 整行 `x-anthropic-billing-header: …`（Claude Code 2.1.x 拼在 system 首行） | 删掉整行 | 键名是判据（大小写不敏感、值任意）；改名或删除即 200 |

关掉：`--no-fingerprint-rewrite` 或 `BRIDGE_FINGERPRINT_REWRITE=0`。
**请自行权衡**：这是绕过厂商侧的一条内容控制，只为让 Claude Code 这类第三方客户端
能用起来（见文末免责声明）。

## 已知限制

- **网关模式依赖那个网关在跑。** 默认指向 DSH 的 `127.0.0.1:8326`，那是桌面应用进程里的
  监听：DSH 关掉，桥就没有上游。要完全独立请用直连模式。
- **推理默认不渲染给客户端**（只）在 `--thinking` 时输出）。
- **`tool_choice` 不转发**（官方客户端从不发；为 `none` 时连工具定义一起摘掉）。
- **工具结果里的图片**按 OpenAI 的多段格式发，标准服务器可能不收。
- **非流式请求也仍然走上游的流式**，本桥负责归并成单个 JSON 响应。
- **`count_tokens` 是估算**（4 字符 ≈ 1 token；图片按固定值计）。
- **`[claude-code:unrecognized_model]` 诊断行在 `-p` 模式下仍会出现。**
  官方给的消诊断办法是把 `modelOverrides` 的键写成 Claude 模型 ID —— 等于让 Claude Code
  以为自己在跑 Opus，随之套用那个模型的窗口与行为。不值得为一行 stderr 噪声付这个代价。
  交互式会话里这行不打印，只进调试日志。
- **OpenCode 免费档靠报文形状过门禁**，官方收紧就会坏（那时会明确报 `FreeTierError`，
  而不是悄悄降级）。它只覆盖免费档；不以 `-free` 结尾的模型需要 OpenCode Go 订阅。
- **服务跑的是哪份代码取决于怎么装的**：全局安装（`npm i -g`）时，服务指向
  `…/lib/node_modules/…/dist/cli.js` 那份**快照**，之后的 `git pull` 或改仓库都不影响它
  （症状是「命令行有新功能，服务没有」）。`fo status` 会打印服务用的代码路径，
  与当前命令不一致时提示重装。
- 只覆盖对话与模型清单。**每日签到领积分不在范围内。**

## 测试

```bash
node --test        # 完全离线，不需要网络或账号
fo doctor         # 唯一会真发请求的检查（两条门禁 + 本地配置）
```

全部用例离线：翻译层的纯函数、网关模式端到端（假上游 SSE）、直连模式的登录轮询
（含 `11217` 尚未就绪不算失败）、模型清单合并与筛选、流内策略拦截如实上报、指纹改写、
安装器的「合并不覆盖 / 写前备份 / 只还原自己写的键 / 服务文件内容」、
终端界面的按键与编号选择，以及 OpenCode 免费档的门禁形状（会话 / 请求 id 位数、
门禁工具的补齐与改名、丢弃桩调用、端到端不泄漏给客户端）。

⚠️ 界面用例单独放在 `test/prompt.test.ts`，**不碰全局 `process.stdin`**：
`src/prompt.ts` 留了 `setStdinForTest()` 这个接缝给它们替换输入流。以前它们直接改
`process.stdin`，会扰动 node:test 的结果记账 —— 往同一个文件里加一个这样的用例，
整个文件的用例计数反而会变少，日志里看不出任何异常。

每个文件的「声明的用例数」与「实际注册数」可以这样对账：

```bash
for f in test/*.test.ts; do
  printf '%-28s declared %s / registered %s\n' "$f" "$(grep -c '^test(' $f)" \
    "$(node --test --test-reporter=tap $f 2>/dev/null | grep -oE '^# tests [0-9]+' | grep -oE '[0-9]+')"
done
```

真机验证（2026-10，本机）：真的 `claude` CLI（2.1.301）经本桥拿到回答；网关模式对真实上游
跑通非流式 / 流式 / 工具往返；两条腾讯产品线的 `/v2/plugin/auth/state` 地址发现；
OpenCode 免费档的非流式 / 流式 / 工具往返（模型发 `bash`，桥回 `Bash`）；
launchd 自启与 `/health`。

## 免责声明

本项目**以你自己的账号凭据**访问官方客户端所用的接口，仅供个人学习与个人使用。
是否符合你所在地区的要求与服务条款，请自行判断；不要把凭据提交到任何仓库，
也不要把本反代暴露到公网。协议细节参考了
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）里实测过的
逆向结论；本项目的实现与它无关。

## 发布到 npm（维护者）

包名 `flow-one` **暂未被占用**（2026-10-16 核查）。`fo` 已被他人占用，所以它只是本包
提供的命令别名，不是包名。

```bash
# 0. 前提：registry 必须是官方源 —— 国内镜像只能装、不能发
npm config get registry          # 应该是 https://registry.npmjs.org/

# 1. 登录（没有账号先去 npmjs.com 注册）
npm login                        # 开了 2FA 时需要一个一次性验证码

# 2. 先空跑：会执行 prepublishOnly（node --test）并列出将要发布的内容
npm publish --dry-run

# 3. 正式发布
npm publish

# 4. 核对
npm view flow-one version
npm i -g flow-one && fo status
```

踩过的几个坑：

- **发布前工作区必须干净**：未提交的改动会以半成品形式进入发布的包里。
- **版本号只能往上走**：先 `npm version patch|minor|major`；重发同一版本会被拒
  （`EPUBLISHCONFLICT`）。
- **只有 72 小时可撤回**：`npm unpublish flow-one@0.1.0`；过期后只能发新版本。
  所以首次发布前先用 `npm i -g .` 本地验一遍更稳。
- **从 CI 发布**需要 **Automation** 类型的 token（npm 网站 → Access Tokens）；
  普通 token 会被 2FA 拒。把它存成仓库密钥 `NPM_TOKEN`，在推 `v*` tag 时跑
  `npm publish --provenance --access public`。

## 许可证

MIT

## 代码规范与门禁

本仓库的规范写在 [AGENTS.md](AGENTS.md)（错误契约、代码落点表与分层、套餐分离不变式、
跨平台要求、测试与验证门禁）。**门禁写成了命令**，一条命令跑完：

```bash
make verify     # build + static checks + all tests
make check      # 只做静态检查：类型 + lint + 格式 + 模块规约
make test       # 只跑用例（node --test，零依赖）
make types      # 对 TypeScript 源码跑 tsc --noEmit
make lint       # ESLint
make format     # Prettier，就地重排
make help       # 列出全部目标
```

`make check` 需要先 `npm install` 一次（typescript / eslint / prettier）。
跑反代与跑用例不需要：`node cli.ts` 与 `node --test` 只用 Node 内置模块。

几条刻意的约束：

- **No third-party runtime dependencies**: only Node built-ins are used at runtime.
- **单包，不拆分**：约 4000 行、17 个模块，作为一个包完全够；拆成 workspace 或多个发布包
  只会把「装一个东西」变成「解析一堆包」，而且每新增一个包都要再过一次 npm 发布审核。
  规模问题用更小的函数与模块解决；文件超过 500 行 `make check` 会提示。
- **不允许循环依赖**：ESM 下的环路表现为 TDZ 报错，报错点离成因很远，所以交给机器兜
  （`scripts/check-modules.ts`）。`src/home.ts` 故意什么都不 import —— 它存在的意义
  就是打断 `config ↔ opencode` 那一环。
- **每个行为变更都要有回归测试**，且用例不得碰真实家目录（一律用临时的 `BRIDGE_HOME`）。
