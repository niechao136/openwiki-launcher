---
type: subsystem
title: 安装决策器与安装编排
description: planInstall 作为纯函数决策器如何为每个宿主算出 skill 与 MCP 动作，以及 runInstall 的编排顺序、护栏一票否决、写入、备份、回滚与安装收尾的默认版本就绪/预热判据。
tags: [installer, plan, orchestration, rollback, default-version]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-f2765e03ab3c44ffdd8995a7
    resource: repo://src/commands/install.mjs
  - id: openwiki-source-b995d49faa81ab47b4496f9b
    resource: repo://src/install.mjs
  - id: openwiki-source-25b67ca644bd99d29a60497f
    resource: repo://src/plan.mjs
  - id: openwiki-source-82ad0bac05d48ab1a24b4e91
    resource: repo://src/targets.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 安装决策器与安装编排

## 切分原则：决策与 IO 分离

安装面被切成两个模块：

- **`src/plan.mjs` —— 纯函数决策器。** 所有检测结果由调用方算好传进来，它只做判断：装什么、跳过什么、报什么冲突、哪个动作被护栏拦。它**不碰文件系统**。
- **`src/install.mjs` —— 编排器。** 检测 → 计划 → 执行 → 回滚 → 报告，只负责按表执行与善后。

这么切分是为了可测试性：整个安装决策面能用纯数据输入完整覆盖，不需要真实宿主、不需要临时目录。（对比之下，superpowers-zh 把决策与 IO 混在一个 83KB 单文件里，只能靠集成测试兜底。）

纯函数还带来一个硬性质：**护栏被拒时执行器一个字节都不写**——`guarded` 的条目在执行阶段被整体拦掉，而不是「跳过这一个文件、继续写别的」。

## planInstall 产出什么

对每个目标宿主返回一个 entry：

```js
{
  hostId, displayName,
  skill: { action, dir, skipKind?, reason? },   // install / skip
  mcp:   { action, path, kind, containerKey?, entryJson?, tomlBlock?, newText?, removed?, reason? },
  takeover, takeoverReason,                     // native-receipt / foreign-entry
  guarded, guardReason,
}
```

顶层还返回 `skippedNoHost`（一个宿主都没命中）与 `nodeWarning`（node 绝对路径退化时的警告）。

### skill 动作

技能目录由 `skillsDirFor` 决定，它在 win32 上优先取注册表的 `globalDirWin`——直接读 `globalDir` 会把 skill 装到宿主不扫描的目录（Crush、Reasonix 的 Windows 全局路径与 Unix 不同构）。

目录为 `null` 时判为 `skip`，`skipKind: "scope"`，并给出人读理由：用户级作用域下提示「该宿主没有已核实的全局技能目录，请改用项目级安装」，项目级则用注册表的 `noProjectReason`。

### MCP 动作

分四种情况：

| 情况 | action |
| --- | --- |
| `host.mcp === null`（无 MCP 客户端能力） | `none` |
| `kind === "manual"` | `manual` |
| 配置文件读不出来 | `error` |
| 正常 | `created` / `updated` / `unchanged` |

三种可自动写格式的载荷形状各不相同：`json` 写 `{command, args}`；`opencode-json` 写 `{type:"local", command:[command, ...args], enabled:true}`；`codex-toml` 写 `[mcp_servers.openwiki]` 表块。

**动作由纯函数的切片/拼接结果决定**：决策器在内存里对快照文本调用 `spliceJsonEntry` / `upsertTomlBlock`，拿到 `created` / `updated` / `unchanged` 与新文本。执行阶段对同一份快照再算一次然后落盘——因为是纯函数，两次结果必然一致。

### 「读不出来」不等于「空配置」

`collectMcpSnapshot` 读文件失败时标记 `unreadable` 而不是当作空字符串。这是一条真实存在的故障面：Windows 上文件被独占、间歇性 IO 错误、并发写导致的截断。如果把读失败当成空配置，就会走「新建」分支，用「只有 openwiki 一个 server」的新内容**覆盖掉用户整个配置文件**，其他 server 全部消失，而退出码还是 0。

