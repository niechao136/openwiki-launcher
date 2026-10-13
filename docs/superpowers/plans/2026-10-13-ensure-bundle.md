# ensureBundle 统一打包入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** bundle 从仓库构建产物变为 launcher 的运行时操作：`ensureBundle(version)` 在 install / update / switch / mcp / doctor 五个时机按需打包，esbuild 懒安装，带元数据失效、原子写入与运行时兜底。

**架构：** 新增 `src/ensure-bundle.mjs`（`ensureBundle({ version, pkgRoot, logger })`：meta 校验 → esbuild 懒安装 → 原子构建 → 写 meta）与 `src/esbuild-tools.mjs`（`ensureEsbuild({ logger })`：`<pkgRoot>/tools/esbuild/` 内 `npm install esbuild`，复用 `npm-runner`）。已有 `runBundleBackend` 降级为构建内核被 `ensureBundle` 调用。接线：install / update / switch / mcp / doctor 五处消费。

**技术栈：** Node ESM、esbuild（懒装到 `<pkgRoot>/tools/esbuild/`）、复用 `src/npm-runner.mjs`。

**规格：** `docs/superpowers/specs/2026-10-13-cold-start-mitigation-design.md` §9

## 评审修订（2026-10-13，绑定实现）

1. **esbuild 装到用户级数据目录**：`%LOCALAPPDATA%\openwiki-launcher\tools\esbuild\`
   （`paths.mjs` 新增 `launcherDataDir()`；非 win32 用 `~/.openwiki-launcher/`）。
   不放 pkgRoot（随 Node 版本/重装漂移）。holder lockfile 迁移为后续项。
2. **esbuild 钉确切版本**：`package.json` 里 devDependency 的当前版本写死为常量；
   `runNpm` 装的是 `esbuild@<确切版本>`；npm-runner 走用户 npm 配置（无硬编码源，
   实现时核对）。
3. **bundle.bad 触发收窄**：仅"bundle 启动失败 **且** 源码入口随后成功"才写；标记含
   meta 哈希；`ensureBundle` 重建成功自动清除；`doctor` 显示并说明清除方式。
4. **并发与覆盖**：`ensureBundle` 用 `wx` 独占 lockfile（`versions/bundle.lock`）做
   构建锁；产物按内容哈希寻址——与现役一致则跳过，不同则写 `bundle-<hash8>.mjs`
   并由 meta 指向实际文件名，绝不 rename 覆盖可能被占用的文件。
5. **后台补打延后到后端就绪之后**（不与冷启动抢 IO）。
6. **冷态验收**：ensureBundle 合入后，重启机器首启实测一次，数据决定
   `LAUNCHER_HOLDER` 默认值。
7. **compile cache**：双路径均不引入（§9 数据），规格 §6.2 条目已删。

## 全局约束

- bundle 失败/缺失永远降级源码入口，绝不致命、绝不阻塞任何命令的退出码语义（install/update 的预热语义沿用："失败不影响安装结果"）
- 原子写入：构建到 `bundle.mjs.tmp-<pid>` 再 `renameSync` 成 `bundle.mjs`
- `bundle.meta.json`：`{ openwikiVersion, scriptHash, nodeMajor, platform }`；`scriptHash` = `scripts/bundle-backend.mjs` 的 sha256；任一不匹配视为过期
- `bundle.bad`：空标记文件，与 bundle 同目录；存在时 `preferBundle` 跳过 bundle
- esbuild 懒装目录 `<pkgRoot>/tools/esbuild/`，用 `runNpm(["install", "esbuild"], { cwd })`；安装失败 → 返回 `{ ok: false, reason }`，由调用方决定提示文案
- 本沙箱 vitest 不可运行（沿用裁决）：等价 node 脚本做 RED/GREEN，vitest 文件照常入库

## 审查重点（Review Focus）

1. esbuild 安装失败（离线/网络）→ install/update/mcp 全部正常完成，只多一行提示，退出码不变（任务 3/4 测试钉住）
2. 并发 `ensureBundle`（mcp 与 switch 同时触发）：两个构建竞争同一 bundle 路径 → 原子 rename 后读到的是完整产物，无半成品（任务 2 测试钉住）
3. Node 大版本升级后旧 bundle（meta.nodeMajor 不匹配）→ 降级 source 并触发重建，绝不拿旧 ABI 场景下验证过的 bundle 硬扛（任务 2 测试钉住）
4. `bundle.bad` 写入后：解析跳过 bundle、switch/mcp/doctor 的提示一致显示"不可用"，且消除 badge 的唯一路径是重新 ensureBundle 成功（任务 5 测试钉住）
5. holder 路径：`resolveHolderSession` 拿到的 cliJs 与 wrapper 同源，bundle 后台补打完成后**不热切换**已运行的 holder（下次会话生效即可），不产生半更新状态（任务 4 测试钉住）

---

### 任务 1：esbuild 懒安装 + ensureBundle 内核

**文件：**
- 创建：`src/esbuild-tools.mjs`、`src/ensure-bundle.mjs`
- 修改：`src/paths.mjs`（`preferBundle` 跳过 `bundle.bad`；新增 `esbuildToolsDir(pkgRoot)` 与 `bundleMetaPath` 约定）
- 测试：`test/ensure-bundle.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/ensure-bundle.test.mjs 断言清单（临时 pkgRoot fixture）：
// - ensureEsbuild：tools/esbuild 不存在 → 注入 runNpm fake 执行 install，返回 { ok: true }；
//   runNpm 返回非 0 → { ok: false, reason }；目录已有 esbuild（node_modules/esbuild 存在）
//   → 不再调用 runNpm
// - ensureBundle：无 meta + 无 bundle → 调 buildKernel（注入）产 bundle + meta 五字段
// - meta 任一字段不匹配（改 nodeMajor / scriptHash / openwikiVersion / platform）→
//   视为过期，重新构建
// - meta 匹配且 bundle 存在 → 直接返回 { ok: true, reused: true }，不调 buildKernel
// - bundle.bad 存在 → ensureBundle 直接返回 { ok: false, reason: "bundle.bad" }？
//   否——bad 只影响解析层；ensureBundle 的成功构建会清除 bundle.bad
// - 构建产物经临时文件 rename（buildKernel 注入可断言 outfile 是 .tmp- 前缀，
//   且调用后有 rename 到 bundle.mjs 的语义——用 fake 记录调用参数）
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/ensure-bundle.test.mjs`（或等价脚本）
预期：FAIL，模块不存在

- [ ] **步骤 3：实现**

`src/esbuild-tools.mjs`：`ensureEsbuild({ pkgRoot, logger, runNpmFn = runNpm })` → `{ ok: true, esbuildModule } | { ok: false, reason }`；目录存在且 `node_modules/esbuild` 可解析 → 动态 import 返回；否则 runNpm install（cwd = tools 目录），失败返回 reason。
`src/ensure-bundle.mjs`：`ensureBundle({ version, pkgRoot, logger, deps: { buildKernel, ensureEsbuild, scriptHash } })`：
- meta 读 + 校验（`createHash("sha256")` 对 `scripts/bundle-backend.mjs`）；匹配 → `{ ok: true, reused: true }`
- 不匹配 → ensureEsbuild → `buildKernel({ version, outDir: 临时, esbuildModule })`（buildKernel = 复用 `runBundleBackend` 的构建段，`outfile` 落 `bundle.mjs.tmp-<pid>`）→ `renameSync` → 写 meta → 清 `bundle.bad` → `{ ok: true }`
- esbuild/构建失败 → `{ ok: false, reason }`（不写 bad）
- `paths.mjs`：`preferBundle` 先查 `bundle.bad` 同名标记 → 存在则 `backend: "source"`

- [ ] **步骤 4：运行测试验证通过**

运行等价脚本 + `npx vitest run test/ensure-bundle.test.mjs`（用户终端）
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/esbuild-tools.mjs src/ensure-bundle.mjs src/paths.mjs test/ensure-bundle.test.mjs
git commit -m "feat: ensureBundle 内核（esbuild 懒安装、meta 失效、原子写入、bundle.bad）"
```

