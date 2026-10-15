---
type: guide
title: "快速上手"
description: openwiki-launcher 解决什么问题，三个全局命令的关系，安装、自检、预热、接入宿主、ow 透传、版本管理与卸载的最小可用流程，以及常见故障的第一处置。
tags: [quickstart, getting-started, troubleshooting, version-management]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-28b2a16f94b60fe1e536f6c6
    resource: repo://src/broker.mjs
  - id: openwiki-source-0cd1bc275c3f60f8f2c8999c
    resource: repo://src/cli.mjs
  - id: openwiki-source-b4ad9d6666f93bb20232315a
    resource: repo://src/commands/doctor.mjs
  - id: openwiki-source-f2765e03ab3c44ffdd8995a7
    resource: repo://src/commands/install.mjs
  - id: openwiki-source-ae090dd614b550bc566d7b91
    resource: repo://src/commands/warm.mjs
  - id: openwiki-source-739e2e8c589e83bab322e11f
    resource: repo://src/ensure-default.mjs
  - id: openwiki-source-b995d49faa81ab47b4496f9b
    resource: repo://src/install.mjs
  - id: openwiki-source-6cd2ed5cbb573f14d226c8d3
    resource: repo://src/node-version.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
  - id: openwiki-source-f90d4cc4e5fe713bf843ecab
    resource: repo://src/registry.mjs
  - id: openwiki-source-ab08d4a1ad09c1011d155d01
    resource: repo://src/self-path.mjs
  - id: openwiki-source-94ff95c1f11b8b7df6ddb6c1
    resource: repo://src/uninstall.mjs
  - id: openwiki-source-96d987ff5f91a05f973f4bfd
    resource: repo://src/versions.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 快速上手

## 它解决什么问题

`openwiki mcp` 冷启动时要导入整套应用图，Windows 实测 30 到 50 秒，热缓存也约 7 秒；Defender 实时扫描 node_modules 时可达 120 秒。对初始化超时较短的宿主，这直接表现为 `MCP error -32001: Request timed out`——握手失败，工具根本用不上。

openwiki-launcher 是插在宿主与 openwiki 之间的一个零依赖代理：握手与工具清单由内置快照即时应答，openwiki 后端在后台按需启动。宿主不再需要等待那几十秒。此外还有两招冷启动治理：**后端单文件 bundle**（自动优先使用）与**可选的 holder 常驻模式**（`LAUNCHER_HOLDER=1`）。

## 三个命令

package.json 的 `bin` 注册三个名字，覆盖两类职责：

| 命令 | 职责 |
| --- | --- |
| `owl` | launcher 的全部命令（`owl doctor`、`owl mcp`…），主推的短命令 |
| `openwiki-launcher` | `owl` 的全名，两者完全等价（同一入口文件） |
| `ow` | **纯透传** openwiki CLI：`ow visualize` 就是 `openwiki visualize` |

下文命令均用短名书写，全名同样有效。

## 前置条件

Node.js **>= 22.22.0**。版本不达标时所有命令（除 `help` 与 `version`）直接返回 1。

## 最小可用流程

```sh
# 1. 安装本包（尚未发布到 npm，需从 GitHub 装）
npm install -g git+https://github.com/niechao136/openwiki-launcher.git

# 2. 自检：Node、openwiki 依赖、快照、默认版本状态、已写入的 MCP 命令、真实后端握手
owl doctor

# 3. 装到自动检测到的宿主（项目级）
owl

# 4. 可选：预热后端，让第一次工具调用更快（安装成功后已自动预热过一次）
owl warm
```

第 3 步之后**要让宿主重连**（多数 IDE 需要重启或刷新 MCP 列表）才能用上。

装完后想直接用 openwiki 的命令行（可视化、link、交互式 agent）：

```sh
ow visualize --no-open --port 3939   # 本地可视化服务器
ow link ../another-repo              # 把另一个仓库链进来
ow                                    # 裸跑进入 openwiki 交互式 agent
```

