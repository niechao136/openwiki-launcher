---
type: subsystem
title: openwiki 后端会话与监管
description: launcher 如何拉起并监管 openwiki 后端子进程：spawn 形式、就绪握手、请求 id 关联、单飞启动、重试退避、崩溃重启、stderr 诊断与孤儿进程防御。
tags: [backend, supervisor, process, lifecycle]
sources:
  - id: openwiki-source-814aeea6bc63a6d45d6c643a
    resource: repo://src/backend.mjs
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-ae090dd614b550bc566d7b91
    resource: repo://src/commands/warm.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
generated: { by: "codebuddy", at: "2026-10-12T05:45:32.864Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-12T05:45:32.864Z
---

# openwiki 后端会话与监管

`src/backend.mjs` 分两层：`createBackendSession` 管**一个**后端进程会话，`createBackendSupervisor` 管**多个宿主共享的**生命周期。

## spawn 形式：为什么不用可执行文件

```js
spawnFn(process.execPath, [cliJs, "mcp", "--host", hostId], {
  env: { ...process.env, ...env },
  stdio: ["pipe", "pipe", "pipe"],
});
```

**始终用 node 的绝对路径加 CLI 的绝对路径**，而不是直接执行 `openwiki`。原因很具体：Windows 上 nvm 生成的 `openwiki.exe` shim **不转发 stdio**——对宿主来说，后端看起来和挂死一模一样。同理，解析 openwiki 依赖只认本包根下的 `versions/` 与 `node_modules`（见[版本目录与生效指针](../versions/version-store.md)），解析不到就抛 `OpenwikiNotFoundError`，**绝不猜测全局安装路径，也绝不向上遍历目录树**：猜错会启动错误的后端或干脆不启动，用户看到的仍然是超时而不是诊断信息。

会话层**不做任何依赖解析**：`cliJs` 是入参。谁创建 supervisor，谁负责先用 `resolveOpenwikiRuntime` 把它算出来——因此后端跑的是 `versions/active.json` 指针指向的版本，指针缺失或损坏时是包内出厂依赖。`LAUNCHER_BACKEND_CLI` 可覆盖这个入参，`mcp` 与 `warm` 两个命令都支持；它存在的意义是测试（`test/fixtures/fake-openwiki.mjs`）与排障，生产路径不应依赖它。

三个 stdio 管道，`env` 在 `process.env` 之上叠加传入的覆盖项。

## 会话层：握手、请求关联、诊断

### 就绪握手

会话创建后立即发起 `initialize`（`protocolVersion: "2024-11-05"`；`clientInfo` 的 `name` 固定为 `openwiki-launcher`，`version` 取自本包 package.json——openwiki 会把它写进 run metadata，写死的旧版本号会让排查的人先怀疑 openwiki 的数据），成功后补发 `notifications/initialized`，整个 promise 就是 `ready`。默认 120 秒（`callReadyTimeoutMs`）超时，超时则 `child.kill()`——一个永远不 ready 的后端不如早点杀掉。

### 请求 id 关联

单调递增的 `nextId` 加一个 `pending` Map。`request` 在进程已退出时直接 reject；`notify` 在已退出时静默返回。

后端输出经 `createLineParser` 逐行处理：

- 非 JSON 行 → **只 warn 一次**，之后降为 debug。干净的服务器不会写这种行，所以它是「起的不是 openwiki」的强信号，值得在不开 `LAUNCHER_DEBUG` 的情况下也可见；
- id 无法对应（未知 id）→ 只 debug 忽略；
- 有 `error` 字段 → reject 成 `openwiki mcp 返回错误: <message>`。

### stderr 尾部

只保留最后 8192 字节（`STDERR_TAIL_LIMIT`），同时把每块前 200 字节写进 debug 日志。保留尾部是因为**最常见的启动失败原因（原生模块没构建成功、Node 版本不匹配）只在这个位置说得清**。

### stop 与强杀

`stop()` 先 `SIGTERM`，3 秒后 `SIGKILL`，强杀定时器 `unref()`——不 `unref` 会把事件循环吊住，进程退不出去。

## 监管器层

### 单飞启动

```js
if (session) return Promise.resolve(session);
if (starting) return starting;
```

`starting` 保存进行中的启动 promise。并发调用共享同一次启动，不会 spawn 多个后端。这是 broker 队列场景下的关键：宿主可能在后端 ready 前连打多个 `tools/call`。

### 有限重试 + 固定退避

`maxSpawnAttempts` 默认 2，`retryDelayMs` 默认 1000。理由写在模块注释里：**拿不到应答的宿主本来就会重连，无界重试只会把一次坏安装变成一个看起来卡死的 agent**。

「握手前就死掉」计为**启动失败**而不是运行期崩溃——它消耗一次尝试额度。

启动失败时把错误详情与 stderr 尾部 400 字打到 stderr 再放弃：没有它，坏安装的表现就是宿主那边一片安静，而用户唯一能看到的另一条通道是宿主自己的 MCP 错误文案。

### 崩溃后自动重启

会话 `exited` 后监管器清空 `session` 并广播 `onSessionExit`。下次 `ensureReady()` 会重新启动。broker 在调用失败时用 `session.isRunning()` 判断是不是崩过，据此给宿主「后端已重启，请重试」还是「调用失败」。

### 孤儿进程防御

两处：

1. **启动完成后检查 `stopped`。** 宿主可能在后端还在导入时就断开了。没有这个检查，刚起的进程会活过 broker 成为孤儿，并且继续吊住事件循环。
2. **`ready.catch(() => {})`。** 调用方可能很晚才 `await ready`；挂一个空的 rejection 处理器，既阻止未观测的 rejection 杀掉 broker，又不改变真实消费者拿到的结果。

## 错误类型

`BackendUnavailableError` 携带 `stderrTail`。这个字段是给调用方的诊断通道——`warm` 与 `doctor` 都会在报错时把它打出来。

## 监管器的三个使用方

同一个 `createBackendSupervisor` 被三处复用，`cliJs` 都来自 `resolveOpenwikiRuntime`：

| 使用方 | 行为 |
| --- | --- |
| `mcp` 命令（broker） | `ensureReady()` 由 broker 在首个 `tools/call` 或连接预热时调用；崩溃后 `onSessionExit` 通知 broker |
| `warm` 命令 | `ensureReady()` 成功即 `stop()`，外面再包一层 60 秒超时（`withTimeout`），失败返回 1 |
| `doctor` 命令 | `ensureReady()` 后请求 `tools/list` 与 manifest 比对，`finally` 中必定 `stop()` |

`LAUNCHER_BACKEND_CLI` 可覆盖 `cliJs`，`mcp` 与 `warm` 两个命令都支持。它存在的意义是测试（`test/fixtures/fake-openwiki.mjs`）与排障，生产路径不应依赖它。

## 相关页面

- [MCP 请求代理（broker）](./mcp-broker.md)
- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [版本命令：check / update / switch / versions](../versions/version-commands.md)
- [系统总览](../architecture/overview.md)
- [测试体系与关键不变量](../testing/test-suite.md)
