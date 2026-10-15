---
type: testing
title: "测试体系与关键不变量"
description: 测试文件如何按子系统分组、依赖注入与 fake-openwiki 夹具如何让后端可控、真实冒烟的门控方式，以及钉住关键设计决策的代表性测试。
tags: [testing, vitest, fixtures, invariants, smoke]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-061deed2c572dd7f339694b5
    resource: repo://scripts/run-smoke.mjs
  - id: openwiki-source-baf7fe0afef9ea1bf0066af6
    resource: repo://test/backend-supervisor.test.mjs
  - id: openwiki-source-c71ee0b9d494d6740289771f
    resource: repo://test/bin-aliases.test.mjs
  - id: openwiki-source-8811fdd0e09f3c0f41c221fc
    resource: repo://test/broker.test.mjs
  - id: openwiki-source-f973fbec0f65ed08b502faca
    resource: repo://test/check.test.mjs
  - id: openwiki-source-938862dbc6482dbf6739daa8
    resource: repo://test/e2e-default-version.test.mjs
  - id: openwiki-source-cb98301bb5637a4169123f5f
    resource: repo://test/e2e-install.test.mjs
  - id: openwiki-source-084b13589c3f1907c3912cfb
    resource: repo://test/e2e-mcp.test.mjs
  - id: openwiki-source-91855d41ad74dba5b05c4b6e
    resource: repo://test/fixtures/fake-openwiki.mjs
  - id: openwiki-source-1025c77a17739b84b76b02fb
    resource: repo://test/helpers.mjs
  - id: openwiki-source-8c72dbad57837a6e49c1beca
    resource: repo://test/install.test.mjs
  - id: openwiki-source-c9a216afc7657cceaf5ac889
    resource: repo://test/manifest.test.mjs
  - id: openwiki-source-a69282cba9ba5bc941d18b58
    resource: repo://test/mcp-config.test.mjs
  - id: openwiki-source-8de8c4ecd1d494a0104fb9a8
    resource: repo://test/real-holder.test.mjs
  - id: openwiki-source-5056630e6e0abb516b159bbb
    resource: repo://test/real-openwiki.test.mjs
  - id: openwiki-source-eeafa5f4e26a0f6cb0f64f0e
    resource: repo://test/release.test.mjs
  - id: openwiki-source-0a647dbc54ab48e02f605a62
    resource: repo://test/switch.test.mjs
  - id: openwiki-source-8e15784c3ae326b60cd4f6bd
    resource: repo://test/update.test.mjs
  - id: openwiki-source-0c8da0fcedff086895cf9b5d
    resource: repo://test/versions.test.mjs
  - id: openwiki-source-e776cd98f7ae253841c76ad7
    resource: repo://vitest.config.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 测试体系与关键不变量

`vitest.config.mjs` 只做两件事：包含 `test/**/*.test.mjs`，超时 20000ms。没有 setup 文件、没有 environment 定制、无覆盖率门禁——Node 默认环境、单进程串行。

## 按子系统分组

`test/` 下每个文件对应源码里的一个模块或一组紧密相关的行为：

| 组 | 文件 |
| --- | --- |
| 协议与 broker | `broker.test.mjs`、`jsonrpc.test.mjs` |
| 后端会话与监管 | `backend-session.test.mjs`、`backend-supervisor.test.mjs`、`warm.test.mjs` |
| 安装器 | `install.test.mjs`、`e2e-install.test.mjs`、`cli-install.test.mjs`、`skill-install.test.mjs`、`uninstall.test.mjs`、`plan.test.mjs`、`guards.test.mjs`、`mcp-config.test.mjs`、`backup.test.mjs`、`ownership.test.mjs`、`paths.test.mjs` |
| openwiki 版本管理 | `versions.test.mjs`、`versions-command.test.mjs`、`update.test.mjs`、`switch.test.mjs`、`check.test.mjs`、`openwiki-install.test.mjs` |
| 默认版本就绪 | `ensure-default.test.mjs`、`e2e-default-version.test.mjs`、`mcp-command.test.mjs` |
| 后端 bundle | `ensure-bundle.test.mjs`、`bundle-backend.test.mjs` |
| holder 常驻后端 | `holder-runtime.test.mjs`、`holder-server.test.mjs`、`holder-session.test.mjs`、`warmup.test.mjs`、`real-holder.test.mjs`（门控） |
| 命令面与透传 | `cli.test.mjs`、`cli-install.test.mjs`、`ow.test.mjs`、`bin-aliases.test.mjs` |
| 锁原语 | `lockfile.test.mjs` |
| 注册表与发布 | `registry.test.mjs`、`manifest.test.mjs`、`release.test.mjs`、`pkg.test.mjs` |
| 诊断 | `doctor.test.mjs` |
| 端到端 | `e2e-mcp.test.mjs`、`real-openwiki.test.mjs`（门控） |
| 其他 | `log.test.mjs` |

