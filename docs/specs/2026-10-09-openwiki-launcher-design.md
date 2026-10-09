# openwiki-launcher 设计规格

- 日期：2026-10-09
- 状态：待审阅
- 分析基础：openwiki@0.6.0 源码（d:/hub/openwiki）、superpowers-zh@1.7.14 安装器（d:/hub/superpowers-zh）
- 决策记录：封装形态为 npm 包；宿主范围 = superpowers-zh 26 家 ∪ openwiki 8 家注册宿主

## 1. 背景与目标

### 1.1 问题

openwiki 的 stdio MCP 服务（`openwiki mcp --host <id>`）存在启动瓶颈，实测（本机 Windows）：

| 场景 | initialize 响应耗时 |
|---|---|
| 文件缓存冷 + Defender 扫描 | >30s（最差 50s） |
| 缓存热，完整 CLI 入口 | ~7s |
| 缓存热，仅 import mcp/stdio.js | ~5.4s |
| 懒加载探针（检索 eager + 生命周期 lazy） | ~5.3s |

根因：CLI 入口静态引入完整应用图（Ink 界面、runners、langchain 链），约 290 个包；冷启动叠加 Defender 逐文件扫描。懒加载实测只省 ~1.7s，eager 底价（MCP SDK + 检索链 ~2.7s + 传输层间隙）无法达标，该路线已否决。

宿主侧症状：CodeBuddy 等短超时客户端报 `MCP error -32001: Request timed out`。

附带问题：`openwiki integrations install` 仅支持 8 家注册宿主（bob/codex/claude/opencode/cursor/kiro/omp/antigravity），未注册宿主（CodeBuddy、Gemini CLI、Trae 等）无安装自动化。

另注：`openwiki_search` 本身在本机（30 页 wiki、热缓存）需 7-9s，属 openwiki 检索实现的固有开销，本封装不解决，记录为上游 issue 线索。

### 1.2 目标

1. 宿主配置指向的进程（broker）毫秒级完成 MCP 握手；
2. 安装自动化覆盖约 28 家宿主（skill + 引导 + MCP 配置）；
3. openwiki 作为普通 npm 依赖被解析，消灭全局路径探测、空格路径、nvm shim 三类故障面；
4. openwiki 发版后的升级路径可由一条命令（doctor）核对完成。

### 1.3 非目标（YAGNI）

- 不耦合 openwiki 内部 dist API（仅黑盒 spawn 官方 CLI）；
- 不实现 HTTP/SSE 传输（仅 stdio）；
- 不做后端空闲回收（v2）；
- 不修改 openwiki 源码，v1 不覆写 8 家已注册宿主的原生 MCP 配置；
- 不解决 `openwiki_search` 单次调用延迟。

## 2. 总体架构

三个组件，唯一运行时依赖为 `openwiki`（精确锁版 `0.6.0`）：

```text
openwiki-launcher/
  bin/openwiki-launcher.mjs        # CLI 入口，纯 ESM
  src/broker.mjs                   # MCP 代理状态机
  src/manifest/openwiki-0.6.0.json # 按版本内置的后端响应快照
  src/registry.mjs                 # 宿主注册表（约 28 家，双能力字段）
  src/install.mjs | uninstall.mjs | warm.mjs | doctor.mjs
  src/util/{guard,sentinel,copy}.mjs
  test/
```

**两段会话数据流**：

```text
宿主 ◀─ 会话 A（broker 以 manifest 即答 initialize/tools/list）─▶ broker
broker ◀─ 会话 B（broker 作为唯一客户端与后端真实握手）─▶ openwiki mcp 子进程
```

宿主与后端无直连；`tools/call` 经 id 映射表（宿主 id ↔ 后端 id）转换，通知双向转发。宿主的 initialize 不透传（已由 manifest 代答）；会话 B 由 broker 拉起后端后自行完成。

后端启动：`spawn(process.execPath, [<依赖解析出的绝对 cli.js 路径>, "mcp", "--host", <id>])`。**硬约束：绝不裸调 `openwiki` 可执行文件**（Windows nvm `.exe` shim 不转发 stdio，实测握手超时）。

## 3. broker 协议细节

### 3.1 manifest 与版本一致性

- manifest 内容：`serverInfo`（name/version）、完整 `instructions`、10 个工具的 `name/description/inputSchema`，来源为对应版本 openwiki 的真实响应快照；
- 启动时读取依赖的 `openwiki/package.json` 版本号选择 manifest；
- **无匹配版本 → 降级直通模式**：initialize/tools/list 不再即答，排队等待后端真实响应。宁慢不假；
- 后端就绪后，broker 用真实 `tools/list` 与 manifest 比对，不一致以后端为准并向 stderr 告警（上游改版的哨兵）。

