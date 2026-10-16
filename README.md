# flow-one

让 **Claude Code CLI** 用上 **WorkBuddy（国内版 CodeBuddy / 国际版）** 与
**OpenCode 免费档**的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，而这几家的接口都是 OpenAI 风格
（WorkBuddy 的 `/v2/chat/completions`、OpenCode 的 `/inference/v1/chat/completions`）。
这个桥就干这一件事：**进门说 Anthropic，出门说 OpenAI**，顺手把登录、续期、模型目录、
免费档的形状门禁、环境隔离都办了。零依赖，只用 Node 内置能力。

```
Claude Code CLI ──► 本桥 127.0.0.1:8788 ──► WorkBuddy 国内版 copilot.tencent.com   cn/…
   (Anthropic            /v1/messages            (OpenAI 形状 SSE)
    Messages)            ⇄ 翻译             ──► WorkBuddy 国际版 www.workbuddy.ai   intl/…
                                          ──► OpenCode 免费档 opencode.ai/inference oc/…
```

## 安装

三种方式，任选一种。命令名有两个：**`fo`** 与 **`flow-one`**，同一个入口。

**1. 不克隆，直接用**

```bash
npx -y github:9Ashwin/flow-one status     # 每次从 GitHub 取最新
npm i -g github:9Ashwin/flow-one          # 或者装成全局命令
```

**2. 克隆后链成全局命令**（要改代码就用这个：`git pull` 之后命令即刻是新的）

```bash
git clone https://github.com/9Ashwin/flow-one.git
cd flow-one
npm link          # 之后任意目录直接 fo
```

**3. 从 npm 全局安装**（发布之后）

```bash
npm i -g flow-one
```

需要 Node ≥ 18.17（用到内置 `fetch`）。**没有依赖**，不会往 `node_modules` 里装东西。

## 快速开始

```bash
fo               # 在终端里直接跑，进交互式菜单
```

选 `1` 之后它自己走完四步：**接哪一家 → 登录 → 选模型 → 写配置并常驻**。

一次只配一家（跟 zcf 一样，一项一项来），配完**按回车回菜单**；想再挂一家，回菜单
再选一次「一键配置」即可 —— 挂载清单是**叠加**的（走 `BRIDGE_PRODUCTS` 并集），
先前配好的不会被顶掉。

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

第 2 步只处理这一家：OpenCode 免费档没有登录这一步，选中它就直接跳到选模型；
腾讯那两家会在这里走浏览器授权。

选模型只列**这一家**的模型（认准一家配一家，不用在全部来源里挑）。
清单**全部列出、不截断**，**免费档单独成组排在最前**（OpenCode 的免费模型不花
积分/额度），其余按量计费或订阅的排在后面；分组标题只是标题，不占编号、光标会跳过。

清单同时支持**边打边筛**：敲 `free`、`glm`、`oc/deep` 都会立刻缩小范围，退格删字、
Esc 清空、↑↓ 移动、回车确认（筛选结果里不再插分组标题）。超过 12 条时只画光标附近
那一段。清单里没有的 ID（自建网关、新模型）走最后那条「手动输入模型 ID」。

列表型的挑选（模型清单）用 ↑↓ 或**直接按编号**，空格建不用记，每一行都带着窗口、
输出上限与档位；结束会给一张摘要框。

配置完直接运行 `claude` 就能用了。想还原：菜单里选「还原配置」，或者 `fo uninstall`。

## 两种上游

| | 直连模式（默认） | 网关模式 |
| --- | --- | --- |
| 谁负责登录 | **本工具自己**；OpenCode 免费档连登录都不需要 | 上游负责，比如 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |
| 依赖 | 无 | 那个网关得在跑 |
| 模型 ID | `cn/deepseek-v4.1-flash`、`intl/hy4-preview-f`、`oc/deepseek-v4.1-flash-free` | 上游的 ID，如 `workbuddy/deepseek-v4.1-flash` |
| 适合 | 只想装这一个工具 | 已经有一套网关 / 多上游混合 |

一个来源一个前缀，所以**一个进程能同时挂三条线**，换个 `ANTHROPIC_MODEL` 就换了来源：

