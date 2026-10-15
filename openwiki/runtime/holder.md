---
type: subsystem
title: 常驻后端（holder）与延迟回收
description: 可选的 holder 模式：detached 常驻进程与 lockfile 仲裁、命名管道多路复用与 id 重映射、TTL 空闲回收、版本换血、wrapper 失败回退，以及 warmup 登录项与已知边界。
tags: [holder, multiplexing, named-pipe, lockfile, ttl, warmup]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-d2a47b74bde3c80b7c2f9209
    resource: repo://src/holder-client.mjs
  - id: openwiki-source-c80596f8bd096a7db826530e
    resource: repo://src/holder-runtime.mjs
  - id: openwiki-source-a7ef79a472ba3d7874d821e7
    resource: repo://src/holder-server.mjs
  - id: openwiki-source-f91a1c92008d27288a08c2d9
    resource: repo://src/holder-session.mjs
  - id: openwiki-source-46f28e4d4b1a794340ed72cb
    resource: repo://src/lockfile.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 常驻后端（holder）与延迟回收

## 它解决什么问题

默认形态下，每个宿主会话的 wrapper 各持有一个后端进程，宿主一断开就回收——每个新会话都要重付一次冷启动（Windows 30 到 50 秒起步）。holder 模式让**首个 wrapper 以 detached 方式拉起一个常驻进程**，后端随之脱离宿主生命周期；同宿主的后续会话经 lockfile 与命名管道接入热后端，首个工具调用秒回。

holder 是 0.4.0 的「延迟回收」方案，目前是**可选功能，默认关闭**：只有 `LAUNCHER_HOLDER=1` 时 `mcp` 命令才会尝试接入/拉起 holder，否则一切都走[进程内 supervisor](./backend-supervisor.md)。验收边界清楚后再考虑改默认。

## 启用与命令

| 入口 | 行为 |
| --- | --- |
| `LAUNCHER_HOLDER=1` | `mcp` 会话先尝试 holder；接入/拉起失败静默回退进程内路径 |
| `owl holder --host <id>` | holder 进程本体：**不面向用户手敲**，由 wrapper 以 detached 方式拉起 |
| `owl warmup --host <id>` | 确保 holder 常驻且后端就绪，适合挂登录启动项；holder 拉不起来时硬失败 |
| `LAUNCHER_HOLDER_TTL_MINUTES` | 空闲 TTL（默认 30 分钟，非法值回退默认） |

`holder` 子命令在 `LAUNCHER_BACKEND_CLI` 覆盖（测试/排障）下不要求包内装有 openwiki；`LAUNCHER_HOLDER_PKG_ROOT` 是排障钩子，把锁与管道指向另一个包根。

## 资源与仲裁：lockfile + 命名管道

两个 wrapper 同时发现「没有 holder」时，必须只有一方负责拉起。仲裁靠 `versions/holder-<hostId>.json` 这个 lockfile：

- **独占创建**（`openSync(..., "wx")`），内容 `{ pid, pipeName, version, startedAt }`；
- 创建失败说明对手赢了 → 读内容、探活管道、接入；
- **pid 探活**清理残留：持有者进程已死（上次崩溃、被 kill）时强制覆盖重取——与 `bundle.lock`、安装锁同一套原语（`src/lockfile.mjs`）；
- 命名管道名固定为 `\\.\pipe\openwiki-launcher-<hostId>-<version>`——`version` 进管道名使**不同版本的 holder 天然隔离**。

`holder-runtime.mjs` 的启动顺序：**先监听命名管道**（失败则释放锁并抛错）→ 独占 lockfile → 后台预热上游（预热失败不退出 holder，首个调用会重试；重试频率由 wrapper 侧 broker 的冷却机制约束）。

## TTL 空闲回收

`armTtl` 只在**没有活跃连接**时武装定时器（`ttlMinutes * 60_000`，`unref`）；新连接到达或连接关闭时重算。到点执行 `shutdown()`：

1. 清掉定时器；
2. 释放 lockfile；
3. `supervisor.stop()` 停上游后端；
4. **销毁所有 socket**——wrapper 侧要靠 close 感知 holder 消失并回退/重连；
5. 关掉服务器（有活跃连接时给 2 秒宽限，不永久挂起）。

## 多路复用核心

openwiki 是 stdio MCP server，一个进程只有一对 stdin/stdout。holder 对上游的复用策略集中在 `holder-server.mjs`：

