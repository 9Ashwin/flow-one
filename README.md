# claude-code-openai-bridge

让 **Claude Code CLI** 用上 **WorkBuddy（国内版 CodeBuddy / 国际版）** 的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，而 WorkBuddy 的接口是 OpenAI 风格
的 `/v2/chat/completions`。这个桥就干这一件事：**进门说 Anthropic，出门说 OpenAI**，
顺手把登录、续期、模型目录、环境隔离都办了。零依赖，只用 Node 内置能力。

```
Claude Code CLI ──► 本桥 127.0.0.1:8788 ──► WorkBuddy 国内版 copilot.tencent.com
   (Anthropic            /v1/messages            (OpenAI 形状 SSE)
    Messages)            ⇄ 翻译             ──► WorkBuddy 国际版 www.workbuddy.ai
```

## 快速开始

需要 Node ≥ 18.17（用到内置 `fetch`）。不需要 `npm install`，没有依赖。

```bash
git clone https://github.com/9Ashwin/claude-code-openai-bridge.git
cd claude-code-openai-bridge
node cli.mjs          # ← 在终端里直接跑，会进交互式菜单
```

选「**一键配置**」，剩下四步它自己走完：

```
? 要做什么？
❯ 一键配置        登录 → 选模型 → 写 Claude Code 配置 → 后台常驻
  启动反代        前台运行，Ctrl+C 退出
  登录 / 换账号
  查看状态
  还原本工具写过的配置
  退出
```

配置完直接运行 `claude` 就能用了。想还原：菜单里选「还原本工具写过的配置」，或者
`node cli.mjs uninstall`。

## 两种上游

| | 直连模式（默认） | 网关模式 |
| --- | --- | --- |
| 谁负责登录 | **本工具自己**（国内版 / 国际版各登一次） | 上游负责，比如 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |
| 依赖 | 无 | 那个网关得在跑 |
| 模型 ID | `cn/deepseek-v4.1-flash`、`intl/hy4-preview-f` | 上游的 ID，如 `workbuddy/deepseek-v4.1-flash` |
| 适合 | 只想装这一个工具 | 已经有一套网关 / 多上游混合 |

一条产品线一个前缀，所以**一个进程可以同时服务国内版与国际版**，换个
`ANTHROPIC_MODEL` 就换了产品线。

## 命令行

| 命令 | 说明 |
| --- | --- |
| `claude-code-bridge` | 终端里跑进菜单；无 TTY（systemd / 管道）直接起服务 |
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
| `--product` | `BRIDGE_PRODUCTS` | `cn,intl` | 挂载哪几条产品线，可重复 |
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
| — | `BRIDGE_HOME` | `~/.claude-code-openai-bridge` | 凭据与安装状态目录 |

## 它到底改了什么

向导只碰三处，且都可还原：

1. **`~/.claude/settings.json`**（先备份成 `settings.json.bak-<时间戳>`）
   —— 只合并 `env` 下的 6 个 `ANTHROPIC_*` 键；原来就在的 `permissions`、`hooks`、
   `statusLine`、`ANTHROPIC_CUSTOM_HEADERS` 等一律原样保留。
   如果你的 `model` 是 `sonnet` 这类别名，会一起钉成我们的模型，免得 Claude Code
   去请求网关里不存在的别名。
   还原时**只删值仍等于本工具写入的那份**的键 —— 你自己改过的会被保留。
2. **后台服务**：macOS 写 `~/Library/LaunchAgents/dev.claude-code-openai-bridge.plist`
   并 `launchctl bootstrap`；Linux 写 `~/.config/systemd/user/` 下的 unit 并
   `systemctl --user enable --now`。模式、上游、模型都写进服务环境，
   所以服务不带参数启动也能拿到同一份配置。
3. **`~/.claude-code-openai-bridge/`**：登录凭据（0600）、`install.json`（记着
   写了哪些键、装了什么服务，供还原用）、服务日志。

### 模型 ID 后面的 `[1m]`

`[1m]` 是 Claude Code 自己的标记，表示「这个模型按 1M 上下文登记」。不带它，
未识别的网关模型会按 200k 压缩上下文，启动时还会警告一句。向导写的是
`workbuddy/deepseek-v4.1-flash[1m]` —— Claude Code 发请求前会把后缀剥掉，
所以上游收到的是干净的 ID。

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
- 只覆盖对话与模型目录。**每日签到领积分不在范围内**。

## 测试

```bash
node --test
```

21 条用例，全部离线：翻译层纯函数、网关模式端到端（假上游 SSE）、直连模式登录轮询
（含 `11217` 尚未就绪）、模型目录合并与过滤、流内策略拦截如实上报、指纹改写，
以及安装器的「合并而非覆盖 / 写前备份 / 只还原自己写的键 / 服务文件内容」与
交互组件的按键行为。

真机验证过（2026-10，本机）：真 `claude` CLI（2.1.301）经本桥拿到回答；
网关模式对真实上游的非流式 / 流式 / 工具往返；两条产品线的 `/v2/plugin/auth/state` 取址；
launchd 自启与 `/health`。

## 免责声明

本项目通过**用户自己的账号凭据**访问官方客户端使用的接口，仅供个人学习与自用。
请自行判断这是否符合你所在地区与服务条款的要求；不要把凭据提交进任何仓库，
也不要把本桥暴露到公网。协议细节参考了
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）中被实测
验证过的逆向结论，本项目的实现与之独立。

## License

MIT