| 前缀 | 来源 | 登录 |
| --- | --- | --- |
| `cn/` | WorkBuddy 国内版（CodeBuddy，`copilot.tencent.com`） | 要 |
| `intl/` | WorkBuddy 国际版（`www.workbuddy.ai`） | 要 |
| `oc/` | **OpenCode 免费档**（`opencode.ai/inference`） | **不要**，装完即用 |
| `ocg/` | **OpenCode Go 套餐**（`opencode.ai/zen/go/v1`） | 要一把 API key（`oc_sk_…`） |

### OpenCode Go 套餐（`ocg/`）

买了 Go 套餐（$10/月起）就在菜单里选「一键配置 → OpenCode Go 套餐」，把
`oc_sk_…` 粘贴进去（输入时不回显）；配好之后**自动多挂一条来源**，模型清单里出现
`ocg/` 前缀的 37 个模型：DeepSeek V4.1 Flash / Pro、GLM-5.1/5.2/5.3、Kimi K3、
Grok 4.6/4.7、Qwen3.8、Claude Haiku 5.5、Gemini 4 Argon…

这条路与免费档**不是同一条**，规矩也不同（2026-10-16 实测；DSH 桌面端的
`cordis.yml` 里也是同一套配置）：

| 事实 | 说明 |
| --- | --- |
| 端点 `/zen/go/v1` | 免费档是 `/inference/v1`，两条路的模型清单不一样 |
| `Authorization: Bearer oc_sk_…` 必需 | 无头或乱写 key 都是 401 |
| **`x-opencode-session` 必需** | 缺了回 `400 MissingSessionID`（"cannot be routed efficiently"）；值是随意的会话 id，UUID 与 `ses_` 形状都收 —— 桥会在首次配置时生成并落盘复用 |
| **不需要**免费档那套形状 | 裸 OpenAI 报文直接 200，不用补那四个小写工具、也不用发 `x-opencode-client` |

两个实操细节：`reasoning_effort: "off"` 上游**不接受**（422，文案还是误导性的
"Endpoint is unavailable"），本桥的档位映射只会发 `low/medium/high`；deepseek 这族
**默认就思考**，`max_tokens` 给小了可能全被推理吃掉、正文为空 —— 调小 `max_tokens`
调试时容易误判成「桥坏了」。

### OpenCode 免费档（`oc/`）

`oc/deepseek-v4.1-flash-free` 就是官方免费档里的 DeepSeek V4.1 Flash，无需账号。
但它**不是「换个 base URL」**：直接发标准 OpenAI 请求会被

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

拒掉 —— 它按**报文形状**判断调用方。实测（2026-10-16）凑齐这三样才 200：

- 5 个 `x-opencode-*` 头：`project`（40 hex）、`session` **与** `session-id`（同一值）、
  `request`、`client: cli`，外加 `User-Agent: opencode/<版本>`；
- 会话 id 形状 `ses_` + 12 位小写 hex + **14** 位 base62（尾段总长 26；误当成
  「随机 26 位」会变 38 字符而一律 403）；
- 请求体 `stream: true`，且 `tools` 里必须有 `bash` / `glob` / `grep` / `read`
  四个小写 function 工具。

工具名冲突由本桥抹平：Claude Code 自带的 `Bash` / `Read` 出站时改小写、响应里改回
原名；它没声明的（通常是 `glob` / `grep`）补一个桩，并把模型对桩的调用**整条丢弃** ——
那是 Claude Code 执行不了的工具名。

**这两条门禁的完整事实、证据与复验方式在 [docs/gates.md](docs/gates.md)**；
`fo doctor` 会把它们**逐项重推一遍**（Go 套餐那条路也会：带会话头的一次最小对话、
不带会话头应被拒、模型清单要 key）（先验完整形状，再逐项去掉一个要件确认它确实
还是必填），上游放松或收紧都会当场显形 —— 不用等用户来提「用不了」。`big-pickle` 等 `-free` 结尾的模型同样可用；
不带 `-free` 的（`deepseek-v4.1-flash`、`deepseek-v4-pro` 等）属于 $10/月的
OpenCode Go 订阅，走了会报 `AuthError`。

## 命令行

下面一律写 `fo`，换成 `flow-one` 等价。

