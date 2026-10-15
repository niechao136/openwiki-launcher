---
type: command-surface
title: ow 透传：把 openwiki CLI 交给用户
description: owl ow 与 ow 的纯透传语义：为何必须用 sourceCliJs、stdio 继承与信号/退出码透明、解析与启动失败的软着陆，以及与 owl mcp 的边界。
tags: [cli, passthrough, ow, openwiki-cli, tty]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-1d006dc0f52ea2a9b05d1f4c
    resource: repo://bin/ow.mjs
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-7280412b8f4838253e82e406
    resource: repo://src/openwiki-cli.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# ow 透传：把 openwiki CLI 交给用户

## 三个命令的关系

package.json 的 `bin` 注册三个名字，覆盖两类职责：

| 命令 | 入口文件 | 职责 |
| --- | --- | --- |
| `openwiki-launcher` | `bin/openwiki-launcher.mjs` | 全名；launcher 的全部命令 |
| `owl` | `bin/openwiki-launcher.mjs` | 与全名完全等价的短命令（同一入口文件） |
| `ow` | `bin/ow.mjs` | **纯透传** openwiki CLI，不经过 launcher 的命令分发 |

`owl ow <参数…>` 与 `ow <参数…>` 等价：前者走 `src/cli.mjs` 的 `ow` 分支，后者走 `bin/ow.mjs`，两者最终都调用 `src/openwiki-cli.mjs` 的同一个 `runOpenwikiCli` 内核。透传用的 openwiki 就是 launcher 自己管理的那一份（当前激活版本优先，出厂依赖兜底），**不需要另外 `npm install -g openwiki`**。

## 纯透传语义

launcher 的命令空间绝不与 openwiki 的子命令混合：`ow` 后面的参数**一个都不解析**，原样转发给 openwiki CLI。例如：

```sh
ow visualize --no-open --port 3939   # 本地可视化服务器，不自动开浏览器
ow link ../another-repo              # 把另一个仓库链进来
ow auth configure openai             # 配置 provider
ow                                    # 裸跑进入 openwiki 交互式 agent
```

这条规则没有例外——`ow` 不拦截任何子命令（包括 `ow mcp`，见下文）。

## 为什么必须用 sourceCliJs

`resolveOpenwikiRuntime` 返回两个入口字段，透传必须用后者：

- `runtime.cliJs`：**运行时入口**。bundle 就绪时它指向 `versions/<版本>/bundle-<hash>.mjs`（MCP 后端的单文件打包产物）；拿它跑 `visualize` 会在参数解析处直接崩——bundle 只有 MCP 服务器能力，没有 CLI 命令分发。
- `runtime.sourceCliJs`：**源码入口** `dist/cli/cli.js`，永远指向完整的 openwiki CLI。

正因如此，`sourceCliJs` 在解析层被单独保留：MCP 路径可以吃 bundle 的加速，CLI 透传永远走源码。详见[后端单文件打包（bundle）](../runtime/backend-bundle.md)。

## stdio 继承、信号与退出码

透传的 spawn 形式是：

```js
spawnFn(process.execPath, [runtime.sourceCliJs, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});
```

三个设计点：

1. **stdio 继承而非管道包装。** openwiki 的交互式 agent（ink 渲染）与 `visualize` 的本地服务器都要求真实 TTY，任何管道包装都会破坏它们。
2. **信号转发。** POSIX 上父进程收到 `SIGINT` / `SIGTERM` 后显式转发给子进程；Windows 上同一控制台进程组会天然同时收到，`child.kill` 不支持该信号时静默忽略。转发器在子进程退出后移除，不残留监听器。
3. **退出码透明。** 子进程 `close` 的事件值就是返回值（`exitCode ?? 1`，被信号终结时为 1）；`bin/ow.mjs` 把它赋给 `process.exitCode`。

## 失败软着陆

两类失败都不抛异常栈，而是给出可操作的中文提示并返回 1：

- **解析失败**：包内 openwiki 不可读（安装不完整或被清理过）时提示「未找到可用的 openwiki：请重跑安装器（`owl install`）或用 `owl warm` 物化默认版本」；其他解析错误提示可用 `owl install` 修复。
- **spawn 失败**：入口在解析与 spawn 之间被删/被锁（并发 update、Defender 扫描）时 Node 会 emit `error` 事件——没有监听器就是未捕获异常、用户拿到裸栈；这里同样软着陆为「启动 openwiki 失败：…（可跑 `owl install` 修复）」并返回 1。

## ow mcp 的边界

`ow mcp` 跑的是 openwiki 的**直连** MCP 服务器：冷启动要 30 到 50 秒，初始化超时较短的宿主会直接报 `-32001`。宿主 MCP 配置**不要**指向 `ow mcp`，要指向 `owl mcp`（broker，毫秒级握手）。`owl help` 在 ow 透传那一行专门标注了这条警示；`ow` 的纯透传语义意味着它不会替你判断或拦截——参数只属于 openwiki。

## 相关页面

- [命令行接口与 doctor 自检](./cli-and-doctor.md)
- [后端单文件打包（bundle）](../runtime/backend-bundle.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [快速上手](../quickstart.md)
