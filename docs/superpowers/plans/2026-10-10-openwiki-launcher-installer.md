# openwiki-launcher 安装器 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付 `openwiki-launcher install` / `--uninstall`，把 openwiki 的 skill 与指向自身 broker 的 MCP 配置一次性装进 28 家宿主，并能从 openwiki 原生安装器手中安全接管。

**架构：** 纯 `.mjs` 零构建 ESM。注册表（28 家）与决策逻辑分离——`src/plan.mjs` 是**纯函数**，输入「作用域 + 目标 + 一次性算好的 detect 快照 + 现状」，输出带护栏标记的动作表；`src/install.mjs` 只负责按表执行、写前快照、失败回滚。MCP 配置三种格式一律用**文本切片替换**而非全量反序列化重写，因此用户的注释、缩进、键序、其他 server 条目都逐字节保留，且零新增依赖。

**技术栈：** Node.js ≥22.22.0、纯 ESM（`.mjs`，零构建）、vitest、node 内置 `fs/path/os/crypto/url`

**规格：** `docs/specs/2026-10-10-openwiki-launcher-installer-design.md`（执行者必须先读这份规格；本计划的论证依据来自它）

---

## 全局约束

以下要求来自规格，每个任务的步骤都隐含包含这些约束，不再逐条重复：

- Node ≥22.22.0；`engines.node = ">=22.22.0"`，install/uninstall 路径也要做前置检查并给可读报错
- 唯一运行时依赖 `openwiki` 精确锁版 `0.6.0`；**禁止新增任何运行时依赖**——包括不引入 `jsonc-parser`/`smol-toml`，注释与 toml 的保留一律靠文本切片实现
- 包为纯 `.mjs` 零构建；`files` 白名单新增模块都在 `src` 下，无需改动
- 诊断信息一律经 `createLogger` 走 stderr，前缀 `[launcher]`；install 路径不写 stdout
- 退出码：`0` 成功；`1` 用户/环境错误（无可安装宿主、依赖缺失、未知宿主、参数非法、执行失败并已回滚）；`2` 护栏拒绝
- 系统目录护栏**不提供** `--force` 绕过；主目录护栏（项目级安装的目标目录等于 home）可由 `--force` 绕过
- 收据文件名固定 `.openwiki-launcher.json`，**不得**与原生 `.openwiki-install.json` 混用
- codex 的 toml marker 固定 `# OPENWIKI-LAUNCHER:MCP:START` / `# OPENWIKI-LAUNCHER:MCP:END`，不得复用原生的 `OPENWIKI:MCP:*`
- MCP 条目的 `command` 写安装时的 `process.execPath` 绝对路径、`args[0]` 写 launcher 自身 bin；取不到 `execPath` 时 `command` 回退字符串 `"node"` 并在报告里打印警告
- `--bootstrap` 首版接受该参数但**不做任何事**，仅在报告里打印一行「引导文件在 0.2.0 未启用」；注册表的 `skill.bootFile` 字段保留但不消费
- 注册表 28 条数据连同从 superpowers-zh 移植的出处注释一并保留，不可为压缩体积删注释
- `src/broker.mjs`、`src/backend.mjs`、`src/manifest.mjs`、`src/paths.mjs`、`src/commands/{mcp,warm}.mjs` **一律不改**（bundle 路径只能通过 `resolveOpenwikiRuntime()` 的返回值推导，不得自行猜测）
- `test:smoke` 依赖 `src/commands/mcp.mjs` 的行为，任务 9 改 `src/cli.mjs` 分发后必须重跑冒烟
- CI 已满足规格 8 的「ubuntu + windows 必跑」：`\.github/workflows/ci.yml` 的矩阵已是 `[ubuntu-latest, windows-latest]`、node `22.22.0`，**本计划不需要改 CI 文件**；但任务 10 必须在两个平台上都实际跑通，若 CI 未覆盖到则由任务 10 补
- 提交信息用 Conventional Commits

## 审查重点（Review Focus）

规格是愿景文档，以下五类失败模式规格未穷举，但最可能伤到真实用户。每条都在下方对应任务里补了钉住它的测试：

1. **用户的 MCP 配置文件内容异常** → 分三种，行为各不相同：**0 字节或纯空白**视为空配置正常写入（无内容可损坏，且 `touch` 出来的空文件很常见）；**畸形内容**（尾逗号、括号不配对、`//` 注释混入 `.json`）必须**拒绝写入并让原文件逐字节不变**，stderr 给出可读原因——绝不能解析失败后当空对象写回去，那等于清空用户的 MCP 配置；**BOM** 剥离后处理、写回时保留（任务 4）
2. **配置文件是符号链接**（dotfiles 用户把 `~/.claude.json` 软链进 git 仓库）→ 必须跟随链接写到真实路径，快照备份也必须落在真实路径旁边；写回时不能把链接替换成普通文件（任务 5）
3. **目标 skills 目录已存在同名 `openwiki` 目录但没有 launcher 收据**（用户手动复制的）→ 必须覆盖前明确打印一行说明，不能静默覆盖，也不能因为没收据就当作「未安装」而留下新旧混杂（任务 3）
4. **`--tool` 给了不存在的 id，或对无全局目录的宿主用了 `--global`** → 必须报可读错误并列出全部可用 id；不得静默无操作退出 0（任务 9）
5. **写入中途失败**（权限不足、文件只读、磁盘满、被 IDE 独占）→ 本次已写入的全部文件必须按快照回滚，不留半装状态；且失败目标的错误必须与其他已成功目标的报告同时可见（任务 7）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/registry.mjs` | 28 家宿主数据、别名表、`CLI_PROBES`、`isOnPath`、`shortestAlias`、条目 schema 自校验 |
| `src/guards.mjs` | `isSystemDir`、`isHomeDir`（纯函数：platform/home/tmpdir/systemRoots 全部由参数注入以便打桩） |
| `src/skill-install.mjs` | bundle 复制、收据 `.openwiki-launcher.json` 读写、逐文件 sha256 校验 |
| `src/mcp-config.mjs` | 三种格式的条目 read / upsert / remove，一律文本切片替换，零依赖 |
| `src/plan.mjs` | 纯函数决策：输入 → 动作表 + `guarded` 标记。无 IO |
| `src/backup.mjs` | 写前快照与失败回滚 |
| `src/self-path.mjs` | 自身 `bin` 绝对路径、`process.execPath` |
| `src/install.mjs` | install 编排：检测 → 计划 → 执行 → 回滚 → 报告 |
| `src/uninstall.mjs` | uninstall 编排（与 install 共用 `src/targets.mjs` 的目标解析） |
| `src/targets.mjs` | **新建**：作用域解析、`--tool` 解析、detect 快照采集（install 与 uninstall 的唯一共用入口） |
| `src/commands/install.mjs` | CLI 参数解析、bundle 解析（异步）、打印 |
| `src/cli.mjs` | **修改**：把 `install`/`uninstall` 从占位桩接到实现 |
| `src/commands/doctor.mjs` | **修改**：新增两项检查（MCP 命令指向、native 路径与 openwiki 版本一致） |
| `test/helpers.mjs` | **新建**：临时目录、logger 收集、bundle 路径等测试公用件 |
| `test/registry.test.mjs` | 28 条 schema、分档表、别名、PATH 探测、bundle 可解析 |
| `test/guards.test.mjs` | 系统目录 / 主目录护栏的全部平台分支 |
| `test/skill-install.test.mjs` | 复制、收据、哈希校验 |
| `test/mcp-config.test.mjs` | 三格式读 / 切片替换 / 格式保真 / 畸形输入 |
| `test/plan.test.mjs` | 决策全分支（纯数据输入，无磁盘） |
| `test/backup.test.mjs` | 快照、回滚、符号链接 |
| `test/install.test.mjs` | install 编排 |
| `test/uninstall.test.mjs` | uninstall 编排（三格式各一） |
| `test/cli-install.test.mjs` | CLI 参数、退出码、错误提示 |
| `test/e2e-install.test.mjs` | 28 家逐家端到端 + 护栏 + 接管 + 格式保真 + 成功标准 |

---

### 任务 1：宿主注册表（28 家数据 + 别名 + PATH 探测）

**文件：**
- 创建：`src/registry.mjs`
- 测试：`test/registry.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/registry.test.mjs`：

```js
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOSTS, ALIASES, CLI_PROBES, findHost, shortestAlias, isOnPath, validateRegistry,
} from "../src/registry.mjs";

const EXPECTED_IDS = [
  "bob", "claude", "cursor", "codex", "kiro", "opencode", "omp", "antigravity",
  "gemini-cli", "trae", "trae-cn", "vscode", "openclaw", "windsurf", "aider",
  "qwen-code", "hermes", "claw-code", "qoder", "codebuddy", "codearts", "reasonix",
  "dsh", "zcode", "crush", "cline", "kilo-code", "deerflow",
];

const MCP_KIND_BY_ID = {
  bob: "json", claude: "json", cursor: "json", kiro: "json",
  omp: "json", antigravity: "json", codex: "codex-toml", opencode: "opencode-json",
  codebuddy: "manual", aider: null, deerflow: null,
};

it("覆盖且仅覆盖 28 家宿主", () => {
  expect(HOSTS.map((h) => h.id).sort()).toEqual([...EXPECTED_IDS].sort());
});

it("每条都通过 schema 自校验", () => {
  expect(validateRegistry()).toEqual([]);
});

it("id 全部匹配 broker 的 host 校验规则", () => {
  for (const h of HOSTS) expect(h.id).toMatch(/^[a-z0-9-]{1,64}$/u);
});

it("mcp.kind 分档与 3.4 一致：8 家可自动写、CodeBuddy manual、其余无 MCP 客户端能力", () => {
  const actual = Object.fromEntries(HOSTS.map((h) => [h.id, h.mcp?.kind ?? null]));
  expect(actual).toEqual(MCP_KIND_BY_ID);
});

it("8 家 native 宿主带原生定位信息，其余为 null", () => {
  expect(HOSTS.filter((h) => h.native).map((h) => h.id).sort()).toEqual(
    ["bob", "claude", "codex", "kiro", "opencode", "omp", "antigravity", "cursor"].sort());
  for (const h of HOSTS.filter((x) => !x.native)) expect(h.native).toBeNull();
});

it("8 家的 mcp 路径与 openwiki 注册表逐字一致（含用户级=项目级的那四家）", () => {
  const m = Object.fromEntries(HOSTS.map((h) => [h.id, h.mcp]));
  expect([m.bob.userPath, m.bob.projectPath]).toEqual([".bob/mcp.json", ".bob/mcp.json"]);
  expect([m.cursor.userPath, m.cursor.projectPath]).toEqual([".cursor/mcp.json", ".cursor/mcp.json"]);
  expect([m.kiro.userPath, m.kiro.projectPath]).toEqual([".kiro/settings/mcp.json", ".kiro/settings/mcp.json"]);
  expect([m.claude.userPath, m.claude.projectPath]).toEqual([".claude.json", ".mcp.json"]);
  expect([m.codex.userPath, m.codex.projectPath]).toEqual([".codex/config.toml", ".codex/config.toml"]);
  expect([m.opencode.userPath, m.opencode.projectPath])
    .toEqual([".config/opencode/opencode.jsonc", "opencode.jsonc"]);
  expect([m.omp.userPath, m.omp.projectPath]).toEqual([".omp/agent/mcp.json", ".omp/mcp.json"]);
  expect([m.antigravity.userPath, m.antigravity.projectPath])
    .toEqual([".gemini/config/mcp_config.json", ".agents/mcp_config.json"]);
});

it("6 家 json 的键名是 mcpServers，opencode 用 mcp", () => {
  expect(Object.fromEntries(HOSTS.filter((h) => h.mcp?.kind === "json").map((h) => [h.id, h.mcp.containerKey])))
    .toEqual({ bob: "mcpServers", claude: "mcpServers", cursor: "mcpServers",
      kiro: "mcpServers", omp: "mcpServers", antigravity: "mcpServers" });
  expect(findHost("opencode").mcp.containerKey).toBe("mcp");
  expect(findHost("codex").mcp.containerKey).toBe("mcp_servers");
});

it("Antigravity 无全局目录（2.3 裁决）", () => {
  expect(findHost("antigravity").skill.globalDir).toBeNull();
});

it("globalDirWin 只有 Crush 与 Reasonix 非空（Windows 差异目录）", () => {
  const withWin = HOSTS.filter((h) => h.skill.globalDirWin).map((h) => h.id).sort();
  expect(withWin).toEqual(["crush", "reasonix"]);
});

it("拒绝项目级的条目带 noProjectReason", () => {
  for (const id of ["zcode", "trae-cn"]) {
    expect(findHost(id).skill.projectDir).toBeNull();
    expect(typeof findHost(id).noProjectReason).toBe("string");
  }
});

