---
type: subsystem
title: 后端单文件打包（bundle）
description: openwiki 后端的 esbuild 单文件 bundle：构建管线与懒安装工具链、内容寻址产物与 entryVersion 闸门、bundle.bad 语义、运行时优先解析与启动失败回退、后台补打时机。
tags: [bundle, esbuild, cold-start, fallback, content-addressing]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-f71b3e44693b0dcee9e43d2d
    resource: repo://scripts/bundle-backend.mjs
  - id: openwiki-source-c89a7c0255f3d83bec964d44
    resource: repo://src/ensure-bundle.mjs
  - id: openwiki-source-de42f82d816bc34f66da685e
    resource: repo://src/esbuild-tools.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 后端单文件打包（bundle）

## 为什么需要它

openwiki 后端的冷启动大头是**逐文件模块加载**（Windows 上叠加 Defender 实时扫描，实测 33~120 秒）。把整个后端预编译成**一个 ESM 文件**，解析与读取的模块数量级下降，冷启动随之压缩。它是 0.4.0 冷启动治理的一招，与[holder 常驻模式](./holder.md)互补。

一条贯穿始终的定位：**bundle 只是优化，绝不致命。** 任何缺失、损坏、构建失败、启动失败都会静默或告警地降级到源码入口，绝不改变命令退出码、绝不阻塞安装。

## 运行时优先解析

解析层（`src/paths.mjs` 的 `preferBundle`）在版本目录 `versions/<版本>/` 下按以下规则决定用哪个入口：

1. 存在 `bundle.bad` → 直接走源码，不再尝试 bundle；
2. `bundle.meta.json` 可解析、`meta.entryVersion === version`、`meta.file` 存在 → 用 `bundle-<hash8>.mjs`，返回 `backend: "bundle"`；
3. 其余任何情况（meta 缺失/损坏/过期、产物文件不存在）→ 静默降级源码 `dist/cli/cli.js`。

`resolveOpenwikiRuntime` 的返回值同时携带 `cliJs`（可能指向 bundle）与 `sourceCliJs`（永远指向源码）——MCP 后端路径吃 bundle 的加速，`ow` 透传与回退路径用源码。

### meta 校验与 entryVersion 闸门

`bundle.meta.json` 记录：`openwikiVersion`、`entryVersion`、`scriptHash`（构建脚本自身的 sha256）、`nodeMajor`、`platform`、`bundleHash`、`file`。`metaValid` 要求**全部匹配当前环境**才算数，其中两条是硬闸门：

- **`entryVersion === version`**：产物必须是**用请求的那个版本**的代码打出来的。缺失该字段的历史 meta 一律视为过期——旧实现会拿出厂代码冒名非默认版本，产出一份「声称 A 版本、内容是 B 版本」的后端。
- **`scriptHash` 匹配**：构建脚本升级后旧产物自动作废，避免用旧配置打出的产物长期被复用。

构建完成入库前还有一道同样的闸：`buildResult.entryVersion !== version` 时删掉临时产物并失败——宁可慢而正确，也不给冒名产物写下 meta。

## 构建管线

`scripts/bundle-backend.mjs` 的 `runBundleBackend` 负责实际构建，配置来源是探路实测固化的结论（改动前先重测）：

| 配置 | 取值与理由 |
| --- | --- |
| `format: "esm"` | openwiki dist 有 top-level await，CJS 输出直接报错 |
| `banner` createRequire | ESM 产物内的 CJS 依赖（signal-exit 等）仍 require node 内置模块 |
| `external: ["better-sqlite3", "jsdom", "jsonc-parser"]` | better-sqlite3 是原生模块无法入包；jsdom 只走 mermaid dom-shim 动态 import，MCP 路径不触达；jsonc-parser 的 UMD 动态 require 相对路径在 bundle 内失效 |
| `stub react-devtools-core` | ink 的调试依赖，静态 import 但运行时不可达，用空模块替换 |
| `target: "node22"` | 与 engines 对齐 |

**入口候选必须来自目标版本自己的包目录**（`versions/<目标版本>/node_modules/openwiki/dist/cli/cli.js`）；只有当目标版本就是出厂版本时才允许回退到 `node_modules/openwiki` 的入口——否则打出的产物内容与版本号对不上。

