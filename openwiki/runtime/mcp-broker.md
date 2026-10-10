---
type: subsystem
title: MCP 请求代理（broker）
description: broker 如何应答宿主的 initialize / tools/list / tools/call：快照快路径的触发条件、排队与超时预算、错误映射为工具结果、冷却熔断与恢复、清单漂移告警与宿主断开时的清理。
tags: [broker, mcp, queue, circuit-breaker, error-mapping]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# MCP 请求代理（broker）

`createBroker` 是宿主与后端之间的全部中介。它的存在理由写在模块注释里：**能用录下来的清单回答时就用**，握手因此是毫秒级而不是 openwiki 的导入时间；需要真活儿的事情排队等后端起来；每一次失败都以宿主能据以行动的有界工具错误呈现。

## 三个时间预算

```js
DEFAULT_QUEUE_TIMEOUT_MS        = 120000;  // 等后端就绪
DEFAULT_CALL_DEADLINE_MS        = 180000;  // 单次 tools/call
DEFAULT_UNAVAILABLE_COOLDOWN_MS = 30000;   // 后端启动失败后的熔断窗口
```

三者是独立的：排队超时说明后端起得太慢，调用超时说明后端太慢，熔断说明后端根本起不来。混成一个预算就没法给出可执行的建议。

## 请求分派：什么时候走快照

`handleClientMessage` 按消息形态分流。

**通知（无 `id`）** 转发给当前会话；后端没就绪就 debug 记一句后丢弃——通知没有应答，丢弃不影响宿主状态机。

**`initialize`**：有 manifest 就直接用快照应答，**不起后端**。没有 manifest 才走 `dispatch`。

**`tools/list`**：条件是 `manifest && !supervisor.current()`——**既要有快照，也要求后端此刻还没启动**。后端一旦起来，就以真实的 `tools/list` 为准。这个分支的取舍是「速度 vs 准确」：宿主连接初期后端还没起，快照足够；后端都起来了还拿快照给一份可能过时的清单没有任何好处。

**`tools/call`**：永远 `dispatch`，没有例外。

**未知方法**：回 `-32601 Method not found`。**非 JSON 行**（行解析器标记的 `invalid`）：debug 记一笔后忽略。

## dispatch：排队与错误映射

`dispatch` 先问熔断，再等 `ensureReady()`。

### 熔断但不闩死

启动失败被记住**只有 30 秒**。注释解释了为什么不做成永久闩死：openwiki 的冷导入在被杀毒软件扫描的文件系统上可能超过任何固定预算，永久闩死会让一个可能持续数小时的宿主会话里后续每一次调用都失败。过期后重试。

`now` 是注入的时钟，测试推进它就能验证恢复行为而不必真的等 30 秒。

### 失败被映射为工具结果

`withDeadline` 与 `withCancellation` 把排队与调用包成有界 promise，失败按原因分派文案：

| 失败原因 | 判定依据 | 工具结果文案 |
| --- | --- | --- |
| 排队超时 | 消息等于 `QUEUE_TIMEOUT` | `openwiki 后端排队超时，请重试` |
| 宿主断开 | 消息等于 `CANCELLED` | `宿主已断开，调用已取消` |
| 调用超时 | 消息等于 `CALL_DEADLINE` | `openwiki 后端调用超时，请重试` |
| 其他启动失败 | 记 `unavailable` 与 `unavailableAt` | `openwiki 后端不可用：<detail>` |
| 调用期其他失败 | `session.isRunning()` 判断是否崩过 | `已重启，请重试` / `调用失败：<message>` |

**所有失败都包成带 `isError: true` 的工具结果，而不是 JSON-RPC error。** 这是一个有意的选择：工具错误宿主能直接展示给用户并据此重试或改参数，JSON-RPC error 往往只被记进宿主日志，用户看不到。

「后端已重启，请重试」这个措辞需要 `session.isRunning()`：只有确认进程确实死了才这么说，否则是误导。

### dispatchSafely：防崩溃的最后一层

`dispatch` 是 async 且不 await 调用，一个内部异常就会变成未处理 rejection——**在 Node 22 上那会终止整个 broker 进程，宿主直接丢掉整个 MCP 会话**。`dispatchSafely` 包一层 catch，把内部错误转成工具结果；连发送本身失败（宿主管道已断）也被吞掉，因为那时已经没有可报告的对象。

## 清单漂移检测

`toolsFromBackend` 在拿到真实清单后与快照比对，只在第一次命中时告警（`mismatchWarned` 保证不刷屏），提示重新生成 manifest，**但清单仍以后端为准**返回给宿主。

`sameToolList` 不只比工具名，还比 `inputSchema` 的 JSON 串。理由写在注释里：**broker 把录下来的 `inputSchema` 交给了宿主，所以 schema 变了就是漂移，即使工具名没变。**

## 宿主断开时的清理

`handleClientEof` 做三件事：

1. 清掉所有 `timers`，排队与调用 deadline 全部作废；
2. `cancel()` 所有在途请求（`withCancellation` 记录的 `inFlight`）；
3. `supervisor.stop()`。

第 2 步的价值在于让等待中的 promise 立刻以「宿主已断开」结束，而不是吊到进程死亡。

## 相关页面

- [openwiki 后端会话与监管](./backend-supervisor.md)
- [工具清单快照（manifest）](./tool-manifest.md)
- [JSON-RPC 行传输与日志纪律](./protocol-and-logging.md)
