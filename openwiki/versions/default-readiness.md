---
type: subsystem
title: 默认版本就绪：物化与自愈
description: 出厂依赖为何要被物化进版本仓库、六态状态机、explicit 与 self-heal 双模式、删除标记与失败退避、后台自愈的时机与降优先级，以及各命令的接线。
tags: [versions, default-version, materialization, self-heal, backoff]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-d39330ef89d13e065ec31a89
    resource: repo://src/commands/switch.mjs
  - id: openwiki-source-81aa5cb3eb7581e3be3fecd8
    resource: repo://src/commands/versions.mjs
  - id: openwiki-source-739e2e8c589e83bab322e11f
    resource: repo://src/ensure-default.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 默认版本就绪：物化与自愈

## 为什么需要「物化」

launcher 的出厂依赖 `node_modules/openwiki` **不在版本仓库里**——`versions/<版本>/` 下只有 side-by-side 安装的显式版本。这带来三个不对称：`switch` 回默认版本会退化成一次几百 MB 的重新下载；`check` / `doctor` 对默认版本与其他版本口径不一致；bundle 也找不到该落的位置（解析层只在版本目录里找产物）。

0.5.0 的「就绪动作」消除这个不对称：把出厂依赖**物化**成 `versions/<默认版本>/` 里的一个真实条目，并备好快照与 bundle。之后默认版本与其它版本**完全平权**——`switch` 回它是一次毫秒级指针翻转，`check` / `doctor` 的口径一致，bundle 落在解析层真正会读的位置。

## 六态：默认版本此刻在哪一态

`defaultVersionState(pkgRoot)` 是 doctor 与 check 共用的唯一判定，两个界面不会分叉：

| 状态 | 含义 | 文案 |
| --- | --- | --- |
| `unknown` | `node_modules/openwiki` 不可读，连默认版本是什么都不知道 | 无法确定（node_modules/openwiki 不可读） |
| `missing` | 没物化，也不在退避、也没被删过 | 未就绪（还没进版本仓库） |
| `ready` | 实体条目 + bundle 都就绪 | ✓ 已就绪 |
| `installed-no-bundle` | 实体条目在，但没有 bundle（冷启动较慢） | ! 已物化但无 bundle |
| `backoff` | 上次就绪失败，仍在退避期内（带下次可重试时间） | 上次就绪失败，退避中（<时间> 后重试） |
| `removed` | 用户显式删过默认版本，标记还在 | 已删除（不会自动重建） |

`doctor` 在 `missing` 时提示「运行 `warm` 让它就绪」，`removed` 时提示「用 install / warm / switch 重建」；`check` 的版本列表里则直接显示同一行状态。

## 就绪动作做什么

`ensureDefaultVersion({ mode, ... })` 的步骤（全部幂等）：

1. 读出厂版本号（`node_modules/openwiki/package.json`）——读不出来直接以 `stage: "version"` 失败，绝不猜；
2. 按 mode 检查删除标记与退避标记（见下）；
3. **物化**：快照已在且 `isInstalled` 命中时什么都不做（出厂版本的快照随包发布，已就绪时连后端都不启一次）；只有快照缺了才装依赖（`installVersion`：临时目录 → 完整性校验 → 原子 rename）；快照也缺时走 `installAndSnapshot`（装 + 录）；
4. **补 bundle**：`ensureBundle`，失败只 warn——「该版本将以源码入口启动，冷启动较慢」；
5. explicit 模式成功后清掉两个标记。

npm 安装用 `npm install --prefer-offline`（优先命中缓存、通常不联网）。所有失败都软着陆：不写版本指针、不改变任何命令的退出码，异常也绝不被丢给宿主。

## 两种模式：explicit 与 self-heal

| 模式 | 触发点 | 对标记的态度 |
| --- | --- | --- |
| `explicit` | `install` / `warm` / `warmup` / `switch` | **无视**删除标记与退避，成功后清掉两者——用户显式下的命令就是要它现在好起来 |
| `self-heal` | `mcp` 会话后台、`update` 前置就绪 | **尊重**删除标记（用户删过的不要自己长回来）与失败退避（离线时不要每个新会话都重试几百 MB），安静跳过 |

