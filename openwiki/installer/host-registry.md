---
type: reference
title: 宿主注册表：28 家 AI 编码宿主的统一描述
description: src/registry.mjs 的条目字段语义、8 家可直写 / 18 家仅打印片段 / 2 家只装 skill 的分组判据、别名解析、PATH 探测与自校验规则。
tags: [registry, hosts, detection, install-targets]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-f90d4cc4e5fe713bf843ecab
    resource: repo://src/registry.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 宿主注册表：28 家 AI 编码宿主的统一描述

## 这张表为什么存在

安装器要回答三个问题：**这个宿主装了吗？装到哪个目录？MCP 配置写到哪里？** 28 家宿主把这三个问题的答案写在一个数据表里（`src/registry.mjs`），其余模块只消费这个表。

路径知识有两个来源，都要求有出处，不猜：superpowers-zh 的 TARGETS 表（26 家宿主的 skills 目录，每条附官方文档或 issue 编号）与 openwiki 自身的宿主注册表（8 家已注册宿主的 MCP 配置路径与格式）。两表重叠 6 家，并集 28 家。表里每条下面的注释保留出处标注，这是「不确认不写、不猜路径」口径的可审计资产。

## 条目字段

```js
{
  id, displayName,
  skill: {
    projectDir,      // 项目级技能目录，相对项目根；null 表示该宿主没有项目级概念
    detect: [...],   // 项目级存在性标记（目录或文件）
    globalDir,       // 用户级技能目录，相对 home
    globalDirWin,    // Windows 上不同的用户级目录（仅 crush、reasonix）
    globalDetect,    // 用户级存在性标记
    bootFile,        // 引导文件路径；0.2.0 未启用
  },
  noProjectReason,   // projectDir 为 null 时必须给出的人读理由
  mcp: { kind, containerKey, userPath, projectPath } | null,
  native: { skillDir, receipt } | null,
}
```

`normalizeHost` 在导出前把数据表整形成**消费端可以无差别处理**的形状：`detect` / `globalDetect` / `aliases` 一律是数组（数据表允许写单字符串）；`globalDir`、`globalDirWin`、`globalDetect`、`bootFile`、`noProjectReason`、`mcp`、`native` 缺省时显式补 `null`。这样「不支持」在数据上是一个**值**，而不是「键不存在」——消费端 `h.native` 与 `h.native === null` 的判断不会因为漏写键而分叉。

## 分组判据

分组的唯一标准是 **`mcp.kind`**：这个宿主的 MCP 配置入口，我们是否有**已核实的落盘路径与格式**。

### A 组：8 家，MCP 配置直接写盘

`NATIVE_IDS` 列的就是这 8 家——它们在 openwiki 自身注册表里已注册，格式有 ground truth。

| id | 显示名 | 技能目录（项目 / 用户） | MCP 格式 | 用户级配置路径 | 项目级配置路径 |
| --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code | `.claude/skills` / `.claude/skills` | json (`mcpServers`) | `.claude.json` | `.mcp.json` |
| `cursor` | Cursor | `.cursor/skills` / — | json (`mcpServers`) | `.cursor/mcp.json` | `.cursor/mcp.json` |
| `codex` | Codex CLI | `.agents/skills` / `.agents/skills` | codex-toml (`mcp_servers`) | `.codex/config.toml` | `.codex/config.toml` |
| `kiro` | Kiro | `.kiro/skills` / — | json (`mcpServers`) | `.kiro/settings/mcp.json` | 同左 |
| `opencode` | OpenCode | `.opencode/skills` / `.config/opencode/skills` | opencode-json (`mcp`) | `.config/opencode/opencode.jsonc` | `opencode.jsonc` |
| `antigravity` | Antigravity | `.agents/skills` / **—** | json (`mcpServers`) | `.gemini/config/mcp_config.json` | `.agents/mcp_config.json` |
| `bob` | IBM Bob | `.agents/skills` / `.agents/skills` | json (`mcpServers`) | `.bob/mcp.json` | 同左 |
| `omp` | Oh My Pi | `.omp/skills` / `.omp/agent/skills` | json (`mcpServers`) | `.omp/agent/mcp.json` | `.omp/mcp.json` |

