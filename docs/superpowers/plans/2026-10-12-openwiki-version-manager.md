# openwiki 版本管理 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 `check` / `update` / `switch` / `versions remove` 四个命令，让 openwiki 版本在本机可查、可控、可秒回滚。

**架构：** 各版本 side-by-side 装在 `<包根>/versions/<semver>/`，`versions/active.json` 指针决定生效版本；`resolveOpenwikiRuntime` 指针优先、显式回退出厂依赖（禁止向上查找命中全局安装）。

**技术栈：** Node.js >= 22.22.0，ESM，零运行时依赖（仅 openwiki），vitest。

**规格：** `docs/specs/2026-10-12-openwiki-version-manager-design.md`（执行者两份都读）

---

## 全局约束

- Node >= 22.22.0；除 `openwiki` 外不引任何运行时依赖（交互确认用 `node:readline`）。
- 退出码约定：0 成功 / 1 用户或环境错误 / 2 护栏拒绝。
- 版本名严格匹配 `/^\d+\.\d+\.\d+$/`；目录拼接前必须过校验（防路径穿越）。
- 写操作只允许落在包根内的 `versions/` 与 `manifest/`。
- 指针损坏（JSON 坏、目录缺失、入口缺失）→ 警告 + 回退出厂依赖，不抛异常。
- `update` 默认交互确认（列出可选版本待选）；`--version <semver>` 跳过选择；`--no-switch` 装好不激活。
- 失败矩阵（规格 5.1）：npm install 失败删半成品目录；快照失败保留版本不激活、退出码 1；指针写入失败版本保留指针不动；任何失败指针不动。
- 每个新文件头部写清职责的 JSDoc 注释（沿用现有文件风格）。

## 审查重点（Review Focus）

1. **路径穿越版本名**（`switch ../../etc`、`versions remove ..`）：必须在校验处被拒，退出码 1，不碰文件系统。
2. **指针损坏时 broker 行为**：回退出厂依赖 + 警告，进程不崩——宿主不感知。
3. **快照生成失败**：版本目录保留、指针不动、退出码 1，并提示可用直通模式。
4. **npm install 半成品**：失败（含信号退出）后 `versions/<v>/` 必须被清掉，不留残留目录。
5. **Windows 指针原子替换**：rename 覆盖已存在的 `active.json` 失败时必须重试，不能留下 `.tmp` 或损坏指针。
6. **switch 代装失败**：确认代装后 install 或快照失败 → 不切指针、退出码 1。

## 文件结构

**创建：**
- `src/versions.mjs` — 版本目录布局、指针读写（原子）、版本名校验、已装列表、删除护栏
- `src/gen-manifest.mjs` — 从 `scripts/gen-manifest.mjs` 迁入的 `generateManifest` / `writeManifest`（新增 `explicitVersion` 透传）
- `src/commands/check.mjs` — `check` 命令
- `src/commands/update.mjs` — `update` 命令；导出 `installVersion` 供 switch 复用
- `src/commands/switch.mjs` — `switch` 命令
- `src/commands/versions.mjs` — `versions remove` 命令
- `test/versions.test.mjs`、`test/check.test.mjs`、`test/update.test.mjs`、`test/switch.test.mjs`、`test/versions-command.test.mjs`

**修改：**
- `src/paths.mjs` — `resolveOpenwikiRuntime({ explicitVersion, pkgRoot })`、`source` 字段、显式回退
- `src/commands/doctor.mjs` — 指针状态行 + 全局 openwiki 检测提示
- `src/cli.mjs` — 注册四个命令、HELP 文案
- `scripts/gen-manifest.mjs` — 改为 CLI 包装，从 `src/gen-manifest.mjs` 导入
- `test/paths.test.mjs`、`test/doctor.test.mjs`、`test/cli.test.mjs` — 适配与新用例
- `README.md` — 命令表、工作方式、故障排查、环境变量表
- `package.json` — 版本 `0.2.0` → `0.3.0`

---

## 任务 1：版本存储层 `src/versions.mjs`

