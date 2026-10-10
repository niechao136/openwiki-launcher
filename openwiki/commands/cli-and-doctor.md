---
type: command-surface
title: 命令行接口与 doctor 自检
description: CLI 的命令分发与参数白名单、退出码约定，以及 doctor 的五段检查链路与严重性分级。
tags: [cli, doctor, exit-codes, diagnostics]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-cf7067276199e27e6324cc91
    resource: repo://bin/openwiki-launcher.mjs
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-b4ad9d6666f93bb20232315a
    resource: repo://src/commands/doctor.mjs
  - id: openwiki-source-f2765e03ab3c44ffdd8995a7
    resource: repo://src/commands/install.mjs
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-ae090dd614b550bc566d7b91
    resource: repo://src/commands/warm.mjs
  - id: openwiki-source-b995d49faa81ab47b4496f9b
    resource: repo://src/install.mjs
  - id: openwiki-source-6cd2ed5cbb573f14d226c8d3
    resource: repo://src/node-version.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 命令行接口与 doctor 自检

## 入口

`bin/openwiki-launcher.mjs` 只有几行——调用 `main(process.argv.slice(2))` 并把返回值赋给 `process.exitCode`。所有逻辑集中在 `src/cli.mjs` 的 `main(argv, deps)`。

`main` 的第二个参数 `deps` 是**可注入依赖**：logger、node 版本、env、cwd、homeDir、platform、`exists`、`spawnFn`、`resolveRuntime`、`createSupervisor`、`nodeCommand`、`selfBin`、`now`。默认值都从真实的 `process.*` / `os.*` 读取，但测试可以整体替换，因此 CLI 层不需要打桩全局对象。

## 命令分发

`main` 按固定顺序判断，命中即返回：

| 输入 | 行为 | 退出码 |
| --- | --- | --- |
| 无参数 / `help` / `--help` / `-h` | 打印帮助 | 0 |
| `version` / `--version` / `-v` | 打印版本 | 0 |
| **Node 版本不达标** | 报错并停止（先于所有子命令） | 1 |
| `mcp` | 以 MCP 服务器身份运行 | 0 / 1 |
| `warm` | 预热后端后退出 | 0 / 1 |
| `doctor` | 自检 | 0 / 1 |
| `install` / `uninstall` | 安装 / 卸载 | 0 / 1 / 2 |
| 其他以 `-` 开头的参数（裸用法） | 按安装处理 | 0 / 1 / 2 |
| 其他 | 打印帮助到日志并报未知命令 | 1 |

注意 `help` 与 `version` 的检查在 Node 版本闸门**之前**——查版本号不需要能跑 MCP。

## `--host` 标识

`mcp` 命令接受 `--host <id>` 与 `--host=<id>` 两种写法。取值必须匹配 `/^[a-z0-9-]{1,64}$/u`；缺值、以 `-` 开头、或含大写字母与下划线都直接报错退出 1，而不是被静默接受。默认值为 `"unknown"`。

这个标识**只有一个用途**：原样透传给后端的 `spawn(process.execPath, [cliJs, "mcp", "--host", hostId])`，让 openwiki 侧知道当前会话属于哪个宿主。launcher 自身不据此做任何分支。

## install / uninstall 的参数

`parseInstallArgs` 用**白名单**而非黑名单：`--global`、`--uninstall`、`--force`、`--no-takeover`、`--bootstrap` 五个布尔标志，加 `--tool <id>` / `--tool=<id>`。任何其他以 `-` 开头的参数一律返回错误——静默忽略一个拼错的参数，会让用户以为某个开关生效了。

`--tool` 支持带空格形式与等号形式两种；`--tool=`（等号后为空）会把 `tool` 置为空字符串，而不是当成未指定。

`uninstall` 子命令会被翻译成「在参数尾部追加 `--uninstall` 后走同一套解析」，因此两条路径的参数语义完全一致。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户或环境错误：未知宿主、该宿主不支持此作用域、找不到 openwiki 依赖、doctor 与真实后端握手失败、安装执行失败并已回滚 |
| 2 | 护栏拒绝（系统目录、或在主目录做项目级安装），**一个字节都不会写** |

2 只由 `runInstall` 在发现任一 entry 被护栏拒绝时返回，并且是在所有写入之前判定。详见[安全护栏、备份与回滚](../safety/guards-and-backups.md)。

## doctor 的检查链路

`runDoctorCommand` 依次做五件事，严重性逐级上升：

1. **Node 版本闸门。** 不满足 `>= 22.22.0` 立即返回 1。闸门逻辑与 CLI 共用 `node-version.mjs` 的 `nodeVersionSupported`，逐段数字比较、缺段补 0，因此 `"22.22"` 与 `"22.22.0"` 都判定为达标。
2. **openwiki 依赖解析。** 解析不到直接返回 1，并提示「本包自带 openwiki 依赖，请重新安装本包」。
3. **版本锁定核对。** 与写死的 `0.6.0` 比对，不一致只 `warn`——因为 launcher 在版本不匹配时会降级为直通模式，仍然可用。
4. **已写入 MCP 命令核对。** 读回各宿主配置里的 `command` 与 `args[0]`，与当前的 node 绝对路径和本包 bin 路径比对。这一项专门解决 node 升级后的场景：配置里存的是旧绝对路径，宿主只会报连接错误，原因在任何日志里都看不到。缺 `baseDir` / `nodeCommand` / `selfBin` 时**静默跳过**——只想检查后端的用户不该收到一堆「不一致」。
5. **与真实后端握手并比对清单。** 创建 supervisor，`ensureReady()` 后请求 `tools/list`，与 manifest 比对。缺失或多出分别以 `+ name` / `- name` 列出（`diffTools`）。

**严重性分级是这个命令的核心设计**：manifest 缺失或漂移只 `warn` 并返回 0，因为 launcher 会降级为直通模式，安装仍然可用，用户可以自行决定什么时候重新生成快照；只有与真实后端的握手失败才返回 1。`finally` 中必定 `supervisor.stop()`，不留孤儿进程。

## mcp 与 warm 的收尾

`runMcpCommand` 在快照缺失时打一条 `warn` 说明已降级为直通模式，然后照常建立 broker。它的收尾逻辑是一组幂等处理：

- stdin / stdout 的 `error` 事件只记 debug，不让宿主拆管道变成未捕获异常；
- `end`、`close`、`SIGTERM`、`SIGINT` 全部指向同一个带 `closed` 闸门的 `finish`，先 `parser.end()` 冲刷无换行的尾包，再 `broker.handleClientEof()`；
- `exit` 时 `supervisor.stop()`，兜住信号没覆盖到的退出路径。

`runWarmCommand` 只做一件事：`ensureReady()` 成功后立刻 `stop()`（`finally` 中执行，失败路径也停）。它的意义是把 openwiki 的冷导入代价挪到用户等待之前。支持 `LAUNCHER_BACKEND_CLI` 覆盖后端入口，`mcp` 命令同样支持——该变量只用于测试与排障。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `LAUNCHER_DEBUG=1` | 放开 debug 级日志（写 stderr） |
| `LAUNCHER_BACKEND_CLI` | 覆盖后端 CLI 入口，仅供测试与排障 |
| `LAUNCHER_REAL_SMOKE=1` | 启用真实后端冒烟测试 |

## 相关页面

- [快速上手](../quickstart.md)
- [工具清单快照（manifest）](../runtime/tool-manifest.md)
- [JSON-RPC 行传输与日志纪律](../runtime/protocol-and-logging.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
