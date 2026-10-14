# 默认版本物化与就绪解耦实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让出厂依赖（`node_modules/openwiki`）在首次就绪时物化成 `versions/<v>/` 这一等公民，并把"默认版本就绪"从宿主安装结果里解耦，使 `switch` 回默认版本零下载、bundle 一定存在且一定来自正确版本的代码。

**架构：** 新增 `src/openwiki-install.mjs` 承载版本键控锁与"临时目录安装 → 完整性校验 → 原子 rename"的安装内核；新增 `src/ensure-default.mjs` 承载 `ensureDefaultVersion({ mode })`（`explicit` / `self-heal` 双模式，带删除标记与失败退避）；`bundle.meta.json` 增加 `entryVersion` 并收紧入口回退条件；`install` / `warm` / `warmup` / `switch` / `update` / `mcp` / `versions` 七个入口接线。

**技术栈：** Node ESM（`node:fs` 同步 API、`node:child_process` 的 `spawnSync`）、vitest、既有 `src/lockfile.mjs` 的 `wx` 独占锁、既有 `src/npm-runner.mjs`。

**规格：** `docs/superpowers/specs/2026-10-14-default-version-materialization-design.md`（执行前两份都读）

## 全局约束

- 安装路径一律 `versions/.tmp-<version>-<pid>/` → 校验 → `renameSync` 成 `versions/<version>/`；任何时刻 `versions/<version>/` 要么不存在、要么完整（规格 I5）。
- 版本名一律走 `isValidVersion`（`/^\d+\.\d+\.\d+$/`），拼进路径前必须校验。
- npm 安装参数固定为 `["install", "openwiki@<v>", "--prefix", <dir>, "--prefer-offline", "--no-audit", "--no-fund"]`。
- bundle meta 最终字段：`{ openwikiVersion, entryVersion, scriptHash, nodeMajor, platform, bundleHash, file }`；`entryVersion !== version` 一律视为过期或构建失败（规格 I6）。
- 所有就绪动作软着陆：失败不写 `versions/active.json`、不改变 `install` / `update` 的退出码；`switch` 例外，物化失败即切换失败（退出码 1）。
- 日志文案沿用既有中文风格；新增文案里不出现英文句子。
- 测试用 `vitest run`；本仓库当前可运行全量测试（若沙箱不可运行，用等价 node 脚本做 RED/GREEN，vitest 文件照常入库）。

## 审查重点（Review Focus）

1. **离线 / npm 缓存未命中**：`installVersion` 失败必须软着陆为 `{ ok: false, stage: "install", reason }` 并清理 `.tmp-*`；`switch` 到未物化的默认版本必须**拒绝切换且 `active.json` 保持不变**。
2. **安装被中断**（宿主退出、进程被杀、CI 超时）：`versions/<v>/` 不得出现半成品；遗留的 `.tmp-<v>-<死pid>` 与 `.bak-<v>-<死pid>` 在下一次触发时被清掉。
3. **非默认版本的 bundle 不得由出厂代码冒充**：`versions/0.7.0` 无入口时 `runBundleBackend` 必须失败（仅当目标版本等于出厂版本才允许回退）；历史错误 meta（缺 `entryVersion`）必须被判过期并重建。
4. **用户显式删除默认版本后**：`mcp` 后台自愈与 `update` 前置就绪不得把它重建；`install` / `warm` / `warmup` / `switch` 可以重建并清除删除标记。
5. **Windows 上目标目录已存在或被占用**：`renameSync` 覆盖失败、Defender 锁文件、运行中后端占用 bundle 文件时，必须留在可诊断的错误态（不写 meta、不留半成品），下一次触发可自愈。

## 文件结构

**创建**

- `src/openwiki-install.mjs` — 安装内核：`withVersionLock`、`cleanupStaleTempDirs`、`installVersion`、`installAndSnapshot`、`promoteVersionDir`、`verifyInstallTree`。这是"往 `versions/` 写一个版本"的唯一入口。
- `src/ensure-default.mjs` — 默认版本就绪：`ensureDefaultVersion`、`bundledVersionMarkerPaths`、`readMarker` / `writeMarker` / `clearMarker`、`prepareEnabled`、`backoffMsFromEnv`。
- `test/openwiki-install.test.mjs`、`test/ensure-default.test.mjs`。

**修改**

- `src/paths.mjs` — 导出 `bundledOpenwikiVersion(pkgRoot)`（现有私有 `readDeclaredVersion` 提升为契约）。
- `src/lockfile.mjs` — 导出 `pidAlive(pid)`（从 `src/ensure-bundle.mjs:14-21` 迁出，供两处共用）。
- `src/npm-runner.mjs` — `runNpm(args, { onStderr, onSpawn })`，`onSpawn(child)` 供设置子进程优先级。
- `src/commands/update.mjs` — `installVersion` / `installAndSnapshot` 改为 re-export；`defaultRunNpm` 透传第二参数；失败分支按新 `stage` 判定。
- `scripts/bundle-backend.mjs` — 有条件的入口回退；返回 `{ ok, entryVersion?, reason? }`；CLI 尾部适配。
- `src/ensure-bundle.mjs` — meta 增 `entryVersion` 并断言一致；`metaValid` 增条件；复用 `pidAlive`。
- `src/commands/mcp.mjs` — 后台补打改走就绪动作、`pkgRoot` 用 launcher 包根。
- `src/commands/install.mjs`、`src/cli.mjs` — 判据改写、`--no-prepare`、HELP。
- `src/commands/warm.mjs`、`src/commands/warmup.mjs`、`src/commands/switch.mjs`、`src/commands/versions.mjs`。
- `src/commands/doctor.mjs`、`src/commands/check.mjs`、`README.md`。
- 既有测试的 fake 适配：`test/update.test.mjs`、`test/switch.test.mjs`。

