---
type: subsystem
title: JSON-RPC 行传输与日志纪律
description: stdio 上换行分隔 JSON 的分帧实现，以及 stdout 只属 MCP、诊断全走 stderr 的纪律。
tags: [jsonrpc, stdio, framing, logging]
sources:
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-99572b72c15bb79b9392bda4
    resource: repo://src/jsonrpc.mjs
  - id: openwiki-source-74a5034640883b216f98ee8d
    resource: repo://src/log.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
---

# JSON-RPC 行传输与日志纪律

## 传输形态

`src/jsonrpc.mjs` 服务于每一个 stdio MCP 界面，宿主侧与后端侧共用同一套。线格式是换行分隔的 JSON，一条完整的 JSON-RPC 消息占一行。因此解析器必须容忍任意分块边界，因为宿主或后端可能在任何位置切断一条消息。

## createLineParser

解析器用增量缓冲加按换行切分：每次 `write` 先把 chunk 追加到缓冲，再循环找出所有换行位置切出一条行交给处理函数。因此一条消息分三次到达也能正确拼回。

`end()` 负责冲刷无换行尾包。宿主在管道关闭前发出的最后一条消息常常没有结尾换行，`runMcpCommand` 在拆掉 broker 之前先调 `parser.end()`，正是为了不丢掉这最后一条。

`formatMessage` 反方向把消息序列化成单行加换行，永远不产生跨行输出。

## handleLine 的两处反直觉设计

处理函数先剥尾部的回车符（容忍 CRLF）、再 `trim`，空行直接返回。然后是两条关键规则。

### 坏行不中断流

JSON 解析失败时不抛错、不退出，而是把这一行包成 `{ invalid: line }` 交给消费者，然后继续处理后续行。

注释写明了理由：一行不是 JSON 就不可能是协议消息，但因此丢掉后面的消息会静默破坏整个会话。调用方拿到 `invalid` 后通常只 debug 记一笔（broker 对宿主侧、后端会话对后端侧），会话继续。

这个标记形状还有诊断价值：干净的后端不会输出非 JSON 行，所以它同时是「起的进程不对」的信号——后端会话因此对第一行 `invalid` 发 warn 而不是 debug。

### 消费者异常必须在 parse guard 之外

合法消息的投递写在 `try/catch` **外面**。

如果在 `try` 内部投递，一个抛错的消费者会让已经解析成功的结果被当成解析失败处理，于是一条完全合法的消息被误报为 `invalid` 行。后果是 broker 丢掉一个真实请求，宿主那边一直等不到应答——一个由内部异常伪装成协议损坏的故障，排查成本极高。

## 日志纪律

模块头的注释就是全部理由：**stdout 属于 MCP 线，多一个杂字节就会破坏会话。** 因此 info / warn / error / debug 全部写 stderr，统一 `[launcher]` 前缀。

| 级别 | 行为 |
| --- | --- |
| `info` | `[launcher] <消息>` |
| `debug` | `[launcher] debug: <消息>`，受 `LAUNCHER_DEBUG=1` 开关控制 |
| `warn` | `[launcher] warn: <消息>` |
| `error` | `[launcher] <消息>`，无额外前缀且不受 debug 开关影响 |

`error` 不受开关控制是刻意的：诊断信息不能因为用户没开 debug 就消失——出问题时用户能看到的往往只有这一条通道。

日志工厂的 sink 与 debug 开关都是入参，测试可以注入内存 sink 断言输出。

## 与进程生命周期的关系

stdio 上的 MCP 服务需要幂等收尾：end、close、SIGTERM 与 SIGINT 全部指向同一个带闸门的收尾函数，先 `parser.end()` 冲刷尾包再 `handleClientEof()`；exit 时兜底停止后端监管器。stdin 与 stdout 的 `error` 事件只 debug 记录，不让宿主拆管道变成未捕获异常。

## 相关页面

- [MCP 请求代理（broker）](./mcp-broker.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
