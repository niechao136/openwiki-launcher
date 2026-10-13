# 后端 bundle（冷启动压缩）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 openwiki 后端打成单文件 bundle，热启动 5.6~7.5s → ~2.5s，并让冷启动（Defender 扫描态）的扫描面从数千文件降到 1 个 bundle + 少量原生模块；doctor 提供 Defender 排除提示。

**架构：** 新增 `scripts/bundle-backend.mjs`（esbuild 构建管线，产出写入 `versions/<v>/bundle.mjs`）；runtime 解析优先使用 bundle（存在即用，缺失降级 node_modules 的 cliJs）；doctor 增加 Defender 排除提示行。compile cache 已探明无收益（bundle 直启 2.5s vs +cache 2.5-3.1s），不做。

**技术栈：** esbuild（devDependency，已装）。

**规格：** `docs/superpowers/specs/2026-10-13-cold-start-mitigation-design.md` §6

## 探路事实（2026-10-13 实测，写死进计划）

- 打包配置：`format: "esm"`, `platform: "node"`, `target: "node22"`, `bundle: true`
- **必须**的 banner：`import { createRequire as __cReq } from "node:module"; const require = __cReq(import.meta.url);`（ESM 产物内 CJS 依赖的 node 内置 require）
- external：`better-sqlite3`（原生）、`jsdom`（mermaid dom-shim 动态 import，MCP 不触达）、`jsonc-parser`（UMD 动态 require 相对路径在 bundle 内失效）
- **必须**的 stub 插件：`react-devtools-core` → `export default undefined;`（ink 调试依赖，静态 import，运行时不可达）
- 产物 ~12.7MB，构建 ~3s；热态 initialize 应答 2.4-2.9s（原版 5.6-7.5s）；真实 tools/call 链路已验证
- `module.enableCompileCache()` 对 bundle 无收益（实测 2.5s vs 3.1s）——规格 §6.2 砍掉
- bundle 运行时 external 依赖从 bundle 文件位置向上找 node_modules——产物必须放在包根之下（`versions/<v>/bundle.mjs` 满足）

## 全局约束

- Node ≥ 22.22.0；esbuild 仅 devDependency，运行时零依赖不变
- bundle 是版本资产：位于 `versions/<active 版本>/bundle.mjs`，`switch`/`versions remove` 天然随版本目录生灭，无额外清理逻辑
- bundle 缺失时一切行为与现状一致（降级 cliJs），**绝不因 bundle 缺失而失败**
- `files` 白名单需含 bundle 产物路径模式，否则 npm 发布不带 bundle

## 审查重点（Review Focus）

1. bundle 缺失 / 版本不匹配（bundle 属于别的版本目录）→ 必须静默降级 cliJs，绝不报错（任务 2 测试钉住）
2. bundle 构建失败（esbuild 缺失、上游结构变化）→ `npm run bundle` 返回非 0 并给出原因；运行时不受影响（任务 1 测试钉住）
3. bundle 与 cliJs 指向不同 openwiki 版本 → manifest 校验沿用现有版本号逻辑，不得用 bundle 覆盖 active 版本号（任务 2 测试钉住）
4. Defender 提示只在 win32 出现，且**永不自动执行**（任务 3 测试钉住）
5. holder 模式下 bundle 路径传递：`runHolder`/`resolveHolderSession` 的 cliJs 参数必须与 wrapper 一致（任务 2 测试钉住）

---

### 任务 1：打包管线

**文件：**
- 创建：`scripts/bundle-backend.mjs`
- 修改：`package.json`（`scripts.bundle`、`files` 白名单加 `"versions"`）
- 测试：`test/bundle-backend.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/bundle-backend.test.mjs 断言清单：
// - runBundleBackend({ logger, pkgRoot, esbuildModule?, outDir? }) → 0 且产物存在、>1MB
//   （真实 esbuild，产物到临时目录；耗时 ~3s 可接受）
// - 再次运行覆盖旧产物（幂等）
// - esbuild 不可用（deps 注入 esbuildModule = null）→ 退出码 1，stderr 含"esbuild"
// - 打包配置断言：对 deps 注入的 fake esbuildModule 捕获 build 参数，
//   断言 external 含三件套、format === "esm"、banner 含 createRequire
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/bundle-backend.test.mjs`
预期：FAIL，`../scripts/bundle-backend.mjs` 不存在

- [ ] **步骤 3：实现**

