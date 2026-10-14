# openwiki-launcher 默认版本物化与就绪解耦设计

日期：2026-10-14
状态：待审查（第二轮修订）
方案：C（真实安装进 `versions/`）
范围：新增 `src/ensure-default.mjs`、`src/openwiki-install.mjs`；修改 `src/versions.mjs`、`src/paths.mjs`、`src/ensure-bundle.mjs`、`src/commands/{install,warm,warmup,mcp,update,switch,check,doctor,versions}.mjs`、`src/cli.mjs`、`scripts/bundle-backend.mjs`、`README.md`

## 1. 背景与问题

两个用户可见现象：

- **现象 A**：第一次安装后，"默认版本"（`package.json` 钉住的出厂依赖 `node_modules/openwiki`）磁盘上没有 bundle；
- **现象 B**：`update` 到新版本后，`switch` 回默认版本要重新下载。

统一根因：

> **出厂依赖不在版本仓库模型里，而 bundle 目录借用了版本仓库的命名空间 `versions/<版本>/`；
> 且"默认版本就绪"没有独立生命周期，只是宿主安装成功后的副产物。**

具体证据（四处独立成因叠加）：

| 编号 | 成因 | 证据 |
| --- | --- | --- |
| A1 | 就绪动作寄生在"安装整体成功"分支，检测不到宿主时被整体跳过 | `src/commands/install.mjs:117-124` 要求 `exitCode === 0`；`src/install.mjs:110-114` 在 `skippedNoHost` 时返回 `exitCode: 1`（README 已写明"IDE 装在应用目录里，PATH 上探不到"是常态）；`--no-warm` 同样跳过 |
| A2 | 默认版本的 bundle 即使生成也不可见 | bundle 输出目录是 `versionDir(pkgRoot, version)`（`src/ensure-bundle.mjs:70`），默认版本在 `versions/<v>/` 下没有 `node_modules/openwiki`，于是 `isInstalled` 为假；`src/commands/doctor.mjs:302` 用 `isInstalled` 过滤后再列 bundle 状态 → 默认版本永不显示；`src/commands/check.mjs:51` 反过来把 bundle-only 目录当"已安装版本"列出 |
| A3 | MCP 会话的后台补打落点错误，产物永远不被采用 | `src/commands/mcp.mjs:109-115` 传 `pkgRoot: runtime.packageRoot`（openwiki 包目录，如 `versions/0.6.1/node_modules/openwiki`），而 `preferBundle` 从 launcher 包根读 `versions/<v>/bundle.meta.json`（`src/paths.mjs:73-88`）→ 补打写进 `…/node_modules/openwiki/versions/<v>/`，解析层永远看不到 |
| A4 | bundle 入口源被硬编码为出厂依赖，非默认版本会打出"错误内容"的 bundle | `scripts/bundle-backend.mjs:82` 固定取 `pkgRoot/node_modules/openwiki/dist/cli/cli.js`，meta 的 `openwikiVersion` 却写成请求版本 → 产物与声明不符；且 meta 里没有"实际打包的包版本"，错误产物会被后续校验**永久复用** |
| B1 | `switch` 回默认版本被判定为"未安装"→ 重新下载 | `switch`/`isInstalled` 只认 `versions/<v>/node_modules/openwiki`（`src/versions.mjs:73-78`）；`src/commands/switch.mjs:73-81` 未安装则 `npm install`（`src/commands/update.mjs:134-147`）。若磁盘上已存在 bundle-only 的 `versions/<v>/`，还会先撞 `src/commands/switch.mjs:65-71` 的"目录存在但无法解析"报错，而按提示清理会**顺带删掉 bundle** |

## 2. 目标与非目标

**目标**

