# openwiki-launcher 安装器 设计规格

- 日期：2026-10-10
- 状态：待审阅
- 前序规格：`docs/specs/2026-10-09-openwiki-launcher-design.md`
- 范围：实现前序规格第 4 节（宿主注册表 + 安装器），即「计划二」
- 版本承诺：包版本 `0.1.0` → `0.2.0`（`src/cli.mjs:114-117` 已埋占位桩）

---

## 1. 背景与决策

### 1.1 前序规格的三处修正

前序规格第 4 节写于动手核实上游源码之前，有三处在实现时必须修正。

**修正一：4.5「转调原生安装器」作废，改为 launcher 自写 MCP 配置。**
前序规格 4.5 要求 8 家已注册宿主转调 `openwiki integrations install <host>`。核实后该路径不可用：原生写入的 MCP 命令固定为 `{command: "openwiki", args: ["mcp", "--host", <id>]}`（`openwiki/src/integrations/install/registry.ts:169-176`），而 `openwiki` 裸命令正是本规格要消灭的冷启动慢路径（Windows 实测 30-50 秒）。照 4.5 执行，8 家宿主安装后仍然超时，broker 的价值不成立。

代价：SHA-256 收据、备份、合并、回滚这四项机制需要自己实现，逻辑从 `openwiki/src/integrations/install/{skill-bundle,installer,install-paths,config-json,config-toml,config-opencode}.ts` 移植。

**修正二：4.2「MCP 格式不确认不写」的 pessimism 可以放松。**
前序规格成文时 8 家的 MCP 配置格式未经核实，故写「不确认不写」。现已从 `registry.ts:10-142` 取得全部 8 家的用户级/项目级路径与格式 ground truth（见 3.1），无需再猜。

**修正三：4.3 的四类引导产物延后，首版默认不写。**
核实结论是 openwiki 原生安装器**完全不写引导文件**（`registry.ts` 无 bootstrap 字段），只装 skill bundle 与 MCP 配置。而 openwiki 只有一个 skill、其 `SKILL.md` frontmatter 的 `description` 已是强触发词。前序规格设计的四类引导产物（常驻 rules / 根 md 小段）全部要写入用户自己的 `CLAUDE.md`、`AGENTS.md`、`GEMINI.md` 等文件，是整个安装器中侵入性最强、收益最不确定的一步。

决策：引导文件保留为注册表字段（`skill.bootFile`）与 `--bootstrap` 可选开关，首版默认关闭。待 MCP 与 skill 链路在真实宿主上验证过「不装引导也能触发」之后再评估默认开启。

### 1.2 已裁决的决策

| 议题 | 决策 |
| --- | --- |
| 装出来的 MCP 命令指向哪 | launcher 自己写配置，指向自身 `bin`，不走原生安装器 |
| 首版宿主覆盖 | 全量 28 家；skill 全装，MCP 按已核实/待核实分档 |
| 与 openwiki 原生安装共存 | 原地接管（替换 MCP 条目 + 更替收据），提供 `--no-takeover` 退出 |
| 引导文件 | 首版默认不写，`--bootstrap` 可选 |

### 1.3 非目标（YAGNI）

- 不实现 HTTP/SSE 传输；
- 不修改 broker 内部结构（`src/broker.mjs`、`src/backend.mjs` 等一律不动）；
- 不支持 `--backend=launcher` 之外的后端选择（用户若要回退原生，自行跑 `openwiki integrations install`）；
- 不做安装过程的交互式 TUI（全命令行参数驱动，可脚本化）；
- 不实现 `--dry-run` 预览；
- 不覆写 openwiki 注册表里的 8 家原生逻辑之外的任何宿主 MCP 配置。

## 2. 宿主范围

### 2.1 清单来源与对齐

宿主清单 = superpowers-zh 的 26 家 ∪ openwiki 注册表的 8 家，两表重叠 6 家（claude / cursor / codex / kiro / opencode / antigravity），并集 **28 家**。

