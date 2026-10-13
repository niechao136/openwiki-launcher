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
| `openwiki-launcher warmup --host <id>` | 确保 holder 常驻且后端就绪（适合挂登录启动项） |
| `openwiki-launcher doctor` | 检查 Node、openwiki、快照、真实后端与已写入的 MCP 命令 |
| `openwiki-launcher check` | 查看本地 openwiki 版本状态：当前生效版本、已装版本与快照、registry 最新版 |
| `openwiki-launcher update [--version <v>]` | 升级 openwiki：列出可选版本交互确认后安装、生成快照并切换（`--no-switch` 只装不切） |
| `openwiki-launcher switch <version>` | 切换当前生效的 openwiki 版本（已装版本间毫秒级，可秒回滚） |
| `openwiki-launcher versions remove <v>` | 删除一个已安装的 openwiki 版本（快照保留，拒删当前激活版本） |
| `openwiki-launcher help` / `version` | 帮助与版本 |

## 工作方式

- 宿主发来的 `initialize` 与 `tools/list` 由 `manifest/openwiki-<版本>.json` 快照即时应答，不触碰后端；
- 连接建立时即在后台预热后端：握手与清单毫秒应答的同时，openwiki 的冷启动（Windows 30-50 秒）
  与宿主连接后的操作重叠，首个工具调用大概率已就绪（`LAUNCHER_EAGER_START=0` 可关闭，恢复懒启动）；
- `tools/call` 在后端未就绪时排队（默认上限 25 秒，`LAUNCHER_QUEUE_TIMEOUT_MS` 可配），
  期间按宿主的 `progressToken` 流式发送 `notifications/progress`；超时返回明确的可重试错误
  （"请等待约 30 秒后重试"），宿主取消（`notifications/cancelled`）只终结该请求、不波及预热；
- 没有匹配快照的 openwiki 版本会自动降级为直通模式：不再即时应答，改为等待真实后端，
  宁可慢也不给宿主一份对不上的工具清单；
- 后端崩溃会自动重启一次，在途调用收到明确错误而不是无声挂起。

Holder 模式（`LAUNCHER_HOLDER=1`，可选）：默认每个宿主会话的 wrapper 各持有一个后端进程，
宿主一断开就回收——每个新会话都要重付一次冷启动。开启后，首个 wrapper 会以 detached 方式
拉起一个常驻 holder 进程（`openwiki-launcher holder --host <id>`），后端随之脱离宿主生命周期；
后续同宿主会话经 lockfile 与命名管道接入热后端，首个工具调用秒回。holder 空闲超过
`LAUNCHER_HOLDER_TTL_MINUTES` 自动退出；版本切换时旧 holder 自动换血；holder 拉不起或
管道连不上时 wrapper 自动回退到默认的进程内路径。两个已知边界：TTL 过期或重启机器后的
第一个会话仍要付冷启动（用 `openwiki-launcher warmup --host <id>` 挂登录启动项缓解，
`doctor` 会打印可复制的 schtasks 命令）；命名管道对本机任意进程可连——openwiki 工具
仅读写仓库内 wiki 文件，风险评估为可接受。

版本管理（0.3.0 新增）：openwiki 各版本 side-by-side 装在 launcher 自己的
`versions/<版本>/` 下，`versions/active.json` 指针决定生效版本——`check` 看状态、
`update` 交互确认式升级、`switch` 毫秒切换、`versions remove` 清理磁盘。解析顺序为
指针优先，指针缺失或损坏时回退出厂依赖（package.json 里钉的那个）并告警；
**全局安装的 openwiki 不参与解析**——launcher 只认自己包根下的 node_modules 与
versions/，想换版本请用上面的命令而不是 `npm install -g openwiki@x`。

冷启动治理（0.4.0 新增）：实测 openwiki 冷启动 33~120 秒（Windows 上 Defender 扫描
node_modules 是主因），0.4.0 用三招压缩它——排队上限降到 25s 并流式发 progress
（首个工具调用不再必然撞宿主超时）；可选的 holder 延迟回收（`LAUNCHER_HOLDER=1`，
见上）；后端 esbuild 单文件打包（`npm run bundle`，运行时自动优先使用，
缺失或不可用自动回退源码入口，`doctor` 一并给出 Defender 排除命令）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 宿主仍报 `-32001` | 先跑 `openwiki-launcher warm` 预热，再让宿主重连 |
| 首次调用很慢 | 连接时的后台预热没盖住：调用会排队等后端就绪，耗时是 openwiki 自己的导入时间，之后调用是透传。安装时的自动预热只能让 OS 文件缓存热着，隔了几小时就指望不上 |
| 预热超时/失败但安装成功 | 预热是优化不是安装的一部分，不影响退出码；可单独跑 `openwiki-launcher warm`（上限 60 秒） |
| `doctor` 报清单差异 | 按提示运行 `npm run manifest`（或在本仓库 `node scripts/gen-manifest.mjs`）重新生成快照 |
| `doctor` 报「MCP 命令指向」不一致 | 你升级过 node，配置里存的是旧绝对路径。重跑 `openwiki-launcher` 即可 |
| `doctor` 报版本指针损坏 | `versions/active.json` 解析不了，已自动回退出厂依赖。重跑 `switch <版本>` 或删掉该文件 |
| `check` 显示已装版本但快照 ✗ | 该版本没有快照，会以直通模式运行（首次工具调用等后端启动）。重跑 `update --version <该版本>` 或等下次升级补录 |
| 安装退出码 2 | 护栏拒绝了（系统目录、或在主目录里做项目级安装），没有写入任何文件。主目录场景可加 `--force` 或改用 `--global` |
| 想保留 openwiki 原生安装 | 加 `--no-takeover`，安装器会跳过该宿主而不是接管 |
| Windows 上后端起不来 / 冷启动慢 | 跑 `openwiki-launcher doctor`：它会打印可复制的 Defender 排除命令与 warmup 登录项模板；`npm run bundle` 生成单文件后端可显著缩短冷启动 |
| `update` 装版本时报 ECONNRESET / 缺 Python | openwiki 的新版本可能带原生模块（better-sqlite3），预编译二进制的下载源在 GitHub。用 npmmirror 镜像重试：`npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3`，然后重跑 `update` |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `LAUNCHER_DEBUG=1` | 打印详细诊断（stderr） |
| `LAUNCHER_REAL_SMOKE=1` | 启用真实后端冒烟测试 |
| `LAUNCHER_BACKEND_CLI` | 覆盖后端入口，仅供测试与排障使用 |
| `LAUNCHER_QUEUE_TIMEOUT_MS` | `tools/call` 排队等待后端就绪的上限（毫秒，默认 25000） |
| `LAUNCHER_HOLDER=1` | 启用 holder 模式：后端脱离宿主会话常驻（延迟回收，见下） |
| `LAUNCHER_HOLDER_TTL_MINUTES` | holder 无活跃连接后的存活时长（分钟，默认 30） |
| `LAUNCHER_EAGER_START=0` | 关闭连接时的后台预热，恢复懒启动（首个工具调用才启动后端） |

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