it("别名解析命中规范 id，未知别名返回 null", () => {
  expect(findHost("cc").id).toBe("claude");
  expect(findHost("claude-code").id).toBe("claude");
  expect(findHost("codebuddy").id).toBe("codebuddy");
  expect(findHost("nope")).toBeNull();
});

it("shortestAlias 返回可复制的最短别名", () => {
  expect(shortestAlias("claude")).toBe("cc");
  expect(shortestAlias("bob")).toBe("bob");
});

it("isOnPath 按 platform 处理分隔符与 PATHEXT", () => {
  const exists = (p) => p === "/usr/bin/codex";
  expect(isOnPath("codex", { platform: "linux", env: { PATH: "/usr/bin" }, exists })).toBe(true);
  expect(isOnPath("codex", { platform: "linux", env: { PATH: "/nowhere" }, exists })).toBe(false);
  expect(isOnPath("codex", { platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
    exists: (p) => p === "C:\\bin\\codex.EXE" })).toBe(true);
});

it("CLI_PROBES 只列 CLI 宿主", () => {
  expect(Object.keys(CLI_PROBES).sort()).toEqual(
    ["claude", "codex", "gemini-cli", "opencode", "aider", "qwen-code",
      "openclaw", "claw-code", "crush", "hermes"].sort());
});

it("全部别名指向存在的宿主", () => {
  for (const [alias, id] of Object.entries(ALIASES)) {
    expect(HOSTS.some((h) => h.id === id), `别名 ${alias} → ${id}`).toBe(true);
  }
});
```

**追加一条 bundle 可解析性测试**（这是规格未写、但计划必须钉住的事实）：

```js
// 放在 test/registry.test.mjs 末尾
it("openwiki 包内的 skill bundle 路径可解析且含 SKILL.md", async () => {
  const { resolveOpenwikiRuntime } = await import("../src/paths.mjs");
  const { bundleDirFor } = await import("../src/skill-install.mjs");
  const bundle = bundleDirFor((await resolveOpenwikiRuntime()).packageRoot);
  expect(existsSync(join(bundle, "SKILL.md"))).toBe(true);
});
```

它把「bundle 来源 = `<packageRoot>/integrations/openwiki`」这条此前只存在于散文里的事实变成可执行断言，并顺带证明 `src/paths.mjs` 的返回值确实可用。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/registry.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/registry.mjs"`

- [ ] **步骤 3：实现 `src/registry.mjs`**

数据来源逐字照抄，**注释一并保留**（出处标注是「不猜路径」口径的可审计资产）：

- `HOSTS` 的 `skill.projectDir` / `skill.detect` / `skill.globalDir` / `skill.globalDirWin` / `skill.globalDetect` / `skill.bootFile` / `noProjectReason`，从 `d:/hub/superpowers-zh/bin/superpowers-zh.js:56-205` 的 `TARGETS` 表逐条移植；`TARGETS` 的 `name` 改为 `displayName`（保留原名便于对照），主键换成规格 2.2 定义的 28 个 `id`
- `HOSTS` 的 `mcp` 与 `native` 字段，从 `d:/hub/openwiki/src/integrations/install/registry.ts:10-142` 的 `HOST_TARGETS` 逐条移植（8 家），其余 20 家按下表分档
- 新增 2 家 superpowers-zh 没有的宿主：`bob`（`projectDir`/`globalDir` 均为 `.agents/skills`，`detect` 为 `[".bob"]`）与 `omp`（`projectDir: ".omp/skills"`，`globalDir: ".omp/agent/skills"`，`detect` 为 `[".omp"]`），依据见规格 2.3
- `ALIASES` 从 `superpowers-zh.js:1109-1159` 的 `TOOL_ALIASES` 移植并把值从 displayName 改为 28 个规范 `id`；补 `bob`、`omp`（原生注册表用的就是这两个）；`claude` 补一个 `cc` 别名使 `shortestAlias("claude")` 有确定值
- `CLI_PROBES` 从 `superpowers-zh.js:1072-1083` 移植，键改为 28 个规范 `id`

**其余 20 家的 MCP 分档表**（这是规格 3.4 要求但未逐家列出的部分，实现时按下表逐条写入，并在每条上用注释记下「需要核实什么」）：

| id | kind | 依据 / 需要核实什么 |
|---|---|---|
| `codebuddy` | `manual` | 规格 3.4 已定：MCP 配置入口在 IDE UI，磁盘路径未确认 |
| `aider` | `null` | 无 MCP 客户端能力，靠 `SKILL.md` 自带降级路径 |
| `deerflow` | `null` | 同上 |
| `gemini-cli` | `manual` | 需核实 `~/.gemini/settings.json` 的 `mcpServers` 键与项目级路径 |
| `trae` / `trae-cn` | `manual` | 需核实 Trae 的 MCP 配置入口是 UI 还是磁盘文件 |
| `vscode` | `manual` | 需核实 `.vscode/mcp.json` 与用户级 `mcp.json` 的实际键名 |
| `openclaw` | `manual` | 需核实 MCP 配置是否落在 `~/.openclaw/` 下 |
| `windsurf` | `manual` | 需核实 `~/.codeium/windsurf/mcp_config.json`（与 skills 的 `dirWin` 差异同源） |
| `qwen-code` | `manual` | Gemini CLI 的 fork，需核实是否沿用 `~/.gemini/` 约定 |
| `hermes` | `manual` | 需核实 `~/.hermes/config.yaml` 的 MCP 段结构（yaml，非三种已支持格式） |
| `claw-code` | `manual` | 需核实 MCP 配置来源（可能仅读 `CLAUDE.md`） |
| `qoder` | `manual` | 需核实 `~/.qoder/` 下的 MCP 配置格式 |
| `codearts` | `manual` | 需核实华为云码道的 MCP 配置入口 |
| `reasonix` | `manual` | 需核实 `reasonix.toml` 的 MCP 表名（toml 需新增第四种 kind） |
| `dsh` | `manual` | 需核实 `dsh.json` 的 MCP 键结构 |
| `zcode` | `manual` | 需核实智谱 ZCode 的 MCP 配置入口 |
| `crush` | `manual` | 需核实 `~/.config/crush/mcp.json`（Windows 下 `dirWin` 差异同样适用） |
| `cline` | `manual` | VS Code 扩展，需核实是否支持 MCP 客户端 |
| `kilo-code` | `manual` | VS Code 扩展，需核实是否支持 MCP 客户端 |

合计 `manual` 18 家 + `null` 2 家 = 20，加 8 家可自动写 = 28。

`mcp` 字段比规格 2.2 多一个 `containerKey`（任务 4 的文本切片需要它定位容器）：

| kind | `containerKey` | `entryKey` | 条目值 |
|---|---|---|---|
| `json` | `mcpServers` | `openwiki` | `{command, args}` |
| `opencode-json` | `mcp` | `openwiki` | `{type:"local", command:[cmd, ...args], enabled:true}` |
| `codex-toml` | `mcp_servers` | `openwiki` | `[mcp_servers.openwiki]` 表 |

签名：

```js
export const HOSTS                    // 只读数组，28 条
export const ALIASES                  // Record<alias, id>
export const CLI_PROBES               // Record<id, string[]>（可执行文件名）
export function findHost(nameOrAlias: string): HostEntry | null
export function shortestAlias(id: string): string
export function isOnPath(bin: string, opts?: {
  platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean,
}): boolean
export function validateRegistry(): string[]   // 返回问题列表，空数组表示全部合法
```

`validateRegistry` 逐条检查：`id` 匹配 `/^[a-z0-9-]{1,64}$/u`；作用域所需目录字段非空；`mcp.kind` 在 `json | codex-toml | opencode-json | manual` 枚举内或为 `null`；`kind` 为三种可自动写格式时 `userPath`/`projectPath`/`containerKey` 均非空；`native` 仅 8 家非空。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/registry.test.mjs`
预期：PASS，17 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/registry.mjs test/registry.test.mjs
git commit -m "feat: add host registry with 28 verified hosts and mcp capability tiers"
```

---

### 任务 2：路径护栏（系统目录 / 主目录）

**文件：**
- 创建：`src/guards.mjs`
- 测试：`test/guards.test.mjs`

- [ ] **步骤 1：写失败的测试**

```js
import { describe, it, expect } from "vitest";
import { isSystemDir, isHomeDir, defaultSystemRoots } from "../src/guards.mjs";

const win = { platform: "win32", home: "C:\\Users\\x", tmpdir: "C:\\Users\\x\\AppData\\Local\\Temp",
  systemRoots: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"] };
// /tmp 必须不在 systemRoots 里，否则「放行 tmpdir」这条断言会恒真
const nix = { platform: "linux", home: "/home/x", tmpdir: "/tmp",
  systemRoots: ["/usr", "/etc", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private/etc"] };

const noRealpath = (p) => p;   // 测试里不碰磁盘

describe("isSystemDir", () => {
  it("拒绝系统目录本身与其之下（win32）", () => {
    expect(isSystemDir("C:\\Windows", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("C:\\Windows\\System32\\.trae\\skills", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("C:\\Program Files\\nodejs", { ...win, realpath: noRealpath })).toBe(true);
  });
  it("拒绝系统目录本身与其之下（unix）", () => {
    expect(isSystemDir("/usr", { ...nix, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("/etc/foo", { ...nix, realpath: noRealpath })).toBe(true);
  });
  it("拒绝盘根与文件系统根", () => {
    expect(isSystemDir("C:", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("/", { ...nix, realpath: noRealpath })).toBe(true);
  });
  it("放行 home 及其之下（否则合法全局目标被自家护栏拦下）", () => {
    expect(isSystemDir("C:\\Users\\x", { ...win, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("C:\\Users\\x\\.codeartsdoer\\skills", { ...win, realpath: noRealpath })).toBe(false);
  });
  it("放行 tmpdir 及其之下，即使 tmpdir 落在 /var 下（macOS 的坑）", () => {
    const macLike = { ...nix, tmpdir: "/var/folders/ab/T" };
    expect(isSystemDir("/var/folders/ab/T/proj/.claude/skills", { ...macLike, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("/var/log/other", { ...macLike, realpath: noRealpath })).toBe(true);
  });
  it("归一化分隔符并忽略 win32 大小写", () => {
    expect(isSystemDir("C:/WINDOWS/System32", { ...win, realpath: noRealpath })).toBe(true);
  });
  it("放行普通用户目录", () => {
    expect(isSystemDir("C:\\Users\\x\\proj\\.claude\\skills", { ...win, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("/home/x/proj/.claude/skills", { ...nix, realpath: noRealpath })).toBe(false);
  });
});

describe("isHomeDir", () => {
  it("仅当相等时为 true", () => {
    expect(isHomeDir("/home/x", { home: "/home/x", realpath: noRealpath })).toBe(true);
    expect(isHomeDir("/home/x/proj", { home: "/home/x", realpath: noRealpath })).toBe(false);
  });
  it("home 不可用时返回 false", () => {
    expect(isHomeDir("/home/x", { home: "", realpath: noRealpath })).toBe(false);
  });
});

describe("defaultSystemRoots", () => {
  it("win32 下从 env 取四个根并带默认值", () => {
    expect(defaultSystemRoots({ platform: "win32", env: {} }))
      .toEqual(["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]);
    expect(defaultSystemRoots({ platform: "win32", env: { SystemRoot: "D:\\Win", ProgramFiles: "E:\\PF" } })[0])
      .toBe("D:\\Win");
  });
  it("unix 下返回固定九个根", () => {
    expect(defaultSystemRoots({ platform: "linux", env: {} }))
      .toEqual(["/usr", "/etc", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private/etc"]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/guards.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/guards.mjs"`

- [ ] **步骤 3：实现 `src/guards.mjs`**

逐字移植 `superpowers-zh.js:1297-1353` 的判定规则（含注释里的三个已踩坑说明：home 排除、tmpdir 豁免、分隔符归一化），但把隐式全局改为参数注入，使测试无需打桩 `process.platform`：