- G1：把"默认版本就绪"从宿主安装结果里解耦，落到一个明确、可测、**幂等**的步骤里；
- G2：默认版本在版本仓库中成为一个**真实条目**，条目本身的语义与其它版本完全一致（`isInstalled` / `check` / `doctor` / `versions remove` 无特判；`switch` 的唯一差异只在"未物化时先物化"，物化完成后与普通版本走同一条指针翻转路径）；
- G3：从其它版本切回默认版本是**毫秒级指针翻转**，不重新下载；
- G4：bundle 对任何版本都从**该版本自身的代码**构建，落点与元数据都能被解析层与后续校验正确识别；
- G5：**安装具备原子性与完整性校验**——被打断的安装不会留下一个"看起来装好了"的版本目录；装坏的原生模块不会让版本进入可用状态；
- G6：失败有边界——离线 / 持续失败不会让每个新会话都重试一次几百 MB 的安装；显式命令不受退避限制。

**非目标**

- 不引入 npm `postinstall`（决策：不动 npm 生命周期；openwiki 带原生模块 `better-sqlite3`，把重下载塞进 `postinstall` 有拖慢/失败风险）；
- 不引入 junction / symlink（决策：走真实安装，磁盘换来的语义简单）；
- 不改动 holder、排队策略、冷启动治理的既有设计；
- **不解决依赖树漂移**（物化出的传递依赖与出厂那份可能不同），只作为已知风险记录并在 `doctor` 提示（§9.7）；
- 不解决"只 `npm install -g`、从不跑安装器、也不开宿主会话"这一路径下的首次会话慢（§9.1）。

## 3. 方案选型

| 方案 | 做法 | 权衡 |
| --- | --- | --- |
| A | junction 物化出厂依赖进 `versions/<v>/node_modules/openwiki` | 零拷贝零下载，但引入链接语义（删除 / 统计 / junction 失败降级都要特判） |
| B | 不物化，`isInstalled`/`switch` 特判出厂版本，bundle 挪到 `bundles/<v>/` | 改造面小，但出厂依赖与版本仓库两处真相长期并存，到处特判 |
| **C（选定）** | 默认版本首次就绪时**真实安装**进 `versions/<v>/` | 磁盘多一份依赖树；但模型单一、无链接语义、bundle 命名空间冲突自然消失 |

代价（已确认接受）：默认版本会多出一份 openwiki 依赖树（数百 MB）；`npm install --prefer-offline` 让这次安装优先命中 npm 缓存、尽量不联网。

## 4. 数据模型与不变量

- **`versions/<v>/` 是版本仓库的唯一真相**，条目 = 真实安装（`versions/<v>/node_modules/openwiki` 可解析）。
- 出厂依赖 `node_modules/openwiki` 保留，角色收窄为两件事：**解析兜底**（指针缺失 / 损坏时）与**物化来源**（就绪动作的数据源）。
- 不变量：
  - **I1**：`isInstalled(pkgRoot, v)` ⇔ `versions/<v>/node_modules/openwiki/{package.json,dist/cli/cli.js}` 存在（定义不变）；
  - **I2**：**bundle 目录 = 版本目录**（`versionDir(pkgRoot, v)`），物化后版本目录必然是可解析安装 → 不再产生 bundle-only 的畸形目录；
  - **I3**：指针 `versions/active.json` **只指向真实条目**（`isInstalled` 为真）；指针缺失或损坏时回退出厂依赖，与现状一致；
  - **I4**：就绪动作幂等——重复执行不产生第二次下载、不覆盖已有 bundle；
  - **I5（新增，原子性）**：`versions/<v>/` 只在**完整安装并通过完整性校验**之后，以一次 `renameSync` 出现。安装过程中的半成品一律停留在 `versions/.tmp-<v>-<pid>/`，任何时刻的 `versions/<v>/` 要么不存在、要么是完整条目；
  - **I6（新增）**：`bundle.meta.json` 必含 `entryVersion`（实际被打包的入口包 `package.json` 的 `version`），且 `entryVersion === 请求版本`。缺该字段的旧 meta 一律视为过期。

## 5. 默认版本就绪：`ensureDefaultVersion()`

新增模块 `src/ensure-default.mjs`，对外只暴露一个函数：

```
ensureDefaultVersion({ pkgRoot, logger, runNpm, writeSnapshot?, hostId?, mode })
  mode: "explicit" | "self-heal"
  → { ok: true, version, installed: boolean, snapshot: boolean, skipped?: "removed" | "backoff" }
  | { ok: false, stage: "version" | "locked" | "install" | "verify" | "snapshot" | "bundle", reason: string }
```