### 3.2 状态机

```text
COLD → SPAWNING → READY
SPAWNING 失败 → 退避 1s 重试 1 次 → 再失败 → FAILED
READY 中后端崩溃 → 在途 call 报错 → 自动重启 → 回 SPAWNING
```

`tools/call` 到达：READY 直接透传；COLD/SPAWNING 入队（120s 兜底超时）。

### 3.3 故障矩阵

| 场景 | broker 行为 | 宿主可见 |
|---|---|---|
| openwiki 依赖缺失/路径损坏 | 启动即失败，stderr 诊断，非零退出 | 连接错误（非挂死超时） |
| 版本无对应 manifest | 直通模式 + stderr 警告 | 慢但正确 |
| 后端 spawn 失败 | 退避 1s 重试 1 次 | 排队中 |
| 连续 2 次失败 | 队列内 call 全部返回有界 MCP 错误，转 FAILED | `isError: true` + 一句可读原因 |
| 后端运行中崩溃 | 在途 call 报错 → 重启 → 后续重新排队（`openwiki_begin` 的 runId 幂等设计保证续跑安全） | 单次失败，重试恢复 |
| 排队 >120s | 兜底 MCP 错误 | 明确失败 |
| 宿主断开 stdin | 杀后端、broker 退出，不留孤儿进程 | — |

### 3.4 日志

诊断全走 stderr（stdout 仅 JSON-RPC），`[launcher]` 前缀；`LAUNCHER_DEBUG=1` 开详细档。

## 4. 宿主注册表

### 4.1 条目结构（双能力字段）

```js
{
  id: "codebuddy",
  aliases: ["codebuddy", "codebuddy-cn"],
  skill: { dir: ".codebuddy/skills", detect: [".codebuddy", "CODEBUDDY.md"],
           global: { dir: ".codebuddy/skills", detect: ".codebuddy" },
           boot: { kind: "root-md", file: "CODEBUDDY.md" } },  // 需要引导的宿主才填
  mcp: null,   // 有把握才填：{ configPath, format: "json"|"toml"|"jsonc", entryTemplate }
               // 或 { kind: "manual" }（仅打印配置片段）
  producerActor: "codebuddy"
}
```

### 4.2 覆盖清单（约 28 家）

Claude Code、Cursor、Codex CLI、Kiro、OpenCode、Gemini CLI、Antigravity、CodeBuddy、Trae（+TRAE CN 全局）、Windsurf、Qoder、Qwen Code、VS Code (Copilot)、Cline、Kilo Code、Crush、OpenClaw、Claw Code、Aider、DeerFlow、Hermes Agent、Reasonix、DeepSeek Harness、ZCode、CodeArts、Bob、Oh My Pi (Pi)。

- `skill` 字段：superpowers-zh 26 家的路径知识直接继承（含 detect 标记、全局/项目级、`dirWin` Windows 差异）；
- `mcp` 字段：遵循"不确认不写"原则渐进填充。首版有把握的：openwiki 8 家的格式（json/codex-toml/opencode-json，转调原生安装）；CodeBuddy 标记 `manual`（MCP 配置入口在 IDE UI，首版打印片段）；
- 无 MCP 客户端能力的宿主（Aider、DeerFlow 等）`mcp` 恒为 null，仅装 skill——openwiki 的 SKILL.md 自带降级路径（"MCP 不可用时直接搜索 `openwiki/` Markdown"）。

### 4.3 安装产物

每家 = skill 目录（canonical bundle 复制，源为依赖的 openwiki 包内 `integrations/openwiki/`）+ 按需引导文件 + MCP 配置：

- 自动发现型宿主（Claude/Cursor/Codex 系）：无需引导文件；
- rules 常驻型宿主（Cline/Kiro steering/Qoder/Trae）：只放一张小索引（内容从 SKILL.md 提炼，数行），哨兵包裹；
- 根 md 型宿主（Gemini=QWEN.md、CodeBuddy=CODEBUDDY.md、Hermes/DSH=AGENTS.md 等）：小引导段，哨兵包裹；
- MCP 配置写入采用安全合并：保留用户已有内容，仅追加 `mcpServers.openwiki` 条目，冲突时提示而不覆盖。

### 4.4 从 superpowers-zh 继承的工程护栏

1. 系统目录护栏（拒绝写入 `System32` 等，无 `--force` 绕过）与主目录护栏（项目级安装拒绝 `~`）；
2. 检测快照先行：所有宿主的 detect 判定在写入任何文件之前完成（避免 A 的产物触发 B 的误检测）；
3. 哨兵注释（`<!-- openwiki-launcher:begin/end -->`）包裹引导段落，卸载精确切除；
4. 升级时清理旧布局残留；
5. 自动检测落空时不安装，扫描 PATH 给出 `--tool` 建议（只提示不执行）。

