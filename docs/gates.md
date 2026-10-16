# 两条门禁：事实、证据与复验方式

这个项目的功能内核压在两条**别人家的规则**上：腾讯的内容风控和 OpenCode 免费档的
报文形状门禁。它们都可能在没有任何预告的情况下改变。

所以这份文档不写猜测，只写**可复验的事实**：每条规则是什么、我们是怎么知道的、
失效时是什么症状、以及怎么当场复验。

```bash
ccb doctor          # 逐项重推两条门禁，并体检本地配置
```

doctor 会先发一次完整形状确认能过，再**逐项去掉一个要件**确认「这一条确实还是必填」。
上游放松或收紧，都会在下一次 doctor 里显形：完整形状过不了 → 收紧；某个变体不再被拒
→ 那一条已放松。

---

## 一、腾讯内容风控（`400` + `code 11128`）

**症状**：整轮请求被拒，报文里是

```
{"code":11128,"msg":"请求被拦截，… Illegal API invocation from an unapproved channel"}
```

客户端侧只看到一句「用不了」，很容易误判成「国际版挂了」或「额度用完了」。

**判据**：逐字符的**字面量**匹配，不是关键词。少一个词、多一个空格、换一个词都不拦
（所以不要把这些规则「泛化」成正则关键词 —— 泛化会误伤无关内容，而真正的判据本来就是整句）。

| # | 被拦的字面量 | 处理 | 证据 |
| --- | --- | --- | --- |
| 1 | `x-anthropic-billing-header:` 开头的**整行** | 整行删除 | 2026-10-16：任意值都拦（键名是判据，值无关），删掉后 200 |
| 2 | `You are Claude Code, Anthropic's official CLI for Claude` | 改成 `…, an official CLI for Claude` | 2026-10-16：两个片段**同现**才拦；改写后仍保留身份句 |
| 3 | `Main branch (you will usually use this for PRs)` | 改成 `Main branch (PRs usually go here)` | 2026-10-16：Claude Code **只在 git 仓库里**注入该句，整句拦；改写后 200（`intl/deepseek-v4.1-flash`、`cn/hy4-preview` 等四个模型实测） |

补充事实：

- **只改 system**：同一句出现在 user / tool 里实测不拦；
- **只对腾讯系模型生效**：`cn/…`、`intl/…`（前缀判别见 `src/fingerprint.mjs` 的 `isTencentModel`）；
- 非 git 目录不注入第 3 条，所以同一条命令在 `/tmp` 正常、在项目目录里 400 —— 这个
  差异本身就说明问题出在 Claude Code 注入的上下文里。

**复验**：`ccb doctor` 会把这三条字面量拼进一次最小请求真发出去。额度/频率受限会单独
报出来（那不是门禁问题）。

**加新规则的流程**：

1. 抓下**真实请求体** —— 用一个本地假上游接住 Claude Code 的请求最省事；
2. 二分定位到具体那一行（删一半看还拦不拦）；
3. 确认它是字面量判据（改一个词就不拦）后，加进 `src/fingerprint.mjs` 的 `RULES`；
4. 把「日期 + 判据 + 证据」补进上面那张表。

---

## 二、OpenCode 免费档的报文形状门禁

**症状**：`403` + 

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

匿名（`Authorization: Bearer public`）能列到 88 个模型，但**标准 OpenAI 请求会被拒** ——
它按报文形状判断调用方是不是官方客户端。

| 要件 | 事实 | 证据 |
| --- | --- | --- |
| `stream: true` | 必填 | 2026-10-16：`false` → 403 |
| `tools` 含 `bash` / `glob` / `grep` / `read` 四个**小写** function，各自 `parameters` 至少声明一个 property | 必填 | 同上：去掉 → 403 |
| 会话 id = `ses_` + 12 位小写 hex + **14** 位 base62（尾段总长 26） | 必填，且只验形状 | 同上：写成 38 位 → 403；12+14 通过 |
| `x-opencode-project`（40 hex）、`x-opencode-session`、`x-opencode-request`（`msg_` 形状）、`x-opencode-client: cli`、`User-Agent: opencode/<版本>` | 按官方客户端形状发送 | 2026-10-16 |
| `x-opencode-session-id`（与 `x-opencode-session` 同值） | **实测当前非必填**（去掉仍 200），但仍照发 | 2026-10-16 `ccb doctor` 判成 `relaxed` |

⚠️ **尾段长度是最容易搞错的一点**：官方 `id/index.ts` 里的 `LENGTH = 26` 是**尾段总长**
（12 hex + 14 base62），把它当成随机段长度就会得到 38 字符，然后一律 403。

⚠️ **反例陷阱**：`ses_` + 26 个 `0` **形状是对的** —— `0` 既是 hex 字符也是 base62 字符，
所以它符合 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，真假门禁都不会拒。拿它当「错形状」的
反例会得到假结论（这个坑在 `doctor` 的探针里踩过一次）。