**文件：**
- 创建：`src/versions.mjs`
- 测试：`test/versions.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERSION_PATTERN, isValidVersion, versionDir, readActive,
  writeActiveAtomic, listInstalled, removeVersion,
} from "../src/versions.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-versions-"));
}

/** 造一个可解析的已安装版本：package.json + dist/cli/cli.js。 */
function plantVersion(root, version, { withManifest = false } = {}) {
  const pkg = path.join(versionDir(root, version), "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
  if (withManifest) {
    mkdirSync(path.join(root, "manifest"), { recursive: true });
    writeFileSync(path.join(root, "manifest", `openwiki-${version}.json`), "{}");
  }
}
```

用例（每条一个 `it`）：
- `rejects version names that are not strict semver`：`isValidVersion("0.6")`、`("v0.6.0")`、`("0.6.0-beta")`、`("../../etc")`、`("0.6.0\n")` 均为 false；`("0.6.0")` 为 true。
- `refuses to build a directory for an invalid version`：`versionDir(root, "../evil")` 抛错。
- `reports no active pointer when active.json is missing`：`readActive(root)` 为 null。
- `reports no active pointer when active.json is corrupted`：写 `"not json"` 后 `readActive(root)` 为 null。
- `round-trips the active pointer`：`writeActiveAtomic(root, "0.7.0")` 后 `readActive(root).version === "0.7.0"`。
- `replaces an existing pointer`：先写 `"0.6.0"` 再写 `"0.7.0"`，`readActive(root).version === "0.7.0"`。
- `leaves no temporary file behind after an atomic replace`：替换后 `existsSync(path.join(root, "versions", "active.json.tmp"))` 为 false。
- `lists installed versions with manifest presence`：种 `0.6.0`（带 manifest）与 `0.7.0`（不带），`listInstalled(root)` 返回 `[{version:"0.6.0",hasManifest:true},…{version:"0.7.0",hasManifest:false}]`（按 semver 升序，每项含 `sizeBytes` 数字）。
- `ignores non-version entries in the versions directory`：建 `versions/README.md` 与 `versions/.tmp` 后 `listInstalled(root)` 不含它们。
- `refuses to remove the active version`：指针指向 `0.6.0` 时 `removeVersion(root, "0.6.0")` 返回 `{removed:false, reason:"active"}` 且目录仍在。
- `removes an inactive version and keeps its manifest snapshot`：删 `0.6.0` 后目录消失、`manifest/openwiki-0.6.0.json` 仍在。
- `reports removing a version that is not installed`：`removeVersion(root, "9.9.9")` 返回 `{removed:false, reason:"not-installed"}`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/versions.test.mjs`
预期：FAIL，`versions.mjs` 模块不存在。

- [ ] **步骤 3：实现 `src/versions.mjs`**

签名（文件头 JSDoc 说明职责：版本目录布局与指针的唯一权威）：

```js
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export function isValidVersion(value) -> boolean
export function versionsRoot(pkgRoot) -> string              // <pkgRoot>/versions
export function versionDir(pkgRoot, version) -> string       // 校验后拼接；非法抛 Error
export function readActive(pkgRoot) -> { version: string } | null
export function writeActiveAtomic(pkgRoot, version) -> void  // active.json.tmp → rename；Windows 覆盖失败重试
export function listInstalled(pkgRoot) -> Array<{ version: string, hasManifest: boolean, sizeBytes: number }>
export function removeVersion(pkgRoot, version) -> { removed: boolean, reason?: "active" | "not-installed" | "invalid" }
```

包根按 `src/manifest.mjs` 同样的两行推导（`path.dirname(path.dirname(fileURLToPath(import.meta.url)))`）；所有函数接受 `pkgRoot` 参数，调用方默认传真实包根。`writeActiveAtomic` 用 `writeFileSync(tmp)` + `renameSync`，rename 抛 `EPERM`/`EEXIST`/`EACCES` 时删除目标后重试一次（Windows 覆盖语义）。`sizeBytes` 用递归 `readdirSync(withFileTypes)` 求和，读失败按 0 计。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/versions.test.mjs`
预期：PASS，全部用例绿。

- [ ] **步骤 5：Commit**

```bash
git add src/versions.mjs test/versions.test.mjs
git commit -m "feat: add version storage layer with atomic active pointer"
```

---