---

### 任务 1：`bundledOpenwikiVersion` + 版本键控锁

**文件：**
- 修改：`src/paths.mjs`、`src/lockfile.mjs`、`src/ensure-bundle.mjs:14-21`
- 创建：`src/openwiki-install.mjs`、`test/openwiki-install.test.mjs`

- [ ] **步骤 1：编写失败的测试**

`test/openwiki-install.test.mjs`：

```js
// bundledOpenwikiVersion：node_modules/openwiki/package.json 的 version；缺失/损坏返回 null
// cleanupStaleTempDirs(root, { isPidAlive }):
//   versions/.tmp-0.6.0-<死pid>/ 与 versions/.bak-0.6.0-<死pid>/ 被删除
//   versions/.tmp-0.6.0-<活pid>/ 保留
//   versions/README.md（不匹配名字）保留
// withVersionLock({ pkgRoot, version, logger }, fn):
//   拿到锁时跑 fn 并返回 { ok: true, value }
//   已有活 pid 持锁 → { ok: false, reason: "locked" }，且不执行 fn
//   残留锁（持锁 pid 已死）→ force 重取并执行 fn
//   无论 fn 抛错与否，versions/install-0.6.0.lock 都不复存在
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/openwiki-install.test.mjs`
预期：FAIL，`src/openwiki-install.mjs` 不存在

- [ ] **步骤 3：实现**

`src/lockfile.mjs` 增加：

```js
export function pidAlive(pid) { /* 迁自 src/ensure-bundle.mjs：EPERM 视为存活 */ }
```

`src/ensure-bundle.mjs` 删除本地 `pidAlive`，改为从 `./lockfile.mjs` 导入（行为不变，`test/ensure-bundle.test.mjs` 必须保持全绿）。

`src/paths.mjs` 增加 `export function bundledOpenwikiVersion(pkgRoot = launcherPackageRoot())`：读 `<pkgRoot>/node_modules/openwiki/package.json` 的 `version`，任何异常返回 `null`。

`src/openwiki-install.mjs`：

```js
export function cleanupStaleTempDirs(pkgRoot, { isPidAlive = pidAlive } = {}) // → { removed: string[] }
export async function withVersionLock({ pkgRoot, version, logger }, fn)
// 锁路径 path.join(versionsRoot(pkgRoot), `install-${version}.lock`)
// 数据 { pid: process.pid, version, startedAt: Date.now() }
// 先 cleanupStaleTempDirs，再 acquireLock；EEXIST 时读 existing.pid，!isPidAlive → releaseLock + 重取一次
// finally 释放锁；返回 { ok: true, value }，拿不到锁返回 { ok: false, reason: "locked" }
```