| 命令 | 说明 |
| --- | --- |
| `fo` | 终端里跑进菜单；无 TTY（systemd / 管道）直接起服务 |
| `switch` | 只换模型（菜单里的「切换模型」） |
| `doctor` | 自检：配置 / 登录 / 两条门禁（会真发几个请求） |
| `setup` / `--setup` | 交互式一键配置 |
| `uninstall` / `--uninstall` | 还原 Claude Code 配置并卸载后台服务 |
| `login [cn\|intl]` | 登录；不带参数两条产品线都登 |
| `status` | 登录状态、令牌有效期、服务与配置文件位置 |
| `models` | 列出可用模型 ID（带窗口 / 输出上限 / 档位） |

不想用向导时，所有步骤都能用参数完成：

```bash
node cli.mjs --mode gateway --upstream http://127.0.0.1:8326 \
             --model workbuddy/deepseek-v4.1-flash --port 8788 --api-key "$(openssl rand -hex 16)"
```

| 选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--mode` | `BRIDGE_MODE` | `direct` | `direct` 直连腾讯产品 / `gateway` 转发给上游 |
| `--product` | `BRIDGE_PRODUCTS` | `cn,intl,oc` | 挂载哪几个来源；一键配置是**叠加**写它的，可重复 |
| `--host` | `BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `--port` | `BRIDGE_PORT` | `8788` | 监听端口 |
| `--model` | `BRIDGE_MODEL` | 直连为空 / 网关为 `workbuddy/deepseek-v4.1-flash` | 兜底模型 ID |
| `--map` | `BRIDGE_MODEL_MAP` | 空 | `A=B,C=D` 形式的模型映射 |
| `--api-key` | `BRIDGE_API_KEY` | 空（不校验） | 本桥自己的门禁密钥 |
| `--max-tokens` | `BRIDGE_MAX_TOKENS_CAP` | 0（不限） | 下发前的单次输出上限 |
| `--heartbeat` | `BRIDGE_HEARTBEAT_MS` | 15000 | 思考期静默时发 ping 帧的间隔，0 关闭 |
| `--thinking` | `BRIDGE_SHOW_THINKING` | 关 | 把上游思考增量渲染成 `thinking` 块 |
| — | `BRIDGE_FINGERPRINT_REWRITE` | 开 | 腾讯内容指纹窄改写（见下） |
| `--upstream` | `UPSTREAM_BASE_URL` | `http://127.0.0.1:8326` | 网关模式的 OpenAI 兼容上游 |
| `--upstream-key` | `UPSTREAM_API_KEY` | 读 DSH 网关密钥 | 上游密钥 |
| — | `BRIDGE_HOME` | `~/.flow-one` | 凭据与安装状态目录 |

## 它到底改了什么

向导只碰三处，且都可还原：

1. **`~/.claude/settings.json`**（先备份成 `settings.json.bak-<时间戳>`）
   —— 只合并 `env` 下的 6 个 `ANTHROPIC_*` 键；原来就在的 `permissions`、`hooks`、
   `statusLine`、`ANTHROPIC_CUSTOM_HEADERS` 等一律原样保留。
   如果你的 `model` 是 `sonnet` 这类别名，会一起钉成我们的模型，免得 Claude Code
   去请求网关里不存在的别名。
   还原时**只删值仍等于本工具写入的那份**的键 —— 你自己改过的会被保留。
2. **后台服务**：macOS 写 `~/Library/LaunchAgents/dev.flow-one.plist`
   并 `launchctl bootstrap`；Linux 写 `~/.config/systemd/user/` 下的 unit 并
   `systemctl --user enable --now`。模式、上游、模型都写进服务环境，
   所以服务不带参数启动也能拿到同一份配置。
3. **`~/.flow-one/`**：登录凭据（0600）、`install.json`（记着
   写了哪些键、装了什么服务，供还原用）、服务日志。

### 模型 ID 后面的 `[1m]`

`[1m]` 是 Claude Code 自己的标记，表示「这个模型按 1M 上下文登记」。
**本工具按模型真实窗口决定加不加**：超过 200k 才加，未知就不加
（Claude Code 对未识别 ID 的默认假设正是 200k）。