决策器对 `unreadable` 的条目判为 `action: "error"`，并给出可读原因。它仍然往下走护栏检查，不在这里提前返回。

执行阶段把 `error` 条目视为**整次安装失败**：不写它不等于这次安装成功，用户需要看到非零退出码与可读原因。

### 路径拼接必须尊重入参平台

`joinFor(platform, base, rel)` 按传入的 `platform` 选 `path.win32` 或 `path.posix`。不能直接用 `path.join`——`platform` 是纯函数的入参，用宿主平台的 `path.join` 会让「注入 linux、跑在 Windows 上」这种测试组合产出反斜杠路径。**纯函数必须只依赖它的输入。**

### 护栏判定

对 `skill.dir` 与 `mcp.path` 逐个检查：

1. 命中系统目录 → `guarded`，理由「拒绝写入系统目录」，**没有 `--force` 绕过**；
2. 项目级作用域且 `baseDir` 就是 home → `guarded`，理由「拒绝在用户主目录里做项目级安装」，这一条**可以**用 `--force` 绕过。

### 接管判定

两种情况判为接管：

- `nativeSnapshot[hostId].receipt === true` → `takeoverReason: "native-receipt"`：该宿主的 skill 目录里存在 openwiki 原生安装器写的 `.openwiki-install.json`；
- `mcp.action === "updated"` 且读回的旧条目 `isOursEntry` 为假 → `takeoverReason: "foreign-entry"`：配置里已有一条 openwiki 条目，但不是本安装器写的。

`--no-takeover` 会把两者降级：skill 变 `skip`（`skipKind: "takeover"`），mcp 变 `skip`，并把 `takeover` 复位为 false。这是**成功路径**（零改动 + 报告标 skipped），不是作用域错误。

## runInstall 的编排顺序

`runInstall` 的顺序本身就是设计：

1. **未知宿主在任何写入之前拒绝。** `resolveTargets` 未命中且显式给了 `--tool` 时，打印可用 id 列表并返回 1。
2. **解析作用域。** `--global` → `{scope:"user", baseDir:homeDir}`，否则 `{scope:"project", baseDir:cwd}`。
3. **一次性算完三张快照，之后才允许写。** detect / native / mcp。
4. **决策。** `planInstall` 拿到全部快照。
5. **护栏一票否决。** 任一 entry `guarded` → 打印每家的拒绝理由，返回 **exit 2**，报告里所有行 `wrote: false`。
6. **无宿主 → exit 1** 并扫 PATH 给建议。
7. **显式 `--tool` 时作用域不支持才算失败**；自动检测时不同——某一家不支持只跳过那一家，其余宿主照常安装。
8. **逐 entry 执行**：先 skill（`installSkill`），后 MCP 配置（先 `createBackup` 再写）。
9. **任一失败 → 回滚**。
10. 报告，并在 win32 上提示 Defender 排除项。
11. **安装收尾（命令层）：先默认版本就绪，再自动预热。** 就绪在成功安装或「检测不到宿主」时执行，预热只在成功安装时执行；两者都是优化，失败只告警、退出码仍然是安装的结果，测试可注入 `ensureDefaultVersionFn` / `ensureBundleFn` / `warmFn` 替掉真实动作。

### 为什么检测快照必须先算完

这是安装编排的一条硬要求。Codex 的技能目录是 `.agents/skills`，而 **Antigravity 的 detect 标记正是 `.agents`**。如果边检测边安装，装完 Codex 后再检测，就会看到 `.agents` 目录刚刚被创建出来，于是把 Antigravity 误判成「已安装」而跳过——用户明明装了 Codex 却连带把 Antigravity 也跳过了。

`collectDetectSnapshot` 的注释把这层因果写得很直白：**先写后判会让它被邻居的产物误判**。

### 快照一律用真实的 existsSync