`cleanupStaleTempDirs` 的匹配式：`/^\.(tmp|bak)-(\d+\.\d+\.\d+)-(\d+)$/`，要求 `lstatSync(...).isDirectory()`，且 `!isPidAlive(pid)` 才 `rmSync(..., { recursive: true, force: true })`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/openwiki-install.test.mjs test/ensure-bundle.test.mjs test/lockfile.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/openwiki-install.mjs src/paths.mjs src/lockfile.mjs src/ensure-bundle.mjs test/openwiki-install.test.mjs
git commit -m "feat: 版本键控安装锁与残留临时目录清理"
```

---

### 任务 2：原子安装与完整性校验（含 `installVersion` 下沉）

**文件：**
- 修改：`src/openwiki-install.mjs`、`src/commands/update.mjs`、`src/npm-runner.mjs`
- 测试：`test/openwiki-install.test.mjs`、`test/update.test.mjs`、`test/switch.test.mjs`

- [ ] **步骤 1：编写失败的测试**

追加到 `test/openwiki-install.test.mjs`（fake `runNpm` 在成功时按 `--prefix` 种出入口树，参考 `test/update.test.mjs:46-51` 的 `plantInstalled`）：

```js
// 成功路径：
//   installVersion({ pkgRoot, version: "0.7.0", runNpm: fake, logger }) → { ok: true, entryVersion: "0.7.0" }
//   versions/0.7.0/node_modules/openwiki/{package.json,dist/cli/cli.js} 存在
//   versions/0.7.0/install.meta.json = { version, nodeMajor, installedAt }
//   versions/ 下没有 .tmp-* / .bak-*
//   fake 收到的 install 参数 === ["install","openwiki@0.7.0","--prefix",<tmp>,"--prefer-offline","--no-audit","--no-fund"]
//     （断言 <tmp> 匹配 /\.tmp-0\.7\.0-\d+$/）
// npm 非 0 退出 → { ok: false, stage: "install", reason } 且 versions/0.7.0 不存在、无 .tmp-*
// 种出入口树但缺 dist/cli/cli.js → { ok: false, stage: "verify" } 且 versions/0.7.0 不存在
// 种出 package.json 的 version 为 "0.6.0"（与请求不符）→ { ok: false, stage: "verify" }
// 种出 better-sqlite3 且注入 verifyNativeFn 返回 false → { ok: false, stage: "verify" }
// 未种 better-sqlite3 时 verifyNativeFn 不得被调用
// versions/0.7.0 已存在且只有 bundle-ad5d0f39.mjs + bundle.meta.json → 安装后两者仍在、node_modules 也在
// 嵌入 withVersionLock 时拿不到锁 → { ok: false, stage: "locked" }
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/openwiki-install.test.mjs`
预期：FAIL，`installVersion` 未导出

- [ ] **步骤 3：实现**

`src/npm-runner.mjs`：`runNpm(args, { onStderr, onSpawn })`，spawn 成功后立刻调用 `onSpawn(child)`（`onSpawn` 未给则跳过）。

`src/openwiki-install.mjs` 追加：

```js
export function verifyInstallTree(tmpDir, version, { isPidAlive, verifyNativeFn = defaultVerifyNative } = {})
// → { ok: true } | { ok: false, reason }
// 1. node_modules/openwiki/package.json 与 dist/cli/cli.js 存在
// 2. package.json.version === version
// 3. 若 node_modules/better-sqlite3 存在 → verifyNativeFn(tmpDir) 必须为 true
export function defaultVerifyNative(dir, { timeoutMs = 30000 } = {})  // spawnSync(process.execPath, ["-e","import('better-sqlite3')"], { cwd: dir, timeout: timeoutMs }).status === 0
export function promoteVersionDir({ pkgRoot, version, tmpDir })
// versions/<v> 不存在 → renameSync(tmpDir, target)
// 已存在 → renameSync(target, versions/.bak-<v>-<pid>) → renameSync(tmpDir, target)
//          → 把 .bak 里的 bundle.meta.json、meta.file 指向的 bundle-*.mjs、bundle.bad 复制进 target
//          → rmSync(.bak)
export async function installVersion({ pkgRoot, version, runNpm, logger, priority = "normal", deps = {} })
// 流程：rmSync(tmp) → runNpm(args, { onSpawn: priority === "below-normal" ? setPriorityBelowNormal : undefined })
//       → 非 0：rmSync(tmp)、summarizeInstallFailure 逐行 logger.error、返回 { ok:false, stage:"install", reason }
//       → verifyInstallTree 失败：rmSync(tmp)、返回 { ok:false, stage:"verify", reason }
//       → promoteVersionDir → 写 install.meta.json → { ok: true, entryVersion: version }
export async function installAndSnapshot({ pkgRoot, version, runNpm, logger, writeSnapshot, hostId })
// 与现状语义一致（已安装则跳过下载），但走 withVersionLock 且安装失败时 stage 为 "install"|"verify"|"locked"
```

`priority === "below-normal"` 时用 `os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`，抛错静默。

`src/commands/update.mjs`：删除本地 `installVersion` / `installAndSnapshot` 实现，改为

```js
export { installVersion, installAndSnapshot } from "../openwiki-install.mjs";
```

`defaultRunNpm` 改为 `(args, options) => runNpm(args, { ...options, onStderr: (t) => process.stderr.write(t) })`；`runUpdateCommand` 的失败分支由 `outcome.stage === "install"` 改为 `!outcome.ok && outcome.stage !== "snapshot"`。

- [ ] **步骤 4：适配既有 fake 并跑全量**

`test/update.test.mjs`：`fakeNpm` 的 `installCode === 0` 分支按 `--prefix` 种出可解析入口树（`package.json` 的 `version` 取 `args[1]` 里 `openwiki@` 后面的版本）；`:132` 的 `expect(outcome).toEqual({ ok: false })` 改为 `expect(outcome).toMatchObject({ ok: false, stage: "install" })`。
`test/switch.test.mjs`：`fakeNpm` 的成功分支同样种入口树（否则 `switch` 的代装会被校验拦下）。

运行：`npx vitest run`
预期：PASS（全绿）

- [ ] **步骤 5：Commit**

```bash
git add src/openwiki-install.mjs src/npm-runner.mjs src/commands/update.mjs test/openwiki-install.test.mjs test/update.test.mjs test/switch.test.mjs
git commit -m "feat: 原子安装与完整性校验，installVersion 下沉到 openwiki-install.mjs"
```

---

### 任务 3：bundle 入口源、回退边界与 `entryVersion`

**文件：**
- 修改：`scripts/bundle-backend.mjs`、`src/ensure-bundle.mjs`、`src/commands/mcp.mjs`
- 测试：`test/bundle-backend.test.mjs`、`test/ensure-bundle.test.mjs`、`test/mcp-command.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/bundle-backend.test.mjs
// 注入 fake esbuild（记录 build 参数）：
//   versions/0.7.0/node_modules/openwiki/dist/cli/cli.js 存在 → entryPoints[0] 是它，返回 { ok: true, entryVersion: "0.7.0" }
//   不存在且 bundledOpenwikiVersion(pkgRoot) === "0.6.0"、version === "0.6.0" → 回退出厂依赖，{ ok: true, entryVersion: "0.6.0" }
//   不存在且 version === "0.7.0" !== 出厂版本 → { ok: false, reason } 且不调用 build
// test/ensure-bundle.test.mjs
//   buildKernel 返回 { ok: true, entryVersion: "0.6.0" } 但请求 "0.7.0" → { ok: false } 且不写 bundle.meta.json
//   已有 meta 缺 entryVersion → 视为过期、重新构建
//   已有 meta 的 entryVersion === "0.6.0" 而请求 "0.7.0" → 视为过期
// test/mcp-command.test.mjs
//   scheduleBackgroundBundle 收到的 pkgRoot 是 launcher 包根（不再是 runtime.packageRoot）
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/bundle-backend.test.mjs test/ensure-bundle.test.mjs`
预期：FAIL（返回类型仍是数字 / meta 无 `entryVersion`）

- [ ] **步骤 3：实现**

`scripts/bundle-backend.mjs`：

```js
const entryCandidates = [
  path.join(versionDir(pkgRoot, targetVersion), "node_modules", "openwiki", "dist", "cli", "cli.js"),
  path.join(pkgRoot, "node_modules", "openwiki", "dist", "cli", "cli.js"),
];
// 第 2 个候选仅当 targetVersion === bundledOpenwikiVersion(pkgRoot) 时才纳入
// 全部落空 → return { ok: false, reason: `versions/${targetVersion} 下找不到可解析的 openwiki 入口` }
// 成功后读实际入口包的 package.json.version 作为 entryVersion，返回 { ok: true, entryVersion }
```

`targetDir` 改为 `outDir ?? versionDir(pkgRoot, targetVersion)`。文件末尾的 CLI 分支按新返回类型适配（`result.ok` → exit 0/1）。

`src/ensure-bundle.mjs`：

- `metaValid` 增加 `meta.entryVersion === version`；
- `ensureBundle` 从 `buildResult` 取 `entryVersion`，`entryVersion !== version` 时按构建失败处理（清临时产物、不写 meta）；
- 写入 meta 时带上 `entryVersion`；
- 内联 kernel 适配新返回类型（`buildKernel` 契约同步改为返回 `{ ok, entryVersion?, reason? }`）。

`src/commands/mcp.mjs:106-116`：`scheduleBackgroundBundle` 的 `pkgRoot` 改为 `launcherPackageRoot()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/bundle-backend.test.mjs test/ensure-bundle.test.mjs test/mcp-command.test.mjs test/paths.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add scripts/bundle-backend.mjs src/ensure-bundle.mjs src/commands/mcp.mjs test/bundle-backend.test.mjs test/ensure-bundle.test.mjs test/mcp-command.test.mjs
git commit -m "fix: bundle 入口按目标版本解析、meta 增加 entryVersion、修正 mcp 补打落点"
```

---

### 任务 4：`ensureDefaultVersion`（双模式、标记与退避）

**文件：**
- 创建：`src/ensure-default.mjs`、`test/ensure-default.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// fixture：临时 pkgRoot + node_modules/openwiki/package.json（version 0.6.0）+ manifest/openwiki-0.6.0.json
// prepareEnabled("0") === false；prepareEnabled({}) === true；prepareEnabled("1") === true；noPrepare 覆盖为 false
// 快照已存在 + isInstalled 为真 → installVersionFn / installAndSnapshotFn 都不被调用，ensureBundleFn 被调用一次
// 快照已存在 + 未安装 → installVersionFn 被调用一次、installAndSnapshotFn 不被调用
// 快照不存在 → installAndSnapshotFn 被调用一次（传入 hostId）
// mode "self-heal" + versions/default-removed.json={version:"0.6.0"} → { ok: true, skipped: "removed" }，三个 fn 都不被调用
// mode "explicit" + 同样的删除标记 → 正常执行，且成功后 default-removed.json 被删除
// mode "self-heal" + prepare-failed.json.nextRetryAt 在未来 → { ok: true, skipped: "backoff" }，不起 npm
// mode "explicit" + 退避中 → 正常执行，成功后 prepare-failed.json 被删除
// installVersionFn 返回 { ok:false, stage:"install", reason:"network down" }：
//   mode "self-heal" → 写 prepare-failed.json（nextRetryAt ≈ now + 24h），返回 { ok:false, stage:"install" }
//   mode "explicit" → 不写 prepare-failed.json
// LAUNCHER_PREPARE_BACKOFF_HOURS="0" → 失败后不写退避标记
// bundledOpenwikiVersion 为 null → { ok: false, stage: "version" }
// ensureBundleFn 返回 { ok:false } → 整体仍 { ok:true }，只 warn
// installVersionFn 返回 { ok:false, stage:"locked" } → 原样透传 stage
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/ensure-default.test.mjs`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现**

`src/ensure-default.mjs`：

```js
export const DEFAULT_REMOVED_FILE = "default-removed.json";   // versions/default-removed.json
export const PREPARE_FAILED_FILE = "prepare-failed.json";     // versions/prepare-failed.json
export const DEFAULT_BACKOFF_HOURS = 24;

