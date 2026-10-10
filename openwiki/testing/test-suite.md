---
type: testing
title: "测试体系与关键不变量"
description: 测试文件如何按子系统分组、依赖注入与 fake-openwiki 夹具如何让后端可控、真实冒烟的门控方式，以及钉住关键设计决策的代表性测试。
tags: [testing, vitest, fixtures, invariants]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-061deed2c572dd7f339694b5
    resource: repo://scripts/run-smoke.mjs
  - id: openwiki-source-baf7fe0afef9ea1bf0066af6
    resource: repo://test/backend-supervisor.test.mjs
  - id: openwiki-source-8811fdd0e09f3c0f41c221fc
    resource: repo://test/broker.test.mjs
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
  - id: openwiki-source-5056630e6e0abb516b159bbb
    resource: repo://test/real-openwiki.test.mjs
  - id: openwiki-source-eeafa5f4e26a0f6cb0f64f0e
    resource: repo://test/release.test.mjs
  - id: openwiki-source-e776cd98f7ae253841c76ad7
    resource: repo://vitest.config.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 测试体系与关键不变量

`vitest.config.mjs` 只做两件事：包含 `test/**/*.test.mjs`，超时 20000ms。没有 setup 文件、没有 environment 定制、无覆盖率门禁——Node 默认环境、单进程串行。

## 按子系统分组

| 组 | 文件 |
| --- | --- |
| 协议与 broker | `broker.test.mjs`、`jsonrpc.test.mjs` |
| 后端 | `backend-session.test.mjs`、`backend-supervisor.test.mjs`、`warm.test.mjs` |
| 安装器 | `install.test.mjs`、`e2e-install.test.mjs`、`cli-install.test.mjs`、`skill-install.test.mjs`、`uninstall.test.mjs`、`plan.test.mjs`、`guards.test.mjs`、`mcp-config.test.mjs`、`backup.test.mjs`、`paths.test.mjs` |
| 注册表与发布 | `registry.test.mjs`、`manifest.test.mjs`、`release.test.mjs` |
| 诊断与 CLI | `doctor.test.mjs`、`cli.test.mjs` |
| 端到端 | `e2e-mcp.test.mjs`、`real-openwiki.test.mjs` |
| 其他 | `log.test.mjs` |

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

`LAUNCHER_REAL_SMOKE=1` 门控两处：`real-openwiki.test.mjs` 的整个 describe 与 `manifest.test.mjs` 的快照一致性测试。默认跳过，因为它们需要真实 openwiki 且耗时以分钟计。

用 `npm run test:smoke`（`scripts/run-smoke.mjs`）而不是在命令行前置环境变量——后者在 Windows shell 里不是合法语法，脚本负责注入。

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

`ships the runtime, the snapshot and the docs` 断言 manifest 快照文件必须随包发布（缺了它用户装的 launcher 永远走直通模式）；`keeps tests and dependencies out of the tarball` 与 `ships every installer module the runtime needs` 断言 tarball 的其余边界。

### 全宿主闭环

`e2e-install.test.mjs` 用 `describe.each` 对**全部 28 家**跑项目级与用户级安装卸载闭环，并断言「卸载后配置文件逐字节还原」。跨宿主不变量另有三条：护栏拒绝时文件系统零改动、格式保真（opencode.jsonc 的注释与 config.toml 的其他表都不丢）、共用同一 skills 目录的三家卸载其中一家不连带删掉另两家。

## 编号标记

若测试标题里带 `(I1)` 到 `(I7)` 这样的编号，它对应实现代码注释里同编号的那条具体故障——例如配置文件读不出来当成空配置会覆盖用户整个文件，以及共享 skills 目录卸载时连带删除。这类编号让测试与设计决策之间的对应关系可追溯。

## 相关页面

- [MCP 请求代理（broker）](../runtime/mcp-broker.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [MCP 配置文件读写](../installer/mcp-config-writer.md)
- [系统总览](../architecture/overview.md)
