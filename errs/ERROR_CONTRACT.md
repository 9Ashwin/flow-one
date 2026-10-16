# 错误契约

这份文档是 `errs` 包的对外承诺。命令边界的**任何**失败都必须是一个 `*errs.Error`；
不是的话（比如裸 `fmt.Errorf`）调用方就只能靠消息文本分支，那等于没有契约。

形状参考 RFC 7807，但为命令行收敛成更小的集合：**Category 是闭集，Subtype 是小写下划线**。

## Problem：一个错误六个字段，分工不许混

| 字段 | 含义 | 谁用 |
| --- | --- | --- |
| `type`（Category） | **稳定分类**，闭集，决定退出码 | 脚本分支、退出码 |
| `subtype` | **稳定细分**，小写下划线，来自闭集合 | 脚本分支、测试断言 |
| `code` | **上游的数字码**（腾讯 `11128`、HTTP 状态码） | 排查上游问题；不承载本程序内部含义 |
| `param` | **只**说明哪一项用户输入不合法（`--port`、`BRIDGE_PORT`） | 提示用户改哪个参数 |
| `hint` | **恢复动作**：下一步该做什么 | 人读输出；**修法写这里，不要写进 message** |
| `message` | 一句话说明发生了什么（可含上游原文） | 人读输出 |

`message` 会被上游文案影响、也可能中英混排，**不要拿它做分支**。要分支就用
`type` + `subtype`（`errors.Is` 已按这两项比较）。

## Category → 退出码

退出码**只由 Category 推导**，不看 subtype、不看 message：

| Category | 退出码 | 什么时候用 |
| --- | --- | --- |
| `validation` | 2 | 用户输入不合法（flag、参数、模型名） |
| `auth` | 3 | 没登录、凭据失效、缺 API key |
| `config` | 4 | 配置缺失或自相矛盾（settings.json、服务文件、账本） |
| `network` | 5 | 连不上、超时、读流出错 |
| `upstream` | 6 | 上游明确拒绝：内容风控、门禁、额度、模型不可用 |
| `internal` | 1 | 本程序自己的 bug（不该发生） |

`validation` 与 `config` 的区别是「谁给的」：**命令行的给 validation，文件里读出来的给 config**。
`network` 与 `upstream` 的区别是「有没有拿到应答」：连不上是 network，拿到了 4xx/5xx 或
上游在流里报错是 upstream。

## 构造

```go
errs.Validation(errs.SubtypeInvalidPort, "端口不合法").WithParam("BRIDGE_PORT")
errs.Auth(errs.SubtypeNotLoggedIn, "WorkBuddy 国内版 未登录").WithHint("flow-one login cn")
errs.Config(errs.SubtypeSettingsMissing, "读不到 settings.json")
errs.Network(errs.SubtypeConnectFailed, "连不上网关").WithCause(err)
errs.Upstream(errs.SubtypeContentBlocked, "请求被拦截").WithCode(11128)
errs.InternalFrom(err)   // 只在「本程序 bug」时用
```

链式方法（都返回同一个 `*Error`，可串）：

- `WithCode(int)`：上游数字码。
- `WithParam(string)`：哪一项输入不合法。
- `WithHint(string)`：恢复动作。
- `WithCause(error)`：原因链，`errors.Unwrap` 能拿到。

## 三条不变式

1. **Subtype 是闭集**：`New` 遇到未声明的 subtype 会 panic（构造期就暴露拼写错误），
   测试里用 `IsDeclared` 断言。新增 subtype 必须同时进 `subtypes.go` 的集合。
2. **包装幂等**：`Wrap` 一个已经类型化的错误会原样返回，不会套第二层
   （否则 `errors.As` 拿到的可能是外层那个信息更少的）。
3. **边界处必须收敛**：`cmd` 层只负责把 `*errs.Error` 渲染成 stderr 上的一行；
   渲染方式由 `--json` 决定，`main` 用 `ExitCode(category)` 退出。

## 输出

默认（人读，stderr）：

```
Error: 端口不合法
  → 用 --port 指定一个空闲端口
```

`--json`（一行信封，便于脚本逐行读）：

```json
{"ok":false,"error":{"type":"validation","subtype":"invalid_port","param":"--port","hint":"用 --port 指定一个空闲端口","message":"端口不合法"}}
```

**stdout 只放成功数据**（模型清单、状态 JSON），进度与告警一律走 stderr ——
这样 `flow-one models --as-json | jq` 永远不会被日志污染。