`mode` 决定是否受"用户已删除"标记（§9.6）与失败退避（§9.8）的约束：`explicit` 不受限，`self-heal` 受限。

**数据源**：`src/paths.mjs` 新增导出 `bundledOpenwikiVersion(pkgRoot)`（把现有私有函数 `readDeclaredVersion` 的能力提升为公共契约），读 `node_modules/openwiki/package.json` 的 `version`。

**步骤**（按序，任一步失败软着陆）：

1. `v = bundledOpenwikiVersion(pkgRoot)`；读不到 → `{ ok: false, stage: "version" }`。
2. `mode === "self-heal"` 时先查两个标记：`versions/default-removed.json` 的 `version === v` → 返回 `{ ok: true, skipped: "removed" }`；`versions/prepare-failed.json` 的 `nextRetryAt > now` → 返回 `{ ok: true, skipped: "backoff" }`。
3. **不自行取锁**：版本键控锁（§5.1）由 `installVersion` / `installAndSnapshot` 内部持有；拿不到锁时它们返回 `{ ok: false, stage: "locked" }`，本函数原样透传。
4. 快照已存在（`manifestFilePath(v, pkgRoot)` 存在）**且** `isInstalled(pkgRoot, v)` 为真 → 跳过安装与录快照；
   快照已存在但未安装 → 只装（§5.2）；
   快照不存在 → `installAndSnapshot`（装 + 录；它自身带"已安装则跳过下载"）。
5. `ensureBundle({ version: v, pkgRoot, logger })`（`src/ensure-bundle.mjs:69`）。

**为什么第 4 步要分开**：`installAndSnapshot` 会启动一次 openwiki 后端来录快照（冷启动实测量级 30~120 秒）。出厂版本的快照随包发布（`manifest/openwiki-<v>.json`），已存在时**绝不能**再录一次，否则每次安装都白付一次冷启动。仅在快照缺失时补录。

**失败软着陆**：任何失败都不写指针、不影响可用性（默认版本仍可经出厂依赖直读），只提示；安装失败复用 `summarizeInstallFailure`（`src/commands/update.mjs:92`）的镜像指引。`self-heal` 模式失败**额外写退避标记**（§9.8）；`explicit` 模式成功时清除退避标记。

### 5.1 版本键控锁与残留清理

- 新增模块 `src/openwiki-install.mjs`，承载安装的全部公共契约：
  - `withVersionLock({ pkgRoot, version, logger }, fn)`：独占 `versions/install-<v>.lock`（`src/lockfile.mjs` 的 `acquireLock`，带 pid 探活与残留锁重取，与 `ensure-bundle.mjs:85-94` 同一套）；进入时顺带清理**属于已死 pid 的** `versions/.tmp-<v>-*` 与 `versions/.bak-<v>-*`；拿不到锁返回 `{ ok: false, reason: "locked" }`；
  - `installVersion` / `installAndSnapshot`：**必须在锁内运行**（内部不再重复加锁）；`commands/update.mjs` 改为 re-export 这两个名字，既有 import 与测试不破。
- **锁按版本键控**：`update` 装 0.7.0、`switch` 装 0.7.0、后台物化 0.7.0 三者互斥；装 0.6.0 与装 0.7.0 并行不冲突。
- 锁的作用域覆盖"装 + 录快照"整段；bundle 有自己的锁（`versions/bundle.lock`），不重复。
- 任意触发点进入就绪前，**先**做一次清理：只清理 `lstat` 为目录、名字匹配 `.tmp-<合法版本>-<pid>` 或 `.bak-<合法版本>-<pid>`、且该 pid 已不存在的条目（`.bak` 是 §5.2 原子替换的中转目录，进程被杀同样会遗留）。

### 5.2 原子安装与完整性校验（I5）

`installVersion` 的执行序：