---

### 任务 2：接线 install / update / switch / doctor

**文件：**
- 修改：`src/commands/install.mjs`（预热前 ensureBundle(active)）、`src/commands/update.mjs`（装完 + 快照后 best-effort）、`src/commands/switch.mjs`（完成时打印 bundle 状态 + 后台补打）、`src/commands/doctor.mjs`（列各版本 bundle 状态）、`src/cli.mjs`（如需注入）
- 测试：`test/warmup.test.mjs` 同层级的命令级等价脚本（inject deps）

- [ ] **步骤 1：编写失败的测试**

```js
// 等价脚本断言清单（deps 注入 ensureBundle/runNpm fake）：
// - install 流程（走 runInstallCommand 或其预热段）：ensureBundle 被调一次且 version = active
// - update 成功路径：ensureBundle(version) 被调；返回 { ok:false } → update 退出码仍 0，
//   输出含"将以源码入口启动"
// - switch：目标版本有 bundle → 输出"已优化"；无 → 输出"冷启动较慢"且后台任务被调度
//   （fake ensureBundle 记录调用，不 await）
// - doctor：对 versions/ 下每个已装版本输出 bundle 状态行
```

- [ ] **步骤 2：运行测试验证失败**

运行等价脚本
预期：FAIL，命令未调 ensureBundle