## 任务 2：指针解析与 doctor 展示

**文件：**
- 修改：`src/paths.mjs`
- 修改：`src/commands/doctor.mjs`
- 测试：修改 `test/paths.test.mjs`、`test/doctor.test.mjs`

- [ ] **步骤 1：编写失败的测试**

`test/paths.test.mjs` 保留现有两条（不传参，走真实包根），追加（用 `mkdtempSync` 造假包根；假 openwiki 只需 `package.json` 与 `dist/cli/cli.js` 两个文件）：

- `prefers the version the active pointer names`：`pkgRoot` 下 `versions/0.7.0/node_modules/openwiki` + `active.json` 指向 `0.7.0` → 返回 `{ version:"0.7.0", source:"versions", cliJs:<versions/0.7.0/.../cli.js> }`。
- `falls back to the bundled dependency when no pointer exists`：`pkgRoot/node_modules/openwiki` 存在、无指针 → `source:"bundled"`、`version` 为该假包版本。
- `falls back with a warning when the pointer is corrupted`：`active.json` 写 `"not json"` → `source:"bundled"` 且注入的 `logger.warn` 被调用过一次。
- `falls back when the pointed version is not installed`：指针指向 `9.9.9`、`versions/` 为空 → `source:"bundled"` + warn。
- `resolves an explicit version without consulting the pointer`：指针指向 `0.6.0`、`versions/0.7.0` 已装 → `resolveOpenwikiRuntime({ explicitVersion:"0.7.0", pkgRoot })` → `version:"0.7.0"`。
- `never resolves an openwiki found by walking up the tree`：`pkgRoot` 无 `node_modules/openwiki`、无指针，但其父目录 `node_modules/openwiki` 存在（模拟 npm 全局根）→ 抛 `OpenwikiNotFoundError`。

`test/doctor.test.mjs` 追加（沿用现有 `capture()` / 注入风格）：
- `shows the active pointer and its source`：`resolveRuntime` 返回 `{...RUNTIME, source:"versions"}`、注入临时 `pkgRoot`（含 `active.json` → `0.7.0`）→ 输出含 `✓ 版本指针：0.7.0（versions）`。
- `warns when the pointer is corrupted and the bundled version is in use`：`source:"bundled"` + `active.json` 损坏 → 输出含指针异常与 `switch` 修复提示。
- `tells the user a globally installed openwiki is not used`：注入 `resolveGlobalRoot` 返回含假 openwiki 的临时目录 → 输出含 `launcher 不使用它`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/paths.test.mjs test/doctor.test.mjs`
预期：FAIL，`source`/指针相关断言不过（旧签名无 `source` 字段、doctor 无指针行）。

- [ ] **步骤 3：实现解析与展示**

`src/paths.mjs`：

```js
export async function resolveOpenwikiRuntime({ explicitVersion, pkgRoot, logger } = {})
// -> { packageRoot, version, cliJs, source: "versions" | "bundled" }
```

解析顺序：`explicitVersion` 给出 → 直接解析 `versionDir(pkgRoot, explicitVersion)` 下的 openwiki（校验入口存在，不存在抛 `OpenwikiNotFoundError`）；否则读指针 → 命中且可解析 → `source:"versions"`；任一环节不满足 → `logger?.warn(...)` 后**显式**回退出厂依赖：只解析 `pkgRoot/node_modules`（`createRequire(import.meta.url)` 加 `paths:[pkgRoot]` 限定，或拼接路径后 `existsSync` 校验），`source:"bundled"`；都失败抛 `OpenwikiNotFoundError`。默认 `pkgRoot` 为真实包根，默认 `logger` 为静默对象。从 `src/versions.mjs` 导入 `versionDir` / `readActive` / `isValidVersion`。

`src/commands/doctor.mjs`：在 openwiki 行之后加一行指针状态——`readActive(pkgRoot)` 有值且与 `runtime.version` 一致 → `✓ 版本指针：<v>（versions）`；指针损坏（`active.json` 存在但 `readActive` 为 null）→ `! 版本指针损坏，已回退出厂依赖；修复：重跑 switch 或删除 versions/active.json`；无指针 → `✓ 版本指针：未设置，使用出厂依赖（bundled）`。新增 `pkgRoot` 与 `resolveGlobalRoot` 注入（默认值：真实包根 / spawn `npm root -g` 取输出），检测到全局 openwiki（`<globalRoot>/openwiki/package.json` 存在）时打印 `! 检测到全局 openwiki（<path>），launcher 不使用它；请用 check/update/switch 管理版本`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/paths.test.mjs test/doctor.test.mjs`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/paths.mjs src/commands/doctor.mjs test/paths.test.mjs test/doctor.test.mjs
git commit -m "feat: resolve openwiki from the active pointer with explicit bundled fallback"
```

---

## 任务 3：`check` 命令

**文件：**
- 创建：`src/commands/check.mjs`
- 测试：`test/check.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
import { runCheckCommand } from "../src/commands/check.mjs";
// 复用 test/helpers.mjs 的 collectLogger / makeTempDir / removeTempDir。
// runNpm 是注入的 npm 执行器：runNpm(["view","openwiki","versions","--json"])
// -> Promise<{ code: number, stdout: string, stderr: string }>
```

用例：
- `prints the active version and its source`：`resolveRuntime` 返回 `{version:"0.7.0",source:"versions"}` → 输出含 `当前生效版本：0.7.0（versions 指针）`。
- `prints the bundled fallback when no pointer is set`：`source:"bundled"` → 输出含 `当前生效版本：0.6.0（出厂依赖）`。
- `lists installed versions with snapshot status and disk usage`：临时 `pkgRoot` 种两个版本（任务 1 的 `plantVersion` 写法）→ 输出两行均含版本号，带 manifest 的那行含 `快照 ✓`，另一行含 `快照 ✗`；含 `磁盘占用`。
- `shows the registry latest version`：`runNpm` 返回 `versions` JSON（`["0.6.0","0.7.0"]`）→ 输出含 `registry 最新版本：0.7.0`。
- `degrades gracefully when the registry query fails`：`runNpm` 返回 `{code:1}` → 仍输出本地信息、含 `registry 查询失败` 提示，退出码 0。
- `reports a corrupted pointer`：`active.json` 损坏 → 输出含 `版本指针损坏` 与修复提示，退出码 0。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/check.test.mjs`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `src/commands/check.mjs`**