1. 建 `versions/.tmp-<v>-<pid>/`；
2. `npm install openwiki@<v> --prefix <tmp> --prefer-offline --no-audit --no-fund`；
3. **完整性校验**（全过才继续）：
   - `<tmp>/node_modules/openwiki/package.json` 与 `dist/cli/cli.js` 存在（I1 的两项）；
   - 入口包 `package.json` 的 `version === v`（防止镜像 / 缓存给出错误内容）；
   - **原生模块可加载**：若 `<tmp>/node_modules/better-sqlite3` 存在，必须能用**当前** `process.execPath` 加载成功（`spawn(process.execPath, ["-e", "import('better-sqlite3')"])`，cwd = tmp，超时上限 30 秒；超时或非 0 退出均判失败）。依赖树里没有该模块的版本跳过本项；
4. 校验通过 → 落盘（见下）；失败 → `rmSync(tmp, { recursive: true, force: true })` 并返回 `{ ok: false, stage: "verify" | "install", reason }`。

**原子替换**（兼顾历史遗留目录）：

- `versions/<v>/` 不存在 → `renameSync(tmp, versions/<v>)`；
- 已存在（历史遗留的 bundle-only 目录）→ 先把已有目录移到 `versions/.bak-<v>-<pid>/`，`renameSync(tmp, versions/<v>)`，再把 `.bak` 里的 bundle 产物（`bundle.meta.json`、meta 指向的 `bundle-*.mjs`、`bundle.bad`）合并进新目录（**不动** `node_modules`），最后删除 `.bak`。合并后由 §7.2 的 `entryVersion` 校验决定复用还是重建。

**安装元数据**：落盘成功后写 `versions/<v>/install.meta.json` = `{ version, nodeMajor, installedAt }`（§9.7 漂移提示的数据源）。

**`--prefer-offline` 落在哪**：`installVersion` 的 npm 参数从
`["install", "openwiki@<v>", "--prefix", dir]` 改为
`["install", "openwiki@<v>", "--prefix", dir, "--prefer-offline", "--no-audit", "--no-fund"]`。
这是"切回默认版本不重新下载"的关键：默认版本的依赖树大概率已在 npm 缓存里（由 `npm install -g` 填充），`--prefer-offline` 只对缓存未命中的包回退联网。该改动同时惠及 `update` / `switch` 对任意已缓存版本的安装。

### 5.3 后台安装的低优先级（自愈专用）

`self-heal` 触发的安装（`mcp` 后台自愈）即使延后到后端就绪之后，仍会与用户的首次使用抢磁盘。约定：

- 起 npm 子进程后调用 `os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`；失败静默忽略（跨平台差异不致命）；
- 日志各留一行：开始（`开始后台就绪默认版本 openwiki@<v>（低优先级）`）与结束（`后台就绪完成/失败，耗时 <ms>`），`explicit` 触发不降优先级。

## 6. 触发点接线

