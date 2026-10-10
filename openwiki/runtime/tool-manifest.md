---
type: subsystem
title: "工具清单快照（manifest）"
description: manifest 快照的生成、按版本选取、缺失降级直通与漂移检测。
tags: [manifest, snapshot, tools-list, drift]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-ad4f149d1c4da0ecd886141d
    resource: repo://manifest/openwiki-0.6.0.json
  - id: openwiki-source-fe7152fb81d635ad49dfb127
    resource: repo://scripts/gen-manifest.mjs
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
  - id: openwiki-source-b4ad9d6666f93bb20232315a
    resource: repo://src/commands/doctor.mjs
  - id: openwiki-source-322237c20df0e9b998d722ac
    resource: repo://src/commands/mcp.mjs
  - id: openwiki-source-841777335cd5bf0a6754a1d9
    resource: repo://src/manifest.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 工具清单快照（manifest）

`manifest/openwiki-<版本>.json` 是从真实 openwiki 后端录下来的应答，包含它对 initialize 与 tools/list 的回答。broker 靠它在毫秒级完成握手。录自真实服务器是它可信的前提——手写的清单迟早对不上真实行为。

快照顶层记录 openwiki 版本、协议版本、serverInfo、instructions 与 tools 数组。当前快照含 10 个工具，从 openwiki_list_workspaces、openwiki_list_wikis、openwiki_search、openwiki_read 到 openwiki_begin、openwiki_submit_plan、openwiki_next_page、openwiki_inspect_page_claims、openwiki_submit_page、openwiki_finish。每个工具带完整的 inputSchema，这正是漂移检测要比对的部分。

## 生成：连接真实后端

`scripts/gen-manifest.mjs`（`npm run manifest`）做的事情很直接：

1. `resolveOpenwikiRuntime()` 解析出被锁版本的 openwiki；
2. 以 `process.execPath` 加绝对 `cliJs` 路径 spawn 后端（与运行时同一套 spawn 纪律）；
3. `initialize` → `notifications/initialized` → `tools/list`，超时 600 秒（冷启动本来就慢）；
4. 把三段应答组装成快照形状；
5. `finally` 里 `clearTimeout` 加 `stdin.end()` 加 `kill()`，不留后端进程。

后端在返回清单前退出时，报错信息里带上 stderr 最后 800 字节。

## 运行时选取

文件名带版本号，运行时按**实际解析到的 openwiki 版本**取。`loadManifest` 在文件不存在时返回 `null`，其他错误照抛——「这个版本没有录过」和「文件坏了」是两回事，不该混成静默降级。

## 缺失即直通模式

`null` 的含义在注释里写得很明确：这个 openwiki 版本还没有录过应答，因此 broker 必须退回真实后端，而不是从缓存回答。

对应行为是：`runMcpCommand` 打一条 warn 说明已降级，首次工具调用需要等后端启动；broker 不再即时应答 `initialize` 与 `tools/list`，一律走真实后端。

这条规则的口径是**宁慢不假**：给宿主一份对不上的工具清单，比慢几秒严重得多——前者会让宿主基于不存在的参数发起调用，失败原因还难以定位。

## 漂移检测：两处实现

**broker 运行时**（自动，只告警一次）：拿到真实清单后与快照比对，同时比较工具名与 `inputSchema` 的 JSON 串。命中后 warn 一次提示重新生成 manifest，但返回给宿主的清单仍以后端为准。

**doctor**（显式，给人看）：`diffTools` 输出名单，只在实况侧出现的工具加 `+ name`，只在快照侧存在的加 `- name`，并提示运行 `npm run manifest`。

因为 launcher 在漂移时仍可用（走真实清单），doctor 对漂移只告警并返回 0，只有与真实后端握手失败才返回 1。

## 发布约束

`manifest/openwiki-<版本>.json` 必须随 npm 包一起发布，否则用户装到的 launcher 永远走直通模式，快路径形同虚设。`test/release.test.mjs` 用 `npm pack --dry-run` 的文件清单把这一点钉住。

## 相关页面

- [MCP 请求代理（broker）](./mcp-broker.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
- [系统总览](../architecture/overview.md)
