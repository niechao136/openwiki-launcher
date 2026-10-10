# openwiki-launcher

毫秒级握手的 [openwiki](https://github.com/langchain-ai/openwiki) MCP 代理。

openwiki 自带的 `openwiki mcp` 在冷启动时要导入整套应用图（Windows 实测 30 秒到 50 秒，
热启动约 7 秒）。对 MCP 初始化超时较短的宿主（CodeBuddy 等），这会直接表现为
`MCP error -32001: Request timed out`。

本包把宿主直连的进程换成一个零依赖的代理：握手与工具清单由内置快照即时应答，
openwiki 后端在后台按需启动。宿主不再需要等待 openwiki 的导入时间。

> 本项目**尚未发布到 npm**，`npm install -g openwiki-launcher` 目前不可用，
> 请使用下面的 GitHub 安装方式。

## 快速开始

要求 Node.js >= 22.22.0，仓库地址 <https://github.com/niechao136/openwiki-launcher.git>。

### 从 GitHub 安装

直接从仓库安装为全局命令：

```sh
npm install -g git+https://github.com/niechao136/openwiki-launcher.git
openwiki-launcher warm        # 可选：预热后端，让第一次工具调用更快
```

不装到全局、只在当前项目使用：

```sh
npm install git+https://github.com/niechao136/openwiki-launcher.git
npx openwiki-launcher warm
```

也可以先克隆再本地安装（需要开发或改代码时用）：

```sh
git clone https://github.com/niechao136/openwiki-launcher.git
cd openwiki-launcher
npm install                # 安装依赖（含 openwiki 后端）
npm link                   # 注册全局 openwiki-launcher 命令
openwiki-launcher doctor   # 自检
```

### 接入宿主

**用安装器一步装好**（推荐）：

```sh
openwiki-launcher                    # 项目级：自动检测当前项目里装了哪些宿主
openwiki-launcher --global           # 用户级：所有项目共享
openwiki-launcher --tool codebuddy   # 显式指定宿主
```

安装器做四件事：把 openwiki 的 skill 目录复制进该宿主的技能目录、把 MCP 配置写成指向本包的
broker（**不是**裸 `openwiki` 命令，那条路径要等 30-50 秒的导入）、在宿主没有 MCP 客户端
能力时只装 skill，并在安装成功后**自动预热一次**后端（预热只留 OS 文件缓存，收益窗口取决于
你隔多久打开宿主；加 `--no-warm` 可跳过）。

支持的 28 家宿主里，8 家（Claude Code、Cursor、Codex CLI、Kiro、OpenCode、Oh My Pi、
IBM Bob、Antigravity）的 MCP 配置由安装器直接写入磁盘；CodeBuddy 等 18 家的 MCP 配置入口
在宿主 UI 里，安装器会打印一段可直接粘贴的 JSON。完整清单见 `docs/specs/`。

卸载：

```sh
openwiki-launcher --uninstall            # 项目级
openwiki-launcher --uninstall --global   # 用户级
```

卸载只删自己写过的东西：skill 目录要收据与逐文件 sha256 全匹配才删（你手改过就跳过并说明），
MCP 条目要确认指向本包才删（指向别处的一律不碰）。备份文件形如
`*.openwiki-launcher-backup-*`，不会自动删除。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户/环境错误（未知宿主、该宿主不支持此作用域、依赖缺失、执行失败并已回滚） |
| 2 | 护栏拒绝（系统目录、主目录），**一个字节都不会写** |

| 参数 | 作用 |
| --- | --- |
| `--tool <id>` | 指定宿主，支持别名（如 `cc` → `claude`） |
| `--global` | 用户级安装/卸载 |
| `--uninstall` | 卸载 |
| `--force` | 允许在用户主目录里做项目级安装（系统目录护栏**没有**这个绕过） |
| `--no-takeover` | 遇到 openwiki 原生安装时跳过而非接管 |
| `--bootstrap` | 额外写引导文件（0.2.0 未启用，仅打印提示） |
| `--no-warm` | 安装成功后不自动预热（默认会预热一次，上限 60 秒，失败不影响安装结果） |

自动检测基于各宿主的标记文件/目录。检测落空时会扫 PATH 给出可直接复制的
`--tool <id>` 命令，只提示不自动安装 —— IDE 装在应用目录里，PATH 上探不到。

### 手动配置 MCP（不走安装器时）

以 CodeBuddy 为例（Settings → MCP → Add MCP）：

```json
{
  "mcpServers": {
    "openwiki": {
      "type": "stdio",
      "command": "<node 的绝对路径>",
      "args": [
        "<全局 node_modules>/openwiki-launcher/bin/openwiki-launcher.mjs",
        "mcp", "--host", "codebuddy"
      ]
    }
  }
}
```

`command` 写 node 的**绝对路径**而不是 `"node"` —— 本包存在的意义就是消灭全局路径探测、
空格路径、nvm shim 这三类故障，配置里不该再留一个要靠 PATH 解析的东西。安装器会自动填好。

`--host` 接受任意 1-64 位小写字母、数字或连字符（CodeBuddy 填 `codebuddy`，
Claude Code 填 `claude`），它只用于在 openwiki 侧标记宿主身份。

全局安装的路径可用 `npm root -g` 查看：`<npm root -g>/openwiki-launcher/bin/openwiki-launcher.mjs`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `openwiki-launcher [install]` | 安装到自动检测到的宿主（项目级） |
| `openwiki-launcher --uninstall` | 卸载 |
| `openwiki-launcher mcp [--host <id>]` | 作为 MCP 服务器运行，宿主配置指向这里 |
| `openwiki-launcher warm` | 启动一次后端到就绪后退出，用于预热 |
| `openwiki-launcher doctor` | 检查 Node、openwiki、快照、真实后端与已写入的 MCP 命令 |
| `openwiki-launcher help` / `version` | 帮助与版本 |

## 工作方式

- 宿主发来的 `initialize` 与 `tools/list` 由 `manifest/openwiki-<版本>.json` 快照即时应答，不触碰后端；
- `tools/call` 在后端未就绪时排队（默认上限 120 秒），就绪后透传；
- 没有匹配快照的 openwiki 版本会自动降级为直通模式：不再即时应答，改为等待真实后端，
  宁可慢也不给宿主一份对不上的工具清单；
- 后端崩溃会自动重启一次，在途调用收到明确错误而不是无声挂起。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 宿主仍报 `-32001` | 先跑 `openwiki-launcher warm` 预热，再让宿主重连 |
| 首次调用很慢 | 正常：那是 openwiki 自己的导入时间。之后调用是透传。安装时的自动预热只能让 OS 文件缓存热着，隔了几小时就指望不上 |
| 预热超时/失败但安装成功 | 预热是优化不是安装的一部分，不影响退出码；可单独跑 `openwiki-launcher warm`（上限 60 秒） |
| `doctor` 报清单差异 | 按提示运行 `npm run manifest`（或在本仓库 `node scripts/gen-manifest.mjs`）重新生成快照 |
| `doctor` 报「MCP 命令指向」不一致 | 你升级过 node，配置里存的是旧绝对路径。重跑 `openwiki-launcher` 即可 |
| 安装退出码 2 | 护栏拒绝了（系统目录、或在主目录里做项目级安装），没有写入任何文件。主目录场景可加 `--force` 或改用 `--global` |
| 想保留 openwiki 原生安装 | 加 `--no-takeover`，安装器会跳过该宿主而不是接管 |
| Windows 上后端起不来 | 建议把 Node 与 openwiki 依赖目录加入 Microsoft Defender 排除项，冷启动会快很多 |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `LAUNCHER_DEBUG=1` | 打印详细诊断（stderr） |
| `LAUNCHER_REAL_SMOKE=1` | 启用真实后端冒烟测试 |
| `LAUNCHER_BACKEND_CLI` | 覆盖后端入口，仅供测试与排障使用 |

## 当前范围

已交付：broker（毫秒级握手）+ 28 家宿主的自动安装与安全卸载。

未交付：

- **引导文件**（`--bootstrap`）在 0.2.0 是带提示的 no-op。openwiki 只有一个 skill、
  其 `SKILL.md` 的 description 已是强触发词，而写引导文件要动用户自己的
  `CLAUDE.md` / `AGENTS.md` 等文件，是侵入性最强、收益最不确定的一步；
- **其余 18 家宿主的 MCP 配置**暂为 `manual`（只打印片段不写盘），因为它们的
  磁盘路径或配置入口未经核实。核实后把注册表里对应条目的 `mcp.kind` 改成已支持格式即可，
  不涉及其他模块改动。逐家「需要核实什么」写在 `src/registry.mjs` 的注释里；
- 无 MCP 客户端能力的宿主（Aider、DeerFlow）只装 skill，靠 `SKILL.md` 自带的降级路径工作。

## License

MIT