export function prepareEnabled(env = process.env, { noPrepare = false } = {})
// noPrepare 为真 → false；否则 env.LAUNCHER_PREPARE !== "0"
export function readMarker(pkgRoot, name)      // 读不出来返回 null
export function writeMarker(pkgRoot, name, data)
export function clearMarker(pkgRoot, name)
export function backoffMsFromEnv(env = process.env)
// LAUNCHER_PREPARE_BACKOFF_HOURS 非负整数则用之，否则 DEFAULT_BACKOFF_HOURS；0 → 0（关闭）
export function markDefaultRemoved(pkgRoot, version)   // 供 versions 命令调用
export function markPrepareFailed(pkgRoot, version, reason, env)
export async function ensureDefaultVersion({
  pkgRoot, logger, mode = "explicit", hostId = "prepare", env = process.env,
  runNpm, priority = "normal",
  deps = { installVersionFn, installAndSnapshotFn, ensureBundleFn, writeSnapshot, now },
})
// 步骤严格按规格 §5：读版本 → self-heal 查标记 → withVersionLock → 快照分流 → ensureBundle
// 快照存在性用 existsSync(manifestFilePath(v, pkgRoot))
// 失败时 mode === "self-heal" 且 backoffMs > 0 → markPrepareFailed；mode === "explicit" 成功 → clearMarker(PREPARE_FAILED_FILE)
```

低优先级只在 `priority === "below-normal"` 时传给 `installVersion` / `installAndSnapshot`；开始与结束各 `logger.info` 一行：`开始后台就绪默认版本 openwiki@<v>（低优先级）`、`后台就绪完成（<ms>ms）` / `后台就绪失败：<reason>`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/ensure-default.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/ensure-default.mjs test/ensure-default.test.mjs
git commit -m "feat: ensureDefaultVersion 双模式就绪（删除标记与失败退避）"
```