```js
export function defaultSystemRoots(opts?: {
  platform?: string, env?: NodeJS.ProcessEnv,
}): string[]
// platform 为 win32 时依次读 env.SystemRoot（默认 "C:\\Windows"）、env.ProgramFiles
// （默认 "C:\\Program Files"）、env["ProgramFiles(x86)"]（默认 "C:\\Program Files (x86)"）、
// env.ProgramData（默认 "C:\\ProgramData"）；其余平台返回规格 4.3 的九个 unix 根。

export function isSystemDir(targetPath: string, opts?: {
  platform?: string,        // 默认 process.platform
  home?: string,            // 默认 homedir()
  tmpdir?: string,          // 默认 tmpdir()
  systemRoots?: string[],   // 默认 defaultSystemRoots({platform, env: process.env})
  realpath?: (p: string) => string,   // 默认 realpathSync，失败回退 resolve
}): boolean
// 顺序固定为：realpath → home 及其之下直接放行 → tmpdir 及其之下直接放行 →
// 归一化（反斜杠转正斜杠、去尾斜杠、win32 小写）→ 空串或盘根判 true →
// 与 systemRoots 逐个比较（根也要 realpath，否则 macOS 上 /var 与 /private/var 会被判成两处）。

export function isHomeDir(targetPath: string, opts?: {
  home?: string,
  realpath?: (p: string) => string,
}): boolean
// 仅当 realpath 后完全相等才为 true；home 取不到时返回 false。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/guards.test.mjs`
预期：PASS，11 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/guards.mjs test/guards.test.mjs
git commit -m "feat: add system and home directory guards with injectable platform"
```

---

### 任务 3：skill bundle 复制与收据

**文件：**
- 创建：`src/skill-install.mjs`
- 创建：`test/fixtures/bundle/`（本任务内新建）
- 测试：`test/skill-install.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/skill-install.test.mjs` 用临时目录，每个用例前 `mkdtempSync`。bundle 源为 `test/fixtures/bundle/`：

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleDirFor, installSkill, readReceipt, verifySkill, removeSkill,
} from "../src/skill-install.mjs";

const BUNDLE = fileURLToPath(new URL("./fixtures/bundle/", import.meta.url));
let root;
let logs;
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ow-skill-")); logs = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const args = (targetDir, extra = {}) => ({
  bundleDir: BUNDLE, targetDir, hostId: "claude", scope: "user",
  mcpCommand: { command: "/node", args: ["/b.mjs", "mcp", "--host", "claude"] },
  launcherVersion: "0.2.0", logger, ...extra,
});

it("bundleDirFor 只做路径拼接，不猜测布局", () => {
  expect(bundleDirFor("/pkg/root")).toBe(join("/pkg/root", "integrations", "openwiki"));
});

it("复制 bundle 的三个文件并写出收据", () => {
  const r = installSkill(args(join(root, ".claude/skills/openwiki")));
  expect(Object.keys(r.files).sort()).toEqual(["SKILL.md", "agents/bob.yaml", "agents/openai.yaml"]);
  expect(existsSync(join(root, ".claude/skills/openwiki/agents/bob.yaml"))).toBe(true);
  const receipt = readReceipt(join(root, ".claude/skills/openwiki"));
  expect(receipt).toMatchObject({ package: "openwiki-launcher", version: "0.2.0",
    target: "claude", scope: "user" });
  expect(Object.keys(receipt.files).every((k) => /^[a-f0-9]{64}$/.test(receipt.files[k]))).toBe(true);
});

it("拒绝白名单之外的 bundle 文件（scripts/），且不产生任何写入", () => {
  const targetDir = join(root, "t");
  expect(() => installSkill(args(targetDir))).toThrow(/不允许的路径/u);
  expect(existsSync(targetDir)).toBe(false);
});

it("重复安装是幂等的，收据逐字节一致", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  const first = readFileSync(join(targetDir, ".openwiki-launcher.json"), "utf8");
  installSkill(args(targetDir));
  expect(readFileSync(join(targetDir, ".openwiki-launcher.json"), "utf8")).toBe(first);
});

it("已存在同名目录但无 launcher 收据时，先打印说明再覆盖（审查重点 3）", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "SKILL.md"), "手工放的文件", "utf8");
  installSkill(args(targetDir));
  expect(logs.join("\n")).toMatch(/已存在同名目录|没有安装收据/u);
  expect(readFileSync(join(targetDir, "SKILL.md"), "utf8")).not.toBe("手工放的文件");
});

it("takeover 时删除原生收据并改写为 launcher 收据", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, ".openwiki-install.json"),
    JSON.stringify({ package: "openwiki", version: "0.5.0" }), "utf8");
  const r = installSkill(args(targetDir, { takeover: true }));
  expect(existsSync(join(targetDir, ".openwiki-install.json"))).toBe(false);
  expect(existsSync(join(targetDir, ".openwiki-launcher.json"))).toBe(true);
  expect(r.tookOver).toBe(true);
});

it("verifySkill 在文件被改后报告不匹配", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  expect(verifySkill(targetDir).ok).toBe(true);
  writeFileSync(join(targetDir, "SKILL.md"), "用户改过了", "utf8");
  const v = verifySkill(targetDir);
  expect(v.ok).toBe(false);
  expect(v.mismatches).toContain("SKILL.md");
});

it("verifySkill 在收据缺失时报告 missing", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(verifySkill(targetDir)).toMatchObject({ ok: false, missing: true });
});

it("removeSkill 只在哈希全匹配时删除，否则报告 modified", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  writeFileSync(join(targetDir, "SKILL.md"), "用户改过了", "utf8");
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: false, reason: "modified" });
  expect(existsSync(targetDir)).toBe(true);
  writeFileSync(join(targetDir, "SKILL.md"), readFileSync(join(BUNDLE, "SKILL.md"), "utf8"), "utf8");
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: true });
  expect(existsSync(targetDir)).toBe(false);
});

it("removeSkill 在无收据时报告 missing", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: false, reason: "missing" });
});

it("readReceipt 在无收据或收据损坏时都返回 null", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(readReceipt(targetDir)).toBeNull();
  writeFileSync(join(targetDir, ".openwiki-launcher.json"), "{ 坏掉的 json", "utf8");
  expect(readReceipt(targetDir)).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/skill-install.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/skill-install.mjs"`

- [ ] **步骤 3：新建 bundle 夹具**

创建 `test/fixtures/bundle/SKILL.md`（内容 `---\nname: openwiki\ndescription: fixture\n---`）、`test/fixtures/bundle/agents/bob.yaml`、`test/fixtures/bundle/agents/openai.yaml`（各一行 `name: fixture`），以及 `test/fixtures/bundle/scripts/evil.sh`（内容 `echo evil`）。后者用于验证白名单拦截。

- [ ] **步骤 4：实现 `src/skill-install.mjs`**

```js
export const RECEIPT_FILE = ".openwiki-launcher.json";
export const NATIVE_RECEIPT_FILE = ".openwiki-install.json";
// 白名单移植 openwiki/src/integrations/install/skill-bundle.ts:13 —— 文件与目录分开声明：
export const ALLOWED_BUNDLE_FILES = ["SKILL.md"];
export const ALLOWED_BUNDLE_DIRS = ["agents", "references"];
// scripts/ 不在其中：夹具里的 scripts/evil.sh 必须被 installSkill 抛错拦下。

export function bundleDirFor(openwikiPackageRoot: string): string
// 只做 path.join(root, "integrations", "openwiki")，不做存在性判断，
// 不做任何路径猜测。路径来源只允许是 resolveOpenwikiRuntime() 的 packageRoot。

export function listBundleFiles(bundleDir: string): string[]
// 递归收集相对路径并用 / 分隔返回。顶层段若是文件则必须在 ALLOWED_BUNDLE_FILES 内，
// 若是目录则必须在 ALLOWED_BUNDLE_DIRS 内；出现 ".." 或不在白名单的段一律抛错，
// 错误信息含 "不允许的路径"。必须整棵树校验完再开始写任何文件。

export function installSkill({ bundleDir, targetDir, hostId, scope, mcpCommand,
  launcherVersion, logger, takeover = false }):
  { receiptPath: string, files: Record<string, string>, tookOver: boolean }
// 顺序：listBundleFiles 全量校验 → targetDir 已存在且无 launcher 收据时 logger.info
// 说明「已存在同名目录但没有安装收据，将覆盖」→ takeover 且存在 NATIVE_RECEIPT_FILE 时
// 删除它并置 tookOver → 复制 → 写 RECEIPT_FILE。
// 收据字段固定 package / version / target / scope / skillDir / mcpServerCommand / files，
// 序列化 JSON.stringify(receipt, null, 2) + "\n"；files 每值为该文件内容的 sha256 hex。

export function readReceipt(targetDir: string): object | null
// 收据不存在或 JSON 解析失败均返回 null —— 用户不该被安装器的收据问题挡住卸载。

export function verifySkill(targetDir: string): { ok: boolean, missing: boolean, mismatches: string[] }
// missing = 无可解析收据；否则逐文件比对 sha256，缺失或哈希不符的文件名进 mismatches。

export function removeSkill(targetDir: string, logger):
  { removed: boolean, reason?: "missing" | "modified" }
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run test/skill-install.test.mjs`
预期：PASS，11 个用例通过

- [ ] **步骤 6：Commit**

```bash
git add src/skill-install.mjs test/skill-install.test.mjs test/fixtures/bundle
git commit -m "feat: add skill bundle install with sha256 receipt verification"
```

---

### 任务 4：MCP 配置三格式的读与文本切片

**文件：**
- 创建：`src/mcp-config.mjs`
- 测试：`test/mcp-config.test.mjs`

本任务的全部函数都是**纯文本函数**：输入字符串，输出字符串，**不碰文件系统**。文件读写、符号链接解析留给任务 5/7。

- [ ] **步骤 1：写失败的测试**

```js
import { describe, it, expect } from "vitest";
import {
  spliceJsonEntry, readJsonEntry,
  upsertTomlBlock, removeTomlBlock, readTomlBlock,
  TOML_START, TOML_END,
} from "../src/mcp-config.mjs";

const cmd = { command: "/abs/node", args: ["/abs/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"] };
const entryJson = JSON.stringify(cmd, null, 2);
const call = (text, extra = {}) =>
  spliceJsonEntry(text, { containerKey: "mcpServers", entryKey: "openwiki", entryJson, ...extra });

describe("json（mcpServers.openwiki）", () => {
  it("空文本与纯空白都按空配置处理", () => {
    for (const input of ["", "   \n\n", "﻿"]) {
      const r = call(input);
      expect(JSON.parse(r.text).mcpServers.openwiki).toEqual(cmd);
      expect(r.action).toBe("created");
    }
  });

  it("保留 BOM", () => {
    expect(call("﻿{}").text.startsWith("﻿")).toBe(true);
  });

  it("保留其他 server 条目与缩进逐字节不变", () => {
    const input = [
      "{", '  "mcpServers": {', '    "other": {', '      "command": "x"', "    }", "  }",
      '  "otherTop": 1', "}", "",
    ].join("\n");
    const r = call(input);
    expect(r.action).toBe("created");
    expect(JSON.parse(r.text)).toMatchObject({ otherTop: 1,
      mcpServers: { other: { command: "x" }, openwiki: cmd } });
    expect(r.text).toContain('    "other": {');
    expect(r.text.endsWith("}\n")).toBe(true);
  });

  it("已存在等值条目时逐字节不变", () => {
    const first = call("");
    const second = call(first.text);
    expect(second.action).toBe("unchanged");
    expect(second.text).toBe(first.text);
  });

  it("已存在不同值条目时替换并标记 updated", () => {
    const base = call("", { entryJson: JSON.stringify({ command: "openwiki", args: ["mcp", "--host", "claude"] }) });
    expect(call(base.text).action).toBe("updated");
    expect(JSON.parse(call(base.text).text).mcpServers.openwiki).toEqual(cmd);
  });

  it("删除条目只影响该键，其他条目保留", () => {
    const base = call('{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    const r = spliceJsonEntry(base.text,
      { containerKey: "mcpServers", entryKey: "openwiki", entryJson: null });
    expect(r.removed).toBe(true);
    expect(JSON.parse(r.text).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("删除后容器变空则连容器键一起删（卸载后的形态）", () => {
    const base = call("");
    const r = spliceJsonEntry(base.text,
      { containerKey: "mcpServers", entryKey: "openwiki", entryJson: null });
    expect(r.removed).toBe(true);
    expect(JSON.parse(r.text).mcpServers).toBeUndefined();
  });

  it("容器不存在时创建它", () => {
    const r = call('{\n  "otherTop": 1\n}\n');
    expect(JSON.parse(r.text)).toMatchObject({ otherTop: 1, mcpServers: { openwiki: cmd } });
  });

  it("畸形内容拒绝写入且原文本逐字节不变（审查重点 1）", () => {
    for (const bad of [
      '{\n  "mcpServers": {\n    "a": 1,\n  }\n}\n',   // 尾逗号
      '{\n  // 我的注释\n  "mcpServers": {}\n}\n', // 注释混入 .json
      '{\n  "mcpServers": {\n',                         // 括号不配对
    ]) {
      expect(() => call(bad)).toThrow(/无法解析|括号不配对/u);
    }
  });
});

describe("opencode jsonc（mcp.openwiki）", () => {
  it("保留注释与兄弟条目", () => {
    const input = [
      "{", "  // 我的 opencode 配置", '  "model": "x",', '  "mcp": {',
      "    // 已有 server",
      '    "other": { "type": "local", "command": ["x"], "enabled": true }', "  }", "}", "",
    ].join("\n");
    const r = spliceJsonEntry(input, { containerKey: "mcp", entryKey: "openwiki",
      entryJson: JSON.stringify({ type: "local", command: ["/n", "mcp", "--host", "opencode"], enabled: true }, null, 2) });
    expect(r.text).toContain("// 我的 opencode 配置");
    expect(r.text).toContain("// 已有 server");
    expect(JSON.parse(r.text.replace(/^\s*\/\/.*$/gmu, "")).mcp.openwiki)
      .toMatchObject({ type: "local", enabled: true });
  });
});

describe("reader", () => {
  it("readJsonEntry 读出当前值", () => {
    expect(readJsonEntry(call("").text, { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toEqual(cmd);
    expect(readJsonEntry('{"mcpServers":{}}', { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toBeNull();
  });

  it("readJsonEntry 在畸形文本上抛错而不是静默返回 null", () => {
    expect(() => readJsonEntry('{"mcpServers":{', { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toThrow(/无法解析|括号不配对/u);
  });

  it("readTomlBlock 读出块内容，无 marker 时返回 null", () => {
    const block = ['[mcp_servers.openwiki]', 'command = "/abs/node"',
      'args = ["/abs/b.mjs", "mcp", "--host", "codex"]'].join("\n");
    const text = upsertTomlBlock('model = "x"\n', { tableName: "mcp_servers.openwiki", block }).text;
    expect(readTomlBlock(text, { tableName: "mcp_servers.openwiki" })).toBe(block);
    expect(readTomlBlock('[mcp_servers.openwiki]\ncommand = "openwiki"\n',
      { tableName: "mcp_servers.openwiki" })).toBeNull();
  });
});

describe("codex toml", () => {
  const block = ['[mcp_servers.openwiki]', 'command = "/abs/node"',
    'args = ["/abs/b.mjs", "mcp", "--host", "codex"]'].join("\n");

  it("marker 常量不是原生的 OPENWIKI:MCP", () => {
    expect(TOML_START).toBe("# OPENWIKI-LAUNCHER:MCP:START");
    expect(TOML_END).toBe("# OPENWIKI-LAUNCHER:MCP:END");
  });

  it("保留其他表", () => {
    const r = upsertTomlBlock('model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n',
      { tableName: "mcp_servers.openwiki", block });
    expect(r.text).toContain("[mcp_servers.other]");
    expect(r.text).toContain('model = "x"');
    expect(r.text).toContain(TOML_START);
    expect(r.text).toContain("[mcp_servers.openwiki]");
  });

  it("连续两次 upsert 不产生两个块且逐字节一致", () => {
    const first = upsertTomlBlock("", { tableName: "mcp_servers.openwiki", block });
    const second = upsertTomlBlock(first.text, { tableName: "mcp_servers.openwiki", block });
    expect(second.action).toBe("unchanged");
    expect(second.text).toBe(first.text);
  });

  it("删除块连同前导空行一起吃掉，使文件逐字节回到原样", () => {
    const before = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
    const text = upsertTomlBlock(before, { tableName: "mcp_servers.openwiki", block }).text;
    expect(removeTomlBlock(text, { tableName: "mcp_servers.openwiki" }).text).toBe(before);
  });

  it("无 marker 的裸表不视为 launcher 的块，不删除", () => {
    const native = '[mcp_servers.openwiki]\ncommand = "openwiki"\n';
    expect(removeTomlBlock(native, { tableName: "mcp_servers.openwiki" }).removed).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/mcp-config.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/mcp-config.mjs"`