这不是洁癖：OpenCode 免费档的 `deepseek-v4.1-flash-free` 实测窗口是 **200k**
（能力数据取自 models.dev，官方 `/v1/models` 不含任何能力字段），给它登记 1M
会让 Claude Code 到 1M 才压缩上下文，然后撞上模型真实上限。腾讯那两条线的窗口
确实是 1M，所以照样带后缀。Claude Code 发请求前会把后缀剥掉，上游收到的是干净的 ID。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages，流式与非流式（`?beta=true` 同样放行） |
| POST | `/v1/messages/count_tokens` | 本地估算，不发上游请求 |
| GET | `/v1/models` | 上游模型清单（直连模式带产品前缀） |
| GET | `/health` | 存活探测，**不需要密钥** |

鉴权同时接受 `x-api-key` 与 `Authorization: Bearer`，比对用定长比较；
`--api-key` 留空时不校验（此时只监听回环，别改成 `0.0.0.0`）。

## 翻译规则

| Anthropic | OpenAI |
| --- | --- |
| `system`（字符串或块数组） | 首条 `{role:'system'}` 消息 |
| `text` / `image` 块 | `{type:'text'}` / `{type:'image_url'}` 部分 |
| `tool_use` 块 | 助手消息上的 `tool_calls[]` |
| `tool_result` 块 | `{role:'tool', tool_call_id}` 独立消息（排在同轮文本之前） |
| `tools[].input_schema` | `tools[].function.parameters` |
| `thinking.budget_tokens` | `reasoning_effort`（≥8192 → high，≥2048 → medium，否则 low） |
| `stop_sequences` | `stop` |

响应侧：`stop_reason` 按本轮是否出现工具调用决定（有则 `tool_use`），否则
`length → max_tokens`、其余 `end_turn`；流式按
`message_start → content_block_start → content_block_delta → content_block_stop →
message_delta → message_stop` 成帧，工具参数走 `input_json_delta`，
响应头发出去之后的失败走流内 `error` 事件。

直连模式额外做四件官方客户端才做的事：

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
`buddy/`、`workbuddy/` 前缀）做两条**有实测依据**的窄改写，其余文本逐字符不动
（腾讯按前缀缓存，无谓地重建字符串会让每轮都算新前缀）：

| 命中的字面量 | 处理 | 实测依据 |
| --- | --- | --- |
| `You are Claude Code, Anthropic's official CLI for Claude` | 改成 `…, an official CLI for Claude` | 原句 `400 + 11128`；只有一半时不拦，所以规则要求两个片段同现 |
| 整行 `x-anthropic-billing-header: …`（Claude Code 2.1.x 拼在 system 首行） | 删掉整行 | 键名是判据（大小写不敏感、值任意）；改名或删除即 200 |

关掉：`--no-fingerprint-rewrite` 或 `BRIDGE_FINGERPRINT_REWRITE=0`。
**请自行权衡**：这是绕过厂商侧的一条内容控制，只为让 Claude Code 这类第三方客户端
能用起来（见文末免责声明）。

## 已知限制

- **网关模式依赖那个网关在跑**。默认指向 DSH 的 `127.0.0.1:8326`，那是桌面应用
  进程里的监听：DSH 关掉，本桥就取不到上游。要彻底独立请用直连模式。
- **思考默认不渲染给客户端**（`--thinking` 才渲染）。
- **`tool_choice` 不下发**（官方客户端从不发；`none` 时连工具定义一起摘掉）。
- **工具结果里的图片**按 OpenAI 多部分格式发出，标准服务端可能不接受。
- **非流式请求在上游仍然是流式**，由本桥归并成一个 JSON 返回。
- **`count_tokens` 是估算**（4 字符 ≈ 1 token，图片记固定值）。
- **`[claude-code:unrecognized_model]` 那行诊断在 `-p` 模式仍会出现**。
  官方给的消除办法是把 `modelOverrides` 的键写成 Claude 的模型 ID —— 那等于让
  Claude Code 以为自己在跑 Opus，会连带套用那个模型的窗口与行为，不值得为一行
  stderr 噪声付这个代价。交互式会话里这行不打印，只进调试日志。
- **OpenCode 免费档靠报文形状过门禁**，官方收紧形状就可能失效（那时会明确报
  `FreeTierError`，不会静默降级）。它也只覆盖免费档，`-free` 结尾以外的模型要
  OpenCode Go 订阅。