---

### 任务 5：`install` 判据改写与 `--no-prepare`

**文件：**
- 修改：`src/commands/install.mjs`、`src/cli.mjs`
- 测试：`test/cli-install.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// 注入桩 ensureDefaultVersionFn / warmFn，断言调用次数与顺序（就绪先于预热）：
//   exitCode 0 且 report 全部 wrote:false（配置 unchanged）→ 就绪被调用一次
//   skippedNoHost（exit 1）→ 就绪被调用一次
//   失败回滚（exit 1、skippedNoHost:false）→ 就绪不被调用
//   护栏（exit 2）→ 就绪不被调用
//   --no-prepare → 就绪不被调用，但 warmFn 仍被调用一次
//   LAUNCHER_PREPARE=0 且无 --no-prepare → 就绪不被调用，warmFn 仍被调用
//   --no-warm → warmFn 不被调用，但就绪被调用一次
// parseInstallArgs(["--no-prepare"]) → flags.noPrepare === true
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/cli-install.test.mjs`
预期：FAIL，`--no-prepare` 被当成无法识别的参数

- [ ] **步骤 3：实现**

`src/commands/install.mjs`：

- `BOOL_FLAGS` 增加 `"--no-prepare"`；`parseInstallArgs` 的 flags 增加 `noPrepare: false`（对象字面量同时提供默认值）；
- `runInstallCommand` 收尾改为：

```js
const shouldPrepare = !flags.uninstall && prepareEnabled(env, { noPrepare: flags.noPrepare })
  && (result.skippedNoHost || result.exitCode === 0);
if (shouldPrepare) await prepareDefaultVersion({ logger, env, ensureBundleFn: deps.ensureDefaultVersionFn });
if (result.exitCode === 0 && !flags.uninstall && !flags.noWarm) {
  await warmAfterInstall({ logger, env, ensureBundleFn: deps.ensureBundleFn, warmFn: deps.warmFn });
}
```

其中 `prepareDefaultVersion` 是新增的收尾函数（`ensureDefaultVersion({ mode: "explicit", priority: "normal" })` + 失败 `logger.warn`，失败不影响退出码）。`warmAfterInstall` 保持现状（它内部的 `ensureBundleForActive` 与就绪互补：就绪管默认版本，它管当前生效版本）。