## 版本管理测试：临时 pkgRoot + 注入 npm

0.3.0 的版本管理测试有两个共同约定：

- **pkgRoot 指向 `mkdtemp` 临时目录**，不碰真实包根。`versions.test.mjs` 还带一个 `plantVersion` 助手，在临时目录里造出「可解析的已安装版本」（`package.json` + `dist/cli/cli.js`）与可选的 manifest 快照，让「目录在但入口不全 = 装坏了」这类状态可以精确构造；
- **不碰真实网络与真实后端**：`runNpm` 注入成脚本化应答（失败形态、prerelease 版本表都可控），`confirm` 注入成固定的 y/N，`writeSnapshot` 注入成可成功可失败的替身。

覆盖点举例：`update.test.mjs` 钉住「装 → 录快照 → 切指针」主链路（已装跳过下载只补快照、快照失败不阻塞升级但默认不切、`--no-switch`、`--version` 缺值报错而非滑进交互、升级前先就绪当前版本）、npm 失败时删除半成品目录、以及 `summarizeInstallFailure` 按根因给镜像/工具链/文件占用提示；`switch.test.mjs` 钉住「毫秒级指针改写、装不好就原样放弃、坏目录拒绝并指路清理、切回默认版本前先物化、就绪失败拒绝切换」；`versions-command.test.mjs` 钉住拒删激活版本、快照保留与删除默认版本的标记；`check.test.mjs` 钉住 registry 查询失败只降级提示、不拒绝报告本地状态；`openwiki-install.test.mjs` 钉住原子安装（临时目录 → 校验 → rename）、版本键控锁的并发语义与残留临时目录清理。

## 0.4~0.6.0 新增的测试组

- **默认版本就绪**：`ensure-default.test.mjs` 钉住六态判定（`unknown` / `removed` / `backoff` / `missing` / `installed-no-bundle` / `ready`）、两个开关来源（`--no-prepare` / `LAUNCHER_PREPARE=0`）、删除标记与失败退避（含 `LAUNCHER_PREPARE_BACKOFF_HOURS=0` 关闭）、`scheduleBackgroundPrepare` 按 `runtime.source` 分流的时机与降优先级；`e2e-default-version.test.mjs` 按「现象 A / 现象 B / 删除默认版本之后」验收端到端行为（就绪后默认版本同时有实体安装与 bundle、切回它是零下载的指针翻转、删除后不会被自愈长回来）；`mcp-command.test.mjs` 钉住 mcp 后台补打的落点与排队上限解析。
- **bundle**：`ensure-bundle.test.mjs` 钉住 esbuild 懒安装、meta 有效即复用、`entryVersion` 不符时拒绝入库、`bundle.bad` 被 `preferBundle` 尊重、构建锁的 pid 探活；`bundle-backend.test.mjs` 除构建行为外，还以**源文件不变量**钉住「本脚本不得静态 import esbuild」——那条静态 import 曾经让全局安装下的 bundle 全部失败。
- **holder**：`holder-runtime.test.mjs`（进程装配 + holder CLI 子进程）、`holder-server.test.mjs`（多路复用、id 重映射、取消集合、探针）、`holder-session.test.mjs`（适配器 + `resolveHolderSession` 仲裁）、`warmup.test.mjs`（登录预热与 doctor 提示）分别覆盖；`real-holder.test.mjs` 是真实后端冒烟，付一次 openwiki 冷启动验证 holder 全链路。
- **透传与命令面**：`ow.test.mjs` 钉住透传内核（用 `sourceCliJs`、stdio 继承、信号转发、退出码、软着陆）与 `owl ow` 子命令分发；`bin-aliases.test.mjs` 钉住 package.json 的 `bin` 三名字映射（`openwiki-launcher` 与 `owl` 同入口、`ow` 走透传入口）——这是 0.6.0 新增的发布守护，防止打包或重命名时把短命令丢掉。