- [ ] **步骤 3：实现 `src/mcp-config.mjs`**

核心是**不重新序列化整个文件**——只定位目标键值区间的字符范围并做文本替换，其余字节原样输出。这同时解决了规格 3.2 的「逐字保留」与全局约束的「零新增依赖」（不需要 `jsonc-parser`）。

```js
export const TOML_START = "# OPENWIKI-LAUNCHER:MCP:START";
export const TOML_END = "# OPENWIKI-LAUNCHER:MCP:END";

export function spliceJsonEntry(text: string, opts: {
  containerKey: string, entryKey: string,
  entryJson: string | null,   // null 表示删除
}): { text: string, action?: "created" | "updated" | "unchanged", removed?: boolean }

export function readJsonEntry(text: string, opts: { containerKey: string, entryKey: string }): unknown | null
// 返回该键的**原始值切片**（trim 后 JSON.parse）。容器或键不存在时返回 null；
// 文本畸形时抛出与 spliceJsonEntry 相同的可读错误（卸载与 doctor 依赖它读取，
// 静默返回 null 会让卸载误判「不是本安装器写的」而留下垃圾条目）。

export function upsertTomlBlock(text: string, opts: { tableName: string, block: string }):
  { text: string, action: "created" | "updated" | "unchanged" }

export function removeTomlBlock(text: string, opts: { tableName: string }): { text: string, removed: boolean }

export function readTomlBlock(text: string, opts: { tableName: string }): string | null
// 返回 marker 区间内去掉 marker 行后的块文本；无 marker 时返回 null（区分「launcher 写的」
// 与「原生或用户手写的」—— 卸载据此决定是否切除）。
```

实现要点（json 侧）：

1. **BOM**：文本以 `\uFEFF` 开头时先剥离，写回时原样加回；
2. **空文本判定**：`text.trim() === ""` 时按 `{}` 处理（审查重点 1 的第一种情形）；
3. **括号配对扫描**：从第一个 `{` 起做带字符串字面量与转义处理的扫描找到根对象末尾；未走到结尾即抛错，信息含「无法解析」或「括号不配对」。纯函数天然保证**抛出时不返回任何修改过的文本**；
4. **两级定位**：先在根对象内按 `containerKey` 找键（跳过字符串字面量），再在容器内按 `entryKey` 找键，得到值区间的 `[start, end)` 字符范围；
5. **缩进推断**：新插入条目的行首缩进取容器内已有兄弟键的缩进，无兄弟键时取容器缩进 + 2 空格；
6. **删除**：`entryJson === null` 时切掉值区间并连带处理相邻逗号；**容器变空则连容器键一起删**（因此卸载后 `mcpServers` 键会消失，这是被测试钉住的行为）；
7. **`unchanged` 判定**：值切片与新 `entryJson` 去掉空白后相等 → 返回原 text 且 `action: "unchanged"`。

toml 侧：块一律以 `[TOML_START]\n<block>\n[TOML_END]\n` 写入。upsert 时若已含 `[TOML_START]` 则原地替换 START..END 之间的内容，否则追加到文件末尾。**追加时用于分隔的空行必须落在 marker 区间之外**——即形如 `...原内容末尾\n` + `\n` + `[START]...` 这样，让 `removeTomlBlock` 切掉 START..END 之后文件能逐字节回到原样（否则任务 10 的逐字节还原断言会挂在残留空行上）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/mcp-config.test.mjs`
预期：PASS，17 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/mcp-config.mjs test/mcp-config.test.mjs
git commit -m "feat: add byte-preserving MCP config read and splice for json, jsonc and toml"
```

---

### 任务 5：备份回滚与自身路径

**文件：**
- 创建：`src/backup.mjs`、`src/self-path.mjs`
- 测试：`test/backup.test.mjs`

- [ ] **步骤 1：写失败的测试**

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, rollbackAll } from "../src/backup.mjs";
import { resolveSelfBin, resolveNodeCommand } from "../src/self-path.mjs";

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ow-bak-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("写前快照把原内容存到备份文件", () => {
  const f = join(root, "mcp.json");
  writeFileSync(f, "原内容", "utf8");
  const b = createBackup(f, root);
  expect(b.existed).toBe(true);
  expect(readFileSync(b.backupPath, "utf8")).toBe("原内容");
  expect(b.backupPath).toMatch(/mcp\.json\.openwiki-launcher-backup-/u);
});

it("原文件不存在时快照记录 existed=false 且不产生备份文件", () => {
  const b = createBackup(join(root, "none.json"), root);
  expect(b.existed).toBe(false);
  expect(existsSync(b.backupPath)).toBe(false);
});

it("rollbackAll 恢复存在过的文件并删除新建的文件", () => {
  const a = join(root, "a.json"); writeFileSync(a, "A", "utf8");
  const c = join(root, "c.json");
  const backups = [createBackup(a, root), createBackup(c, root)];
  writeFileSync(a, "被改坏", "utf8");
  writeFileSync(c, "新建的", "utf8");
  rollbackAll(backups);
  expect(readFileSync(a, "utf8")).toBe("A");
  expect(existsSync(c)).toBe(false);
});

it("符号链接跟随到真实路径，快照写在真实路径旁（审查重点 2）", () => {
  mkdirSync(join(root, "real"), { recursive: true });
  const real = join(root, "real", "claude.json");
  writeFileSync(real, "真实内容", "utf8");
  symlinkSync(real, join(root, "claude.json"));
  const b = createBackup(join(root, "claude.json"), root);
  expect(b.realPath).toBe(real);
  expect(lstatSync(b.backupPath).isSymbolicLink()).toBe(false);
  expect(b.backupPath.startsWith(join(root, "real"))).toBe(true);
  expect(readFileSync(b.backupPath, "utf8")).toBe("真实内容");
});

it("resolveSelfBin 由模块位置推导包根下的 bin", () => {
  const selfUrl = new URL("../src/self-path.mjs", import.meta.url);
  expect(resolveSelfBin(selfUrl.href)).toBe(
    join(fileURLToPath(new URL("..", import.meta.url)), "bin", "openwiki-launcher.mjs"));
});