`src/cli.mjs`：`HELP` 增一行 `openwiki-launcher --no-prepare           跳过默认版本就绪（物化与 bundle），仍会预热`；`cliDeps` 增加 `ensureDefaultVersionFn: deps.ensureDefaultVersionFn`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/cli-install.test.mjs test/cli.test.mjs test/install.test.mjs test/e2e-install.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/install.mjs src/cli.mjs test/cli-install.test.mjs
git commit -m "feat: install 收尾按 skippedNoHost/exitCode 就绪，新增 --no-prepare"
```

---

### 任务 6：`warm` / `warmup` / `switch` / `update` 接线

**文件：**
- 修改：`src/commands/warm.mjs`、`src/commands/warmup.mjs`、`src/commands/switch.mjs`、`src/commands/update.mjs`、`src/cli.mjs`
- 测试：`test/warm.test.mjs`、`test/warmup.test.mjs`、`test/switch.test.mjs`、`test/update.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// warm：
//   就绪先于 ensureBundleForActive、且先于预热（按调用顺序断言三个桩）
//   LAUNCHER_PREPARE=0 → 就绪桩不被调用，ensureBundleForActive 与预热仍各调一次
// warmup：就绪桩在 resolveRuntime 之前被调用一次
// switch：
//   version === 出厂版本且未安装 → ensureDefaultVersionFn 被调用一次，runNpm 未被调用（零下载），指针已切换
//   同上但 ensureDefaultVersionFn 返回 { ok:false, stage:"install", reason:"network down" }
//     → 退出码 1、readActive 仍是原值、日志含 "network down"
//   同上但 LAUNCHER_PREPARE=0 → 退出码 1、提示就绪动作已被关闭、指针未变
//   versions/<出厂版本>/ 只剩 bundle（不存在 node_modules）→ 不报"目录存在但无法解析"，走就绪后切换成功
//   version !== 出厂版本且未安装 → 仍走 confirm + install 分支（原有行为不变）
// update：runtime.source === "bundled" 时 ensureDefaultVersionFn 被调用一次且早于安装；LAUNCHER_PREPARE=0 时不调用
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/warm.test.mjs test/warmup.test.mjs test/switch.test.mjs test/update.test.mjs`
预期：FAIL（就绪桩未被调用）

- [ ] **步骤 3：实现**

- `runWarmCommand`：`ensureBundleFn` 之前插入
  `if (prepareEnabled(env)) await (deps.ensureDefaultVersionFn ?? ensureDefaultVersion)({ mode: "explicit", logger });`（失败只 warn）；`src/cli.mjs` 的 `warm` 分支透传 `deps.ensureDefaultVersionFn`。
- `runWarmupCommand`：增加 `ensureDefaultVersionFn` 依赖，`resolveOpenwikiRuntime()` 之前同样插入（失败只 warn）。
- `runSwitchCommand`：增加 `env = process.env`、`ensureDefaultVersionFn = ensureDefaultVersion` 两个参数（`src/cli.mjs` 的 `switch` 分支透传 `env`）；判定顺序改为：

```js
const isBundled = version === bundledOpenwikiVersion(pkgRoot);
if (!isBundled && existsSync(versionDir(pkgRoot, version)) && !isInstalled(pkgRoot, version)) { /* 原报错，return 1 */ }
if (!isInstalled(pkgRoot, version)) {
  if (isBundled) {
    if (!prepareEnabled(env)) { logger.error("就绪动作已被 LAUNCHER_PREPARE=0 关闭，无法切换到未物化的默认版本；移除该变量后重试"); return 1; }
    const prepared = await ensureDefaultVersionFn({ mode: "explicit", pkgRoot, logger, runNpm });
    if (!prepared.ok || !isInstalled(pkgRoot, version)) { logger.error(`无法就绪默认版本 openwiki@${version}：${prepared.reason ?? "未知原因"}`); return 1; }
  } else { /* 原 confirm + install 分支不变 */ }
}
```

- `runUpdateCommand`：增加 `env = process.env`、`ensureDefaultVersionFn = ensureDefaultVersion`；`resolveRuntime` 之后、`install(...)` 之前插入
  `if (runtime.source === "bundled" && prepareEnabled(env)) await ensureDefaultVersionFn({ mode: "self-heal", pkgRoot, logger, runNpm }).catch(...)`（失败只 warn）；`src/cli.mjs` 的 `update` 分支透传 `env`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/warm.test.mjs test/warmup.test.mjs test/switch.test.mjs test/update.test.mjs test/cli.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/warm.mjs src/commands/warmup.mjs src/commands/switch.mjs src/commands/update.mjs src/cli.mjs test/warm.test.mjs test/warmup.test.mjs test/switch.test.mjs test/update.test.mjs
git commit -m "feat: warm/warmup/switch/update 接线默认版本就绪，switch 就绪失败即拒绝切换"
```

---

### 任务 7：`mcp` 后台自愈（物化 + bundle + 低优先级）

**文件：**
- 修改：`src/ensure-default.mjs`、`src/commands/mcp.mjs`
- 测试：`test/ensure-default.test.mjs`、`test/mcp-command.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// ensure-default.test.mjs：
//   scheduleBackgroundPrepare 在 supervisor.ensureReady() resolve 之前不起任何动作（断言顺序）
//   runtime.source === "bundled" → ensureDefaultVersionFn 收到 { mode: "self-heal", priority: "below-normal" }
//   runtime.source === "versions" 且 backend === "source" → 只调 ensureBundleFn(runtime.version)
//   runtime.source === "versions" 且 backend === "bundle" → 两者都不调
//   env.LAUNCHER_PREPARE === "0" → 直接返回，不起任何动作
//   supervisor.ensureReady() reject → 不抛出未处理拒绝，只 warn
// mcp-command.test.mjs：runMcpCommand 调用的是 scheduleBackgroundPrepare，且 pkgRoot 是 launcher 包根
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/ensure-default.test.mjs test/mcp-command.test.mjs`
预期：FAIL，`scheduleBackgroundPrepare` 未导出