| 时机 | 动作 | 文件 |
| --- | --- | --- |
| `install` 收尾 | 就绪动作判据：`!uninstall && prepareEnabled && (result.skippedNoHost \|\| result.exitCode === 0)`，其中 `prepareEnabled` = 未给 `--no-prepare` 且 `LAUNCHER_PREPARE !== "0"`。**不看 `report.some(r => r.wrote)`**——重跑安装器时配置已是最新、`wrote` 为空，而用户正是通过重跑来修复上一次失败的就绪；就绪幂等，已完成时近乎零成本。`exitCode === 1`（未知宿主 / 不支持作用域 / 失败回滚）与 `exitCode === 2`（护栏）不在判据内 | `src/commands/install.mjs:117-124`、`src/install.mjs:110-114` |
| `warm` | 先 `ensureDefaultVersion({ mode: "explicit" })`，再 `ensureBundleForActive()`，再预热 | `src/commands/warm.mjs:59-68` |
| `warmup` | 同 `warm`；需为该命令补一个与 `warm` 的 `ensureBundleFn` 同形的注入点 | `src/commands/warmup.mjs:24-37` |
| `mcp` 首次会话 | 后台自愈（`mode: "self-heal"`），**延后到后端就绪之后**、不与冷启动抢 IO；分支按来源分流：`runtime.source === "bundled"` → 就绪默认版本；`runtime.source === "versions" && runtime.backend === "source"` → 只补该版本 bundle。`pkgRoot` 由 `runtime.packageRoot` 改为 launcher 包根（§7.3）。受 `LAUNCHER_PREPARE=0`、删除标记、失败退避三重约束 | `src/commands/mcp.mjs:106-116`、`src/ensure-bundle.mjs:201-211` |
| `update` | 装目标版本**之前**：若 `runtime.source === "bundled"`，先 `ensureDefaultVersion({ mode: "self-heal" })`（失败只告警，不阻塞升级）。受 `LAUNCHER_PREPARE=0` 约束 | `src/commands/update.mjs:215-288` |
| `switch <v>` | 若 `v === bundledOpenwikiVersion(pkgRoot)` 且未安装 → `ensureDefaultVersion({ mode: "explicit" })`；**失败即拒绝切换**（保持当前指针、退出码 1、打印原因），否则违反 I3；`v` 为出厂版本时跳过 `src/commands/switch.mjs:65-71` 的畸形目录守卫；成功后照常写指针 | `src/commands/switch.mjs` |
| `check` / `doctor` | **只报告不写盘**：显式打印"默认版本（出厂依赖）v，版本仓库状态"；bundle 状态按真实条目枚举；`doctor` 增加 `install.meta.json` 的 Node 主版本漂移提示（§9.7） | `src/commands/check.mjs`、`src/commands/doctor.mjs` |
| `versions remove <v>` | 删除后写 `versions/default-removed.json`（`{ version, removedAt }`）**当且仅当** `v === bundledOpenwikiVersion(pkgRoot)`；非默认版本的删除不写标记（§9.6） | `src/commands/versions.mjs`、`src/versions.mjs:164-172` |

- `LAUNCHER_BACKEND_CLI` 覆盖（测试 / 排障路径）时不触发任何就绪动作，与现有 `ensureBundle` 的跳过条件一致。
- `warm` 在 `--no-prepare` 或 `LAUNCHER_PREPARE=0` 下**只预热当前运行时**，不做物化与 bundle。

## 7. bundle：入口源、回退边界与元数据加固

### 7.1 入口源从该版本自身解析（修 A4）

`scripts/bundle-backend.mjs:82` 目前**硬编码**

```
const entry = path.join(pkgRoot, "node_modules", "openwiki", "dist", "cli", "cli.js");
```

改为按目标版本解析：

```
主候选：versions/<targetVersion>/node_modules/openwiki/dist/cli/cli.js
回退候选：<pkgRoot>/node_modules/openwiki/dist/cli/cli.js
```

**回退是有条件的**：只有当 `targetVersion === bundledOpenwikiVersion(pkgRoot)` 时才允许回退出厂依赖；否则（目标版本与出厂版本不同、但该版本目录里没有可解析入口）**直接判失败**，返回 `{ ok: false, reason: "versions/<v> 下找不到可解析的 openwiki 入口" }`。

这一条是硬约束：只要允许无条件回退，"用出厂代码冒充 v0.7.0" 就仍然可能发生，只是变少了。

### 7.2 `entryVersion` 元数据（修 A4 的复用陷阱）

- `runBundleBackend` 的返回值由 `number`（退出码）改为 `{ ok, entryVersion?, reason? }`，其中 `entryVersion` 取自**实际入口包**的 `package.json` 的 `version`；`npm run bundle` 的 CLI 尾部同步适配。
- `ensureBundle` 写 meta 时增加 `entryVersion` 字段，并在写入前断言 **`entryVersion === version`**；不相等视为构建失败（**不写 meta**、清理临时产物、返回 `{ ok: false, reason }`）。
- `metaValid`（`src/ensure-bundle.mjs:38-48`）增加条件：`meta.entryVersion === version`。**缺该字段的旧 meta 一律视为过期**——这正好覆盖"升级前已经用出厂代码为某个非默认版本打过错误 bundle"的历史状态，一次重建即可自愈（§9.4）。

meta 最终字段：`{ openwikiVersion, entryVersion, scriptHash, nodeMajor, platform, bundleHash, file }`。

### 7.3 MCP 后台补打落点（修 A3）

`src/commands/mcp.mjs:111` 的 `pkgRoot: runtime.packageRoot` 改为 launcher 包根。`ensureBundleFn` 的注入点保持不变（测试仍可替身）。