**工具名冲突怎么抹平**：Claude Code 自带 `Bash` / `Read`，门禁要的是小写四个名字，
而且它不一定声明 `glob` / `grep`。处理方式是：

- 调用方声明过的（不分大小写）→ 出站改小写，响应里**改回原名**（否则 Claude Code
  认不出 `bash` 这个工具）；
- 调用方没声明的 → 补一个「摆设」桩，并把模型对桩的调用**整条丢弃** —— 那是
  Claude Code 执行不了的工具名，转发过去只会变成一条无从处理的错误。

**复验**：`ccb doctor` 逐项重推（完整形状 + 四个变体）。

---

## 三、OpenCode Go 套餐（认证通道，`/zen/go/v1`）

与免费档**不是同一条路**：端点不同、模型清单不同（Go 37 个）、规矩也不同。
DSH 桌面端的 `cordis.yml` 里 `opencode-go` 就是这套配置（`apiKeyEnv:
OPENCODE_GO_API_KEY`、`baseURL: https://opencode.ai/zen/go/v1`、
`headers: { x-opencode-session: <uuid> }`）。

| 要件 | 事实 | 证据 |
| --- | --- | --- |
| `Authorization: Bearer oc_sk_…` | 必需 | 2026-10-16：无头、乱写 key 都 401 |
| `x-opencode-session` | **必需**，值随意（UUID 或 `ses_` 形状都收） | 2026-10-16：缺 → `400 MissingSessionID`（"cannot be routed efficiently"）；两种值都 200 |
| 免费档那套形状（5 个客户端头、四个小写工具、`ses_` 形状） | **不需要** | 同上：裸 OpenAI 报文直接 200 |
| `reasoning_effort` | `low` / `medium` / `high` / `max` / `minimal` 都 200；**`off` 被拒** | 2026-10-16：`off` → 422，且文案是误导性的 `Endpoint is unavailable` |

补充事实（都是实测撞出来的）：

- **deepseek 这族默认就思考**：`max_tokens` 给小了（实测 48 与 400）可能整段额度被
  `reasoning_content` 吃掉，正文为空、`stop_reason: max_tokens` —— 看着像桥坏了，
  其实不是；
- **`high` 偶发 503**：首次实测撞到一次，随后连测 3 次都 200，属上游抖动，重试即可；
- 能力元数据（窗口 / 输出上限 / 视觉）同样取自 models.dev：`deepseek-v4.1-flash` =
  1M 窗口 / 384k 输出，与 DSH 配置里手写的值一致。

**复验**：`ccb doctor` 的「OpenCode Go 套餐（认证通道）」一节会重推这三条
（带会话头的最小对话、不带会话头应被拒、模型清单要 key）。

---

## 四、失效时是什么样

| 失效点 | 症状 | 响亮吗 |
| --- | --- | --- |
| 腾讯内容风控加了新规则 | `400` + `11128`，整轮失败 | 响亮，但客户端文案容易把人带偏 |
| 免费档门禁收紧 | `403` + `FreeTierError` | 响亮 |
| 免费档门禁放松 | 探针里某个变体不再被拒 | 只在 `ccb doctor` 里显形 |
| 模型清单变了 | 个别模型 400/401（例如拿匿名 key 打付费档） | 响亮 |
| 上游返回了没见过的新形状 | 翻译层可能**静默丢字段** | **不响亮** —— 需要看 `~/.claude-code-openai-bridge/bridge.log` |

最后一行是这个项目最需要盯的地方：前四条都会大声失败，只有「新形状」会安静地少点东西。
发现回答缺字段时的第一动作是看 bridge.log 里那一轮的 `in= / out=` 与上游原始帧。

---

## 五、怎么自己加一条探针

`src/doctor.mjs` 里的探针都是纯函数 + 可注入的 `fetchImpl` / 服务器地址，所以能离线测：

- `probeOpencodeGate({ baseUrl, fetchImpl })` —— 返回每一行的 `verdict`：
  `pass`（该拒的被拒）/ `relaxed`（该拒的没拒）/ `fail` / `inconclusive`；
- `probeTencentFingerprint(product)` —— 走**本工具自己的翻译层 + 改写器**再真发一次，
  返回 `{ ok, blocked, limited }`；
- `probeOpencodeGo()` —— 认证通道的三条（会话头必填、key 必需、能出字），返回带
  `verdict` 的行；未配置 key 时整节跳过；
- `localIssues({ settings, serviceEnv, serviceCli, runningCli, healthOk })` —— 纯函数，
  喂假数据即可断言（密钥不一致、`model` 与 `ANTHROPIC_MODEL` 不一致、服务跑着别的代码、
  没人监听这四类都覆盖到了）。