## 两把测试杠杆

### 依赖注入：不需要打桩全局

`main`、`runInstall`、`runUninstall`、`createBroker`、`createBackendSession`、`createBackendSupervisor` 的外部依赖全是入参。`test/helpers.mjs` 的 `baseDeps()` 把它们一次性装配好，并且刻意中和了真实机器路径：platform 固定为 linux、systemRoots 用一个永不匹配的系统根、selfBin 与 nodeCommand 用固定假路径、时间戳固定。测试因此不会因为跑在哪台机器上而误触护栏。

`collectLogger()` 返回一个把日志收进内存的对象供断言。

### fake-openwiki：让后端完全可控

`test/fixtures/fake-openwiki.mjs` 是一个 stdio 替身，存在的理由是不必为每个测试付 openwiki 真实 10 到 60 秒的导入代价。

| 变量 | 行为 |
| --- | --- |
| `FAKE_STARTUP_DELAY_MS` | 服务前忙等，模拟慢导入 |
| `FAKE_SERVER_NAME` | serverInfo 名称，默认 fake-openwiki；测试靠这个暗号证明应答来自 manifest 而非后端 |
| `FAKE_EXIT_AFTER_MS` / `FAKE_EXIT_CODE` | N 毫秒后退出，模拟崩溃 |
| `FAKE_STDOUT_NOISE` | 每次应答前写一行非 JSON |
| `FAKE_STDERR` | 启动时写入 stderr，供 stderrTail 断言 |
| `FAKE_PID_FILE` | 写出自身 pid，供「无孤儿」断言 |
| `FAKE_TOOLS` | 覆盖 tools/list 应答，驱动漂移测试 |
| `FAKE_STALL_CALL` | tools/call 接受但永不回答 |
| `FAKE_REFUSE` | 读 stdin 前就死，模拟导入致命失败 |

## 真实后端冒烟的门控

`LAUNCHER_REAL_SMOKE=1` 门控三处：`real-openwiki.test.mjs` 的整个 describe、`real-holder.test.mjs` 的整个文件、`manifest.test.mjs` 里「matches the live openwiki response」单条（committed 快照与真实握手的比对）。默认全部跳过，因为它们需要真实 openwiki 且耗时以分钟计。

用 `npm run test:smoke`（`scripts/run-smoke.mjs`）而不是在命令行前置环境变量——后者在 Windows shell 里不是合法语法，脚本负责注入。它默认跑 `real-openwiki` 与 `manifest` 两个文件（快照漂移不能只靠手工发现）；holder 的真实链路跑 `real-holder.test.mjs`，需要时同样以 `LAUNCHER_REAL_SMOKE=1` 单独启用。

`npm test` 只跑 `vitest run`；`npm run bundle` 与 `npm run manifest` 分别是 bundle 生产与快照录制的入口，测试不触发它们（esbuild 懒安装与真实握手都代价高昂）。

## 钉住关键不变量的代表性测试

### 快路径不启后端

`answers initialize from the manifest without starting the backend` 断言 spawn 一次都没发生；`serves tools/list from the manifest before the backend is ready` 是它的孪生测试。端到端版本是 `answers initialize from the manifest long before the backend is ready` 与 `lists the ten openwiki tools from the manifest`。

