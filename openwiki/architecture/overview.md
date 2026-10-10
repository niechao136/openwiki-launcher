---
type: architecture
title: 系统总览：为什么需要 broker 代理
description: openwiki-launcher 解决的问题、两段会话架构、模块职责地图与贯穿全局的设计不变量。
tags: [architecture, mcp, broker, design-invariants]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-cf7067276199e27e6324cc91
    resource: repo://bin/openwiki-launcher.mjs
  - id: openwiki-source-814aeea6bc63a6d45d6c643a
    resource: repo://src/backend.mjs
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-c346a3d078823ecde57ba108
    resource: repo://src/guards.mjs
  - id: openwiki-source-74a5034640883b216f98ee8d
    resource: repo://src/log.mjs
  - id: openwiki-source-841777335cd5bf0a6754a1d9
    resource: repo://src/manifest.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
  - id: openwiki-source-25b67ca644bd99d29a60497f
    resource: repo://src/plan.mjs
  - id: openwiki-source-ab08d4a1ad09c1011d155d01
    resource: repo://src/self-path.mjs
  - id: openwiki-source-a4f5a4545f8074c813e8e76f
    resource: repo://src/skill-install.mjs
  - id: openwiki-source-94ff95c1f11b8b7df6ddb6c1
    resource: repo://src/uninstall.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 系统总览：为什么需要 broker 代理

## 问题：openwiki 冷启动比宿主的 MCP 超时更长

`openwiki mcp` 的 CLI 入口在冷启动时要静态导入整套应用图，Windows 实测需要 30 到 50 秒，热缓存下也约 7 秒。对初始化超时较短的宿主（CodeBuddy 等），这直接表现为 `MCP error -32001: Request timed out`——宿主先放弃，握手失败，工具根本用不上。

根因有两层：一是 openwiki 自身的导入时间；二是 Windows Defender 会对逐文件读取做实时扫描，冷启动更慢。两者都不是宿主配置能调优的。

## 架构：清单快照 + 后台按需启动

launcher 不做 openwiki 的替代实现，而是在宿主与 openwiki 之间插一个零依赖的代理进程，把「需要快」和「需要真」两类请求分开处理。

**第一段：即时应答。** 宿主发来的 `initialize` 与 `tools/list` 由内置快照 `manifest/openwiki-<版本>.json` 直接回答，**不触碰后端**。快照是预先连接真实 openwiki 后端录下来的工具清单，因此握手耗时是毫秒级。

**第二段：按需启动。** `tools/call` 永远走真实后端。后端未就绪时请求排队等待，就绪后透传；后端崩溃会被监管器重启，在途调用收到明确错误而不是无声挂起。

```text
AI 宿主 ──stdio(JSON-RPC)──> openwiki-launcher(broker) ──spawn(node, <abs>/openwiki/dist/cli/cli.js mcp --host <id>)──> openwiki 后端
                                   │
                                   └── manifest/openwiki-<版本>.json （快照，即时应答 initialize / tools/list）
```

快路径与后端之间没有耦合：`manifest` 为 `null` 时（版本不匹配或快照缺失），broker 自动降级为**直通模式**——不再即时应答，改为等待真实后端。宁可慢，也不给宿主一份对不上的工具清单。

## 端到端时序

1. 宿主启动配置里指向的进程：`node <abs>/bin/openwiki-launcher.mjs mcp --host <id>`。
2. `runMcpCommand` 解析 openwiki 运行时，加载匹配版本的快照；快照缺失则不创建 broker，直接把宿主管道直通给真实后端。
3. broker 接管 stdin/stdout：解析 JSON-RPC 行，应答 `initialize`（用快照），应答 `tools/list`（用快照，且仅在后端尚未启动时）。
4. 宿主第一次 `tools/call`：broker 调用 `supervisor.ensureReady()`，监管器用 `process.execPath` 加绝对 `cli.js` 拉起后端，等待 `initialize` 握手完成。
5. 后端就绪后调用透传；期间排队超过上限则返回明确的中文工具错误。
6. 宿主关闭 stdin：`handleClientEof` 清掉所有定时器、取消在途请求、`supervisor.stop()` 终止后端。

## 模块职责地图

按 `src/` 的实际文件划分，而不是照抄目录：