it("resolveNodeCommand 绝对路径不可用时回退 node 并带警告", () => {
  expect(resolveNodeCommand(() => "/abs/node", () => null))
    .toEqual({ command: "/abs/node", warning: null });
  expect(resolveNodeCommand(() => "", () => "警告文本"))
    .toEqual({ command: "node", warning: "警告文本" });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/backup.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/backup.mjs"`

- [ ] **步骤 3：实现两个模块**

`src/self-path.mjs`：

```js
export function resolveSelfBin(moduleUrl: string): string
// 由本模块 URL 的绝对路径向上两级得到包根，拼出 bin/openwiki-launcher.mjs。
// 不依赖 process.argv[1]（全局 npm link 时 argv[1] 是 shim 路径）。调用方一律传
// resolveSelfBin(import.meta.url) —— 无参调用是错误用法。

export function resolveNodeCommand(execPath?: () => string, warning?: () => string | null):
  { command: string, warning: string | null }
// 默认 execPath 取 process.execPath；为空串或抛错时 command 回退 "node"，
// warning 由调用方提供的回调生成（默认给一句固定中文说明）。
```

`src/backup.mjs`：

```js
export function createBackup(targetPath: string, backupDir: string, now?: () => Date):
  { path: string, realPath: string, backupPath: string, existed: boolean }
// realPath = 解开符号链接后的真实路径（realpathSync 失败时，用最近的存在的祖先 +
// 余下段拼接，保证对尚不存在的文件也能定位目录）；existed = 真实路径是否存在。
// existed 时把原内容写到 `${basename}.openwiki-launcher-backup-${ISO时间}`，
// 备份目录即 realPath 所在目录，保证与真实文件同盘、可直接覆盖回去。

export function rollbackAll(backups: Array<{ realPath: string, backupPath: string, existed: boolean }>): void
// existed → copyFileSync(backupPath, realPath)；!existed → rmSync(realPath, { force: true })。
// 单个失败不中断后续恢复，收集错误并在末尾抛出汇总异常。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/backup.test.mjs`
预期：PASS，6 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/backup.mjs src/self-path.mjs test/backup.test.mjs
git commit -m "feat: add write-time backup, rollback and symlink-safe path resolution"
```

---

### 任务 6：plan.mjs（纯函数决策）

**文件：**
- 创建：`src/plan.mjs`
- 测试：`test/plan.test.mjs`

本任务是整个安装器的决策核心，也是唯一保证「护栏拒绝时零写入」的地方：**所有检测结果由调用方算好传进来，plan 自己不碰文件系统**。

- [ ] **步骤 1：写失败的测试**

`test/plan.test.mjs` 全部用纯数据，不建任何目录：

```js
import { describe, it, expect } from "vitest";
import { planInstall } from "../src/plan.mjs";
import { HOSTS, findHost } from "../src/registry.mjs";
import { spliceJsonEntry } from "../src/mcp-config.mjs";

const NIX = { platform: "linux", home: "/home/u", tmpdir: "/tmp",
  systemRoots: ["/usr", "/etc", "/bin"] };
const base = {
  hosts: HOSTS,
  scope: "project",
  baseDir: "/home/u/proj",
  homeDir: "/home/u",
  targets: null,
  detectSnapshot: {},
  nativeSnapshot: {},
  mcpSnapshot: {},
  nodeCommand: { command: "/abs/node", warning: null },
  selfBin: "/abs/bin/openwiki-launcher.mjs",
  launcherVersion: "0.2.0",
  flags: { force: false, noTakeover: false },
  ...NIX,
};

const detectAllFalse = () => Object.fromEntries(HOSTS.map((h) => [h.id, false]));
const entry = (plan, id) => plan.entries.find((e) => e.hostId === id);
const withFlag = (extra) => ({ ...base, flags: { ...base.flags, ...extra } });

it("自动检测：只对命中的宿主产出条目", () => {
  const plan = planInstall({ ...base, detectSnapshot: { ...detectAllFalse(), codebuddy: true } });
  expect(plan.entries.map((e) => e.hostId)).toEqual(["codebuddy"]);
  expect(plan.skippedNoHost).toBe(false);
});

it("检测全落空时 skippedNoHost 为 true 且条目为空", () => {
  const plan = planInstall({ ...base, detectSnapshot: detectAllFalse() });
  expect(plan.entries).toEqual([]);
  expect(plan.skippedNoHost).toBe(true);
});

it("--tool 指定时忽略 detect 快照", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")], detectSnapshot: detectAllFalse() });
  expect(plan.entries.map((e) => e.hostId)).toEqual(["claude"]);
});

it("项目级装到只支持全局的宿主时跳过并给出替代命令", () => {
  const e = entry(planInstall({ ...base, targets: [findHost("zcode")] }), "zcode");
  expect(e.skill.action).toBe("skip");
  expect(e.skill.reason).toContain("--global");
});

it("--global 装到无全局目录的宿主时跳过并指向项目级（Antigravity 裁决）", () => {
  const e = entry(planInstall({ ...base, scope: "user", baseDir: "/home/u",
    targets: [findHost("antigravity")] }), "antigravity");
  expect(e.skill.action).toBe("skip");
  expect(e.skill.reason).toContain("项目级");
});

it("全局作用域把 skill 目录解析到 home 下", () => {
  const e = entry(planInstall({ ...base, scope: "user", baseDir: "/home/u",
    targets: [findHost("codebuddy")] }), "codebuddy");
  expect(e.skill.action).toBe("install");
  expect(e.skill.dir).toBe("/home/u/.codebuddy/skills/openwiki");
});

it("系统目录被护栏标记 guarded，且 --force 也不放行", () => {
  expect(entry(planInstall({ ...base, baseDir: "/usr/local/proj",
    targets: [findHost("claude")] }), "claude").guarded).toBe(true);
  const forced = entry(planInstall({ ...base, baseDir: "/usr/local/proj",
    targets: [findHost("claude")], flags: { ...base.flags, force: true } }), "claude");
  expect(forced.guarded).toBe(true);
  expect(forced.guardReason).toContain("系统目录");
});

it("主目录护栏判的是安装目标目录本身等于 home，而不是 cwd 等于 home", () => {
  // baseDir = home，但目标是 ~/.claude/skills/openwiki ≠ home → 放行
  expect(entry(planInstall({ ...base, baseDir: "/home/u",
    targets: [findHost("claude")] }), "claude").guarded).toBe(false);
  // 让目标目录恰好等于 home（该宿主 globalDir 缺失 → 目录解析退化为 baseDir 本身）
  const degenerate = { ...base, baseDir: "/home/u",
    targets: [{ ...findHost("claude"), skill: { ...findHost("claude").skill, projectDir: "" } }] };
  expect(entry(planInstall(degenerate), "claude").guardReason).toContain("主目录");
});

it("主目录护栏可由 --force 放行", () => {
  const degenerate = (flags) => ({ ...base, baseDir: "/home/u", flags,
    targets: [{ ...findHost("claude"), skill: { ...findHost("claude").skill, projectDir: "" } }] });
  expect(entry(planInstall(degenerate({ ...base.flags, force: true })), "claude").guarded).toBe(false);
});

it("mcp.kind 为 manual 时 action=manual，为 null 时 action=none", () => {
  const plan = planInstall({ ...base, targets: [findHost("codebuddy"), findHost("aider")] });
  expect(entry(plan, "codebuddy").mcp).toMatchObject({ action: "manual", path: null });
  expect(entry(plan, "aider").mcp).toMatchObject({ action: "none", path: null });
});

it("MCP 路径按作用域解析到用户级或项目级", () => {
  const user = planInstall({ ...base, scope: "user", baseDir: "/home/u", targets: [findHost("claude")] });
  expect(entry(user, "claude").mcp.path).toBe("/home/u/.claude.json");
  const project = planInstall({ ...base, targets: [findHost("claude")] });
  expect(entry(project, "claude").mcp.path).toBe("/home/u/proj/.mcp.json");
});

it("条目缺失时 created、等值时 unchanged、不同时 updated", () => {
  const entryJson = JSON.stringify({ command: "/abs/node",
    args: ["/abs/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"] }, null, 2);
  const equalText = spliceJsonEntry("", { containerKey: "mcpServers", entryKey: "openwiki", entryJson }).text;
  const nativeText = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}';
  const snap = (text, exists) => ({ mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text, exists } } });
  const run = (s) => entry(planInstall({ ...base, targets: [findHost("claude")], ...s }), "claude").mcp.action;

  expect(run(snap("", false))).toBe("created");
  expect(run(snap(equalText, true))).toBe("unchanged");
  expect(run(snap(nativeText, true))).toBe("updated");
});

it("MCP 条目存在但不属于本安装器时标记 takeover（规格 4.4 第二种情形）", () => {
  const foreign = '{"mcpServers":{"openwiki":{"command":"/other/bin/node","args":["x"]}}}';
  const e = entry(planInstall({ ...base, targets: [findHost("claude")],
    mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text: foreign, exists: true } } }), "claude");
  expect(e.mcp.action).toBe("updated");
  expect(e.takeover).toBe(true);
  expect(e.takeoverReason).toBe("foreign-entry");
});

it("配置文件畸形时 action=error 而不是抛异常", () => {
  const e = entry(planInstall({ ...base, targets: [findHost("claude")],
    mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text: '{ "mcpServers": {', exists: true } } }), "claude");
  expect(e.mcp.action).toBe("error");
  expect(e.mcp.reason).toBeTruthy();
  expect(e.guarded).toBe(false);
});

it("原生收据存在时标记 takeover；--no-takeover 下整家跳过", () => {
  const withNative = { nativeSnapshot: { claude: { receipt: true, skillDir: "/home/u/.claude/skills/openwiki" } } };
  const normal = entry(planInstall({ ...base, targets: [findHost("claude")], ...withNative }), "claude");
  expect(normal.takeover).toBe(true);
  expect(normal.takeoverReason).toBe("native-receipt");

  const opted = entry(planInstall({ ...base, targets: [findHost("claude")], ...withNative,
    flags: { ...base.flags, noTakeover: true } }), "claude");
  expect(opted.takeover).toBe(false);
  expect(opted.mcp.action).toBe("skip");
  expect(opted.mcp.reason).toContain("native install present");
  expect(opted.skill.action).toBe("skip");
});

it("node 回退警告透出到 plan 顶层", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")],
    nodeCommand: { command: "node", warning: "未能确定 node 绝对路径" } });
  expect(plan.nodeWarning).toContain("未能确定");
});