**钉住的是**：毫秒级握手这个项目的立身之本。一旦有人让 initialize 走了真实后端，快路径就废了，而功能测试仍然全绿。

### 熔断只冷却不闩死

`retries the backend after the failure cooldown instead of latching` 先断言冷却期内快速失败，再把注入的时钟推进 31000 毫秒，断言重试成功。

**钉住的是**：30 秒冷却这个决定。改成永久闩死，重试那半会挂；改成无限重试，快速失败那半会挂。

### 并发单飞

`shares a single startup across concurrent callers` 断言 spawn 只发生一次，且三个并发调用拿到**同一个**会话对象。

### 宿主断管无孤儿

`exits and leaves no backend behind when the host closes stdin` 从 pid 文件读出后端 pid，断言退出码 0 且该 pid 已从进程表消失。进程内的对应测试是 `clears queued timers and stops the backend when the host disconnects`。

### 畸形配置拒绝写入

两层，都标着「审查重点 1」：`畸形内容拒绝写入且原文本逐字节不变（审查重点 1）` 用尾逗号、混进 `.json` 的注释、括号不配对做输入并断言抛错；`配置畸形时报可读错误并回滚，不清空用户文件（审查重点 1）` 断言用户文件内容一字未变。配套的还有「配置文件读不出来时跳过写盘而不是当成空配置覆盖」。

### 发布包内容

`ships the runtime, the snapshot and the docs` 断言 manifest 快照文件必须随包发布（缺了它用户装的 launcher 永远走直通模式）；`keeps tests and dependencies out of the tarball` 与 `ships every installer module the runtime needs` 断言 tarball 的其余边界；其中还专门断言 **`versions/` 不进包**（它是运行时数据：本地版本仓库与 holder lockfile 都在里面）——这条既有产物断言也有 package.json `files` 配置断言，因为开发机的残留混进过发布包。

### 短命令与透传入口

`bin-aliases.test.mjs` 断言 package.json 的 `bin` 仍是「`openwiki-launcher` 与 `owl` 指向同一入口、`ow` 指向透传入口」的三名字结构。**钉住的是**：0.6.0 主推的短命令不会在重构或打包时悄悄失效。

### 默认版本零下载切回

`e2e-default-version.test.mjs` 的「现象 B」验收：默认版本被物化后，`switch` 回它是毫秒级指针翻转、**不发生任何下载**。**钉住的是**：物化一旦失效，用户会在每次切回默认版本时重付几百 MB 与几分钟——而这种退化在单测里看不出来。

### 全宿主闭环

`e2e-install.test.mjs` 用 `describe.each` 对**全部 28 家**跑项目级与用户级安装卸载闭环，并断言「卸载后配置文件逐字节还原」。跨宿主不变量另有三条：护栏拒绝时文件系统零改动、格式保真（opencode.jsonc 的注释与 config.toml 的其他表都不丢）、共用同一 skills 目录的三家卸载其中一家不连带删掉另两家。

## 编号标记

若测试标题里带 `(I1)` 到 `(I7)` 这样的编号，它对应实现代码注释里同编号的那条具体故障——例如配置文件读不出来当成空配置会覆盖用户整个文件（I7），以及共享 skills 目录卸载时连带删除（I5）。这类编号让测试与设计决策之间的对应关系可追溯。

## 相关页面

- [openwiki 版本目录与生效指针](../versions/version-store.md)
- [版本命令：check / update / switch / versions](../versions/version-commands.md)
- [默认版本就绪：物化与自愈](../versions/default-readiness.md)
- [MCP 请求代理（broker）](../runtime/mcp-broker.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [常驻后端（holder）与延迟回收](../runtime/holder.md)
- [后端单文件打包（bundle）](../runtime/backend-bundle.md)
- [ow 透传：把 openwiki CLI 交给用户](../commands/ow-passthrough.md)
- [MCP 配置文件读写](../installer/mcp-config-writer.md)
- [系统总览](../architecture/overview.md)