**本脚本不得静态 `import esbuild`。** esbuild 不是运行时依赖（全局安装只有 `dependencies`），由 `ensureBundle` 经 `ensureEsbuild` 懒安装后以参数注入；顶部静态 import 会在模块加载时直接抛 `ERR_MODULE_NOT_FOUND`，把整套懒加载设计击穿（全局安装下曾经导致 update 的 bundle 全部失败）。`test/bundle-backend.test.mjs` 有源文件不变量用例守护这条规则。

直接运行 `node scripts/bundle-backend.mjs` 或 `npm run bundle` 时，脚本走 `ensureBundle`（meta、内容寻址、`bundle.bad` 清除只有它管），失败时打印原因并以非零码退出。

## esbuild 工具链的懒安装

`src/esbuild-tools.mjs` 把 esbuild 钉在确切版本（`0.28.2`，不用范围），安装到**用户级数据目录** `<launcherDataDir>/tools/esbuild`（Windows 上是 `%LOCALAPPDATA%/openwiki-launcher/tools/esbuild`），而不是包根——包根随 Node 版本与重装漂移，工具链放那里会在升级时丢失或分叉成多份。

加载顺序：先尝试从工具目录 `import` esbuild；不存在才 `npm install --prefix <toolsDir> esbuild@<钉版>`；任何一步失败（离线、网络）都返回 `{ ok: false, reason }` 由调用方降级，绝不抛出。

## 构建锁与内容寻址

`ensureBundle` 是 bundle 生产与保鲜的唯一入口，流程：

1. meta 有效 → 直接复用（`reused: true`），零 IO；
2. 确保 esbuild 可用；
3. 取 `versions/bundle.lock`（独占创建）。残留锁先做 **pid 探活**：持有者进程已死（上次构建被杀）就强制重取；持有者活着则软失败「另一进程正在构建 bundle」，本次降级源码，等下一次触发补上；
4. 构建到临时文件 `bundle.mjs.tmp-<pid>`；
5. **内容寻址入库**：对产物取 sha256 前 8 位，落成 `bundle-<hash8>.mjs`。同名文件已存在就丢弃临时文件（内容相同）——避免 rename 覆盖一个可能正被运行中后端占用的旧文件；
6. 写 `bundle.meta.json`，清除 `bundle.bad`，打印产物大小；
7. `finally` 释放构建锁。

## bundle.bad：启动失败的记忆

`bundle.bad` 是「这份产物把后端搞挂过」的标记，语义设计得很克制：

- **只在源码兜底成功后才写。** `createBundleFallbackSupervisor`（`src/ensure-bundle.mjs`）包装 bundle 入口的监管器：`ensureReady()` 首次失败时改用源码入口重试；只有**源码随后成功**才写标记——磁盘满、杀毒拦截等与 bundle 无关的失败不污染它；源码也失败则不写（问题不在 bundle）；
- **任何一次成功构建都会清除它**（`ensureBundle` 第 6 步），重建成功即恢复；
- 运行时的 `preferBundle` 见到它就直接走源码，`doctor` / `check` 把该版本显示为 `bad`。

`bundleStatus(pkgRoot, version)` 返回 `ready` / `bad` / `missing` 三态，与 `preferBundle` 同一口径（缺 `entryVersion` 的历史 meta 不谎报就绪）。

## 触发点

`ensureBundle` 的调用方分布在各命令的收尾/前置，共同特征是**失败只告警**：

| 触发点 | 模式 |
| --- | --- |
| `install` 收尾 | 先默认版本就绪，再 `ensureBundle`，最后预热 |
| `warm` / `warmup` | 预热前先补打（顺带验证 bundle 可启动） |
| `update` | 装完新版本、切指针后的收尾 best-effort |
| `switch` | 切换后检查状态：missing 后台补打不阻塞退出，bad 则警告新会话走源码 |
| `mcp` 会话 | 后台补打：缺 bundle（`backend === "source"`）时**等后端就绪之后**再调度，不与冷启动抢 IO，下次会话生效 |

`--no-prepare` / `LAUNCHER_PREPARE=0` 会跳过全部 bundle 动作——bundle 落在版本仓库里，「别动版本仓库」的开关必须同样约束它，否则物化关了、bundle 还照打，会造出 bundle-only 的畸形目录。

## 相关页面

- [openwiki 后端会话与监管](./backend-supervisor.md)
- [常驻后端（holder）与延迟回收](./holder.md)
- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [版本命令：check / update / switch / versions](../versions/version-commands.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
- [ow 透传：把 openwiki CLI 交给用户](../commands/ow-passthrough.md)