it("注入的 isSystemDir 可替换", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")], isSystemDir: () => true });
  expect(plan.entries[0].guarded).toBe(true);
  expect(plan.entries[0].guardReason).toContain("系统目录");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/plan.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/plan.mjs"`

- [ ] **步骤 3：实现 `src/plan.mjs`**

```js
export function planInstall(opts: {
  hosts: HostEntry[],
  scope: "user" | "project",
  baseDir: string, homeDir: string,
  targets: HostEntry[] | null,
  detectSnapshot: Record<string, boolean>,
  nativeSnapshot: Record<string, { receipt: boolean, skillDir: string | null }>,
  mcpSnapshot: Record<string, { path: string, text: string, exists: boolean }>,
  nodeCommand: { command: string, warning: string | null },
  selfBin: string, launcherVersion: string,
  flags: { force: boolean, noTakeover: boolean },
  platform?: string, tmpdir?: string, systemRoots?: string[],
  isSystemDir?: (p: string, o: object) => boolean,
  isHomeDir?: (p: string, o: object) => boolean,
}): {
  entries: Array<{
    hostId: string, displayName: string,
    skill: { action: "install" | "skip", dir: string, reason?: string },
    mcp: { action: "created" | "updated" | "unchanged" | "manual" | "none" | "skip" | "error",
           path: string | null, kind: string | null, entryJson?: string, reason?: string },
    takeover: boolean, takeoverReason?: "native-receipt" | "foreign-entry",
    guarded: boolean, guardReason?: string,
  }>,
  skippedNoHost: boolean,
  nodeWarning: string | null,
}
```

实现要点：

1. **目标集合**：`targets` 非 null 时直接用；否则取 `detectSnapshot[id] === true` 的宿主，保持 `hosts` 原顺序（顺序决定报告顺序与写入顺序）；
2. **skill 目录**：`<baseDir>/<projectDir|globalDir>/openwiki`。作用域所需字段为 `null` 时 `skill.action = "skip"`——项目级取注册表 `noProjectReason`，全局级用固定文案「该宿主没有已核实的全局技能目录，请改用项目级安装」；
3. **护栏**（对 `skill.dir` 与 `mcp.path` 各判一次）：
   - `isSystemDir(dir)` → `guarded = true`，`guardReason` 含「系统目录」，**不看 `flags.force`**；
   - `scope === "project"` 且 `isHomeDir(skill.dir)` → `guarded = true`，`guardReason` 含「主目录」，`flags.force` 可放行；
   - `isSystemDir` / `isHomeDir` 从参数注入，默认取 `src/guards.mjs`；
4. **mcp 条目文本**：按 `kind` 组装——`json` 值形状 `{command, args}`、容器键取注册表的 `mcp.containerKey`；`opencode-json` 值形状 `{type:"local", command:[command, ...args], enabled:true}`；`codex-toml` 值形状 `[mcp_servers.openwiki]` 表。`manual` → `{action:"manual", path:null}`，`null` → `{action:"none", path:null}`；
5. **mcp action 判定**：调用任务 4 的 `spliceJsonEntry` / `upsertTomlBlock` 并捕获异常——抛错 → `{action:"error", reason: err.message}`；未抛错 → 采用返回的 `action`；
6. **接管判定**：`nativeSnapshot[id]?.receipt === true` → `takeover = true`、`takeoverReason = "native-receipt"`；否则若 `mcp.action === "updated"` 且读回的旧条目的 `command` 不等于 `nodeCommand.command` 或 `args[0]` 不等于 `selfBin` → `takeover = true`、`takeoverReason = "foreign-entry"`（规格 4.4 的第二种情形：用户手工写的同名条目也要被标记并在报告里告知）；
7. **`--no-takeover`**：任一 `takeover` 成立即把该宿主的 `skill.action` 与 `mcp.action` 双双置 `skip`，`reason` 为含 `native install present` 的固定英文串；
8. **nodeWarning**：原样透出到顶层。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/plan.test.mjs`
预期：PASS，14 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/plan.mjs test/plan.test.mjs
git commit -m "feat: add pure install planner with guard and takeover decisions"
```

---

### 任务 7：目标解析与 install 编排

**文件：**
- 创建：`src/targets.mjs`、`src/install.mjs`、`test/helpers.mjs`
- 测试：`test/install.test.mjs`

- [ ] **步骤 1：新建测试公用件 `test/helpers.mjs`**

```js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE = fileURLToPath(new URL("./fixtures/bundle/", import.meta.url));
export const SELF_BIN = "/abs/bin/openwiki-launcher.mjs";
export const NODE = "/abs/node";

export function makeTempDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
export function removeTempDir(dir) { rmSync(dir, { recursive: true, force: true }); }
export function collectLogger() {
  const lines = [];
  return { lines, text: () => lines.join("\n"),
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m),
      error: (m) => lines.push(m), debug: () => {} } };
}
export function baseDeps({ logger, cwd, homeDir, platform = "linux", env = process.env }) {
  return { logger, cwd, homeDir, platform, env, tmpdir: homeDir,
    systemRoots: platform === "win32" ? [] : ["/usr", "/etc", "/bin"],
    nodeCommand: { command: NODE, warning: null }, selfBin: SELF_BIN,
    launcherVersion: "0.2.0", bundleDir: BUNDLE,
    now: () => new Date("2026-10-10T00:00:00Z") };
}
```

任务 7 与任务 8 的测试一律从这里取 `BUNDLE` / `SELF_BIN` / `NODE` 与临时目录构造器，不要各自重复 import。

- [ ] **步骤 2：写 `src/targets.mjs` 的失败测试**

先在 `test/install.test.mjs` 顶部写下这两个用例（与编排测试同文件，先让它们失败）：

```js
import { resolveScope, resolveTargets, collectDetectSnapshot } from "../src/targets.mjs";

it("作用域解析：--global 用 home，否则用 cwd", () => {
  expect(resolveScope({ global: true, cwd: "/proj", homeDir: "/home/u" }))
    .toEqual({ scope: "user", baseDir: "/home/u" });
  expect(resolveScope({ global: false, cwd: "/proj", homeDir: "/home/u" }))
    .toEqual({ scope: "project", baseDir: "/proj" });
});

it("--tool 解析与 detect 快照在 install/uninstall 之间共用同一实现", () => {
  expect(resolveTargets({ tool: "cc", hosts: HOSTS }).map((h) => h.id)).toEqual(["claude"]);
  expect(resolveTargets({ tool: "nope", hosts: HOSTS })).toBeNull();
  expect(resolveTargets({ tool: null, hosts: HOSTS })).toBeNull();   // 交给自动检测
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx vitest run test/install.test.mjs`
预期：FAIL，报错 `Failed to resolve import "../src/targets.mjs"`

- [ ] **步骤 4：实现 `src/targets.mjs`**

```js
export function resolveScope({ global, cwd, homeDir }):
  { scope: "user" | "project", baseDir: string }

export function resolveTargets({ tool, hosts }): HostEntry[] | null
// tool 为 null/undefined → 返回 null 表示「走自动检测」；
// 否则 findHost(tool)，未命中也返回 null —— 调用方负责区分两种 null 并给出不同提示。

export function collectDetectSnapshot(hosts, { scope, baseDir }): Record<string, boolean>
// 每个宿主对作用域对应的 detect 标记（global ? skill.globalDetect : skill.detect，
// 字符串或数组，数组取 some）做 existsSync(resolve(baseDir, marker))，
// 全池一次性算完返回。**必须在任何写入之前调用完**（规格 4.2 的硬要求）。

export function collectNativeSnapshot(hosts, { scope, baseDir, openwikiSkillName = "openwiki" }):
  Record<string, { receipt: boolean, skillDir: string | null }>
// 对有 native 的 8 家，算出 launcher 将要写入的 skill 目录，检查其下是否存在
// .openwiki-install.json。非 native 宿主返回 { receipt: false, skillDir: null }。

export function collectMcpSnapshot(hosts, { scope, baseDir }):
  Record<string, { path: string, text: string, exists: boolean }>
// 仅 8 家可自动写格式的宿主；路径 = resolve(baseDir, kind==="codex-toml" ? mcp.userPath : ...)
// —— 用户级取 mcp.userPath、项目级取 mcp.projectPath。exists 用 existsSync；
// 读取失败按 { exists: true, text: "" } 处理，交给切片层走「空配置」分支。
```

- [ ] **步骤 5：写 install 编排的失败测试**

追加到 `test/install.test.mjs`：

```js
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTS } from "../src/registry.mjs";
import { runInstall } from "../src/install.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => { home = makeTempDir("ow-home-"); proj = makeTempDir("ow-proj-"); logs = collectLogger(); });
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

const deps = (over = {}) => ({ ...baseDeps({ logger: logs.logger, cwd: proj, homeDir: home }), ...over });

it("为指定宿主安装 skill 并把 MCP 命令指向自身 bin", () => {
  const r = runInstall(deps({ tool: "claude" }));
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
  expect(existsSync(join(proj, ".claude/skills/openwiki/.openwiki-launcher.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers.openwiki)
    .toEqual({ command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"] });
});

it("CodeBuddy 打印 manual 配置片段且不写 MCP 文件", () => {
  const r = runInstall(deps({ tool: "codebuddy" }));
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(proj, ".codebuddy/skills/openwiki/SKILL.md"))).toBe(true);
  expect(existsSync(join(proj, ".codebuddy/mcp.json"))).toBe(false);
  expect(r.report[0].mcp).toMatchObject({ action: "manual" });
  expect(logs.text()).toContain('"command"');
});

it("系统目录被拒绝时退出码 2 且文件系统零改动", () => {
  const before = readdirSync("/usr").length;
  const r = runInstall(deps({ tool: "claude", cwdOverride: "/usr/local/proj" }));
  expect(r.exitCode).toBe(2);
  expect(r.guardedCount).toBeGreaterThan(0);
  expect(r.report.every((x) => !x.wrote)).toBe(true);
  expect(readdirSync("/usr").length).toBe(before);
});

it("检测落空时给 PATH 建议而不是静默退出 0", () => {
  const r = runInstall(deps({ env: { PATH: "" }, exists: () => false }));
  expect(r.exitCode).toBe(1);
  expect(r.skippedNoHost).toBe(true);
  expect(logs.text()).toContain("--tool");
});

it("接管原生安装：替换 MCP 条目、更替收据、留下备份", () => {
  const skillDir = join(home, ".claude/skills/openwiki");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, ".openwiki-install.json"),
    '{"package":"openwiki","version":"0.5.0"}', "utf8");
  writeFileSync(join(home, ".claude.json"),
    '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}', "utf8");

  const r = runInstall(deps({ tool: "claude", global: true }));
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(skillDir, ".openwiki-install.json"))).toBe(false);
  expect(existsSync(join(skillDir, ".openwiki-launcher.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.openwiki.command).toBe(NODE);
  expect(logs.text()).toContain("接管");
  expect(readdirSync(home).filter((f) => f.includes(".openwiki-launcher-backup-"))).toHaveLength(1);
});

it("接管用户手工写的同名条目时也打印说明", () => {
  writeFileSync(join(proj, ".mcp.json"),
    '{"mcpServers":{"openwiki":{"command":"/other/node","args":["x"]}}}', "utf8");
  const r = runInstall(deps({ tool: "claude" }));
  expect(r.report[0].takeoverReason).toBe("foreign-entry");
  expect(logs.text()).toContain("接管");
});

it("--no-takeover 下零改动", () => {
  const before = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}';
  writeFileSync(join(home, ".claude.json"), before, "utf8");
  const r = runInstall(deps({ tool: "claude", global: true, noTakeover: true }));
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
  expect(r.report[0].mcp.reason).toContain("native install present");
});

it("配置畸形时报可读错误并回滚，不清空用户文件（审查重点 1）", () => {
  const bad = '{ "mcpServers": { }';
  writeFileSync(join(proj, ".mcp.json"), bad, "utf8");
  const r = runInstall(deps({ tool: "claude" }));
  expect(r.exitCode).toBe(1);
  expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(bad);
  expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
  expect(logs.text()).toMatch(/无法解析|括号不配对/u);
});

it("重复安装幂等，第二次报 unchanged 且不重写", () => {
  runInstall(deps({ tool: "claude" }));
  const first = readFileSync(join(proj, ".mcp.json"), "utf8");
  const r = runInstall(deps({ tool: "claude" }));
  expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(first);
  expect(r.report[0].mcp.action).toBe("unchanged");
});

it("--bootstrap 首版不写任何引导文件但打印说明", () => {
  const r = runInstall(deps({ tool: "claude", bootstrap: true }));
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(proj, ".claude/CLAUDE.md"))).toBe(false);
  expect(logs.text()).toContain("引导文件");
});

it("node 绝对路径不可用时回退 node 并在报告里警告", () => {
  const r = runInstall(deps({ tool: "claude",
    nodeCommand: { command: "node", warning: "未能确定 node 绝对路径" } }));
  expect(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers.openwiki.command).toBe("node");
  expect(logs.text()).toContain("未能确定");
});

it("自动检测命中多个宿主时按注册表顺序全部安装", () => {
  const r = runInstall(deps({ detectSnapshotOverride: { claude: true, codebuddy: true } }));
  expect(r.report.map((x) => x.hostId)).toEqual(["claude", "codebuddy"]);
  expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
  expect(existsSync(join(proj, ".codebuddy/skills/openwiki/SKILL.md"))).toBe(true);
});

it("所有宿主全都没安装时退出码 1（供 isOnPath 建议分支复用）", () => {
  const r = runInstall(deps({ detectSnapshotOverride: {} }));
  expect(r.exitCode).toBe(1);
  expect(r.skippedNoHost).toBe(true);
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：`npx vitest run test/install.test.mjs`
预期：FAIL——`resolveScope` 等未定义，且 `Failed to resolve import "../src/install.mjs"`

- [ ] **步骤 7：实现 `src/install.mjs`**

```js
export function runInstall(deps: {
  logger, cwd: string, homeDir: string, env?: NodeJS.ProcessEnv,
  platform?: string, tmpdir?: string, systemRoots?: string[],
  tool?: string | null, global?: boolean, force?: boolean, noTakeover?: boolean, bootstrap?: boolean,
  nodeCommand?: { command: string, warning: string | null }, selfBin: string, launcherVersion: string,
  bundleDir: string, now?: () => Date, hosts?: HostEntry[],
  cwdOverride?: string,                                    // 仅测试打桩用
  detectSnapshotOverride?: Record<string, boolean>,       // 仅测试打桩用
  exists?: (p: string) => boolean,                        // 传给 isOnPath
}): {
  exitCode: 0 | 1 | 2,
  report: Array<{ hostId: string, wrote: boolean, takeoverReason?: string,
                  skill: { action: string, dir?: string, reason?: string },
                  mcp: { action: string, path?: string | null, reason?: string } }>,
  guardedCount: number, skippedNoHost: boolean,
}
```

`runInstall` 是**同步**函数（fs 操作本就是同步的），实现顺序严格照规格 4.1：

1. `tool` 非 null 时走 `resolveTargets`；未命中 → 打印「未知宿主 `<x>`」+ 全部可用 id（按 `displayName` 排序）并返回 `{exitCode: 1}`，**在任何 fs 写入之前**；
2. 算 `baseDir`（`global ? homeDir : (cwdOverride ?? cwd)`）与作用域；一次性构造 `detectSnapshot`（有 `detectSnapshotOverride` 时用它）、`nativeSnapshot`、`mcpSnapshot` 三张表——**规格 4.2 的硬要求，任何写入之前全部算完**；
3. 调 `planInstall`，透传 `platform` / `tmpdir` / `systemRoots`；
4. `guardedCount > 0` → 逐条打印拒绝理由，返回 `{exitCode: 2}`，**不做任何写入**；
5. `skippedNoHost` → 对 `CLI_PROBES` 的每个可执行名调 `isOnPath(bin, { platform, env: deps.env, exists: deps.exists })`（**`deps.env` 必须转发**，否则测试会用真实 `process.env` 假通过），命中则打印可直接复制的 `openwiki-launcher --tool <别名>`，返回 `{exitCode: 1}`；
6. 遍历 entries 执行：每个将被修改的 MCP 文件先 `createBackup` 收进 `backups`；skill 动作调 `installSkill`（透传 `takeover`）；MCP 动作按 `kind` 调任务 4 的 `spliceJsonEntry` / `upsertTomlBlock` 并写盘；
7. 任一步抛错 → `rollbackAll(backups)` + 删除本次新建的 skill 目录，把该宿主的 `mcp.action` 置 `error`、report 标 `wrote: false`，并**继续处理剩余宿主**（保证一个失败不掩盖其他结果，审查重点 5），最终 `exitCode: 1`；
8. 报告：逐宿主打印动作与绝对路径；`manual` 打印可直接粘贴的配置片段；`nodeWarning` 与 `--bootstrap` 的「引导文件在 0.2.0 未启用」各打印一行；结尾打印 `openwiki-launcher warm` 与 Windows Defender 排除建议。

- [ ] **步骤 8：运行测试验证通过**

运行：`npx vitest run test/install.test.mjs`
预期：PASS，19 个用例通过（`targets.mjs` 2 个 + install 17 个）

- [ ] **步骤 9：Commit**

```bash
git add src/targets.mjs src/install.mjs test/helpers.mjs test/install.test.mjs
git commit -m "feat: add target resolution and install orchestration with rollback"
```

---

### 任务 8：uninstall

**文件：**
- 创建：`src/uninstall.mjs`
- 测试：`test/uninstall.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/uninstall.test.mjs`：

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSkill } from "../src/skill-install.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => { home = makeTempDir("ow-u-home-"); proj = makeTempDir("ow-u-proj-"); logs = collectLogger(); });
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

const deps = (over = {}) => ({ ...baseDeps({ logger: logs.logger, cwd: proj, homeDir: home }), ...over });

function installFixture(skillDir, mcpPath, extraServer) {
  installSkill({ bundleDir: BUNDLE, targetDir: skillDir, hostId: "claude", scope: "project",
    mcpCommand: { command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"] },
    launcherVersion: "0.2.0", logger: logs.logger });
  mkdirSync(join(mcpPath, ".."), { recursive: true });
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: {
    ...(extraServer ? { other: { command: "x" } } : {}),
    openwiki: { command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"] },
  } }, null, 2), "utf8");
}

it("json：删除 MCP 条目并保留其他 server", () => {
  const cfg = join(proj, ".mcp.json");
  installFixture(join(proj, ".claude/skills/openwiki"), cfg, true);
  const r = runUninstall(deps({ tool: "claude" }));
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(cfg, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
});

it("json：配置文件逐字节回到只有其他 server 的原始形态", () => {
  const cfg = join(proj, ".mcp.json");
  installFixture(join(proj, ".claude/skills/openwiki"), cfg, true);
  const before = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
  writeFileSync(cfg, before, "utf8");
  runUninstall(deps({ tool: "claude" }));
  expect(readFileSync(cfg, "utf8")).toBe(before);
});

it("codex-toml：删除 marker 块后逐字节还原", () => {
  const cfg = join(proj, ".codex/config.toml");
  const before = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
  mkdirSync(join(cfg, ".."), { recursive: true });
  writeFileSync(cfg, before, "utf8");
  runInstallForTest(cfg);
  expect(readFileSync(cfg, "utf8")).toContain("# OPENWIKI-LAUNCHER:MCP:START");
  const r = runUninstall(deps({ tool: "codex" }));
  expect(r.exitCode).toBe(0);
  expect(readFileSync(cfg, "utf8")).toBe(before);
});

it("opencode-json：删除条目后注释与其他 server 完好", () => {
  const cfg = join(proj, "opencode.jsonc");
  mkdirSync(join(cfg, ".."), { recursive: true });
  writeFileSync(cfg,
    '{\n  // 我的配置\n  "model": "x",\n  "mcp": {\n    "other": { "type": "local", "command": ["y"], "enabled": true }\n  }\n}\n', "utf8");
  runInstallForTest(cfg, "opencode");
  const r = runUninstall(deps({ tool: "opencode" }));
  expect(r.exitCode).toBe(0);
  const after = readFileSync(cfg, "utf8");
  expect(after).toContain("// 我的配置");
  expect(after).toContain('"other"');
  expect(after).not.toContain("openwiki");
});

it("条目指向别处时不碰用户的配置", () => {
  const cfg = join(proj, ".mcp.json");
  const foreign = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp"]}}}';
  writeFileSync(cfg, foreign, "utf8");
  const r = runUninstall(deps({ tool: "claude" }));
  expect(readFileSync(cfg, "utf8")).toBe(foreign);
  expect(r.report[0].mcp.reason).toContain("不是本安装器写入");
});

it("用户改过 skill 文件时跳过删除，并在警告里给出目录路径", () => {
  const skillDir = join(proj, ".claude/skills/openwiki");
  installSkill({ bundleDir: BUNDLE, targetDir: skillDir, hostId: "claude", scope: "project",
    mcpCommand: { command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"] },
    launcherVersion: "0.2.0", logger: logs.logger });
  writeFileSync(join(skillDir, "SKILL.md"), "我改过了", "utf8");
  const r = runUninstall(deps({ tool: "claude" }));
  expect(existsSync(skillDir)).toBe(true);
  expect(r.report[0].skill.reason).toBe("modified");
  expect(logs.text()).toContain("未被删除");
  expect(logs.text()).toContain(skillDir);
});

it("未安装时是干净的 no-op，退出码 0", () => {
  const r = runUninstall(deps({ tool: "claude" }));
  expect(r.exitCode).toBe(0);
  expect(r.report[0].skill.action).toBe("skip");
  expect(r.report[0].mcp.action).toBe("skip");
});

it("自动检测卸载：不带 --tool 时对命中的宿主生效", () => {
  const skillDir = join(proj, ".codebuddy/skills/openwiki");
  installSkill({ bundleDir: BUNDLE, targetDir: skillDir, hostId: "codebuddy", scope: "project",
    mcpCommand: { command: NODE, args: [SELF_BIN, "mcp", "--host", "codebuddy"] },
    launcherVersion: "0.2.0", logger: logs.logger });
  const r = runUninstall(deps({ detectSnapshotOverride: { codebuddy: true } }));
  expect(r.report.map((x) => x.hostId)).toEqual(["codebuddy"]);
  expect(existsSync(skillDir)).toBe(false);
});

it("自动检测落空时 skippedNoHost 为 true 且退出码 1（与 install 一致）", () => {
  const r = runUninstall(deps({ detectSnapshotOverride: {} }));
  expect(r.exitCode).toBe(1);
  expect(r.skippedNoHost).toBe(true);
});
```

`runInstallForTest` 是本文件内的辅助函数（装一次 skill + 写一次 MCP），实现：

```js
function runInstallForTest(cfgPath, hostId = "codex") {
  runInstall({ ...deps({ tool: hostId }) });
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/uninstall.test.mjs`
预期：FAIL——`runInstall` 未 import、`runUninstall` 模块不存在

- [ ] **步骤 3：实现 `src/uninstall.mjs`**

```js
export function runUninstall(deps: {
  logger, cwd: string, homeDir: string, env?: NodeJS.ProcessEnv,
  platform?: string, tmpdir?: string, systemRoots?: string[],
  tool?: string | null, global?: boolean, force?: boolean,
  nodeCommand?: { command: string, warning: string | null }, selfBin: string,
  launcherVersion?: string, hosts?: HostEntry[],
  detectSnapshotOverride?: Record<string, boolean>,
  cwdOverride?: string,
}): {
  exitCode: 0 | 1 | 2,
  report: Array<{ hostId: string, skill: { action: string, reason?: string },
                  mcp: { action: string, reason?: string } }>,
  guardedCount: number, skippedNoHost: boolean,
}
```

实现要点：

- **与 install 共用 `src/targets.mjs`** 的 `resolveScope` / `resolveTargets` / `collectDetectSnapshot` / `collectMcpSnapshot`（不复制粘贴）；
- skill 动作走任务 3 的 `removeSkill`：`missing` → `skip`/`reason: "missing"`；`modified` → `skip`/`reason: "modified"` 并打印含「未被删除」**与该目录绝对路径**的警告（规格 5 的明确要求）；
- MCP 动作先用任务 4 的 `readJsonEntry` / `readTomlBlock` 读回条目，再判定 `command === deps.nodeCommand.command && args[0] === deps.selfBin`（**注意比对的是 `command` 对 node 路径、`args[0]` 对 launcher bin**，规格 3.3）；不匹配 → `skip`，`reason` 为含「不是本安装器写入」的固定串；
- 匹配则先 `createBackup` 再按 `kind` 调 `spliceJsonEntry(..., { entryJson: null })` 或 `removeTomlBlock`；`kind` 为 `manual` / `null` 时 `skip`（无自动写入的东西可删）；
- 备份文件按规格 5 节不主动删除。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/uninstall.test.mjs`
预期：PASS，9 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/uninstall.mjs test/uninstall.test.mjs
git commit -m "feat: add uninstall with hash-gated skill removal and owned-entry cleanup"
```

---

### 任务 9：CLI 接线与 doctor 扩展

**文件：**
- 创建：`src/commands/install.mjs`
- 修改：`src/cli.mjs`、`src/commands/doctor.mjs`、`package.json`
- 测试：`test/cli-install.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/cli-install.test.mjs` 直接调 `main(argv, deps)`，与现有 `test/cli.test.mjs` 同风格。deps 注入 `cwd` / `homeDir` / `env` / `platform` / `logger` / `bundleDir` / `selfBin` / `nodeCommand` / `exists`：

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => { home = makeTempDir("ow-cli-home-"); proj = makeTempDir("ow-cli-proj-"); logs = collectLogger(); });
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