```js
export async function runCheckCommand({
  logger, pkgRoot, resolveRuntime = resolveOpenwikiRuntime,
  runNpm, env = process.env,
}) -> Promise<number>
```

只读命令：`resolveRuntime({ pkgRoot })` 拿生效版本与 source → 打印；`listInstalled(pkgRoot)` 逐行打印（版本、快照有无——用 `src/manifest.mjs` 的 `loadManifest(v)` 判断、`sizeBytes` 汇总成一行磁盘占用）；`runNpm(["view","openwiki","versions","--json"])` 取数组最后一个为最新版，失败只降级提示不改变退出码。退出码恒 0（规格 4.1）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/check.test.mjs`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/commands/check.mjs test/check.test.mjs
git commit -m "feat: add check command for local openwiki version status"
```

---

## 任务 4：`update` 命令

**文件：**
- 创建：`src/gen-manifest.mjs`（从 `scripts/gen-manifest.mjs` 迁入 `generateManifest` / `writeManifest`）
- 修改：`scripts/gen-manifest.mjs`（改为 CLI 包装，从 `../src/gen-manifest.mjs` 导入；保留 `npm run manifest` 行为）
- 创建：`src/commands/update.mjs`
- 测试：`test/update.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// 注入面（全部可假）：
//   runNpm(args) -> Promise<{code, stdout, stderr}>   —— 按 args 分支：
//     ["view","openwiki","versions","--json"] -> {code:0, stdout:'["0.6.0","0.7.0"]'}
//     ["install", ...]                          -> {code:0} 或 {code:1}
//   confirm(question) -> Promise<boolean>        —— 交互确认
//   writeSnapshot(options) -> Promise<manifest>  —— 默认=writeManifest，测试返回假快照或抛错
```