<!-- openwiki: broken internal link [../commands/ow-passthrough.md] file "../commands/ow-passthrough.md" does not exist. Fix the href or restore the target, then delete this comment. -->
透传用的 openwiki 就是 launcher 自己管理的那一份，**不需要另外 `npm install -g openwiki`**；注意 `ow mcp` 是直连入口（冷启动 30 到 50 秒），宿主 MCP 配置请指向 `owl mcp`。详见[ow 透传](../commands/ow-passthrough.md)。

## 安装选项

| 命令 | 作用 |
| --- | --- |
| `owl` | 项目级：自动检测当前项目里装了哪些宿主 |
| `owl --global` | 用户级：所有项目共享 |
| `owl --tool codebuddy` | 显式指定宿主（支持别名，如 `cc` → `claude`） |
| `owl --uninstall` | 卸载（可加 `--global`） |
| `owl --force` | 允许在用户主目录里做项目级安装 |
| `owl --no-takeover` | 遇到 openwiki 原生安装时跳过而非接管 |
| `owl --no-warm` | 安装成功后不自动预热 |
| `owl --no-prepare` | 跳过「默认版本就绪」（物化 + bundle），与 `--no-warm` 正交 |

安装器做四件事：把 skill 目录复制进该宿主的技能目录、把 MCP 配置写成指向本包代理进程的条目（**不是**裸 `openwiki` 命令，那条路径要等 30 到 50 秒）、在宿主没有 MCP 客户端能力时只装 skill，并在安装成功后**自动预热一次**后端（预热只留 OS 文件缓存，失败不影响安装结果）。

28 家宿主里，8 家的 MCP 配置由安装器直接写盘；其余 18 家的 MCP 配置入口在宿主 UI 里，安装器会打印一段可直接粘贴的 JSON；另有 2 家只装 skill。完整清单见[宿主注册表](./installer/host-registry.md)。

自动检测落空时安装器会扫 PATH 并给出可直接复制的 `--tool <id>` 命令——**只提示不自动安装**，因为 IDE 装在应用目录里，PATH 上探不到。

## 默认版本就绪（0.5.0 起）

出厂依赖 `node_modules/openwiki` 本身不在版本仓库里。安装收尾（或 `warm` / `warmup` / 首次 MCP 会话的后台自愈）会把它**物化**成 `versions/<默认版本>/` 里的真实条目并生成 bundle，之后它与其它版本完全平权：

- `switch` 回默认版本是毫秒级指针翻转，**不再重新下载**；
- `check` / `doctor` 直接报它处于哪一态（未就绪 / 已物化无 bundle / 已就绪 / 退避中 / 已删除 / 未知）；
- 物化失败（离线、缓存未命中）只软着陆并告警，退避 24 小时内后台不再重试；显式跑 `install` / `warm` / `switch` 不受退避限制；
- `versions remove` 掉默认版本会写标记，后台自愈不会把它长回来。

想跳过全部就绪动作：`owl --no-prepare` 或 `LAUNCHER_PREPARE=0`。细节见[默认版本就绪：物化与自愈](./versions/default-readiness.md)。

## openwiki 版本管理

openwiki 各版本 side-by-side 装在 launcher 自己的 `versions/<版本>/` 下，`versions/active.json` 指针决定生效版本：

| 命令 | 作用 |
| --- | --- |
| `owl check` | 看状态：当前生效版本（指针还是出厂依赖）、默认版本状态、已装版本与快照、registry 最新版 |
| `owl update [--version <v>]` | 升级：列出可选版本交互确认后安装、生成快照并切换（`--no-switch` 只装不切） |
| `owl switch <version>` | 切换当前生效版本（已装版本间毫秒级，可秒回滚） |
| `owl versions remove <v>` | 删除一个已安装版本（快照保留，拒删当前激活版本） |

解析顺序是指针优先，指针缺失或损坏时回退出厂依赖并告警。**全局安装的 openwiki 不参与解析**——launcher 只认自己包根下的 `node_modules` 与 `versions/`，换版本请用上面的命令而不是 `npm install -g openwiki@x`。细节见[版本目录与生效指针](./versions/version-store.md)与[版本命令](./versions/version-commands.md)。

## 卸载

```sh
owl --uninstall            # 项目级
owl --uninstall --global   # 用户级
```