`deps.exists` 是 PATH 探测的 seam，不是文件系统抽象。快照采集统一用真实的 `existsSync`；需要控制检测结果时走 `detectSnapshotOverride`。之前的实现把 `deps.exists` 一并传下去，导致测试里 `exists: () => false` 会让快照永远认为「文件不存在」。

### 回滚清单只收本次新建的目录

`installSkill` 返回的 `preexisting` 表示目录在运行之前就存在。只有 `!preexisting` 的目录进 `createdSkillDirs`。否则一次失败就会把用户原有的 skill 目录整个删掉，而报告说的是「已回滚本次写入的内容」——报告与实际动作不一致比报错更糟。

回滚本身：`rollbackAll(backups)` 恢复配置文件，然后 `rmSync(dir, {recursive:true, force:true})` 删掉本次新建的 skill 目录。回滚过程本身出错只记日志，不掩盖原始失败原因。

### 幂等

`spliceJsonEntry` / `upsertTomlBlock` 在内容等价时返回 `unchanged`，执行阶段据此跳过写入——重复安装不会产生任何文件改动，报告会说「MCP 已是最新，未改动」。

## manual 与 none 的报告

`manual` 宿主会打印一段可直接粘贴到宿主 MCP 设置里的 JSON（`mcpServers.openwiki` 指向 `node <绝对路径>` 与本包 bin）。`none` 宿主明确说明「只安装 skill，openwiki 的 SKILL.md 自带降级路径」。

## 安装收尾：默认版本就绪与自动预热

收尾动作挂在命令层（`src/commands/install.mjs`）而不是 `runInstall` 内部，原因写在注释里：`runInstall` / `runUninstall` 是同步函数（28 家 e2e、回滚逻辑与纯函数决策面都依赖这个契约），不能为了 async 收尾改签名。同样在这一层，命令启动时会先解析运行时并算出 `bundleDir`（`bundleDirFor(runtime.packageRoot)`）供 skill 安装使用——解析不到 openwiki 依赖就直接报错退出 1，skill 安装不会半途启动。

### 默认版本就绪（0.5.0 起）

`shouldPrepareAfterInstall` 的判据覆盖四态：成功安装（`exitCode === 0`）与「检测不到宿主」（`exitCode === 1` 且 `skippedNoHost`）都要做；失败回滚 / 未知宿主 / 作用域不支持（`exitCode === 1` 且非 `skippedNoHost`）与护栏拒绝（`exitCode === 2`）都不做。判据刻意不看报告里是否真的写了字节：重跑安装器时配置可能早已是最新，而用户正是通过重跑来修复上一次失败的就绪。

就绪开关有两个等价来源：`--no-prepare` 与 `LAUNCHER_PREPARE=0`（`prepareEnabled`），任一关闭即跳过。就绪失败只告警，并提示可稍后运行 `openwiki-launcher warm` 重试；完整语义（六态、删除标记、失败退避）见[默认版本就绪：物化与自愈](../versions/default-readiness.md)。

### 自动预热

- 触发条件：安装退出码为 0、非卸载、未给 `--no-warm`；
- 顺序：先 `ensureBundle`（补打当前版本 bundle，预热顺带验证它可启动），再复用 `warm` 命令（60 秒超时上限），宿主标识为 `warm`；
- `--no-prepare` 同时跳过 bundle 补打（物化关了、bundle 还照打会造出 bundle-only 的畸形目录），但**不**跳过预热本身——物化与预热是两个正交开关；
- 失败只打告警「不影响本次安装结果」，退出码不变；
- 预热已自报耗时，成功时不再重复提示；只有 `--no-warm` 时才提示手动跑 `openwiki-launcher warm`。

## 相关页面

- [宿主注册表](./host-registry.md)
- [Skill 目录安装、收据与完整性校验](./skill-install.md)
- [卸载与归属判定](./uninstall.md)
- [安全护栏、备份与回滚](../safety/guards-and-backups.md)
- [默认版本就绪：物化与自愈](../versions/default-readiness.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