- superpowers-zh 26 家：`superpowers-zh/bin/superpowers-zh.js:56-205` 的 `TARGETS` 表，每条附官方文档出处（issue 编号或文档 URL），属于已核实数据，直接移植。
- openwiki 独有 2 家：**Bob**、**Oh My Pi (omp)**，只在 openwiki 注册表里有，需补 superpowers-zh 侧的目录知识（见 2.3）。

### 2.2 条目结构

```js
{
  id: "claude",                 // = 传给 broker --host 的值，必须匹配 /^[a-z0-9-]{1,64}$/
  displayName: "Claude Code",
  aliases: ["claude", "claude-code", "cc"],
  skill: {
    projectDir: ".claude/skills",   // null = 拒绝项目级（ZCode / TRAE CN）
    detect: [".claude"],            // 数组，含产物文件（GEMINI.md / dsh.json / reasonix.toml 等）
    globalDir: ".claude/skills",
    globalDirWin: null,             // 仅 Crush / Reasonix 非空
    globalDetect: ".claude",
    bootFile: ".claude/CLAUDE.md",  // 仅 --bootstrap 时使用
  },
  noProjectReason: null,            // projectDir 为 null 时给用户看的拒绝理由
  mcp: {
    kind: "json",                   // "json" | "codex-toml" | "opencode-json" | "manual" | null
    userPath: ".claude.json",       // 相对 home；kind 为 manual 时为 null
    projectPath: ".mcp.json",       // 相对项目根；kind 为 manual 时为 null
  },
  native: {                         // 仅 8 家 openwiki 已注册宿主有；用于接管定位
    skillDir: ".claude/skills/openwiki",
    receipt: ".openwiki-install.json",
  },
}
```

`id` 统一采用 openwiki 注册表的 id（`bob` / `codex` / `claude` / `opencode` / `cursor` / `kiro` / `omp` / `antigravity`），其余 20 家自定小写连字符 id。这样 broker 转发给后端的 `--host` 与 openwiki 自身注册表对齐，后端的行为与原生直连一致。

### 2.3 两处需要单独裁决的宿主

**Antigravity 全局目录存在来源冲突。**
superpowers-zh 明确不给 Antigravity 提供全局目录，理由是「其全局 skills 加载路径未在 docs 证实」（`superpowers-zh.js:104-105`）；openwiki 注册表却声称用户级为 `.gemini/antigravity-cli/skills/openwiki`（`registry.ts:130`）。二者对不上。

裁决：以 superpowers-zh 为准——`globalDir: null`，`--global --tool antigravity` 明确拒绝。理由是 superpowers-zh 的路径知识逐条附官方文档出处，而 openwiki 注册表给出该路径时引用的 `documentationUrl` 是 MCP 文档（`https://antigravity.google/docs/mcp?tab=cli`），并未证实 skills 加载路径。保守方向的代价是「拒绝了少数情况可用」；冒进方向的代价是「装到不扫描的目录，装了不生效」，后者正是本项目要消灭的失败模式。

**Bob 与 Oh My Pi 缺 superpowers-zh 侧目录知识。**
按 openwiki 注册表的 `skillDirectory` 反推其 skills 父目录：

| 宿主 | 项目级 `projectDir` | 全局 `globalDir` | detect |
| --- | --- | --- | --- |
| bob | `.agents/skills` | `.agents/skills` | `.bob` |
| omp | `.omp/skills` | `.omp/agent/skills` | `.omp` |

两者与 openwiki 原生安装位置逐字一致（同为 `.agents/skills/openwiki` / `.omp/agent/skills/openwiki`），接管时不会出现路径错位。detect 标记取自 openwiki 的 MCP 配置路径所在目录（`.bob/mcp.json` → `.bob`；`.omp/` → `.omp`）。

## 3. MCP 配置写入

### 3.1 三种格式

前序规格 4.2 的「不确认不写」原则保留：只自动写这 8 家已核实的，其余 20 家按 3.4 分档。

| kind | 宿主 | 配置键 | 条目值 |
| --- | --- | --- | --- |
| `json` | bob / claude / cursor / kiro / omp / antigravity | `mcpServers.openwiki` | `{command, args}` |
| `codex-toml` | codex | `[mcp_servers.openwiki]` | `command=` / `args=[...]` |
| `opencode-json` | opencode | `mcp.openwiki` | `{type:"local", command:[cmd, ...args], enabled:true}` |