const deps = (over = {}) => ({
  logger: logs.logger, cwd: proj, homeDir: home, env: { PATH: "" }, platform: "linux",
  exists: () => false, bundleDir: BUNDLE, selfBin: SELF_BIN,
  nodeCommand: { command: NODE, warning: null }, ...over,
});
```

| 输入 | 期望返回码 | 期望输出包含 |
|---|---|---|
| `["--tool", "claude"]` | 0 | `.claude/skills/openwiki` |
| `["install", "--tool", "claude"]` | 0 | 同上（子命令写法等价） |
| `["--tool", "claude"]` 跑第二次 | 0 | `已是最新` |
| `["--tool", "nope"]` | 1 | `未知宿主` + `codebuddy` |
| `["--uninstall", "--tool", "claude"]` | 0 | `.claude/skills/openwiki` |
| `["uninstall", "--tool", "claude"]` | 0 | 同上 |
| `["--frobnicate"]` | 1 | `无法识别的参数` |
| `["--tool", "antigravity", "--global"]` | 1 | `全局` |
| `["--help"]` | 0 | `--no-takeover` |
| 注入 `nodeVersion: "20.0.0"`，跑 `["--tool", "claude"]` | 1 | `22.22.0` |

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/cli-install.test.mjs`
预期：FAIL——现有 `src/cli.mjs:114-117` 对 `install`/`uninstall` 直接返回 1 并打印「将在 0.2.0 提供」，裸 `["--tool","claude"]` 会落到「未知命令」分支。

- [ ] **步骤 3：实现 `src/commands/install.mjs`**

```js
export function parseInstallArgs(args: string[]):
  { error?: string, flags?: { tool?: string | null, global: boolean, uninstall: boolean,
                              force: boolean, noTakeover: boolean, bootstrap: boolean } }
// 白名单：--tool <id> / --global / --uninstall / --force / --no-takeover / --bootstrap /
//         --help / --version；遇到其他以 - 开头的参数 → { error: "无法识别的参数: <x>" }；
//         --tool 缺值或值以 - 开头 → { error: "--tool 需要一个宿主 id" }。

export async function runInstallCommand(flags: object, deps: object): Promise<number>
// **异步**：bundle 路径依赖 src/paths.mjs 的 resolveOpenwikiRuntime()，它是 async。
// 正确取法：
//   const runtime = await resolveOpenwikiRuntime();                    // 解析失败 → 打印含尝试过 specifier 的诊断，返回 1
//   const bundleDir = bundleDirFor(runtime.packageRoot);
// bundleDir 优先取 deps.bundleDir（测试注入），未注入时才走上面这条真实路径。
// 作用域与目标解析走 runInstall / runUninstall，二者都是同步的 —— 此处只需 await
// 这一次依赖。返回其 exitCode。
```

- [ ] **步骤 4：改 `src/cli.mjs` 的分发**

在现有 `main` 里，`nodeVersionSupported` 检查之后、命令分发处改为：

- `command` 为 `mcp` / `warm` / `doctor` / `help` / `version` / `--help` / `-h` / `--version` / `-v` → **保持现有行为逐字不变**；
- `command` 为 `install` / `uninstall` → `parseInstallArgs(rest)`，其中 `uninstall` 强制为 `command === "uninstall"`；
- `command` 以 `-` 开头，或 `command` 为 `undefined` → `parseInstallArgs(argv)`（这实现规格 6 节的裸用法）；
- 其他 → 保持「未知命令」提示。

`deps` 的组装链要写清楚：`main` 的 deps 里透传 `cwd` / `homeDir` / `env` / `platform` / `exists` / `bundleDir` / `selfBin` / `nodeCommand`；`cwd` 缺省 `process.cwd()`，`homeDir` 缺省 `homedir()`，`platform` 缺省 `process.platform`，`selfBin` 缺省 `resolveSelfBin(import.meta.url)`。`main` 本身已是 `async`，直接 `return runInstallCommand(...)` 即可，退出码原样冒泡。

把 `HELP` 数组补上安装相关用法行：

```
  openwiki-launcher [install]              安装到自动检测到的宿主（项目级）
  openwiki-launcher --global               用户级安装
  openwiki-launcher --tool <id>            指定宿主安装
  openwiki-launcher --uninstall [--global] 卸载
  openwiki-launcher --force                允许项目级安装落到用户主目录
  openwiki-launcher --no-takeover          遇到 openwiki 原生安装时跳过而非接管
  openwiki-launcher --bootstrap            额外写引导文件（0.2.0 未启用，仅提示）
```

删除 `src/cli.mjs:114-117` 的占位桩分支。

- [ ] **步骤 5：扩展 `doctor`**

`src/commands/doctor.mjs` 在既有 4 项之后**追加**两项，既有 4 项的输出与判定逐字不动：

- **第 5 项 MCP 命令指向**：对 8 家可自动写的宿主，读回 `command` 与 `args[0]`，与 `resolveNodeCommand()` 的 `command` 和 `resolveSelfBin(import.meta.url)` 比对。全部一致输出 `✓ MCP 命令指向当前 node 与本安装器`；有偏差则逐条输出 `! <hostId>: command=<值> args0=<值>（当前为 <期望>），请重新运行 install`；
- **第 6 项 native 路径与 openwiki 版本一致**：读 `resolveOpenwikiRuntime().version`（需把 `doctor` 的该函数调用改为 await，或用已解析的 runtime 变量），与注册表里 8 家 `native` 条目对应的 openwiki 版本基线比对；本包锁 `openwiki@0.6.0`，因此只做「实际解析到的版本是否等于 `package.json` 的 dependencies.openwiki 值」这一项，不一致则输出 `! 依赖 openwiki@<实际> 与锁定的 <锁定> 不符，请检查安装来源`。

- [ ] **步骤 6：运行测试验证通过**

运行：`npx vitest run test/cli-install.test.mjs test/cli.test.mjs test/doctor.test.mjs test/warm.test.mjs`
预期：PASS——新表 10 例通过，且**既有 `test/cli.test.mjs`、`test/doctor.test.mjs`、`test/warm.test.mjs` 全部仍然通过**（回归证明分发改动没伤到 mcp/warm/doctor）