几条值得注意的目录知识：

- **Codex 各层级扫的都是 `.agents/skills`，从不扫 `.codex/skills`。** 它与 Antigravity 共用 `.agents/skills` 是预期的——两者共用这个开放约定。
- **OpenCode 同时扫 `.claude/skills` 与 `.agents/skills`**，所以装过那两家的项目它能直接读到。
- **omp 的项目级与用户级不同构**：用户级默认指向 agent 目录 `.omp/agent/skills`，命名 profile 与 `PI_CODING_AGENT_DIR` 覆盖的设置应该用项目级。

### B 组：18 家，MCP 配置只打印片段（`kind: "manual"`）

这些宿主的 skills 目录知识是核实的，但 MCP 配置入口在 IDE UI 里，或者磁盘路径/键名未经证实。安装器会打印一段可直接粘贴的 JSON，不写盘。每条注释里写明「需要核实什么」：

| id | 显示名 | 项目级目录 | 用户级目录 | 待核实事项 |
| --- | --- | --- | --- | --- |
| `gemini-cli` | Gemini CLI | `.gemini/skills` | — | `settings.json` 的 mcpServers 键；全局需走扩展目录 |
| `trae` | Trae | `.trae/skills` | — | MCP 配置是 UI 还是磁盘文件 |
| `trae-cn` | TRAE CN | — | `.trae-cn/skills` | 同 Trae |
| `vscode` | VS Code | `.github/superpowers` | — | `.vscode/mcp.json` 与用户级 mcp.json 的键名 |
| `openclaw` | OpenClaw | `skills` | `.openclaw/skills` | 配置是否落在 `~/.openclaw/` 下 |
| `windsurf` | Windsurf | `.windsurf/skills` | **`.codeium/windsurf/skills`** | `~/.codeium/windsurf/mcp_config.json` |
| `qwen-code` | Qwen Code | `.qwen/skills` | `.qwen/skills` | 是否沿用 `~/.gemini/` 约定 |
| `hermes` | Hermes Agent | `.hermes/skills` | `.hermes/skills` | `config.yaml` 的 MCP 段（yaml，需新增第四种 kind） |
| `claw-code` | Claw Code | `.claw/skills` | — | MCP 配置来源（可能仅读 CLAUDE.md） |
| `qoder` | Qoder | `.qoder/skills` | `.qoder/skills` | `~/.qoder/` 下的配置格式 |
| `codebuddy` | CodeBuddy | `.codebuddy/skills` | `.codebuddy/skills` | 规格已定：入口在 IDE UI，磁盘路径未确认 |
| `codearts` | CodeArts | `.codeartsdoer/skills` | `.codeartsdoer/skills` | MCP 配置入口 |
| `reasonix` | Reasonix | `.reasonix/skills` | `.reasonix/skills`（Win: `AppData/Roaming/reasonix/skills`） | `reasonix.toml` 的 MCP 表名（需新增 kind） |
| `dsh` | DeepSeek Harness | `.dsh/skills` | `.dsh/skills` | `dsh.json` 的 MCP 键结构 |
| `zcode` | ZCode | — | `.zcode/skills` | MCP 配置入口 |
| `crush` | Crush | `.crush/skills` | `.config/crush/skills`（Win: `AppData/Local/crush/skills`） | `~/.config/crush/mcp.json` |
| `cline` | Cline | `.cline/skills` | — | 是否支持 MCP 客户端 |
| `kilo-code` | Kilo Code | `.kilocode/skills` | — | 是否支持 MCP 客户端 |

Windsurf 的用户级目录是**反直觉**的：`~/.codeium/windsurf/skills`，不是 `~/.windsurf/skills`——已核实。

### C 组：2 家，无 MCP 客户端能力（`mcp: null`）

| id | 显示名 | 项目级目录 | 说明 |
| --- | --- | --- | --- |
| `aider` | Aider | `.aider/skills` | 靠 `SKILL.md` 自带的降级路径工作；`CONVENTIONS.md` 需 `aider --read` 才加载 |
| `deerflow` | DeerFlow | `skills/custom` | 自动扫描 `skills/public` 与 `skills/custom`，后者默认 gitignore |