用户级与项目级路径（相对 home / 相对项目根）：

| 宿主 | 用户级 | 项目级 |
| --- | --- | --- |
| bob | `.bob/mcp.json` | `.bob/mcp.json` |
| claude | `.claude.json` | `.mcp.json` |
| cursor | `.cursor/mcp.json` | `.cursor/mcp.json` |
| kiro | `.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |
| omp | `.omp/agent/mcp.json` | `.omp/mcp.json` |
| antigravity | `.gemini/config/mcp_config.json` | `.agents/mcp_config.json` |
| codex | `.codex/config.toml` | `.codex/config.toml` |
| opencode | `.config/opencode/opencode.jsonc` | `opencode.jsonc` |

### 3.2 marker 与合并语义

**codex 的 marker 必须自有一套。** 原生用 `# OPENWIKI:MCP:START` / `# OPENWIKI:MCP:END` 包裹（`config-toml.ts:6-7`），launcher 改用 `# OPENWIKI-LAUNCHER:MCP:START` / `# OPENWIKI-LAUNCHER:MCP:END`。共用 marker 会让两个安装器在各自卸载时互相切除对方写的块，直接破坏 4.4 的接管前提。

合并语义统一为：**只重写 `openwiki` 这一个键/表，其余内容逐字保留。**

- `json`：`JSON.stringify(root, null, 2) + "\n"`（与原生 `config-json.ts:38` 一致）；文件不存在时创建并带完整 `mcpServers` 对象。
- `opencode-json`：jsonc，必须保留注释（原生用 `jsonc-parser` + `COMMENT_PATTERN`，`config-opencode.ts:10`）；保留原文件的缩进风格。
- `codex-toml`：只重写 marker 之间的块，文件其余部分（其他 `[table]`、注释）逐字保留；若文件不存在则创建只含本块的新文件。

若目标键已存在且值**不等于**我们期望的 launcher 命令值，判定为冲突（多半是原生安装器或其他工具写的），按 4.4 处理。

### 3.3 命令形态

```json
"openwiki": {
  "command": "<安装时的 process.execPath>",
  "args": ["<abs>/bin/openwiki-launcher.mjs", "mcp", "--host", "<id>"]
}
```

用绝对路径的 `process.execPath` 而非裸 `"node"`：本包存在的意义就是消灭全局路径探测、空格路径、nvm shim 三类故障面（见前序规格 1.2 第 3 条），配置里不该再留一个需要靠 PATH 解析的东西。绝对 node 路径在 node 升级后可能失效，此时 `doctor` 报告重新安装即可（3.1 的成功标准第 4 条已包含核对流程）。

`process.execPath` 不可用时（极端嵌入环境）回退到字符串 `"node"`，并在报告里打印一条警告。

### 3.4 其余 20 家的 MCP 分档

| 档 | 条件 | 行为 |
| --- | --- | --- |
| `manual` | 已知该宿主要在 UI 里配置、磁盘路径未经核实 | 安装 skill，打印可直接粘贴的配置片段，报告标 `manual` |
| `null` | 宿主根本没有 MCP 客户端能力（如 Aider、DeerFlow） | 只装 skill，不提示 MCP；openwiki 的 `SKILL.md` 自带降级路径（直接搜索 `openwiki/` Markdown） |

首版判定：**CodeBuddy 为 `manual`**（MCP 配置入口在 IDE UI，本规格成文时磁盘路径未确认）。其余 19 家按「有无 MCP 客户端能力」归入 `manual` 或 `null`，待后续核实磁盘路径后升级为自动写入——升级只需把 `mcp.kind` 从 `manual` 改为对应枚举并填路径，不涉及其他模块改动。

## 4. 安装流程

### 4.1 主流程