### 7.4 状态可见性口径统一

- `src/commands/doctor.mjs:302`：bundle 状态枚举去掉 `isInstalled` 过滤的副作用——默认版本就绪后它本就是真实条目，会自然出现；同时为"版本仓库里没有默认版本条目、当前跑出厂依赖"的情况补一行明确状态（并区分"未就绪 / 已就绪 / 已删除标记 / 退避中"）。
- `src/commands/check.mjs:51-63`：沿用 `listInstalled`（不引入特判）；I2 保证版本目录必为真实安装，历史遗留的 bundle-only 目录会被就绪动作填充（§9.4）。

## 8. CLI、开关与文档

- `src/commands/install.mjs:19` 的 `BOOL_FLAGS` 增加 `--no-prepare`；`parseInstallArgs` 的 flags 增加 `noPrepare`；`src/cli.mjs:29` 的 HELP 增加说明。
- 环境变量：新增 `LAUNCHER_PREPARE=0`，风格与既有 `LAUNCHER_EAGER_START=0` 一致，供**没有命令行参数可传**的运行时就绪触发点使用（`mcp` 后台自愈、`update` 前置就绪）；它同时是 `--no-prepare` 的等价开关——有 `--no-prepare` 或 `LAUNCHER_PREPARE=0` 任一即视为关闭就绪。
- **两个开关保持正交**（决策修正）：
  - `--no-prepare` / `LAUNCHER_PREPARE=0` **只**跳过物化与 bundle，**不**跳过预热——预热从出厂依赖也能进行，其价值（填文件缓存）与就绪独立；用户想跳过一个大概率仍想保留另一个；
  - `--no-warm` **只**跳过安装后的自动预热，仍执行就绪动作（**与现状不同**，必须在 README 参数表写明）；
- 退出码语义不变：就绪动作是优化，其失败不改变 `install` / `update` 的退出码；`switch` 例外——物化失败**就是**切换失败（退出码 1）。
- `README.md` 更新：命令表、参数表（`--no-prepare`、`LAUNCHER_PREPARE=0`、`--no-warm` 语义变化）、故障排查表（新增"默认版本没有 bundle""切回默认版本要重新下载""删除默认版本后不想被自动重建"三行）、"工作方式"里版本管理段落补充默认版本物化语义。

## 9. 边界、降级与风险

### 9.1 不加 postinstall 的后果（明确写进 README）

`npm install -g` 本身不触发任何就绪动作。就绪发生在：安装器收尾、`warm` / `warmup`、首次 MCP 会话后台自愈。因此：

- 走文档化流程（装完跑安装器）→ 宿主首次连接时 bundle 已就位；
- 只 `npm install -g` + 手配 MCP → **首次会话仍慢**，会话结束后 bundle 落盘，后续会话受益。README 明示，不做隐藏。

### 9.2 磁盘重复

默认版本会多一份 openwiki 依赖树。`check` 已按版本显示 `sizeBytes`，用户可见。若未来要消除重复，A 方案（junction）是预留路径，本次不做。

### 9.3 缓存未命中 / 离线

`--prefer-offline` 在缓存未命中时回退联网，可能失败（含 `better-sqlite3` 预编译二进制被重置）。失败走软着陆 + 退避（§9.8），不阻塞其它版本可用、不影响 `install` / `update` 退出码。

### 9.4 历史遗留状态的自愈

两类遗留状态都被一次成功就绪自愈，无需用户手工清理：

- **bundle-only 目录**（例如当前开发机上的 `versions/0.6.0/`）：`isInstalled` 为假 → 走 §5.2 的原子替换，把 bundle 产物合并进新条目；
- **用出厂代码打出的错误 bundle**：meta 缺 `entryVersion` → I6 判为过期 → 重建（§7.2）。

### 9.5 护栏承诺

`exitCode === 2`（系统目录 / 主目录）时**不执行**就绪动作，保持 README"一个字节都不会写"的承诺。

### 9.6 用户删除默认版本后不被自动重建