用例：
- `installs the chosen version, writes a snapshot and activates it`：`confirm` 恒 true、`writeSnapshot` 返回 `{openwikiVersion:"0.7.0",protocolVersion:"2024-11-05",tools:[{name:"openwiki_a"}]}` → 退出码 0；`versions/0.7.0` 目录被 `runNpm` 的 install 触达（记录调用）；`readActive(pkgRoot).version === "0.7.0"`；`manifest/openwiki-0.7.0.json` 被写入（JSON 含 `"openwiki_a"`）。
- `does nothing when the user declines the prompt`：`confirm` 返回 false → 退出码 0，`runNpm` 无 install 调用，指针不变。
- `does nothing when already on the latest version`：指针已指向 `0.7.0`、registry 最新 `0.7.0` → 输出含 `已是最新`，退出码 0，无 install。
- `cleans up the version directory when npm install fails`：install 返回 `{code:1}` → 退出码 1，`existsSync(versionDir(pkgRoot,"0.7.0"))` 为 false，指针不变。
- `keeps the version but does not activate it when snapshot generation fails`：`writeSnapshot` 抛错 → 退出码 1，`versionDir` 仍在，`readActive` 为 null；输出含 `直通模式`。
- `activates anyway when the user accepts a snapshot-less version`：`writeSnapshot` 抛错、第二次 `confirm`（“仍要激活吗”）返回 true → 退出码 0，指针指向 `0.7.0`。
- `rejects a snapshot with no tools`：`writeSnapshot` 返回 `{protocolVersion:"2024-11-05",tools:[]}` → 视同快照失败（退出码 1、不激活）。
- `skips activation with --no-switch`：install + 快照成功 → `readActive` 为 null，`versionDir` 与 manifest 均在，退出码 0。
- `rejects an invalid --version value`：`--version latest` → 退出码 1，输出含版本名规则，`runNpm` 无任何调用。
- `installs an explicit --version without prompting`：`--version 0.6.3` → `confirm` 从未被调用，install 的 args 含 `openwiki@0.6.3`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/update.test.mjs`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现搬迁与 `src/commands/update.mjs`**

搬迁：把 `scripts/gen-manifest.mjs` 中 `generateManifest` 与 `writeManifest` 原样移入 `src/gen-manifest.mjs`，`generateManifest` 增加 `explicitVersion` 参数并透传给 `resolveOpenwikiRuntime({ explicitVersion, pkgRoot })`；`scripts/gen-manifest.mjs` 只剩「直接运行时的 CLI 包装」，从 `../src/gen-manifest.mjs` 导入。`npm run manifest` 行为不变。

```js
// src/commands/update.mjs
export async function installVersion({ pkgRoot, version, runNpm, logger })
// -> { ok: true } | { ok: false }；执行 npm install openwiki@<v> --prefix <versionDir>
//   （win32 用 "npm.cmd"）；失败时 rm -rf 该版本目录（半成品清理）。