```
1. 前置：node ≥22.22.0；解析 openwiki 依赖拿 packageRoot/version；解析自身 bin 绝对路径
2. 定作用域：--global → baseDir = home，scope = user；否则 baseDir = cwd，scope = project
3. 定目标：--tool <id> 解析别名 → 单家；否则对全池做 detect 快照（★ 快照必须在第 5 步之前全部算完）
4. 无目标且零命中 → 扫 PATH 打印 --tool 建议，退出码 1
5. plan.mjs（纯函数）算出每家的动作表，每条动作内含护栏判定结果
6. 任一目标被护栏拒绝 → 打印全部拒绝理由，退出码 2，且一个字节都不写
7. 逐家执行：复制 skill + 写收据 → 写 MCP（每步写前快照备份）
8. 任一失败 → 用快照回滚本次已写文件，退出码 1
9. 报告逐家动作与路径；manual 的打印配置片段
10. 收尾提示：warm 预热建议 + Windows Defender 排除建议
```

### 4.2 检测快照先行是硬要求

第 3 步的 detect 判定必须在任何写入之前全部完成并缓存，理由是实测记录的反例：Codex 安装会创建 `.agents/skills`，而 Antigravity 的 detect 标记正是 `.agents`。先写后判会让 Antigravity 被自己的邻居产物误判为「已安装」而跳过（`superpowers-zh.js:1686-1689` 记录了这个坑及其修复）。

因此 `plan.mjs` 的输入是「一次性算好的 detect 快照」，不是让它自己去 `existsSync`。

### 4.3 护栏

护栏是 `plan.mjs` 内部的一个**纯步骤**：`isSystemDir` / `isHomeDir` 只依赖路径字符串与 `platform` 参数，不做 IO，因此可以留在 plan 里完整单测。plan 输出的每条动作带 `guarded` 标记与拒绝理由；执行器（第 7 步）只在 plan 中不存在 `guarded` 动作时才允许写入，这保证了「被拒绝则零写入」。

| 护栏 | 行为 | `--force` |
| --- | --- | --- |
| 系统目录 | 拒绝写入 `SystemRoot` / `ProgramFiles` / `ProgramData`（win32）或 `/usr` `/etc` `/bin` `/sbin` `/var` `/opt` `/System` `/Library` `/private/etc`（unix）及其之下 | **不提供绕过** |
| 项目级落在 home | 项目级安装的目标目录等于 `~` 时拒绝 | 可绕过 |
| 未知/空目录 | 注册表条目缺 `projectDir` 或 `globalDir` 时明确拒绝并给出替代命令 | 不适用 |

移植自 `superpowers-zh.js:1297-1353`，保留其中两个已踩过的坑：

- **tmpdir 豁免**：macOS 的 `TMPDIR` 落在 `/var` 下，不豁免会让所有临时目录测试被系统目录护栏拦下；
- **home 排除**：`isSystemDir` 的判定必须排除 home，否则 `~/.codeartsdoer/skills` 这类合法全局目标会被自家护栏拦下。

比较前统一做路径归一化（`/` 分隔），win32 下再小写化。

### 4.4 接管策略

仅对 8 家 `native` 非空的宿主生效。

| 情形 | 行为 |
| --- | --- |
| skill 目录内存在 `.openwiki-install.json` | 打印「检测到 openwiki 原生安装」；删除该原生收据（其记录的 version 与 files 哈希已不再可信）；写入我们的 `.openwiki-launcher.json` |
| MCP 条目存在且 `command` 不等于我们的 bin 路径 | 原地替换该条目（只动这一个键），打印「已接管」 |
| `--no-takeover` 且命中上述任一情形 | 整家跳过，报告标 `skipped (native install present)`，零改动 |

对 8 家的**项目级**与 7 家的**用户级**（除 Antigravity），launcher 推导出的 skill 目录与原生 `skillDirectory` 逐字相同，因此接管在磁盘上表现为同一目录内的内容覆盖 + 收据更替，不存在路径迁移。

唯一的例外是 Antigravity 用户级：launcher 按 2.3 的裁决拒绝其全局安装（`globalDir: null`），而原生会写 `.gemini/antigravity-cli/skills/openwiki`。两者路径不同，因此 launcher 永远不会碰到原生在该目录留下的产物；`--global --tool antigravity` 直接以「该宿主无已核实的全局技能目录」拒绝并指向项目级安装。