`versions remove <默认版本>` 会写 `versions/default-removed.json`（`{ version, removedAt }`）。**自愈类触发点**（`mcp` 后台、`update` 前置）看到该版本的标记直接跳过，避免"删了又自己长回来"。**显式触发点**（`install`、`warm`、`warmup`、`switch`）无视标记；一旦显式就绪成功，删除标记被清除。切换出厂版本时若标记存在且需要就绪，`switch` 属于显式触发点，正常重建。

### 9.7 已知风险：依赖树漂移与 Node 主版本漂移

- 物化执行的是 `npm install openwiki@<v>`，npm 会**重新解析传递依赖**，结果可能与 `npm install -g openwiki-launcher` 那次钉下的依赖树不完全一致（同一语义版本范围内的次级依赖可能取到不同 patch）。这不影响正确性（openwiki 自己的 semver 范围），但两个位置的行为理论上可能有细微差别；**本次不解决**，记录在此。
- 原生模块与 Node ABI 绑定：安装时把 `nodeMajor` 写进 `versions/<v>/install.meta.json`；`doctor` 在 `install.meta.json` 的 `nodeMajor` 与当前 `process.versions.node` 主版本不一致时提示"该版本的原生模块可能需要在当前 Node 下重装"，并给出 `versions remove <v>` 后重跑的可复制命令。**不自动重装**。

### 9.8 失败退避

`self-heal` 模式的就绪失败写 `versions/prepare-failed.json` = `{ version, at, nextRetryAt, reason }`，默认 `nextRetryAt = at + 24h`（`LAUNCHER_PREPARE_BACKOFF_HOURS` 可配，设为 0 关闭）。退避期内自愈触发点直接返回 `{ ok: true, skipped: "backoff" }`，不再起 npm 子进程。**显式触发点不受退避限制**，成功后就绪清除该标记（`install` / `warm` 是用户的修复通道）。

### 9.9 `versions remove` 默认版本的口径

物化后默认版本是普通条目：未被激活可删。删除写标记（§9.6），不写标记的版本删除后与他人一致。

## 10. 测试与验收

**单测**

- `installVersion`：
  - npm 参数包含 `--prefer-offline --no-audit --no-fund`；
  - 装到 `versions/.tmp-<v>-<pid>/`，校验通过才 `renameSync` 到 `versions/<v>/`（用 fake `runNpm` + 注入 tmp 布局断言中间态）；
  - 校验失败（缺 cli.js / 入口包 version 不匹配 / better-sqlite3 加载失败）→ 目标目录**不存在**、tmp 被清理；
  - 目标目录已存在（bundle-only）→ 走 `.bak` 旁路后 bundle 产物被合并回来；
  - 版本键控锁：同版本并发第二次返回 `locked`，不同版本可并行；
  - `.tmp-<v>-<死 pid>` 被清理，活 pid 的不动。
- `ensureDefaultVersion`：快照已存在时只装不录（断言 `writeSnapshot` 未被调用）；快照缺失时调用 `installAndSnapshot`；已安装时跳过下载；`self-heal` 遇 `default-removed` / `prepare-failed` 时 `skipped`；`explicit` 无视两者且成功后清标记；失败返回带 `stage` 的结果。
- `runBundleBackend` / `ensureBundle`：目标版本目录存在时用其入口；不存在且**等于出厂版本**才回退；不存在且**不等于**出厂版本时报错；meta 缺 `entryVersion`、或 `entryVersion !== version` 时判过期并重建；构建成功但 `entryVersion !== version` → 不写 meta。
- `parseInstallArgs` 识别 `--no-prepare`；就绪开关解析函数把 `LAUNCHER_PREPARE=0` 判为关闭（仅 `"0"` 关闭，其余一律视为开启，与 `LAUNCHER_EAGER_START` 同规则）。

**命令级**