- [ ] **步骤 3：实现**

`src/ensure-default.mjs` 追加：

```js
export function scheduleBackgroundPrepare({ runtime, pkgRoot, logger, supervisor, env = process.env, deps = {} })
// prepareEnabled(env) 为假 → 立即 return
// supervisor.ensureReady()
//   .then(() => runtime.source === "bundled"
//     ? (deps.ensureDefaultVersionFn ?? ensureDefaultVersion)({ mode: "self-heal", priority: "below-normal", pkgRoot, logger, env })
//     : runtime.backend === "source"
//       ? (deps.ensureBundleFn ?? ensureBundle)({ version: runtime.version, pkgRoot, logger })
//       : null)
//   .catch((error) => logger.warn(`后台就绪未完成：${error.message}`))
```

`src/commands/mcp.mjs:106-116`：把 `scheduleBackgroundBundle({...})` 换成 `scheduleBackgroundPrepare({ runtime, pkgRoot: launcherPackageRoot(), logger, supervisor, env, deps: { ensureBundleFn: deps?.ensureBundleFn, ensureDefaultVersionFn: deps?.ensureDefaultVersionFn } })`；`ensure-bundle.mjs` 的 `scheduleBackgroundBundle` 保持导出（已无生产调用点，留给后续 holder 路径复用；若审查认为应删，删除并同步测试）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/ensure-default.test.mjs test/mcp-command.test.mjs test/e2e-mcp.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/ensure-default.mjs src/commands/mcp.mjs test/ensure-default.test.mjs test/mcp-command.test.mjs
git commit -m "feat: mcp 后台自愈按来源分流，延后到后端就绪之后并降优先级"
```

---

### 任务 8：`versions remove` 写删除标记

**文件：**
- 修改：`src/commands/versions.mjs`
- 测试：`test/versions-command.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// versions remove <出厂版本> 成功 → versions/default-removed.json = { version, removedAt }
// versions remove <非出厂版本> 成功 → default-removed.json 不存在
// removeVersion 返回 { removed:false, reason:"active" } → 不写标记、退出码非 0
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/versions-command.test.mjs`
预期：FAIL，标记文件未生成

- [ ] **步骤 3：实现**

`src/commands/versions.mjs` 的 `remove` 分支：`removeVersion(pkgRoot, version)` 返回 `{ removed: true }` 且 `version === bundledOpenwikiVersion(pkgRoot)` 时调用 `markDefaultRemoved(pkgRoot, version)`，并 `logger.info` 一行说明"已记录：自动就绪不再重建该版本（显式 install / warm / switch 可重建）"。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/versions-command.test.mjs test/versions.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/versions.mjs test/versions-command.test.mjs
git commit -m "feat: 删除默认版本时写标记，阻止自动就绪重建"
```

---

### 任务 9：`doctor` / `check` 可见性与 README

**文件：**
- 修改：`src/commands/doctor.mjs`、`src/commands/check.mjs`、`README.md`
- 测试：`test/doctor.test.mjs`、`test/check.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// doctor（注入 bundledOpenwikiVersion 等依赖或构造真实 fixture）：
//   版本仓库空、跑出厂依赖、无标记 → 输出一行 "默认版本（出厂依赖）0.6.0：未就绪"
//   已物化 + bundle ready → 输出 "默认版本（出厂依赖）0.6.0：✓ 已就绪"
//   default-removed.json 命中该版本 → 输出含 "已删除（不会自动重建）"
//   prepare-failed.json 的 nextRetryAt 在未来 → 输出含 "上次就绪失败"
//   versions/0.6.0/install.meta.json 的 nodeMajor 与当前主版本不同 → 输出一行原生模块重装提示
// check：打印默认版本状态行；其余输出与现状一致
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/doctor.test.mjs test/check.test.mjs`
预期：FAIL，缺少默认版本状态行

- [ ] **步骤 3：实现**

- `src/commands/doctor.mjs`：`src/commands/doctor.mjs:299-310` 的 bundle 枚举改为不依赖 `isInstalled` 过滤（条目本身即真实安装），并在此之前插入"默认版本状态"一行（四态文案：`未就绪` / `✓ 已就绪` / `已删除（不会自动重建）` / `上次就绪失败（退避中，<nextRetryAt> 后重试）`）；追加"Node 主版本漂移"检查：遍历 `listInstalled` 读 `versions/<v>/install.meta.json`，`nodeMajor !== process.versions.node.split(".")[0]` 时 `logger.info` 提示并给出 `openwiki-launcher versions remove <v>` 后再装的可复制命令。
- `src/commands/check.mjs`：在"当前生效版本"之后打印一行默认版本状态（复用同一套四态判定）。
- `README.md`：
  - 参数表增 `--no-prepare`，写明 `--no-warm` 现在**只**跳过预热；
  - 环境变量表增 `LAUNCHER_PREPARE`、`LAUNCHER_PREPARE_BACKOFF_HOURS`；
  - 故障排查表增三行：默认版本没有 bundle / 切回默认版本要重新下载 / 删除默认版本后不想被自动重建；
  - "工作方式"版本管理段落补默认版本物化语义与"只 `npm install -g` + 手配 MCP 时首次会话仍慢，会话结束后落盘"。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/doctor.test.mjs test/check.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/doctor.mjs src/commands/check.mjs README.md test/doctor.test.mjs test/check.test.mjs