接管时不额外要求 `--force`：被替换的是 openwiki 自己的条目，语义完全相同（都是「让宿主能用 openwiki 工具」），且每个被改动的文件都已按 4.1 第 7 步做过快照备份。用户若不想要这个行为，用 `--no-takeover` 显式退出。

## 5. 卸载

`--uninstall` 与 install 共享作用域与目标解析逻辑，动作表相反。

| 对象 | 条件 | 动作 |
| --- | --- | --- |
| skill 目录 | 存在 `.openwiki-launcher.json` 且其 `files` 逐文件 sha256 全部匹配 | 删除整个 skill 目录 |
| skill 目录 | 收据缺失，或有文件哈希不匹配 | **跳过并警告**「文件已被修改，未删除」，给出目录路径 |
| MCP 条目 | 条目的 `command` 等于我们的 bin 路径 | 删除该条目/块 |
| MCP 条目 | `command` 不是我们的 bin 路径 | 跳过，不碰用户自己写的配置 |
| 备份文件 | `.openwiki-launcher-backup-*` | 不主动删除（留给用户回溯） |

哈希校验是硬要求：用户可能手动编辑过 `SKILL.md`，静默删除会丢数据。哈希不匹配时宁可留垃圾也不删。

## 6. CLI

```
openwiki-launcher                          项目级：自动检测宿主并安装（需在项目目录）
openwiki-launcher --global                 用户级安装
openwiki-launcher --tool <id>              显式指定宿主（支持别名）
openwiki-launcher --uninstall [--global]   卸载
openwiki-launcher --force                  允许项目级安装落到 home（系统目录护栏无绕过）
openwiki-launcher --no-takeover            遇到 openwiki 原生安装时跳过而非接管
openwiki-launcher --bootstrap              额外写入引导文件（首版默认关闭，见 1.1 修正三）
openwiki-launcher --no-warm                安装成功后不自动预热（默认预热一次，60 秒上限，失败不改安装退出码）
openwiki-launcher mcp [--host <id>]        broker（已交付）
openwiki-launcher warm                     预热（已交付）
openwiki-launcher doctor                   体检（已交付）
```

退出码沿用前序规格 5 节：`0` 成功；`1` 用户/环境错误（无可安装宿主、依赖缺失、执行失败并已回滚）；`2` 安装护栏拒绝（系统目录、项目级落 home）。

`install` / `uninstall` 都是幂等的：重复执行结果相同，不产生额外副作用。

## 7. 代码结构

延续现有 `src/*.mjs` 扁平 ESM、零构建风格（现有 `src/{paths,manifest,backend,broker,log,jsonrpc}.mjs` + `src/commands/{mcp,warm,doctor}.mjs`）。

| 模块 | 职责 |
| --- | --- |
| `src/registry.mjs` | 28 家数据；别名解析；detect 池；native 路径表；条目 schema 自校验 |
| `src/plan.mjs` | **纯函数**：输入（作用域、目标、detect 快照、现状）→ 输出变更计划。无 IO |
| `src/skill-install.mjs` | bundle 复制；收据 `.openwiki-launcher.json` 读写与 sha256 校验 |
| `src/mcp-config.mjs` | 三种格式的条目读 / 写 / 删；冲突判定 |
| `src/guards.mjs` | `isSystemDir`、`isHomeDir` |
| `src/backup.mjs` | 写前快照与失败回滚 |
| `src/self-path.mjs` | 自身 `bin` 绝对路径、`process.execPath` |
| `src/install.mjs` / `src/uninstall.mjs` | 编排：检测 → 计划 → 执行 → 报告 |
| `src/commands/install.mjs` | CLI 命令层，参数解析与打印 |

**`plan.mjs` 必须是纯函数**，这是本设计最重要的可测试性决策：整个安装决策面（装什么、跳过什么、报什么冲突、退出码是什么）都能在临时目录上以纯数据输入完整覆盖，不需要真实宿主、不需要碰磁盘。superpowers-zh 的 83KB 单文件做不到这一点，它把决策与 IO 混在一起，只能靠 `verify-release.sh` 的分段集成测试兜底。