- **initialize 只对上游做一次**，结果缓存在 `initCache` 供所有连接共享（直通模式下 wrapper 需要它）；
- **id 重映射**：每个连接内的原始 id 与上游全局唯一 id 一一对应，响应回来按映射送回正确连接；
- **`_meta` 剥除**：progressToken 在进 holder 前被剥掉——上游不发 progress，token 没有下游；对通知只认 `notifications/cancelled`（按连接维护取消集合），其余丢弃；
- **`holder/status` 探针**：返回 `{ backendReady: supervisor.current() != null, version }`，warmup 用它轮询；
- **`holder/shutdown`**：支持请求与通知两种形态（version 换血时 wrapper 用通知形态），收到即触发 holder 自身的 shutdown 流程。

上游会话经 `getSession()` 取得：`current()` 命中直接复用，否则交给 supervisor 的单会话语义去重并发 `ensureReady`——冷却由 wrapper 侧 broker 承担，holder 不重复造。

## wrapper 侧仲裁与版本换血

`resolveHolderSession`（`src/holder-client.mjs`）的决策链，任何一步失败都返回 `{ mode: "inprocess", reason }`：

1. **探活接入**：lockfile 存在且管道可达 → 用 `createHolderSupervisorAdapter` 接入；
2. **残留清理**：lockfile 在但管道不可达 → force 覆盖锁后重新拉起；
3. **并发竞争**：独占创建失败 → 探活对手并接入；对手也探活失败 → force 接管；
4. **版本换血**：lock 里的 `version` 与当前请求版本不符 → 先连旧管道发 `holder/shutdown` 并等 300ms；连不上才按 `lock.pid` `process.kill` 兜底；释放锁后走新拉。

拉起动作 `spawnHolder`：`spawn(process.execPath, [selfBin, "holder", "--host", id], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, LAUNCHER_BACKEND_CLI: cliJs } })` 后 `unref()`——detached + ignore 让 holder 活过 wrapper，`LAUNCHER_BACKEND_CLI` 把已解析的入口传下去。

## 适配器：像 supervisor，但不是 supervisor

`createHolderSupervisorAdapter` 把命名管道连接包装成 broker 期望的 `ensureReady / current / onSessionExit / stop` 形状，broker 的排队、progress、超时、冷却逻辑原样复用——它只看得到一个「会话还没就绪」的 supervisor。

两个关键语义：

- **`stop()` 只断开自己的连接**，绝不杀 holder——宿主会话结束时 holder 要继续为后续会话服务；
- 连接建立有 1500ms 超时；连接断开时清空 pending 并通知 `onSessionExit`（不自动重连，交给 wrapper 的下一次会话重新仲裁）。

### 失败回退的两种口径

| 使用方 | holder 不可用时 |
| --- | --- |
| `mcp` 命令 | warn 一条原因，静默回退进程内 supervisor（会话必须能用） |
| `warmup` 命令 | 硬失败返回 1（登录项场景需要知道预热没生效） |

## warmup 登录项

`warmup` 与 `warm` 的区别在终点：warm 拉起后端就退出（只留 OS 文件缓存），warmup 拉起的是**常驻 holder**（TTL 内的所有会话直接接入热后端），随后以 500ms 轮询 `holder/status` 直到 `backendReady`（默认 60 秒上限），最后断开自己的连接——holder 的空闲 TTL 从此刻重新起算。

挂到登录启动项即可在每天第一次会话前把冷启动付掉；`doctor` 会打印可复制的计划任务模板：

```text
schtasks /create /tn "openwiki-warmup" /sc onlogon /tr "<node> <selfBin> warmup --host <宿主id>"
```

## 已知边界

- **TTL 过期或重启机器后的第一个会话仍要付冷启动**：holder 不在服务状态时的首个会话只能走拉起 + 预热；这是登录项（warmup）存在的理由，不是缺陷。
- **命名管道对本机任意进程可连**：风险评估为可接受——openwiki 工具仅读写仓库内 wiki 文件；这是可选模式而非默认打开的原因之一。
- holder 与 bundle 兜底**互斥**：holder 分支自管后端进程，不包装 `createBundleFallbackSupervisor`。

## 相关页面

- [openwiki 后端会话与监管](./backend-supervisor.md)
- [MCP 请求代理（broker）](./mcp-broker.md)
- [后端单文件打包（bundle）](./backend-bundle.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [快速上手](../quickstart.md)