### 4.5 8 家已注册宿主策略

转调原生 `openwiki integrations install <host> [--project]`（其配置有 SHA-256 收据/备份/合并机制，不重写）。v2 再评估 `--backend=launcher` 覆写选项；v1 不碰原生安装过的配置。

## 5. CLI 命令规范

```text
openwiki-launcher                       # 项目级：自动检测宿主并安装（需在项目目录）
openwiki-launcher --global              # 用户级安装
openwiki-launcher --tool <id>           # 显式指定宿主
openwiki-launcher --uninstall [--global]
openwiki-launcher mcp [--host <id>]     # broker；host 需匹配 ^[a-z0-9-]{1,64}$
openwiki-launcher warm                  # 拉起后端至 READY 后退出
openwiki-launcher doctor                # 体检并输出核对报告
```

行为约定：

- `install` 成功后自动执行一次 `warm` 预热，并打印 Windows Defender 排除建议（排除 openwiki 依赖所在目录）；
- `doctor` 检查：node 版本（≥22.22.0）、openwiki 版本与 manifest 匹配、拉起后端冒烟握手、与 manifest 的工具清单比对；该命令同时是 openwiki 升级后的核对流程；
- 退出码：0 成功；1 用户/环境错误；2 安装护栏拒绝；
- `engines: { node: ">=22.22.0" }`，启动前置检查并给出可读报错。

## 6. 版本与依赖策略

- `"dependencies": { "openwiki": "0.6.0" }` 精确锁版：manifest 按版本内置，锁版保证必然匹配；
- 升级流程：openwiki 发新版 → 本仓库更新依赖 → `doctor` 比对新版真实 `tools/list` → 更新 manifest → changeset 发版；
- 不使用 peerDependencies/optionalDependencies（不依赖用户全局装的 openwiki，避免路径探测问题回归）。

## 7. 测试策略

- **单元**：注册表条目 schema 校验、护栏函数（系统/主目录）、哨兵切除、id 映射、manifest 选择逻辑；
- **集成**：以"故意慢启动的假 openwiki 后端"脚本驱动 broker 全路径（即答、排队、直通降级、spawn 重试、FAILED、崩溃重启、120s 超时、stdin 断开清理）——协议分支不依赖真实 openwiki；另有真实后端冒烟；
- **端到端**：临时 HOME + 临时项目目录执行 `install`，逐宿主断言产物路径与内容；断言护栏拒绝路径；8 家转调路径验证（mock 原生命令）；
- **平台**：CI 必跑 ubuntu + windows（Windows 覆盖空格路径、shim、System32 护栏），macOS 可选。

## 8. 发布与分发

- npm 公共包；GitHub Actions：tag → test → `npm publish --provenance`；
- changesets 管理版本与 changelog；
- 本包纯 `.mjs` 零构建，`npm i github:<仓库所有者>/openwiki-launcher` 无 `prepare` 负担，作为 Beta 通道（仓库地址发布时以实际为准）；
- README（中英）含逐宿主安装指引表与 CodeBuddy 手动 MCP 配置片段示例。

## 9. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| openwiki 发版频繁，manifest 维护滞后 | 直通模式降级保证"慢而不假"；doctor 一条命令核对 |
| 各宿主 MCP 配置格式核实工作量大 | "不确认不写"：未核实的宿主 `mcp` 置 null/manual，skill 照装 |
| CodeBuddy MCP 配置可能只能 UI 手工配置 | 首版 `manual` 模式打印片段；跟进官方文档确认磁盘路径后升级为自动写入 |
| 假后端测试与真实后端行为漂移 | 真实后端冒烟测试纳入 CI（安装 openwiki 依赖即可） |
| 与原生安装器在同一宿主上并存冲突 | 只清理自己哨兵标记的产物；检测到原生安装时提示并存关系 |

## 10. 成功标准

1. CodeBuddy 配置 `command: node, args: [<launcher bin>, "mcp", "--host", "codebuddy"]` 后，`initialize` 响应 <1s（宿主实测不再 -32001）；
2. 8 家已注册宿主 + CodeBuddy + Gemini CLI + Trae 四类代表路径上 `install` 端到端可用（其余宿主按注册表增量交付）；
3. 冷启动场景：首个工具调用最坏排队一次，重试即恢复；
4. `openwiki` 升级后 `doctor` 能在 5 分钟内完成核对并定位差异。
