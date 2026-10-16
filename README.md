# claude-code-openai-bridge

让 **Claude Code CLI** 用上 **WorkBuddy（国内版 CodeBuddy / 国际版）** 的本地反代。

Claude Code 只会说 Anthropic 的 Messages 协议，而 WorkBuddy 的接口是 OpenAI 风格
的 `/v2/chat/completions`。这个桥就干这一件事：**进门说 Anthropic，出门说 OpenAI**，
顺手把登录、续期、模型目录都办了。零依赖，只用 Node 内置能力。

```
Claude Code CLI ──► 本桥 127.0.0.1:8788 ──► WorkBuddy 国内版 copilot.tencent.com
   (Anthropic            /v1/messages            (OpenAI 形状 SSE)
    Messages)            ⇄ 翻译             ──► WorkBuddy 国际版 www.workbuddy.ai
```

## 它解决什么

- Claude Code 需要 `ANTHROPIC_BASE_URL` 指向一个说 Anthropic 协议的服务；
- WorkBuddy 的客户端只提供 OpenAI 形状的接口，而且**必须登录**（外部链接轮询式
  OAuth，令牌 5 分钟轮询到手，之后靠 refresh token 静默续期）；
- 这个桥两件事都做了：`login` 一次，然后 Claude Code 直接指向它。

两条产品线可以**同时挂载**：模型 ID 带产品前缀（`cn/…`、`intl/…`），换一个
`ANTHROPIC_MODEL` 就换了产品线。

## 快速开始

需要 Node ≥ 18.17（用到内置 `fetch`）。不需要 `npm install`，没有依赖。

```bash
git clone https://github.com/9Ashwin/claude-code-openai-bridge.git
cd claude-code-openai-bridge

# 1. 登录（会打开浏览器；不带产品名时国内版与国际版都登）
node cli.mjs login

# 2. 看看有哪些模型 ID 可用
node cli.mjs models

# 3. 起反代
node cli.mjs --port 8788
```

然后让 Claude Code 接上（KEY 随便填一个非空值即可，除非你起了 `--api-key`）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_AUTH_TOKEN=any-non-empty
export ANTHROPIC_MODEL=cn/deepseek-v4.1-flash
export ANTHROPIC_SMALL_FAST_MODEL=cn/deepseek-v4.1-flash
claude
```

`ANTHROPIC_SMALL_FAST_MODEL` 也要设：Claude Code 的后台小任务（起标题、判断意图）
走的是它，不设会去请求一个不存在的 Claude 小模型。设成同一个模型最省事。

想长期生效，把这几行写进 shell 配置或 Claude Code 的 `settings.json`。

## 三种用法

### 1. 直连腾讯产品（默认）

```bash
node cli.mjs login cn      # 只登国内版（CodeBuddy，copilot.tencent.com）
node cli.mjs login intl    # 只登国际版（WorkBuddy，www.workbuddy.ai）
node cli.mjs status        # 看登录状态与令牌有效期
node cli.mjs               # 两条都挂
```

凭据存在 `~/.claude-code-openai-bridge/credentials.json`（权限 0600），
与官方客户端、DSH 的数据目录互不干扰。到期前 2 分钟自动续期；被上游回 401
时也会续期后重试一次。

### 2. 网关模式：转发给任意 OpenAI 兼容端点

```bash
node cli.mjs --upstream http://127.0.0.1:8326 --model workbuddy/deepseek-v4.1-flash
```

只要给了 `--upstream` 就是网关模式。这条路径适合已经有一个 OpenAI 兼容网关
（[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的渠道网关、
LiteLLM、Ollama、vLLM……）的场景：登录与账号轮换由那边负责，本桥只做协议翻译。

```bash
# 密钥未显式给出时，会依次读 DSH_OPENAI_GATEWAY_API_KEY、
# $DSH_HOME/openai-gateway/api-key
node cli.mjs --upstream https://api.deepseek.com --upstream-key sk-xxx --model deepseek-chat
```

### 3. 多账号 / 多云混合

`--map` 把 Claude 的模型名直接钉到具体模型，避免每次都去猜：

```bash
node cli.mjs --map "claude-opus-4-5=cn/deepseek-v4.1-flash,claude-haiku-4-5=intl/hy4-preview-f"
```

## 命令与配置

| 命令 | 说明 |
| --- | --- |
| `claude-code-bridge` | 启动反代（默认子命令） |
| `login [cn\|intl]` | 登录；不带参数两条产品线都登 |
| `status` | 登录状态、令牌有效期 |
| `models` | 列出可用模型 ID（直连模式带窗口 / 输出上限 / 档位信息） |

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
| `--upstream` | `UPSTREAM_BASE_URL` | `http://127.0.0.1:8326` | 网关模式的 OpenAI 兼容上游 |
| `--upstream-key` | `UPSTREAM_API_KEY` | 读 DSH 网关密钥 | 上游密钥 |
| — | `BRIDGE_HOME` | `~/.claude-code-openai-bridge` | 凭据目录 |

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