## 特殊裁决及其理由

**`projectDir: null` 必须配 `noProjectReason`。** 只有两家：`trae-cn` 与 `zcode`。

- TRAE CN 的项目级技能目录与国际版完全相同（`.trae/skills/`），已由 Trae 那条覆盖。这条只承担 TRAE CN 独有的全局目录 `~/.trae-cn/skills`，所以 `--tool trae-cn --global` 才是它的正确用法。
- ZCode 的项目级技能在「设置 → 技能」里通过 UI 导入，官方文档从未暴露项目级磁盘路径。这是证据决定的，不是偷懒——理由文案直接告诉用户改用 `--global --tool zcode`。

**`globalDir: null` 表示刻意不给全局目录**，目前只有 Antigravity。理由写在注释里：superpowers-zh 明确标注「未在 docs 证实」，而 openwiki 注册表声称的全局路径引用的文档 URL 其实是 MCP 文档，并未证实 skills 加载路径。保守方向的代价是拒绝了少数可用情况，冒进方向的代价是装到不扫描的目录（装了不生效）——后者正是本项目要消灭的失败模式。

**`globalDirWin` 目前只有 crush 与 reasonix。** 两者的 Windows home 与 Unix 不同构：Crush 的 README 给 Windows 用户的命令是 `mkdir "$env:LOCALAPPDATA\crush\skills"`，Reasonix 的文档写明 Windows 是 `%APPDATA%\reasonix`。`skillsDirFor` 在 win32 上优先取这一列。

**`bootFile` 字段保留但 0.2.0 不写。** 引导文件要动用户自己的 `CLAUDE.md` / `AGENTS.md`，是侵入性最强、收益最不确定的一步，因此 `--bootstrap` 在 0.2.0 是带提示的 no-op。

## 别名与探测

`ALIASES` 把用户可能输入的各种写法映射到规范 id：`cc` / `claudecode` / `copilot` → `claude`，`gemini` → `gemini-cli`，`codebuddy-cn` → `codebuddy`，`huawei` → `codearts`，`deepseek` → `dsh`，等等。`findHost` 先按 `id` 命中，再查别名表。

`shortestAlias(id)` 反查该宿主最短的别名，用于拼出可直接复制的 `--tool <id>` 命令。

`CLI_PROBES` 只列 CLI 类宿主（claude、codex、gemini、opencode、aider、qwen、openclaw、claw、crush、hermes），**不列 IDE**——Cursor、Trae、Qoder 这类装在应用目录里，PATH 上探不到。检测落空时扫 PATH 给出建议，只提示不自动安装。

`isOnPath` **只查文件是否存在，绝不 spawn 探测命令**——既慢又有副作用风险。win32 下按 `;` 切 PATH 并按 `PATHEXT` 展开后缀，单个路径不可访问时吞掉异常继续。

## 自校验闸门

`validateRegistry()` 是「不猜路径」口径的自动化闸门，返回问题列表（空数组表示合法）：

- `id` 唯一且匹配 `/^[a-z0-9-]{1,64}$/`；
- `projectDir` 为 `null` 时必须有 `noProjectReason` 字符串；`projectDir` 为 `undefined` 视为未声明（必须显式写 `null`）；
- 有 `globalDir` 必须有 `globalDetect`；有 `globalDirWin` 必须有 `globalDir`；
- `mcp` 必须是 `null` 或合法 kind；三种可自动写的 kind 必须同时给出 `containerKey`、`userPath`、`projectPath`；
- `native` 字段只能出现在 `NATIVE_IDS` 这 8 家身上，且 `receipt` 必须是 `.openwiki-install.json`；
- `ALIASES` 与 `CLI_PROBES` 的每个键都必须指向已注册宿主。

新增宿主时若漏填字段、id 不合法、声称可自动写 MCP 却没有路径，立刻在这里暴露，而不是等到某台机器上装错。

## 相关页面

- [安装决策器与安装编排](./install-plan.md)
- [MCP 配置文件读写](./mcp-config-writer.md)
- [快速上手](../quickstart.md)