`update` 的前置就绪是 self-heal 最实用的一处：当前生效版本还是出厂依赖时，先把**旧默认版本**物化好再装新的——否则指针一旦切走，就再也切不回去（`switch` 只认真实条目，会退化成重下载）。失败只 warn，不阻塞升级。

## 两个开关与两个标记

**开关**：`prepareEnabled` 判两个来源——`--no-prepare`（install 命令）与 `LAUNCHER_PREPARE=0`，任一关闭即跳过全部就绪与 bundle 动作。注意它与 `--no-warm` **正交**：`--no-prepare` 只关就绪（物化 + bundle），预热照走；反过来 `--no-warm` 也只关预热。`mcp` 的后台自愈同样受它约束。

**标记**（都写在 `versions/` 下）：

| 文件 | 写入时机 | 效果 |
| --- | --- | --- |
| `default-removed.json` | `versions remove` 删掉默认版本时（`markDefaultRemoved`） | 自愈不再重建它；只有显式命令能清掉 |
| `prepare-failed.json` | self-heal 模式就绪失败时（`markPrepareFailed`），记录 `{ version, at, nextRetryAt, reason }` | 退避期内自愈安静跳过 |

退避时长 `LAUNCHER_PREPARE_BACKOFF_HOURS` 默认 **24 小时**，`0` 关闭退避（此时连标记都不写），非法值回退默认。显式命令永远不受退避限制——离线时用户仍可手动 `warm` 重试。

## 后台自愈：时机与降优先级

`scheduleBackgroundPrepare` 挂在 `mcp` 命令上（`LAUNCHER_BACKEND_CLI` override 时不调度），有两条硬设计：

1. **延后到后端就绪之后**：冷启动的瓶颈是文件 IO，构建与 npm install 的 CPU/磁盘占用与它同时发生只会互相拖慢。用户那一侧先用起来，这些活儿排在后面做；
2. **降优先级**：`priority: "below-normal"` 让 npm install 的 `onSpawn` 把子进程设成低于正常优先级（`os.setPriority(PRIORITY_BELOW_NORMAL)`）。

按运行时来源分流：

- `runtime.source === "bundled"`：默认版本还没进版本仓库 → self-heal 就绪它（物化 + bundle）；
- `runtime.backend === "source"`：条目齐全但缺 bundle → 只补 bundle，下次会话生效；
- 其余（已在用 bundle）：什么都不做。

## 各命令接线一览

| 命令 | 就绪模式 | 失败时的行为 |
| --- | --- | --- |
| `install` | explicit（成功安装或「检测不到宿主」时；护栏拒绝不做） | 只 warn，提示稍后 `warm` 重试 |
| `warm` / `warmup` | explicit（预热前先行） | 只 warn，预热仍以当前运行时完成 |
| `switch <默认版本>` | explicit（切到未物化的默认版本时） | **拒绝切换**——指针只允许指向真实条目 |
| `update` | self-heal（升级前就绪当前版本） | 只 warn，升级照常 |
| `mcp` 会话 | self-heal + below-normal（后端就绪之后） | 只 warn，写退避标记 |

`switch` 的拒绝条件是这套设计里最严的一处：物化失败或就绪动作被 `LAUNCHER_PREPARE=0` 关闭时，直接报错退出 1 并给出指引，而不是写一个指向不存在的目录的指针。

## 两条已知边界

- **`npm install -g` 之后如果从不跑安装器、也不开宿主会话**，默认版本不会有 bundle——就绪只发生在显式命令与首次 MCP 会话的后台自愈里，首次会话仍会偏慢，会话结束后后台会把这一份补上，后续会话受益；
- **删除标记是单向的**：`versions remove` 掉默认版本后，自愈永不重建；要恢复只能显式跑 `install` / `warm` / `switch`（它们会清掉标记）。

## 相关页面

- [openwiki 版本目录与生效指针](./version-store.md)
- [版本命令：check / update / switch / versions](./version-commands.md)
- [后端单文件打包（bundle）](../runtime/backend-bundle.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
- [快速上手](../quickstart.md)
