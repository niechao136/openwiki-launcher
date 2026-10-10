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

把宿主的 MCP 配置指向本包。以 CodeBuddy 为例（Settings → MCP → Add MCP）：

```json
{
  "mcpServers": {
    "openwiki": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<全局 node_modules>/openwiki-launcher/bin/openwiki-launcher.mjs",
        "mcp", "--host", "codebuddy"
      ]
    }
  }
}
```

`--host` 接受任意 1-64 位小写字母、数字或连字符（CodeBuddy 填 `codebuddy`，
Claude Code 填 `claude-code`），它只用于在 openwiki 侧标记宿主身份。

全局安装的路径可用 `npm root -g` 查看：`<npm root -g>/openwiki-launcher/bin/openwiki-launcher.mjs`。

宿主还需要知道何时使用这些工具：把 openwiki 的 skill 目录放进宿主的技能目录，
例如 CodeBuddy 的 `.codebuddy/skills/openwiki/`（内容见 `node_modules/openwiki/integrations/openwiki/`）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `openwiki-launcher mcp [--host <id>]` | 作为 MCP 服务器运行，宿主配置指向这里 |
| `openwiki-launcher warm` | 启动一次后端到就绪后退出，用于预热 |
| `openwiki-launcher doctor` | 检查 Node、openwiki、快照与真实后端是否一致 |
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
| 首次调用很慢 | 正常：那是 openwiki 自己的导入时间。之后调用是透传 |
| `doctor` 报清单差异 | 按提示运行 `npm run manifest`（或在本仓库 `node scripts/gen-manifest.mjs`）重新生成快照 |
| Windows 上后端起不来 | 建议把 Node 与 openwiki 依赖目录加入 Microsoft Defender 排除项，冷启动会快很多 |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `LAUNCHER_DEBUG=1` | 打印详细诊断（stderr） |
| `LAUNCHER_REAL_SMOKE=1` | 启用真实后端冒烟测试 |
| `LAUNCHER_BACKEND_CLI` | 覆盖后端入口，仅供测试与排障使用 |

## 当前范围

本版本只交付 MCP 代理与诊断命令。宿主 skill 的命令行自动安装（`install` / `uninstall`）
尚未提供，请按上面说明手动复制 skill 目录。

## License

MIT