- `install` 就绪判据四态：成功（exit 0）→ 执行；`skippedNoHost`（exit 1）→ **仍执行**；失败回滚 / 未知宿主 / 不支持作用域（exit 1 且非 `skippedNoHost`）→ 不执行；护栏（exit 2）→ 不执行；`--no-prepare` 或 `LAUNCHER_PREPARE=0` → 不执行就绪但**仍执行预热**（正交性断言）；
- `install` 重跑修复：配置 `unchanged`（`wrote` 全为 false）但 `exitCode === 0` 时**仍**执行就绪动作；
- `switch` 到出厂版本：走 `ensureDefaultVersion` 而非裸 `installAndSnapshot`；物化失败 → 退出码 1、`active.json` 未被改动、提示原因；
- `update` 在 `runtime.source === "bundled"` 时先以 `self-heal` 就绪默认版本，且受 `LAUNCHER_PREPARE=0` 约束；
- `mcp` 的 `scheduleBackgroundBundle` 收到 launcher 包根作为 `pkgRoot`；
- `versions remove <默认版本>` 写标记；`versions remove <非默认版本>` 不写；
- `doctor` / `check` 对"当前跑出厂依赖""已就绪""已删除标记""退避中"四种状态输出一致。

**验收标准**

| 项 | 标准 |
| --- | --- |
| 现象 A | 全新机器：`npm install -g` → `openwiki-launcher`（安装器）→ `versions/<默认版本>/` 同时有 `node_modules/openwiki`、`install.meta.json` 与 `bundle-*.mjs`；`doctor` 显示 bundle 就绪 |
| 现象 A（无宿主） | 裸跑 `openwiki-launcher`（检测落空、退出码 1）后，默认版本仍完成物化 + bundle |
| 现象 A（重跑修复） | 首次离线导致就绪失败，联网后重跑 `openwiki-launcher`（配置 `unchanged`）→ 就绪成功 |
| 现象 B | `update` 到新版本后 `switch <默认版本>`：不调用 npm 下载（注入 `runNpm` 断言），输出"已切换"，毫秒级；`versions remove <默认版本>` 后 `switch` 会重建（显式触发点） |
| 现象 B（失败路径） | 离线且缓存未命中时 `switch <默认版本>`：退出码 1、指针未变、提示可操作原因 |
| 原子性 | 安装中途杀进程：不留下 `versions/<v>/`；遗留 `.tmp-*` 在下一次触发时被清理 |
| bundle 正确性 | 为 `versions/<v>` 构建的 bundle，其入口来自该版本自身的 `node_modules/openwiki`，且 meta 的 `entryVersion === v`；历史错误 meta 被重建 |
| 失败边界 | 离线状态下连续两次 MCP 会话：第二次不再起 npm 子进程（退避生效）；`warm` 不受退避限制 |
| 后台优先级 | `mcp` 自愈安装期间 npm 子进程优先级低于普通进程，日志有开始 / 结束两行 |
| 回归 | 既有 vitest 全绿；`LAUNCHER_HOLDER` / holder lockfile / 排队策略行为不变 |
| 退出码 | `install` 的就绪失败不改变退出码；护栏 `exitCode === 2` 时无任何写入 |

## 11. 交付拆分（供 writing-plans 展开）

1. **安装内核**：新增 `src/openwiki-install.mjs`（版本键控锁 + `.tmp` 清理 + 原子安装 + 完整性校验 + `--prefer-offline` + 低优先级），`commands/update.mjs` 改 re-export；`src/paths.mjs` 导出 `bundledOpenwikiVersion`；
2. **bundle 加固**：`runBundleBackend` 有条件的入口回退 + 返回 `entryVersion`，`ensureBundle` 写 `entryVersion` 且断言一致，`metaValid` 加条件，`mcp` 的 `pkgRoot` 落点修复；`scripts/bundle-backend.mjs` CLI 尾部适配；
3. **就绪模块**：`src/ensure-default.mjs`（`explicit` / `self-heal` 双模式、标记与退避、快照分流）；
4. **接线**：`install` 判据（含 `--no-prepare`）、`warm` / `warmup`、`switch`（失败即拒绝）、`update`、`mcp` 后台自愈、`versions remove` 写标记；
5. **可见性与文档**：`doctor` / `check` 四种状态与 `nodeMajor` 漂移提示、`README.md`；
6. **验收**：全新机器端到端（现象 A / B 各一次）+ 失败路径（离线、中途杀进程、退避）+ 历史遗留状态自愈一次 + 全量回归。