**运行时（MCP 面）**

| 文件 | 职责 |
| --- | --- |
| `src/jsonrpc.mjs` | stdio 上的 JSON-RPC 行分帧与解析 |
| `src/log.mjs` | 日志工厂，全部写 stderr |
| `src/broker.mjs` | 宿主请求代理：快路径、排队、错误映射 |
| `src/backend.mjs` | openwiki 后端子进程会话 + 多宿主共享的监管器 |
| `src/manifest.mjs` | 按版本选取快照；缺失返回 `null` |
| `src/paths.mjs` | 解析被锁版本的 openwiki 依赖与 CLI 入口 |
| `src/commands/mcp.mjs` / `warm.mjs` | 以 MCP 服务器身份运行 / 预热后端 |

**安装器（宿主接入面）**

| 文件 | 职责 |
| --- | --- |
| `src/registry.mjs` | 28 家宿主的统一描述与自校验 |
| `src/targets.mjs` | 作用域解析、目标宿主解析、安装前的快照采集 |
| `src/plan.mjs` | 纯函数决策器：算出每个宿主要做什么 |
| `src/install.mjs` / `uninstall.mjs` | 安装 / 卸载编排、写入、回滚 |
| `src/skill-install.mjs` | skill 包白名单校验、复制、收据与 sha256 |
| `src/ownership.mjs` | 「这条 MCP 条目是不是我们写的」统一口径 |
| `src/mcp-config.mjs` | 三种宿主配置格式的精确读写 |
| `src/guards.mjs` | 系统目录 / 主目录护栏 |
| `src/backup.mjs` | 同目录备份与回滚 |

**入口与命令**

| 文件 | 职责 |
| --- | --- |
| `bin/openwiki-launcher.mjs` | 4 行入口，只设置 `process.exitCode` |
| `src/cli.mjs` | 命令分发、参数校验、依赖装配 |
| `src/commands/install.mjs` | `install` / `--uninstall` 的参数与运行时解析 |
| `src/commands/doctor.mjs` | 环境、快照、已写入配置与真实后端的自检 |
| `src/self-path.mjs` / `node-version.mjs` | 自身 bin 路径、node 路径、Node 版本闸门 |

## 贯穿全局的设计不变量

**stdout 只属于 MCP 协议。** 日志工厂把 `info` / `warn` / `error` / `debug` 全部写到 stderr，stdout 上多一个字节就会破坏线协议。`LAUNCHER_DEBUG=1` 才放开 debug 输出。

**绝不裸调 `openwiki` 可执行文件。** 后端始终用 `process.execPath` 加绝对 `cli.js` 路径 spawn——Windows 上 nvm 生成的 `openwiki.exe` shim 不转发 stdio，表现和挂死一模一样。解析 openwiki 依赖也只走 Node 模块解析，解析不到就抛 `OpenwikiNotFoundError`，**绝不猜测全局安装路径**：猜错会启动错误的后端或干脆不启动，用户看到的仍然是超时而不是诊断信息。

**配置里不写要靠 PATH 解析的东西。** 写进宿主 MCP 配置的是 node 的绝对路径（`process.execPath`）与本包 bin 的绝对路径，两者都由 `self-path.mjs` 从 `import.meta.url` 推导，不依赖 `process.argv[1]`——全局安装时那是 npm shim 路径，同样存在 stdio 丢失风险。

**决策与 IO 分离。** `plan.mjs`、`targets.mjs`、`guards.mjs`、`ownership.mjs`、`node-version.mjs` 都是不碰文件系统的纯函数，所有隐式全局（platform、homedir、tmpdir、env）都改成入参。这既让决策可独立测试，也让护栏能在真正写入前一次性否决整次安装。

**宁慢不假。** 快照缺失就降级直通；配置读不出来就不当作空配置；退出前能自己诊断就写 stderr。

**只删自己写过的东西。** 安装写收据与逐文件 sha256，卸载要全匹配才删，用户手改过就跳过并说明。

## 相关页面

- [MCP 请求代理（broker）](../runtime/mcp-broker.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [工具清单快照（manifest）](../runtime/tool-manifest.md)
- [安装决策器与安装编排](../installer/install-plan.md)
- [快速上手](../quickstart.md)