卸载**只删自己写过的东西**：skill 目录要收据与逐文件 sha256 全匹配才删（你手改过就跳过并说明），MCP 条目要确认指向本安装器才删（指向别处的一律不碰）。备份文件形如 `*.openwiki-launcher-backup-*`，**不会自动删除**，确认无误后可自行清理。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户或环境错误：未知宿主、该宿主不支持此作用域、找不到 openwiki 依赖、doctor 与真实后端握手失败、安装执行失败并已回滚、版本名非法或版本未安装 |
| 2 | 护栏拒绝（系统目录、或在主目录做项目级安装），**一个字节都不会写** |

## 常见故障与第一处置

| 现象 | 处理 |
| --- | --- |
| 宿主仍报 `-32001` | 先跑 `owl warm` 预热，再让宿主重连 |
| 首次调用很慢 | 正常：那是 openwiki 自己的导入时间，之后调用是透传。排队期间 broker 会按 `progressToken` 流式发进度，超时会给出「请等待约 30 秒后重试」的可重试错误 |
| `doctor` 报工具清单差异 | 按提示运行 `npm run manifest` 重新生成快照 |
| `doctor` 报「MCP 命令指向」不一致 | 你升级过 node，配置里存的是旧绝对路径。重跑 `owl` 即可 |
| `doctor` 报版本指针损坏 | `versions/active.json` 解析不了，已自动回退出厂依赖。重跑 `switch <版本>` 或删掉该文件 |
| `check` 显示已装版本但快照 ✗ | 该版本没有快照，会以直通模式运行（首次工具调用等后端启动）。重跑 `update --version <该版本>` 补录 |
| 安装退出码 2 | 护栏拒绝了，没有写入任何文件。主目录场景可加 `--force` 或改用 `--global` |
| 想保留 openwiki 原生安装 | 加 `--no-takeover`，安装器会跳过该宿主而不是接管 |
| `ow` 报「未找到可用的 openwiki」 | launcher 包内的 openwiki 不可读（安装不完整或被清理过）。重跑安装器（`owl install`）修复；只想物化默认版本也可以 `owl warm` |
| `doctor` / `check` 报默认版本未就绪 | 出厂依赖还没物化进 `versions/`。跑 `owl warm`（或重跑安装器）即可；只做过 `npm install -g` 而没跑过安装器时，首次 MCP 会话仍偏慢，会话结束后后台会补上 |
| `switch` 回默认版本时它又要下载 | 默认版本还没被物化。`owl warm` 一次即可（之后 `switch` 回它是指针翻转） |
| 删掉默认版本后又被自动重建 | 不会：`owl versions remove <默认版本>` 会记一条标记，后台自愈不再重建；只有显式命令会重建并清掉标记 |
| `update` / `switch` 后提示 bundle 未就绪 | 跑 `owl warm`：它会先补打当前版本的 bundle 再预热（首次 MCP 会话也会在后台自动补打，下次会话生效）。bundle 缺失只影响冷启动速度，不影响工具可用性 |
| Windows 上后端起不来 / 冷启动慢 | 跑 `owl doctor`：它会打印可复制的 Defender 排除命令与 warmup 登录项模板；`npm run bundle` 生成单文件后端可显著缩短冷启动 |
| `update` 装版本时报 ECONNRESET / 缺 Python | openwiki 的新版本可能带原生模块（better-sqlite3），预编译下载源在 GitHub。用 npmmirror 镜像重试：`npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3`，然后重跑 `update` |
| 每天都付冷启动 | 可选 holder 模式：`LAUNCHER_HOLDER=1` 让后端脱离宿主会话常驻（空闲 30 分钟后回收）；再把 `owl warmup --host <id>` 挂登录启动项（`doctor` 会打印可复制的 schtasks 命令），首个会话即接入热后端 |

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
- 想用 openwiki 自己的命令：[ow 透传](./commands/ow-passthrough.md)
- 想升级、切换或清理 openwiki：[版本命令](./versions/version-commands.md)
- 想搞懂默认版本就绪：[默认版本就绪：物化与自愈](./versions/default-readiness.md)
- 想让后端常驻、免掉每天第一次冷启动：[常驻后端（holder）](./runtime/holder.md)
