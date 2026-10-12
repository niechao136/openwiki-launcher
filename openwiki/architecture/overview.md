---
type: architecture
title: 系统总览：为什么需要 broker 代理
description: openwiki-launcher 解决的问题、两段会话架构、端到端时序、模块职责地图、openwiki 版本管理子系统的位置，以及贯穿全局的设计不变量。
tags: [architecture, mcp, broker, version-management, design-invariants]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-12T05:45:32.864Z
sources:
  - id: openwiki-source-cf7067276199e27e6324cc91
    resource: repo://bin/openwiki-launcher.mjs
  - id: openwiki-source-fe7152fb81d635ad49dfb127
    resource: repo://scripts/gen-manifest.mjs
  - id: openwiki-source-814aeea6bc63a6d45d6c643a
    resource: repo://src/backend.mjs
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-4ace6d5c885a3cfa1a8c5685
    resource: repo://src/gen-manifest.mjs
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
  - id: openwiki-source-96d987ff5f91a05f973f4bfd
    resource: repo://src/versions.mjs
generated: { by: "codebuddy", at: "2026-10-12T05:45:32.864Z" }
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
2. `runMcpCommand` 用 `resolveOpenwikiRuntime` 解析 openwiki 运行时——解析顺序是 `versions/active.json` 指针优先，指针缺失或损坏时回退包内出厂依赖；加载匹配版本的快照，快照缺失则不创建 broker，直接把宿主管道直通给真实后端。
3. broker 接管 stdin/stdout：解析 JSON-RPC 行，应答 `initialize`（用快照），应答 `tools/list`（用快照，且仅在后端尚未启动时）。连接建立时即后台预热后端（`LAUNCHER_EAGER_START=0` 可关闭）。
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
| `src/paths.mjs` | 解析当前生效的 openwiki 依赖与 CLI 入口（指针 > 出厂依赖） |
| `src/commands/mcp.mjs` / `warm.mjs` | 以 MCP 服务器身份运行 / 预热后端 |

**openwiki 版本管理（0.3.0 新增）**

| 文件 | 职责 |
| --- | --- |
| `src/versions.mjs` | 版本目录布局、`active.json` 生效指针与已装清单的唯一权威 |
| `src/paths.mjs` | 在指针与出厂依赖之间做运行时解析（显式版本 > 指针 > 出厂） |
| `src/npm-runner.mjs` | npm 子进程调用与 registry 稳定版挑选 |
| `src/commands/check.mjs` | 版本状态一屏总览：当前生效、已装清单、registry 最新版 |
| `src/commands/update.mjs` | 升级编排：装依赖 → 录快照 → 切指针 |
| `src/commands/switch.mjs` | 已装版本间的毫秒级切换（可秒回滚） |
| `src/commands/versions.mjs` | 版本目录管理（目前只有 `remove`） |

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
| `bin/openwiki-launcher.mjs` | 4 行入口，只把 `main()` 的返回值赋给 `process.exitCode` |
| `src/cli.mjs` | 命令分发、参数校验、依赖装配 |
| `src/commands/install.mjs` | `install` / `--uninstall` 的参数与运行时解析 |
| `src/commands/doctor.mjs` | 环境、快照、已写入配置与真实后端的自检 |
| `src/gen-manifest.mjs` | 快照录制核心（连接真实后端问 `initialize` 与 `tools/list`），`update` 与 `switch` 代装时复用 |
| `scripts/gen-manifest.mjs` | `npm run manifest` 的 CLI 包装，被直接运行时才动手 |
| `src/self-path.mjs` / `node-version.mjs` | 自身 bin 路径、node 路径、Node 版本闸门 |

## openwiki 版本管理在架构中的位置

0.3.0 起，launcher 对 openwiki 的依赖从「package.json 里钉死的一个版本」变成可管理的多版本：

- 各 openwiki 版本 side-by-side 装在 launcher 包根的 `versions/<x.y.z>/` 下，`versions/active.json` 指针决定当前生效版本；
- 运行时解析（broker 启动、warm、doctor、版本命令）都走同一条 `resolveOpenwikiRuntime` 路径：显式版本 > `active.json` 指针 > 包内出厂 `node_modules/openwiki`；
- `check` / `update` / `switch` / `versions` 四条命令是对这条链路的运维入口。

细节见 [openwiki 版本目录与生效指针](../versions/version-store.md) 与 [版本命令](../versions/version-commands.md)。

## 贯穿全局的设计不变量

**stdout 只属于 MCP 协议。** 日志工厂把 `info` / `warn` / `error` / `debug` 全部写到 stderr，stdout 上多一个字节就会破坏线协议。`LAUNCHER_DEBUG=1` 才放开 debug 输出。

**绝不裸调 `openwiki` 可执行文件。** 后端始终用 `process.execPath` 加绝对 `cli.js` 路径 spawn——Windows 上 nvm 生成的 `openwiki.exe` shim 不转发 stdio，表现和挂死一模一样。解析 openwiki 依赖只认本包根下的 `versions/` 与 `node_modules`，解析不到就抛 `OpenwikiNotFoundError`，**绝不猜测全局安装路径，也绝不向上遍历目录树**：全局装的 openwiki 恰好在本包上一层，一次向上查找就会在出厂依赖缺失时被悄悄采纳，版本报告从此开始说谎。

**配置里不写要靠 PATH 解析的东西。** 写进宿主 MCP 配置的是 node 的绝对路径（`process.execPath`）与本包 bin 的绝对路径，两者都由 `self-path.mjs` 从 `import.meta.url` 推导，不依赖 `process.argv[1]`——全局安装时那是 npm shim 路径，同样存在 stdio 丢失风险。

**决策与 IO 分离。** `plan.mjs`、`targets.mjs`、`guards.mjs`、`ownership.mjs`、`node-version.mjs` 都是不碰文件系统的纯函数；版本命令通过注入 `runNpm` / `confirm` / `writeSnapshot` / `resolveRuntime` 获得同样的可测试性，所有隐式全局（platform、homedir、tmpdir、env）都是入参。这既让决策可独立测试，也让护栏能在真正写入前一次性否决整次安装。

**宁慢不假。** 快照缺失就降级直通；配置读不出来就不当作空配置；显式版本解析不到就明说，绝不用出厂依赖冒名顶替（否则录出的快照自称 A 版本、内容是 B 版本）；退出前能自己诊断就写 stderr。

**只删自己写过的东西。** 安装写收据与逐文件 sha256，卸载要全匹配才删，用户手改过就跳过并说明；版本删除同样有护栏——当前激活版本拒删，manifest 快照保留。

## 相关页面

- [MCP 请求代理（broker）](../runtime/mcp-broker.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [工具清单快照（manifest）](../runtime/tool-manifest.md)
- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [版本命令：check / update / switch / versions](../versions/version-commands.md)
- [安装决策器与安装编排](../installer/install-plan.md)
- [快速上手](../quickstart.md)