请求方向：

| Anthropic | OpenAI |
| --- | --- |
| `system`（字符串或块数组） | 首条 `{role:'system'}` 消息 |
| `text` / `image` 块 | `{type:'text'}` / `{type:'image_url'}` 部分 |
| `tool_use` 块 | 助手消息上的 `tool_calls[]` |
| `tool_result` 块 | `{role:'tool', tool_call_id}` 独立消息（排在同轮文本之前） |
| `tools[].input_schema` | `tools[].function.parameters` |
| `thinking.budget_tokens` | `reasoning_effort`（≥8192 → high，≥2048 → medium，否则 low） |
| `stop_sequences` | `stop` |

响应方向：`stop_reason` 按本轮是否出现工具调用决定（有则 `tool_use`），否则
`length → max_tokens`、其余 `end_turn`；流式按
`message_start → content_block_start → content_block_delta → content_block_stop →
message_delta → message_stop` 成帧，工具参数走 `input_json_delta`，
响应头发出去之后的失败走流内 `error` 事件。

直连模式额外做四件官方客户端才做的事：

1. **首条消息必须是 `system`** —— 国际版网关对首条是 user 的请求直接回
   `400 + code 11128`，所以缺了就补一条。
2. **`prompt_cache_key`** —— 同一个 system 前缀稳定命中服务端前缀缓存
   （官方客户端实测同一请求开了缓存计费差约 17 倍）。
3. **按模型族选 `User-Agent`** —— 国际版后台按这组分列「使用端」，`glm-*` /
   `hy*` / `kimi-*` / `minimax-*` 这几条国内模型线要用国内客户端形态发。
4. **DeepSeek 系要显式开思考** —— 这一族只有 `reasoning_effort` 生效，
   `thinking` 字段单独不生效，两个都带才稳定返回 `reasoning_content`。

## 已知限制

- **思考默认不渲染给客户端**。`reasoning_content` 只在 `--thinking` 时变成
  `thinking` 块；Claude Code 对无签名的 thinking 块容忍度未知，默认不冒险。
- **`tool_choice` 不下发**。官方客户端从不发这个字段，转发一个没被验证过的参数
  只会换来 400；`tool_choice: none` 时本桥会连工具定义一起摘掉。
- **图片只在 user 消息里保证可用**。工具结果里的图片会按 OpenAI 的多部分格式发出，
  标准 OpenAI 服务端可能不接受（WorkBuddy 的接口接受）。
- **非流式请求在上游仍然是流式**（这条上游没有非流式对话接口），由本桥归并成
  一个 JSON 返回。
- **`count_tokens` 是估算**：按 4 字符 ≈ 1 token，图片记固定值，不加载分词器。
- 只覆盖对话与模型目录。**每日签到领积分不在范围内**（那需要另一套接口）。

## 测试

```bash
node --test
```

14 条用例，全部离线：翻译层的纯函数断言、网关模式的端到端（假上游 SSE）、
直连模式的登录轮询（含 `11217` 尚未就绪）、模型目录合并与过滤、流内策略拦截的
如实上报、门禁与存活探测。

真机验证过的部分（2026-10，本机）：网关模式对真实上游的非流式 / 流式 / 工具往返；
国内版与国际版的 `/v2/plugin/auth/state` 取址。

## 免责声明

本项目通过**用户自己的账号凭据**访问官方客户端使用的接口，仅供个人学习与自用。
请自行判断这是否符合你所在地区与服务条款的要求；不要把凭据提交进任何仓库，
也不要把本桥暴露到公网。协议细节参考了
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）中被实测
验证过的逆向结论，本项目的实现与之独立。

## License

MIT