`scripts/bundle-backend.mjs`：导出 `runBundleBackend({ logger, pkgRoot = launcherPackageRoot(), version, esbuildModule = esbuild, outDir })` 与 CLI 入口（`node scripts/bundle-backend.mjs [--version <v>]`）。
- entry：`<pkgRoot>/node_modules/openwiki/dist/cli/cli.js`；outfile：`<pkgRoot>/versions/<version>/bundle.mjs`
- 打包配置照抄本计划"探路事实"一节（banner、stub 插件、external 三件套逐字）
- 完成后打印产物大小与耗时；任何异常 `logger.error` 后返回 1
- `package.json`：`"bundle": "node scripts/bundle-backend.mjs"`；`files` 数组加 `"versions"`

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/bundle-backend.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add scripts/bundle-backend.mjs test/bundle-backend.test.mjs package.json package-lock.json
git commit -m "feat: openwiki 后端 esbuild 打包管线（单文件 ESM bundle）"
```

---

### 任务 2：runtime 解析集成（bundle 优先）

**文件：**
- 修改：`src/paths.mjs`（`resolveOpenwikiRuntime` 增加 bundle 探测）
- 测试：`test/paths.test.mjs` 扩展 + 真实冒烟复跑

- [ ] **步骤 1：编写失败的测试**

```js
// test/paths.test.mjs 追加断言清单：
// - versions/<v>/bundle.mjs 存在 → resolveOpenwikiRuntime().cliJs 指向 bundle，
//   且 .backend === "bundle"（新增字段），version 仍为 active 版本号
// - bundle 不存在 → cliJs 指向 node_modules cli.js，.backend === "source"（现状不变）
// - bundle 存在但属于其他版本目录（active 指到另一个版本）→ 降级 source
// - 运行时冒烟：LAUNCHER_BACKEND_CLI 指向 bundle 路径时 mcp 命令行为与 cliJs 一致
//   （复用既有 e2e 断言；bundle 已在任务 1 生成）
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/paths.test.mjs`
预期：FAIL，`.backend` 字段不存在

- [ ] **步骤 3：实现**

`resolveOpenwikiRuntime` 末尾：`const bundlePath = path.join(versionRoot, "bundle.mjs")`；`existsSync(bundlePath)` → `cliJs = bundlePath, backend = "bundle"`，否则 `backend = "source"`。version 判定逻辑不动（审查重点 3）。holder / wrapper / warm 均消费 `runtime.cliJs`，无需逐个改动（审查重点 5 由"同一 cliJs 来源"天然满足，测试用例覆盖）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/paths.test.mjs test/holder-runtime.test.mjs test/broker.test.mjs`
预期：PASS（不回归）

- [ ] **步骤 5：Commit**

```bash
git add src/paths.mjs test/paths.test.mjs
git commit -m "feat: runtime 解析优先使用版本目录内的 bundle"
```

---

### 任务 3：doctor Defender 提示 + 文档

**文件：**
- 修改：`src/commands/doctor.mjs`、`README.md`
- 测试：`test/doctor.test.mjs` 扩展

- [ ] **步骤 1：编写失败的测试**

```js
// test/doctor.test.mjs 追加断言清单：
// - platform 注入 win32 → 输出含 "Add-MpPreference" 与排除路径建议
//   （node 所在目录 + 包根），且**不含**任何执行该命令的调用
// - platform 注入 darwin/linux → 无 Defender 相关输出
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/doctor.test.mjs`
预期：FAIL

- [ ] **步骤 3：实现**

doctor 的 win32 分支（已有 Node 版本检查后）追加两行提示：冷启动受实时扫描影响的说明 + 可复制的 `Add-MpPreference -ExclusionPath "<node 目录>","<包根>"` 命令（需管理员）；darwin/linux 不输出。README 排障表"Windows 上后端起不来"一行扩为"冷启动慢/后端异常"并指向 doctor 提示与 bundle。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/doctor.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/doctor.mjs test/doctor.test.mjs README.md
git commit -m "feat: doctor 输出 Defender 排除提示（win32）"
```

---

### 任务 4：冷启动验收

- [ ] **步骤 1：生成 bundle 并用真实后端复跑冒烟**

运行：`npm run bundle`，然后复用任务 6 的真实冒烟（LAUNCHER_REAL_SMOKE）记录 bundle 态的冷启动与热调耗时，与基线（33.5s 半热 / >120s 全冷）对比。
预期：热态 < 3s；冷态因扫描面缩小应显著低于 33s（不做硬断言，数据入账本）。

- [ ] **步骤 2：全量回归**

运行：`npx vitest run`（用户终端）
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add -A
git commit -m "chore: 冷启动验收数据与产物提交"
```

## 自检记录

- 规格覆盖度：§6.1 bundle（任务 1/2）、§6.2 compile cache（探路证伪，砍掉，计划不实现）、§6.3 Defender（任务 3）、§6.4 验收（任务 4）——无遗漏
- 步骤扫描：打包配置从探路脚本逐字固化（banner/stub/external/format），无歧义
- 类型一致性：`runBundleBackend`/`resolveOpenwikiRuntime().backend` 跨任务一致
- 审查重点：5 条分别由任务 1（2）、任务 2（1/3/5）、任务 3（4）钉住