注册表数据（28 条）与移植自 superpowers-zh 的注释一并保留出处标注——这是「不猜路径」口径的可审计资产，不可为了压缩体积删掉注释。

## 8. 测试策略

| 层 | 覆盖点 |
| --- | --- |
| 单元 · registry | 28 条逐条 schema 校验：`id` 匹配 `/^[a-z0-9-]{1,64}$/`；有作用域时对应目录非空；`mcp.kind` 在枚举内；`kind` 非 `manual`/`null` 时 user/project 路径均非空；`native` 仅 8 家非空 |
| 单元 · guards | win32 打桩 `SystemRoot`/`ProgramFiles`/`ProgramData`；unix 根目录；tmpdir 豁免；home 排除；路径归一化与大小写 |
| 单元 · mcp-config | 三种格式的写入 → 读回往返；jsonc 注释保留；toml 其他表保留；json 其他键保留；已存在等值条目幂等；冲突条目识别；删除条目 |
| 单元 · skill-install | 复制后文件数与 sha256 匹配收据；收据哈希不匹配时拒绝删除 |
| 单元 · plan | 全分支：命中/未命中、护栏拒绝、项目级落 home、`--no-takeover` 跳过、manual 档、native 接管、幂等重入 |
| 集成 | 临时 HOME + 临时项目目录，**28 家逐家**跑 install → 断言产物路径与内容 → uninstall → 断言目录消失且配置文件字节级回到安装前 |
| 护栏 | 系统目录与项目级落 home 两类拒绝 → 退出码 2 且断言零写入 |
| 接管 | 预置原生收据 + 原生 MCP 条目的临时 HOME → 断言条目已替换、收据已更替、备份文件存在；`--no-takeover` → 断言零改动 |
| 格式保真 | 预置含注释的 `opencode.jsonc`、含多表的 `config.toml`、含其他 server 的 `mcp.json` → 断言安装后注释、其他表、其他 server 完好 |
| CLI | 参数解析、退出码、`help` 文案 |
| CI | ubuntu + windows 必跑（windows 覆盖空格路径与系统目录护栏） |

集成测试不允许依赖真实已安装的宿主：所有路径根通过可注入的 `baseDir` / `homeDir` 指向临时目录。

## 9. 风险与开放问题

| 风险 | 缓解 |
| --- | --- |
| 28 家宿主目录知识移植过程中出错 | superpowers-zh 每条附官方文档出处，移植时保留注释；schema 测试只保证结构不保证路径正确，路径正确性靠集成测试断言产物落在预期位置 |
| 其余 20 家 MCP 配置长期停在 manual/null | 用户拿不到自动 MCP 配置，但 skill 已装、可用降级路径；升级只需改注册表一个字段，不动其他模块 |
| 接管策略覆盖了用户手工写的同名条目 | 只在条目 `command` 指向 openwiki 原生命令或值不匹配时替换，且写前有快照备份，`--no-takeover` 可退出 |
| `process.execPath` 硬编码在配置里，node 升级后失效 | `doctor` 增加一项：核对已写入的 MCP 命令是否仍指向当前 node 与 launcher |
| 与 openwiki 上游注册表漂移 | `doctor` 核对 launcher 注册表的 8 家 native 路径与已安装的 openwiki 版本是否一致；漂移只影响接管定位，不影响 skill 安装 |

## 10. 成功标准

1. 28 家宿主逐家 `install --tool <id>` 在临时 HOME/项目目录下端到端通过，`uninstall` 后目录消失且配置文件字节级还原。
2. 8 家已注册宿主的 MCP 条目指向 launcher 自身 bin，`mcp --host <id>` 握手 <1s（复用前序规格 10.1 的口径）。
3. 预置原生安装的临时 HOME 下，`install` 完成接管，且 `openwiki integrations list` 不再把该条目报告为原生安装；`--no-takeover` 下零改动。
4. 系统目录与项目级落 home 两类路径均以退出码 2 拒绝，且断言文件系统无任何改动。
5. 安装后运行 `openwiki-launcher warm` 能把后端拉到就绪，`doctor` 全绿。