---
type: guide
title: "快速上手"
description: openwiki-launcher 解决什么问题，以及安装、自检、预热、接入宿主、卸载的最小可用流程与故障处置。
tags: [quickstart, getting-started, troubleshooting]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-b4ad9d6666f93bb20232315a
    resource: repo://src/commands/doctor.mjs
  - id: openwiki-source-ae090dd614b550bc566d7b91
    resource: repo://src/commands/warm.mjs
  - id: openwiki-source-b995d49faa81ab47b4496f9b
    resource: repo://src/install.mjs
  - id: openwiki-source-6cd2ed5cbb573f14d226c8d3
    resource: repo://src/node-version.mjs
  - id: openwiki-source-25b67ca644bd99d29a60497f
    resource: repo://src/plan.mjs
  - id: openwiki-source-f90d4cc4e5fe713bf843ecab
    resource: repo://src/registry.mjs
  - id: openwiki-source-ab08d4a1ad09c1011d155d01
    resource: repo://src/self-path.mjs
  - id: openwiki-source-94ff95c1f11b8b7df6ddb6c1
    resource: repo://src/uninstall.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 快速上手

## 它解决什么问题

`openwiki mcp` 冷启动时要导入整套应用图，Windows 实测 30 到 50 秒，热缓存也约 7 秒。对初始化超时较短的宿主，这直接表现为 `MCP error -32001: Request timed out`——握手失败，工具根本用不上。

openwiki-launcher 是插在宿主与 openwiki 之间的一个零依赖代理：握手与工具清单由内置快照即时应答，openwiki 后端在后台按需启动。宿主不再需要等待那几十秒。

## 前置条件

Node.js **>= 22.22.0**。版本不达标时所有命令（除 `help` 与 `version`）直接返回 1。

## 最小可用流程

```sh
# 1. 安装本包（尚未发布到 npm，需从 GitHub 装）
npm install -g git+https://github.com/niechao136/openwiki-launcher.git

# 2. 自检：Node、openwiki 依赖、快照、已写入的 MCP 命令、真实后端握手
openwiki-launcher doctor

# 3. 装到自动检测到的宿主（项目级）
openwiki-launcher

# 4. 可选：预热后端，让第一次工具调用更快
openwiki-launcher warm
```

第 3 步之后**要让宿主重连**（多数 IDE 需要重启或刷新 MCP 列表）才能用上。

## 安装选项

| 命令 | 作用 |
| --- | --- |
| `openwiki-launcher` | 项目级：自动检测当前项目里装了哪些宿主 |
| `openwiki-launcher --global` | 用户级：所有项目共享 |
| `openwiki-launcher --tool codebuddy` | 显式指定宿主（支持别名，如 `cc` → `claude`） |
| `openwiki-launcher --uninstall` | 卸载（可加 `--global`） |
| `openwiki-launcher --force` | 允许在用户主目录里做项目级安装 |
| `openwiki-launcher --no-takeover` | 遇到 openwiki 原生安装时跳过而非接管 |

安装器做三件事：把 skill 目录复制进该宿主的技能目录、把 MCP 配置写成指向本包代理进程的条目（**不是**裸 `openwiki` 命令，那条路径要等 30 到 50 秒）、并在宿主没有 MCP 客户端能力时只装 skill。

28 家宿主里，8 家的 MCP 配置由安装器直接写盘；其余 18 家的 MCP 配置入口在宿主 UI 里，安装器会打印一段可直接粘贴的 JSON；另有 2 家只装 skill。完整清单见[宿主注册表](./installer/host-registry.md)。

自动检测落空时安装器会扫 PATH 并给出可直接复制的 `--tool <id>` 命令——**只提示不自动安装**，因为 IDE 装在应用目录里，PATH 上探不到。

## 卸载

```sh
openwiki-launcher --uninstall            # 项目级
openwiki-launcher --uninstall --global   # 用户级
```

卸载**只删自己写过的东西**：skill 目录要收据与逐文件 sha256 全匹配才删（你手改过就跳过并说明），MCP 条目要确认指向本安装器才删（指向别处的一律不碰）。备份文件形如 `*.openwiki-launcher-backup-*`，**不会自动删除**，确认无误后可自行清理。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户或环境错误：未知宿主、该宿主不支持此作用域、找不到 openwiki 依赖、doctor 与真实后端握手失败、安装执行失败并已回滚 |
| 2 | 护栏拒绝（系统目录、或在主目录做项目级安装），**一个字节都不会写** |

## 常见故障与第一处置

| 现象 | 处理 |
| --- | --- |
| 宿主仍报 `-32001` | 先跑 `openwiki-launcher warm` 预热，再让宿主重连 |
| 首次调用很慢 | 正常：那是 openwiki 自己的导入时间，之后调用是透传 |
| `doctor` 报工具清单差异 | 按提示运行 `npm run manifest` 重新生成快照 |
| `doctor` 报「MCP 命令指向」不一致 | 你升级过 node，配置里存的是旧绝对路径。重跑 `openwiki-launcher` 即可 |
| 安装退出码 2 | 护栏拒绝了，没有写入任何文件。主目录场景可加 `--force` 或改用 `--global` |
| 想保留 openwiki 原生安装 | 加 `--no-takeover`，安装器会跳过该宿主而不是接管 |
| Windows 上后端起不来 | 建议把 Node 与 openwiki 依赖目录加入 Microsoft Defender 排除项，冷启动会快很多 |

排障时加 `LAUNCHER_DEBUG=1` 打开详细诊断（写 stderr，不污染 MCP 通道）。

## 手动配置 MCP（不走安装器时）

以 CodeBuddy 为例，在它的 MCP 设置里添加：

```json
{
  "mcpServers": {
    "openwiki": {
      "type": "stdio",
      "command": "<node 的绝对路径>",
      "args": ["<全局 node_modules>/openwiki-launcher/bin/openwiki-launcher.mjs", "mcp", "--host", "codebuddy"]
    }
  }
}
```

`command` 写 node 的**绝对路径**而不是 `"node"`——本包存在的意义就是消灭全局路径探测、空格路径与 nvm shim 这三类故障，配置里不该再留一个要靠 PATH 解析的东西。安装器会自动填好；全局安装路径可用 `npm root -g` 查看。

`--host` 接受任意 1 到 64 位小写字母、数字或连字符，它只用于在 openwiki 侧标记宿主身份。

## 下一步

- 想理解为什么这样设计：[系统总览](./architecture/overview.md)
- 想接入更多宿主：[宿主注册表](./installer/host-registry.md)
- 命令与参数细节：[命令行接口与 doctor 自检](./commands/cli-and-doctor.md)