- [ ] **步骤 7：Commit**

```bash
git add src/commands/install.mjs src/cli.mjs src/commands/doctor.mjs package.json test/cli-install.test.mjs
git commit -m "feat: wire install and uninstall commands and extend doctor checks"
```

---

### 任务 10：28 家端到端、README 与发布形态

**文件：**
- 创建：`test/e2e-install.test.mjs`
- 修改：`README.md`、`package.json`、`test/release.test.mjs`

- [ ] **步骤 1：写端到端测试**

`test/e2e-install.test.mjs` 对 `HOSTS` 的 28 家逐家跑，作用域组合按注册表字段存在与否参数化：

```js
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS } from "../src/registry.mjs";
import { runInstall } from "../src/install.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

const AUTO_MCP = ["json", "codex-toml", "opencode-json"];

function seedConfig(cfgPath, kind) {
  mkdirSync(join(cfgPath, ".."), { recursive: true });
  const text = kind === "codex-toml"
    ? 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n'
    : kind === "opencode-json"
      ? '{\n  // 我的配置\n  "model": "x",\n  "mcp": {\n    "other": { "type": "local", "command": ["y"], "enabled": true }\n  }\n}\n'
      : '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';
  writeFileSync(cfgPath, text, "utf8");
  return text;
}

describe.each(HOSTS)("宿主 $id", (host) => {
  const autoMcp = AUTO_MCP.includes(host.mcp?.kind);

  if (host.skill.projectDir) {
    it("项目级安装与卸载闭环", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: "linux" });
        expect(runInstall({ ...d, tool: host.id }).exitCode).toBe(0);
        const skillDir = join(proj, host.skill.projectDir, "openwiki");
        expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
        expect(existsSync(join(skillDir, ".openwiki-launcher.json"))).toBe(true);
        expect(runUninstall({ ...d, tool: host.id }).exitCode).toBe(0);
        expect(existsSync(skillDir)).toBe(false);
      } finally { removeTempDir(proj); }
    });
  }

  if (host.skill.globalDir) {
    it("用户级安装与卸载闭环（globalDirWin 按 platform 选取）", () => {
      const home = makeTempDir("ow-e-");
      const platform = "linux";   // 路径选择必须跟注入的 platform 走，不能读真实 process.platform
      const rel = platform === "win32" && host.skill.globalDirWin ? host.skill.globalDirWin : host.skill.globalDir;
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: join(home, "proj"), homeDir: home, platform });
        expect(runInstall({ ...d, tool: host.id, global: true }).exitCode).toBe(0);
        expect(existsSync(join(home, rel, "openwiki", "SKILL.md"))).toBe(true);
        expect(runUninstall({ ...d, tool: host.id, global: true }).exitCode).toBe(0);
        expect(existsSync(join(home, rel, "openwiki"))).toBe(false);
      } finally { removeTempDir(home); }
    });
  }

  if (autoMcp) {
    it("MCP 条目写入正确且卸载后配置文件逐字节还原", () => {
      const proj = makeTempDir("ow-e-");
      const cfg = join(proj, host.mcp.projectPath);
      const before = seedConfig(cfg, host.mcp.kind);
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: "linux" });
        expect(runInstall({ ...d, tool: host.id }).exitCode).toBe(0);
        const after = readFileSync(cfg, "utf8");
        if (host.mcp.kind === "codex-toml") {
          expect(after).toContain("# OPENWIKI-LAUNCHER:MCP:START");
          expect(after).toContain("[mcp_servers.other]");
          expect(after).toContain(SELF_BIN);
        } else {
          const stripped = after.replace(/^\s*\/\/.*$/gmu, "");
          const parsed = JSON.parse(stripped);
          expect(parsed[host.mcp.containerKey].openwiki).toBeTruthy();
          expect(JSON.stringify(parsed[host.mcp.containerKey].openwiki)).toContain(NODE);
          expect(parsed[host.mcp.containerKey].other).toBeTruthy();
        }
        expect(runUninstall({ ...d, tool: host.id }).exitCode).toBe(0);
        expect(readFileSync(cfg, "utf8")).toBe(before);
      } finally { removeTempDir(proj); }
    });
  }

  if (host.mcp?.kind === "manual") {
    it("只装 skill 并报告 manual", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: "linux" });
        const r = runInstall({ ...d, tool: host.id });
        expect(r.exitCode).toBe(0);
        expect(r.report[0].mcp).toMatchObject({ action: "manual" });
        expect(logs.text()).toContain('"command"');
      } finally { removeTempDir(proj); }
    });
  }

  if (host.skill.projectDir === null) {
    it("拒绝项目级并给出替代命令", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: "linux" });
        const r = runInstall({ ...d, tool: host.id });
        expect(r.report[0].skill.action).toBe("skip");
        expect(r.report[0].skill.reason).toContain("--global");
        expect(existsSync(join(proj, host.native?.skillDir ?? "."))).toBe(false);
      } finally { removeTempDir(proj); }
    });
  }
});
```

追加四个独立用例（规格 8 的「护栏 / 接管 / 格式保真」三行 + 成功标准第 4 条）：

```js
it("护栏：系统目录被拒绝时文件系统零改动", () => {
  const before = readdirSync("/usr").length;
  const logs = collectLogger();
  const r = runInstall(baseDeps({ logger: logs.logger, cwd: "/usr/local/proj",
    homeDir: "/usr/local/home", platform: "linux" }));
  expect(r.exitCode).toBe(2);
  expect(r.report.every((x) => !x.wrote)).toBe(true);
  expect(readdirSync("/usr").length).toBe(before);
});

it("接管：预置原生收据与原生条目，安装后完成接管", () => {
  const home = makeTempDir("ow-e-");
  try {
    const skillDir = join(home, ".claude/skills/openwiki");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, ".openwiki-install.json"), '{"package":"openwiki","version":"0.5.0"}', "utf8");
    writeFileSync(join(home, ".claude.json"),
      '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}', "utf8");
    const logs = collectLogger();
    const d = baseDeps({ logger: logs.logger, cwd: join(home, "proj"), homeDir: home, platform: "linux" });
    expect(runInstall({ ...d, tool: "claude", global: true }).exitCode).toBe(0);
    expect(existsSync(join(skillDir, ".openwiki-install.json"))).toBe(false);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(SELF_BIN);
  } finally { removeTempDir(home); }
});

it("格式保真：opencode.jsonc 的注释与 config.toml 的其他表都不丢", () => {
  const proj = makeTempDir("ow-e-");
  try {
    const logs = collectLogger();
    const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: "linux" });
    const oc = join(proj, "opencode.jsonc");
    seedConfig(oc, "opencode-json");
    const cx = join(proj, ".codex/config.toml");
    seedConfig(cx, "codex-toml");
    runInstall({ ...d, tool: "opencode" });
    runInstall({ ...d, tool: "codex" });
    expect(readFileSync(oc, "utf8")).toContain("// 我的配置");
    expect(readFileSync(cx, "utf8")).toContain("[mcp_servers.other]");
    expect(readFileSync(cx, "utf8")).toContain('model = "x"');
  } finally { removeTempDir(proj); }
});

it("成功标准 1：安装后的 broker 握手 <1s 且清单为 10 个 openwiki_ 工具", async () => {
  const exe = fileURLToPath(new URL("../bin/openwiki-launcher.mjs", import.meta.url));
  const child = spawn(process.execPath, [exe, "mcp", "--host", "claude"],
    { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const started = Date.now();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }) + "\n");
    const initLine = await readLine(child.stdout);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(JSON.parse(initLine).result.serverInfo.name).toBe("openwiki");

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const list = JSON.parse(await readLine(child.stdout));
    expect(list.result.tools).toHaveLength(10);
    for (const t of list.result.tools) expect(t.name.startsWith("openwiki_")).toBe(true);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
```

`readLine(stream)` 在本文件内定义：监听 `data` 事件累积缓冲，按 `\n` 切出第一行返回原始字符串后即 resolve 并清理监听器；流结束仍未凑够整行则 reject。**不带** `LAUNCHER_BACKEND_CLI`——这一条要的就是真实 broker 与真实 manifest 即答。

- [ ] **步骤 2：运行测试**

运行：`npx vitest run test/e2e-install.test.mjs`
预期：全部通过。这是**验证**步骤而非 TDD 的红灯步骤——实现已在任务 1-9 完成，此处若失败即为回归，按系统化调试定位后修复，不要删断言。

- [ ] **步骤 3：跑全量测试确认无回归**

运行：`npm test`
预期：全部通过（含任务 1-9 的全部用例）

- [ ] **步骤 4：追加发布产物断言**

`test/release.test.mjs` 增加断言：`npm pack --dry-run --json` 的文件列表包含 `src/registry.mjs`、`src/targets.mjs`、`src/install.mjs`、`src/uninstall.mjs`、`src/plan.mjs`、`src/mcp-config.mjs`、`src/skill-install.mjs`、`src/backup.mjs`、`src/self-path.mjs`、`src/guards.mjs`、`src/commands/install.mjs`，且仍不包含 `test/`、`node_modules/`。

- [ ] **步骤 5：改 README**

`README.md` 必须补上安装章节，并把「当前范围」一节改写：

1. **快速开始**改为 `npm install -g git+https://github.com/niechao136/openwiki-launcher.git` → `openwiki-launcher` → `openwiki-launcher warm`；
2. **新增「安装到宿主」章节**：命令表（install / `--global` / `--tool` / `--uninstall` / `--force` / `--no-takeover` / `--bootstrap`）、自动检测规则（基于 detect 标记）、8 家自动写 MCP + CodeBuddy 手动片段 + 其余 18 家只装 skill 的说明、退出码 0/1/2 的含义；
3. **删掉**「宿主还需要知道何时使用这些工具：把 openwiki 的 skill 目录放进宿主的技能目录」这段手工步骤（已被安装器取代），保留一句说明：无 MCP 客户端能力的宿主（Aider、DeerFlow）只装 skill，靠 `SKILL.md` 自带的降级路径工作；
4. **修正** MCP 配置示例的 `command`：从 `"node"` 改为安装时写入的 node 绝对路径，并注明「由 `openwiki-launcher` 安装器自动写入，无需手改」；
5. **故障排查**补三行：退出码 2 是什么、`--no-takeover` 的用途、`doctor` 报「MCP 命令指向」不一致时重新跑 install；
6. **当前范围**改写为：broker 与安装器已交付；引导文件（`--bootstrap`）在 0.2.0 未启用；其余 18 家宿主的 MCP 配置待核实磁盘路径后开放自动写入。

- [ ] **步骤 6：更新 package.json 元数据**

`version` 已是 `0.2.0`（任务 9 已改）；`keywords` 追加 `installer`、`host-integration`；`files` 保持 `["bin", "src", "manifest", "scripts"]`（新增模块都在 `src` 下，无需改白名单）。

- [ ] **步骤 7：跑全量与冒烟验证**

运行：`npm test`
预期：全部通过

运行：`npm run test:smoke`
预期：PASS —— 这一步验证任务 9 对 `src/cli.mjs` 的分发改动没有破坏 broker 路径（规格的成功标准第 5 条由此覆盖；规格第 3 条的 `openwiki integrations list` 需要真实安装态的 openwiki，留在人工核对清单里，不进自动化测试）

- [ ] **步骤 8：Commit**

```bash
git add test/e2e-install.test.mjs test/release.test.mjs README.md package.json
git commit -m "test: cover all 28 hosts end to end and document the installer"
```

---

## 计划边界与后续

- 本计划实现规格第 1-8 节全部内容；第 9 节的两项开放问题中，doctor 核对已在任务 9 落地。
- **不在本计划范围**：引导文件的实际生成逻辑（`--bootstrap` 在 0.2.0 是带提示的 no-op，字段已预留）；其余 18 家宿主 MCP 配置的磁盘路径核实（分档表已把每家「需要核实什么」写进注释）；后端空闲回收（规格 v2）；`--backend=launcher` 覆写选项（规格 v2）；`openwiki_search` 检索延迟（上游 issue 线索）；规格成功标准第 3 条（`openwiki integrations list` 的真实安装态核对）需人工在装了 openwiki 的机器上执行。
- 本计划**不改动** `src/broker.mjs`、`src/backend.mjs`、`src/manifest.mjs`、`src/paths.mjs`、`src/commands/mcp.mjs`、`src/commands/warm.mjs`；任务 9 只对 `src/commands/doctor.mjs` 追加两项检查，不改既有 4 项。
- CI 无需改动：`\.github/workflows/ci.yml` 已是 `[ubuntu-latest, windows-latest]` × node 22.22.0，满足规格 8；但任务 10 的 e2e 必须在两个平台上都实际跑通，Windows 上要重点确认 `globalDirWin`（Crush / Reasonix）与系统目录护栏。
- 任务 10 完成后 `openwiki-launcher` 即为 0.2.0 可发布产物：broker 的毫秒级握手 + 28 家的自动安装与安全卸载。