export async function runUpdateCommand({
  logger, pkgRoot, env = process.env, runNpm,
  confirm,                          // (question) => Promise<boolean>；默认 node:readline
  resolveRuntime = resolveOpenwikiRuntime,
  writeSnapshot = writeManifest,    // ({explicitVersion, hostId}) -> Promise<manifest>
}) -> Promise<number>
```

流程按规格 4.2：解析 `--version` / `--no-switch`（`--version` 值过 `VERSION_PATTERN`，非法退出 1）→ `runNpm(["view","openwiki","versions","--json"])` 取数组末位为最新（查询失败退出 1）→ `resolveRuntime` 取当前版本，相同则 `已是最新` 退出 0 → 目标 = `--version` 或「列出最近 10 个版本 + confirm（默认建议最新版）」，decline 退出 0 → `installVersion`（失败退出 1）→ `writeSnapshot({explicitVersion: target, hostId:"update"})`，失败或 `tools` 为空/缺 `protocolVersion` → 提示直通模式 + confirm 是否仍激活（默认否；否 → 退出 1）→ `--no-switch` 时跳过、否则 `writeActiveAtomic`（失败退出 1）→ 打印摘要（版本、工具数）与提醒（skill 刷新、宿主下次连接生效、可跑 `warm`）。所有 `logger` 文案用中文，与既有命令风格一致。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/update.test.mjs`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/gen-manifest.mjs scripts/gen-manifest.mjs src/commands/update.mjs test/update.test.mjs
git commit -m "feat: add update command with interactive confirmation and failure rollback"
```

---

## 任务 5：`switch` 命令

**文件：**
- 创建：`src/commands/switch.mjs`
- 测试：`test/switch.test.mjs`

- [ ] **步骤 1：编写失败的测试**

注入面同任务 4（`runNpm` / `confirm` / `writeSnapshot` / `resolveRuntime`）。

用例：
- `switches to an installed version`：`versions/0.6.0` 已种、指针原指向 `0.7.0` → `runSwitchCommand({version:"0.6.0",...})` 退出码 0，`readActive(pkgRoot).version === "0.6.0"`，输出含 `0.7.0 → 0.6.0`。
- `refuses an invalid version name`：`version:"latest"` → 退出码 1，指针不变，`runNpm` 无调用。
- `offers to install a version that is not installed`：`confirm` 返回 false → 退出码 1，无 install，指针不变，输出含 `未安装`。
- `installs on confirmation and then switches`：`confirm` 恒 true、`versions/` 为空 → install + 快照 + 指针写入，退出码 0。
- `leaves the pointer untouched when the confirmed install fails`：install 返回 `{code:1}` → 退出码 1，`readActive` 为调用前值。
- `refuses a version directory without the openwiki entry`：建了 `versions/9.9.9/` 但无 `node_modules/openwiki` → 退出码 1，输出含无法解析，指针不变。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/switch.test.mjs`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `src/commands/switch.mjs`**

```js
export async function runSwitchCommand({
  logger, pkgRoot, version, runNpm, confirm,
  resolveRuntime = resolveOpenwikiRuntime,
  writeSnapshot = writeManifest,
  installVersion: install = installVersion,   // 默认从 update.mjs 导入
}) -> Promise<number>
```

流程：版本名过 `VERSION_PATTERN`（非法退出 1）→ 已安装判定 = `versionDir` 下能解析出 `node_modules/openwiki/package.json` 与 `dist/cli/cli.js`；未安装 → confirm 代装（否 → 退出 1），代装走任务 4 的 `installVersion` + `writeSnapshot`（失败退出 1、不切指针）→ `writeActiveAtomic`（失败退出 1）→ 打印「当前 → 目标」与提示（运行中会话不受影响、宿主下次连接生效、可跑 `warm`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/switch.test.mjs`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/commands/switch.mjs test/switch.test.mjs
git commit -m "feat: add switch command for instant version rollback"
```

---

## 任务 6：`versions remove` 命令

**文件：**
- 创建：`src/commands/versions.mjs`
- 测试：`test/versions-command.test.mjs`

- [ ] **步骤 1：编写失败的测试**