git commit -m "feat: doctor/check 显示默认版本四态与 Node 主版本漂移，README 更新"
```

---

### 任务 10：端到端验收

**文件：**
- 测试：`test/e2e-default-version.test.mjs`（新建，`LAUNCHER_REAL_SMOKE=1` 才跑真实 npm；默认只跑注入桩的编排）

- [ ] **步骤 1：写验收脚本**

编排级（不需网络）：用临时 pkgRoot + 真实 `src/` 模块 + 注入 `runNpm`（种入口树）+ 注入 `verifyNativeFn`，串起：

```
install 收尾（skippedNoHost）→ versions/<v>/ 有 node_modules + install.meta.json + bundle-*.mjs（bundle 用注入 buildKernel）
update 到 0.7.0 → switch <v> → runNpm 只被调用过 0 次（零下载）且 active.json === v
versions remove <v> → mcp 自愈不动（skipped: "removed"）→ warm 重建成功且标记清除
```

- [ ] **步骤 2：跑验收**

运行：`npx vitest run test/e2e-default-version.test.mjs`
预期：PASS

- [ ] **步骤 3：真实链路（有网络时人工执行，记录结果）**

```bash
npm run bundle            # 确认 bundle 构建链路本身可用
openwiki-launcher doctor  # 应显示默认版本 ✓ 已就绪
openwiki-launcher check   # 应显示默认版本条目与磁盘占用
openwiki-launcher warm    # 应命中 bundle 入口，耗时明显低于源码入口
```

预期：`doctor` 默认版本状态为 `✓ 已就绪`；`warm` 日志里的后端入口指向 `versions/<v>/bundle-<hash>.mjs`。

- [ ] **步骤 4：全量回归**

运行：`npx vitest run`
预期：PASS，且 `LAUNCHER_REAL_SMOKE=1 npx vitest run` 在具备真实后端的机器上同样 PASS。

- [ ] **步骤 5：Commit**

```bash
git add test/e2e-default-version.test.mjs
git commit -m "test: 默认版本物化与零下载切换的端到端验收"
```

---

## 自检记录

**1. 规格覆盖度**

| 规格章节 | 覆盖任务 |
| --- | --- |
| §4 I1/I2/I3/I4 | 任务 2（I1 校验项）、任务 4（幂等）、任务 6（switch 失败不改指针 = I3） |
| §4 I5 原子性 | 任务 1（tmp/bak 清理）、任务 2（tmp 安装 + 校验 + 原子 replace） |
| §4 I6 `entryVersion` | 任务 3 |
| §5 + §5.1 + §5.2 | 任务 1、任务 2、任务 4 |
| §5.3 低优先级 | 任务 2（`priority` + `onSpawn`）、任务 4、任务 7 |
| §6 八个触发点 | 任务 5（install）、任务 6（warm/warmup/switch/update）、任务 7（mcp）、任务 8（versions remove）、任务 9（check/doctor） |
| §7.1 / §7.2 / §7.3 / §7.4 | 任务 3、任务 9 |
| §8 CLI 与开关 | 任务 4（`prepareEnabled`）、任务 5（`--no-prepare`）、任务 6（`--no-warm` 语义）、任务 9（README） |
| §9.1–§9.9 边界 | 任务 2（§9.3/§9.4）、任务 4（§9.6/§9.8）、任务 6（§9.5/§9.6）、任务 9（§9.7 漂移提示）、任务 10（§9.4 端到端） |
| §10 测试与验收 | 任务 1–10 各自的测试步骤 + 任务 10 |

**2. 步骤扫描**：所有实现步骤只给签名、返回形状、确切参数与文案，函数体留给实现者；未出现"处理边界情况""添加适当的验证"这类空行；每个任务以可独立验证的交付物结束。

**3. 类型一致性**：`installVersion` 返回 `{ ok: true, entryVersion } | { ok: false, stage: "locked"|"install"|"verify", reason }` 在任务 2 定义、任务 4 消费；`ensureDefaultVersion` 的 `{ ok, stage?, reason?, skipped? }` 在任务 4 定义、任务 5/6/7 消费；`buildKernel` / `runBundleBackend` 的 `{ ok, entryVersion?, reason? }` 在任务 3 统一；标记文件名与形状在任务 4 定义、任务 8/9 消费。

**4. 审查重点**：五条分别由任务 2（1、5：install 失败软着陆、rename 覆盖失败）、任务 1（2：`.tmp`/`.bak` 清理）、任务 3（3：入口回退边界与 meta 过期）、任务 4/8（4：删除标记）的测试钉住。

**5. 比例**：本计划不含完整函数体，只含签名、断言与规格钉死的取值；篇幅约为规格的 1.2 倍，符合"决定集合"而非"程序抄本"。