- [ ] **步骤 3：实现**

各命令按规格 §9 表格接线；`switch` 的后台补打用 `ensureBundle(...).catch(() => {})` 不 await（进程可能立即退出——接受尽力而为，下次触发再补；文档写明）；`doctor` 读 meta 文件列表。

- [ ] **步骤 4：运行测试验证通过**

- [ ] **步骤 5：Commit**

```bash
git add src/commands/install.mjs src/commands/update.mjs src/commands/switch.mjs src/commands/doctor.mjs
git commit -m "feat: ensureBundle 接线 install/update/switch/doctor"
```

---

### 任务 3：mcp 运行时后台补打 + bundle.bad 运行时兜底

**文件：**
- 修改：`src/commands/mcp.mjs`（连接时后台补打）、`src/backend.mjs` 或 supervisor 包装（bundle 启动就绪前崩 → 换源码重试 + 写 bundle.bad）
- 测试：`test/ensure-bundle.test.mjs` 扩展

- [ ] **步骤 1：编写失败的测试**

```js
// 等价脚本断言清单：
// - LAUNCHER_HOLDER/普通模式下 mcp 启动：runtime backend=bundle 且 meta 过期 →
//   后台 ensureBundle 被调（fake 记录），不影响首调路径
// - bundle 启动就绪前崩溃（fixture 后端 exit）且 cliJs 是 bundle →
//   supervisor 重启用源码入口成功 + bundle.bad 文件出现 + 后续解析 backend=source
```

- [ ] **步骤 2：运行测试验证失败**

- [ ] **步骤 3：实现**

- `mcp.mjs`：prewarm 之前若 `runtime.backend === "source"` → 后台 `ensureBundle(active)`（fire-and-forget）；若 `backend === "bundle"` → 校验 meta，过期同样后台补打（当前会话继续用旧 bundle，审查重点 5）
- bundle 启动失败兜底：`runMcpCommand` 里 `runtime.backend === "bundle"` 时给 supervisor 包一层：`ensureReady` 失败且错误为"backend exited（进程启动即死）"→ `writeFileSync(bundle.bad)` + 用 `runtime.sourceCliJs`（preferBundle 需保留 sourceCliJs 字段）重建 supervisor 重试一次；仅重试一次
- `paths.mjs`：返回对象加 `sourceCliJs` 字段

- [ ] **步骤 4：运行测试验证通过**

- [ ] **步骤 5：Commit**

```bash
git add src/commands/mcp.mjs src/backend.mjs src/paths.mjs test/ensure-bundle.test.mjs
git commit -m "feat: mcp 后台补打 bundle 与启动失败换源码兜底"
```

---

### 任务 4：真实验收 + 收尾

- [ ] **步骤 1**：真实链路验收——删 versions/0.6.0/bundle.mjs 与 meta → `npm install`（dev 仓库）验证 prepare 外的 ensureBundle 自动补齐（经 mcp 会话触发）→ switch 到 0.6.1（若有）验证状态提示与后台补打
- [ ] **步骤 2**：全量等价断言回归 + `npx vitest run`（用户终端）
- [ ] **步骤 3**：账本 + 最终自审 + 清理工作区
- [ ] **步骤 4**：Commit

```bash
git add -A
git commit -m "chore: ensureBundle 验收与收尾"
```

## 自检记录

- 规格覆盖度：§9 五个触发点（任务 2/3）、esbuild 懒安装（任务 1）、原子写入/meta（任务 1）、bundle.bad 兜底（任务 3）、不静默（任务 2/3）——无遗漏
- 步骤扫描：meta 五字段、esbuild 目录、bad 语义、各命令失败容错均已钉死
- 类型一致性：`ensureBundle`/`ensureEsbuild`/`buildKernel`/`preferBundle` 跨任务一致
- 审查重点：5 条分别由任务 3/4（1）、任务 1（2）、任务 1（3）、任务 5→任务 3 扩展（4）、任务 3（5）钉住