用例：
- `removes an inactive version and reports it`：`versions/0.6.0` 已种、指针指向 `0.7.0` → 退出码 0，目录消失，输出含 `已删除`。
- `refuses to remove the active version`：指针指向 `0.6.0` → 退出码 1，目录仍在，输出含 `当前激活` 与 `先 switch`。
- `rejects an invalid version name`：`version:".."` → 退出码 1，文件系统无任何改动。
- `reports a version that is not installed`：`9.9.9` → 退出码 1，输出含 `未安装`。
- `keeps the manifest snapshot after removal`：删 `0.6.0` 后 `manifest/openwiki-0.6.0.json` 仍存在。
- `prints usage when no subcommand is given`：`[]` → 退出码 1，输出含 `versions remove <version>`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/versions-command.test.mjs`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `src/commands/versions.mjs`**

```js
export async function runVersionsCommand({ logger, pkgRoot, args }) -> Promise<number>
```

只认 `remove <version>` 一个子命令：过 `removeVersion(pkgRoot, version)`（护栏在任务 1 已实现：激活版本拒删、未安装报 `not-installed`、非法名报 `invalid`），按 `reason` 给对应中文提示与退出码；`args` 为空或其他子命令 → 打印用法 `versions remove <version>` 退出 1。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/versions-command.test.mjs`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/commands/versions.mjs test/versions-command.test.mjs
git commit -m "feat: add versions remove command with active-version guard"
```

---

## 任务 7：CLI 注册、HELP、文档与版本号

**文件：**
- 修改：`src/cli.mjs`
- 修改：`README.md`
- 修改：`package.json`（`version` → `0.3.0`）
- 测试：修改 `test/cli.test.mjs`

- [ ] **步骤 1：编写失败的测试**

`test/cli.test.mjs` 追加（沿用 `main(argv, deps)` 注入风格）：
- `routes check to the check command`：`main(["check"], { logger, resolveRuntime: async () => ({version:"0.6.0",source:"bundled"}), runNpm: async () => ({code:0,stdout:'["0.6.0"]'}) })` → 退出码 0，输出含 `当前生效版本`。
- `routes update and forwards --version`：`main(["update","--version","0.6.3"], { logger, runNpm, confirm, writeSnapshot })` → 退出码 0，`runNpm` 收到含 `openwiki@0.6.3` 的 install 调用。
- `routes switch with its version argument`：`main(["switch","0.6.0"], deps)` → 退出码 0。
- `routes versions remove`：`main(["versions","remove","0.6.0"], deps)` → 退出码 0。
- `keeps the version command for the launcher itself`：`main(["--version"])` 仍打印 launcher 版本（不被 update 的 `--version` 歧义影响）。
- `help lists the four new commands`：`main(["help"])` 输出含 `check`、`update`、`switch`、`versions remove` 四行。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/cli.test.mjs`
预期：FAIL，新命令走到 `未知命令` 分支。

- [ ] **步骤 3：接线与文档**

`src/cli.mjs`：在 `doctor` 分支后追加 `check` / `update` / `switch` / `versions` 四个分支（`versions` 把 `rest` 作为 `args` 传入）；`HELP` 增加四行命令说明；`cliDeps` 补齐新命令需要的注入（`runNpm`、`confirm`、`writeSnapshot` 默认值走真实实现）。`package.json` 版本改 `0.3.0`。README：命令表加四行；「工作方式」加一条指针解析说明（指针优先、损坏回退出厂、全局安装不参与）；故障排查加「指针损坏」一行；环境变量表无需新增（本任务无新变量）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/cli.test.mjs`
预期：PASS。

- [ ] **步骤 5：全量验证**

运行：`npx vitest run`
预期：全部通过（`real-openwiki` 三个用例在无 `LAUNCHER_REAL_SMOKE=1` 时跳过）。

- [ ] **步骤 6：Commit**

```bash
git add src/cli.mjs test/cli.test.mjs README.md package.json
git commit -m "feat: register version commands, ship 0.3.0"
```

---

## 自检记录

- **规格覆盖度**：规格 3.1/3.2（目录布局与解析）→ 任务 1、2；3.3（自动生效面）→ 任务 2 解析变更即全链路生效，无额外代码；4.1 check → 任务 3；4.2 update → 任务 4；4.3 switch → 任务 5；4.4 versions remove → 任务 6；4.5 CLI 与文档 → 任务 7；第 5 节失败矩阵 → 任务 4/5 的失败用例；第 6 节护栏 → 任务 1 校验 + 任务 5/6 拒绝用例；第 7 节影响面 → 任务 2（paths/doctor）、4（gen-manifest 搬迁）、7（cli/README）；第 8 节测试 → 各任务测试文件；第 9 节范围外 → 无对应任务（符合预期）。
- **审查重点落点**：6 条全部有用例钉住——路径穿越（任务 1 `refuses to build a directory for an invalid version` + 任务 5/6 拒绝用例）、指针损坏（任务 2）、快照失败（任务 4）、半成品清理（任务 4）、Windows 原子替换（任务 1 `leaves no temporary file behind`）、代装失败不切指针（任务 5）。
- **类型一致性**：`readActive`/`writeActiveAtomic`/`versionDir`/`listInstalled`/`removeVersion`/`isValidVersion` 在任务 1 定义，任务 2-6 同名沿用；`installVersion` 在任务 4 导出、任务 5 默认导入；`runNpm`/`confirm`/`writeSnapshot` 三个注入名全计划一致。
- **比例**：计划只钉签名、注入面、测试名与断言、规格文案；函数体留给实现者。