- **服务跑的是「哪份代码」要看安装来源**：用全局安装（`npm i -g`）装的，服务指向
  `…/lib/node_modules/…/cli.mjs` 这份**快照**，之后 `git pull` 与改仓库都不会生效
  （表现是「命令行有新功能、服务里没有」）。`fo status` 会把服务代码路径打出来，
  与当前命令不一致时会直接警告并提示重装。
- 只覆盖对话与模型目录。**每日签到领积分不在范围内**。

## 测试

```bash
node --test        # 全部离线，不需要网络与账号
fo doctor         # 唯一会真发请求的检查（两条门禁 + 本地配置）
```

33 条用例，全部离线：翻译层纯函数、网关模式端到端（假上游 SSE）、直连模式登录轮询
（含 `11217` 尚未就绪）、模型目录合并与过滤、流内策略拦截如实上报、指纹改写、
安装器的「合并而非覆盖 / 写前备份 / 只还原自己写的键 / 服务文件内容」，
终端界面的按键与编号选择，以及 OpenCode 免费档的门禁形状（会话/请求 id 位数、
门禁工具补齐与改名、桩调用丢弃、端到端不落到客户端）。

⚠️ 界面用例单独放在 `test/prompt.test.mjs`，并且**不碰全局 `process.stdin`**：
`src/prompt.mjs` 留了一个 `setStdinForTest()` 接缝给它们换输入流。早先是直接改
`process.stdin`，结果是 node:test 的结果记账被搅乱 —— 往同一个文件里加一条这样的
用例，整个文件的计数反而变少，日志里看不出异常。

每个文件的「声明用例数」与「实际注册数」可以这样核对：

```bash
for f in test/*.test.mjs; do
  printf '%-28s 声明 %s / 注册 %s\n' "$f" "$(grep -c '^test(' $f)" \
    "$(node --test --test-reporter=tap $f 2>/dev/null | grep -oE '^# tests [0-9]+' | grep -oE '[0-9]+')"
done
```

真机验证过（2026-10，本机）：真 `claude` CLI（2.1.301）经本桥拿到回答；
网关模式对真实上游的非流式 / 流式 / 工具往返；两条腾讯产品线的
`/v2/plugin/auth/state` 取址；OpenCode 免费档的非流式 / 流式 / 工具往返
（模型发 `bash`、本桥交回 `Bash`）；launchd 自启与 `/health`。

## 免责声明

本项目通过**用户自己的账号凭据**访问官方客户端使用的接口，仅供个人学习与自用。
请自行判断这是否符合你所在地区与服务条款的要求；不要把凭据提交进任何仓库，
也不要把本桥暴露到公网。协议细节参考了
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）中被实测
验证过的逆向结论，本项目的实现与之独立。

## 发布到 npm（维护者）

包名 `flow-one` 在 npm 上**尚未被占用**（2026-10-16 查证）。`fo`
这个名字已被别人占用，所以它只作为本包提供的命令别名，不作包名。

```bash
# 0. 前提：registry 必须是官方源 —— 国内镜像只能装、不能发
npm config get registry          # 应为 https://registry.npmjs.org/

# 1. 登录（没有账号先去 npmjs.com 注册）
npm login                        # 开了双因素会要一次性验证码

# 2. 先空跑：会执行 prepublishOnly（node --test）并列出将要发布的内容
npm publish --dry-run

# 3. 正式发布
npm publish

# 4. 核对
npm view flow-one version
npm i -g flow-one && fo status
```

几条踩过的坑：

- **发布前工作区要干净**：`git status` 有未提交改动时，包里会带上半成品。
- **版本号只升不覆**：先 `npm version patch|minor|major`；同一个版本重发会被拒
  （`EPUBLISHCONFLICT`）。
- **72 小时内可撤**：`npm unpublish flow-one@0.1.0`；超过就只能发新版本。
  所以第一次发之前，先 `npm i -g .` 在本地验一遍更稳。
- **CI 里发布**要用 **Automation 类型**的 token（npm 网站 → Access Tokens），
  普通 token 遇到 2FA 会被拒；配成仓库 secret `NPM_TOKEN`，打 `v*` tag 时
  `npm publish --provenance --access public`。需要这条工作流可以说一声，我加个
  `.github/workflows/release.yml`。

## License

MIT
