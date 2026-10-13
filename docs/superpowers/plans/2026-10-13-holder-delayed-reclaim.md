# 延迟回收（holder + lockfile + TTL）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** openwiki 后端脱离宿主会话生命周期：首个 wrapper 拉起 holder（detached），后续会话经 lockfile 接入热后端；空闲 TTL 后 holder 自退。

**架构：** wrapper 的 `createBroker` 保持不变，其 `supervisor` 参数换成一个实现同接口的 holder 适配器（连接 holder 的管道并转发 tools/call/cancelled）——排队/progress/超时逻辑原样复用。holder 是独立 detached 进程：监听 `\\.\pipe\openwiki-launcher-<hostId>-<version>`，内部对上游只做一次 initialize，按连接重映射 id，剥掉 progressToken。lockfile 用 `wx` 独占创建防并发，探活用管道 connect。

**技术栈：** Node ESM（零运行时依赖，`node:net` / `node:child_process` / `node:fs`）、vitest。

**规格：** `docs/superpowers/specs/2026-10-13-cold-start-mitigation-design.md` §5（本计划实现其全部内容；§4 已由上一个计划交付）

## 全局约束

- Node ≥ 22.22.0（`engines`），零运行时依赖
- stdout 只承载 MCP 线协议；诊断走 stderr
- 逐宿主实测结论：CodeBuddy 宿主不使用 Job Object（2026-10-13 实测 `IsProcessInJob=false`），detached holder 天然存活；其余宿主保留验收门槛（§8）
- holder spawn 参数：`detached: true, stdio: "ignore", windowsHide: true`，spawn 后 `unref()`
- holder 退出兜底：spawn 失败或连续 3 次 / 5 秒管道连接失败才回退进程内 supervisor，回退必须打日志
- lockfile：`<packageRoot>/versions/holder-<hostId>.json`，内容 `{ pid, pipeName, version, startedAt }`，`openSync(..., 'wx')` 独占创建
- 管道名：`\\\\.\\pipe\\openwiki-launcher-<hostId>-<version>`（Node `net`；version 来自 active runtime）
- TTL：无活跃连接 30 分钟（`LAUNCHER_HOLDER_TTL_MINUTES` 可配），有新连接即取消计时，断开后重计
- holder 端排队上限固定 120000ms（wrapper 侧已有 25s 可配上限，两层独立）
- holder 协议 = JSON-RPC 行协议（复用 `src/jsonrpc.mjs`），方法仅四种：`tools/call`（转发）、`notifications/cancelled`（映射取消）、`holder/status`（就绪探针，回 `{ backendReady, version }`）、`holder/shutdown`（优雅退出）
- progressToken 在 wrapper→holder 方向剥掉（已核实 openwiki 不发 progress）；wrapper 对宿主的 progress 由现有 broker 逻辑产生，不经 holder
- 所有新代码遵循既有中文注释/文案风格

## 审查重点（Review Focus）

1. 两个 wrapper 并发抢 lockfile：一方 `wx` 失败后必须探活对方并接入，绝不能覆盖或双开（任务 4 测试钉住）
2. holder 崩溃后 lockfile 残留：下一个 wrapper 探活失败必须删除残留并重新拉起，不能永久卡死在失效 lockfile 上（任务 4 测试钉住）
3. 两个连接并发 `tools/call`，上游响应乱序返回：id 映射不得串线（任务 2 测试钉住）
4. 连接中途断开（wrapper 崩溃）：holder 必须清理该连接的 pending 映射，结果丢弃，不影响其他连接（任务 2/3 测试钉住）
5. 版本不匹配：wrapper 必须让旧 holder 退出并拉新，而不是把调用发进旧版本后端（任务 4 测试钉住）

---

### 任务 1：lockfile 模块

**文件：**
- 创建：`src/lockfile.mjs`
- 修改：`src/paths.mjs`（新增 `holderLockPath(hostId)`）
- 测试：`test/lockfile.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/lockfile.test.mjs 断言清单（fixture 目录内操作）：
// - acquire 独占语义：首次成功；未释放再 acquire 同名 → 返回 { acquired: false, existing }
// - existing 内容可 read 读出（pid/pipeName/version/startedAt 原样）
// - release 删除文件；删除后可再次 acquire
// - acquire({ force: true }) 覆盖残留（用于探活失败后的清理路径）
// - hostId 含非法字符（非 [a-z0-9-]）→ 抛错
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/lockfile.test.mjs`
预期：FAIL，`../src/lockfile.mjs` 不存在

- [ ] **步骤 3：实现**

`src/paths.mjs` 导出 `holderLockPath(hostId)`：`<packageRoot>/versions/holder-<hostId>.json`（复用既有 packageRoot 解析）。
`src/lockfile.mjs` 导出：

- `acquireLock(lockPath, data, { force = false } = {})` → `{ acquired: true } | { acquired: false, existing: object }`；`wx` 打开，EEXIST 时读现有内容返回；`force` 时先 `rmSync` 再建；内容 `JSON.stringify(data, null, 2)`
- `readLock(lockPath)` → object | null（ENOENT → null，JSON 损坏 → null）
- `releaseLock(lockPath)` → 幂等删除

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/lockfile.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/lockfile.mjs src/paths.mjs test/lockfile.test.mjs
git commit -m "feat: holder lockfile 模块（wx 独占创建、读取、幂等释放）"
```

---

### 任务 2：holder 多路复用核心（纯逻辑）

**文件：**
- 创建：`src/holder-server.mjs`（`createHolderCore`：不含管道，只含会话映射逻辑）
- 测试：`test/holder-server.test.mjs`（假上游 supervisor + 模拟连接对象）

- [ ] **步骤 1：编写失败的测试**

```js
// test/holder-server.test.mjs 断言清单（supervisor 用假上游，参照 broker.test.mjs 的
// makeBrokerWithSupervisor 模式）：
// - createHolderCore({ supervisor, logger, queueTimeoutMs }) 返回
//   { handleConnection(conn), connections(): number }
// - conn 是 { send(message), onMessage(cb), close() } 形态（测试直接喂回调）
// - 首个 tools/call 触发 supervisor.ensureReady()（上游 initialize 一次）；
//   后续连接的调用不产生第二次上游 initialize（断言 ensureCalls === 1）
// - id 重映射：连接 A 发 id=1，连接 B 发 id=1，上游收到的两个请求 id 全局唯一；
//   上游响应按映射各回各的连接、原 id 保留
// - 响应乱序：上游按 B→A 顺序 resolve，两连接各收到自己的结果
// - progressToken 剥离：params._meta.progressToken 不出现在上游收到的请求里
// - notifications/cancelled { requestId }：映射到全局 id，上游响应到达后被丢弃，
//   该连接不再收到该 id 的任何消息
// - 连接 close：其 pending 全部丢弃；其他连接不受影响
// - holder/status：回 { backendReady: <supervisor.current() != null>, version }
// - supervisor.ensureReady 抛 BackendUnavailableError：该连接收到
//   isError "openwiki 后端不可用" 的 tools/call 应答，连接保持可用
// - 排队超时（queueTimeoutMs 用极小值注入）：该连接收到
//   isError "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试"
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/holder-server.test.mjs`
预期：FAIL，`../src/holder-server.mjs` 不存在

- [ ] **步骤 3：实现**

`createHolderCore({ supervisor, logger, queueTimeoutMs = 120000, now = () => Date.now() })`：

- 全局 `nextId = 1`；每连接维护 `pending: Map<globalId, { conn, connId }>` 与 `idMap: Map<connId, globalId>`（connId = 连接内原始 id）
- `handleConnection(conn)`：注册 conn.onMessage → `handleMessage(conn, message)`：
  - `tools/call`：`params = { ...message.params, _meta: undefined }`（剥 token），globalId = nextId++，登记 pending 后 `session.request("tools/call", params)`（session 来自 `ensureReady()`，上游未就绪则在 core 内排队等待，超时同 broker 文案），响应映射回 `conn.send({ jsonrpc, id: connId, result })`
  - `notifications/cancelled`：connId → globalId 查映射，从 pending 删除（响应到达时无主即丢）
  - `holder/status`：`conn.send({ jsonrpc, id: message.id, result: { backendReady: supervisor.current() != null, version } })`
  - `holder/shutdown`：回调 `onShutdown()`（由装配层提供）
- 连接断开（`conn.onClose`）：删除该连接全部 pending
- 上游响应路由：supervisor 的 session 与 broker 不同，这里直接用 `session.request()` 的 promise（每调用一个 promise，无乱序问题；"乱序"由测试用不同 resolve 顺序验证映射正确性）
- 实现者注意：`session.request` promise 与 broker 既有 `withDeadline`/`withCancellation` 不复用（holder 端语义更简单：超时/失败即回 isError，无需 EOF 级联），错误分两类映射为 isError：启动失败 → "openwiki 后端不可用：…；排队超时 → 逐字复用 broker 的新文案"

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/holder-server.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/holder-server.mjs test/holder-server.test.mjs
git commit -m "feat: holder 多路复用核心（单次上游握手、id 重映射、取消与状态探针）"
```

---

### 任务 3：holder 进程装配（管道监听 + TTL + 生命周期）

**文件：**
- 创建：`src/holder-runtime.mjs`（`runHolder({ hostId, version, runtime, logger, env })`：管道 server + core 装配 + TTL + lockfile 写删 + spawn 上游预热）
- 创建：`src/commands/holder.mjs`（`runHolderCommand`：CLI 入口，解析 `--host`，调 `runHolder`）
- 修改：`src/cli.mjs`（注册 `holder` 命令，不进 help 显眼位置也行但必须可调用）
- 测试：`test/holder-runtime.test.mjs`（真实 `node:net` 管道 + 假上游 CLI，参照 backend-session.test.mjs 的 fixture 模式；管道名用测试专用后缀避免撞名）

- [ ] **步骤 1：编写失败的测试**

```js
// test/holder-runtime.test.mjs 断言清单（真实管道，假上游 CLI 用 fixtures/fake-openwiki.mjs）：
// - runHolder 启动后：lockfile 存在且内容正确（pid/pipeName/version/startedAt）
//   → 用 readLock 断言
// - 客户端 net.connect(pipeName) 可连上；发 tools/call（上游有延迟）收到正确结果
// - holder/status 在上游就绪前回 backendReady:false，就绪后回 true
// - holder/shutdown：优雅退出（进程退出码 0）、lockfile 删除、上游子进程被杀
// - TTL=0（测试注入极小值，如 500ms）：无连接时自动退出且删 lockfile；
//   期间建立连接则不退出，断开后重新计时
// - lockfile 已被别处占用（先手工 acquire）：第二个 runHolder 以非 force 启动
//   → 报错退出码 1（不覆盖）；测试覆盖 force 启动路径：探活失败后 force 重启成功
// - 上游 CLI 指向 FAKE_REFUSE=1 的 fixture：holder 退出并删 lockfile，退出码 1
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/holder-runtime.test.mjs`
预期：FAIL，`../src/holder-runtime.mjs` 不存在

- [ ] **步骤 3：实现**

`runHolder({ hostId, version, cliJs, logger, env, ttlMs, pipeName, lockPath })`：

- 启动顺序（规格 §5.3）：`net.createServer` 先 `listen(pipeName)`，成功后 `acquireLock`（失败且非 force → `logger.error` + 退出码 1），然后 `createBackendSupervisor(...).ensureReady()` 后台预热（失败只 warn，不退出——等待首个调用重试）
- core = `createHolderCore(...)`；`server.on("connection", conn => core.handleConnection(wrapConn(conn)))`，`wrapConn` 把 socket 适配成 core 要的 `{ send, onMessage, onClose }`（`createLineParser` + `formatMessage`）
- 连接计数：connection/close 事件维护 `activeCount`；`activeCount === 0` 时启动 TTL timer，新连接取消 timer
- TTL 到期：优雅退出（server.close → supervisor.stop → releaseLock → process.exit(0)）
- `holder/shutdown` / SIGTERM / SIGINT：同上退出路径
- 退出前保证 `releaseLock(lockPath)`
- `runHolderCommand({ args, logger, env })`：解析 `--host`，用 `resolveOpenwikiRuntime()` 取 version/cliJs，调 `runHolder`；返回退出码（0 成功退出，1 启动失败）

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/holder-runtime.test.mjs test/holder-server.test.mjs test/lockfile.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/holder-runtime.mjs src/commands/holder.mjs src/cli.mjs test/holder-runtime.test.mjs
git commit -m "feat: holder 进程装配（命名管道、TTL 空闲回收、lockfile 生命周期）"
```

---

### 任务 4：wrapper 接入（探活 → 拉起 → 回退）

**文件：**
- 创建：`src/holder-client.mjs`（`connectToHolder` / `spawnHolder` / `resolveHolderSession`）
- 创建：`src/holder-session.mjs`（`createHolderSupervisorAdapter`：把 holder 连接适配成 broker 要的 supervisor 接口）
- 修改：`src/commands/mcp.mjs`（启动顺序改造）
- 测试：`test/holder-session.test.mjs`、`test/mcp-command.test.mjs` 扩展

- [ ] **步骤 1：编写失败的测试**

```js
// test/holder-session.test.mjs（适配器，假 holder server 用任务 3 的真实管道 + 假上游）：
// - createHolderSupervisorAdapter({ hostId, version, logger, queueTimeoutMs })
//   返回 { ensureReady(), current(), onSessionExit(fn), stop() }
// - ensureReady 在管道可连后 resolve 一个 session：
//   session.request("tools/call", params) → 经管道转发 → 收到 holder 回来的结果
// - session.notify("notifications/cancelled", { requestId }) → 转成 holder 协议取消
// - stop() 只断开管道连接，绝不杀 holder 进程（断言 holder 进程仍活着、lockfile 仍在）
// - 管道断开：ensureReady 的 session rejected → onSessionExit 监听者被通知
// - 剥 token：session.request 收到的 params._meta.progressToken 被适配器剥掉
//   （假 holder 端断言收到的请求无 _meta.progressToken）

// test/mcp-command.test.mjs 追加（环境变量驱动，不起真 holder）：
// - LAUNCHER_HOLDER=1 且探活失败且回退 → runMcpCommand 走进程内 supervisor
//   （logger.warn 含 "回退"），行为与现状一致
// - LAUNCHER_HOLDER=0（默认）：行为与现状完全一致（现有用例不回归）
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/holder-session.test.mjs test/mcp-command.test.mjs`
预期：FAIL，`../src/holder-client.mjs` 不存在

- [ ] **步骤 3：实现**

`src/holder-client.mjs`：

- `connectToHolder(pipeName, { attempts = 3, intervalMs = 500 } = {})` → Promise<socket | null>（连接重试；null = 超上限）
- `spawnHolder({ hostId, version, cliJs, logger })`：`spawn(process.execPath, [holderEntry, "holder", "--host", hostId], { detached: true, stdio: "ignore", windowsHide: true })` + `unref()`；spawn 同步异常向上抛（回退触发点之一）
- `resolveHolderSession({ hostId, version, cliJs, logger, env })` →
  `{ mode: "holder", pipeName } | { mode: "inprocess" } | { mode: "inprocess", reason }`：
  1. readLock → 存在且 version 匹配 → connectToHolder → 成功即接入
  2. 存在但探活失败 → `acquireLock(force: true)` 覆盖残留 → spawnHolder
  3. 不存在 → `acquireLock`；`acquired: false`（并发对手）→ 探活对手 → 接入；对手也探活失败 → force 覆盖拉起
  4. version 不匹配 → 向旧 holder 发 `holder/shutdown`（连不上则 kill pid），releaseLock，重新 acquire + spawn
  5. spawnHolder 抛错或 connectToHolder 超上限 → `{ mode: "inprocess", reason }`（调用方 logger.warn）

`src/holder-session.mjs`：`createHolderSupervisorAdapter({ pipeName, hostId, version, logger, queueTimeoutMs })` —— 实现 broker 的 supervisor 接口；`ensureReady` 首次建立连接并保持；内部把 broker 的 `session.request` 翻译成管道 JSON-RPC（id 自增，响应路由）；`session.notify` → 管道通知；管道断开 → 当前 session 置 null 并触发 onSessionExit（broker 既有崩溃语义接管）。

`src/commands/mcp.mjs`：`LAUNCHER_HOLDER=1` 时走 `resolveHolderSession`；`mode === "holder"` → `createBroker({ ..., supervisor: adapter })`；否则维持现有 `createBackendSupervisor` 路径。默认不开（`LAUNCHER_HOLDER` 缺省 = 现状），待逐宿主验收完成后再改默认——规格 §8 门槛决定的保守上线策略，此偏离已在规格允许范围内。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/holder-session.test.mjs test/mcp-command.test.mjs test/broker.test.mjs`
预期：PASS（现有 broker 用例不回归）

- [ ] **步骤 5：Commit**

```bash
git add src/holder-client.mjs src/holder-session.mjs src/commands/mcp.mjs test/holder-session.test.mjs test/mcp-command.test.mjs
git commit -m "feat: wrapper 接入 holder（lockfile 探活、并发竞争、崩溃残留、版本换血、安全回退）"
```

---

### 任务 5：warmup 命令 + doctor 提示 + 文档

**文件：**
- 创建：`src/commands/warmup.mjs`
- 修改：`src/cli.mjs`（注册 `warmup`）、`src/commands/doctor.mjs`（打印 schtasks 提示）、`README.md`
- 测试：`test/warm.test.mjs` 扩展或 `test/warmup.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/warmup.test.mjs 断言清单：
// - LAUNCHER_HOLDER=1 下 warmup：无 holder → spawn 并等 holder/status 的 backendReady
//   为 true 后退出码 0（假上游 CLI）
// - 已有热 holder → 直接退出码 0（不重复 spawn，lockfile 未变）
// - holder 拉起失败 → 退出码 1，stderr 有原因
// - doctor 输出包含 schtasks 注册命令模板（--host 替换到位）
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/warmup.test.mjs test/doctor.test.mjs`
预期：FAIL，`../src/commands/warmup.mjs` 不存在

- [ ] **步骤 3：实现**

- `runWarmup({ hostId, logger, env })`：复用 `resolveHolderSession` + `createHolderSupervisorAdapter`，轮询 `holder/status`（500ms 间隔，上限复用现有 `warm` 的 60 秒）直到 `backendReady`；TTL 语义下 warmup 自己的连接断开后 holder 才开始计空闲
- doctor：安装/检查通过时打印一行可复制的 `schtasks /create /tn "openwiki-warmup" /sc onlogon /tr "<node 绝对路径> <bin 绝对路径> warmup --host <hostId>"`（不执行）
- README：命令表加 `warmup`；环境变量表加 `LAUNCHER_HOLDER`、`LAUNCHER_HOLDER_TTL_MINUTES`；"工作方式"节补 holder 一段；命名管道本机可连的安全说明（规格 §7）

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/warmup.test.mjs test/doctor.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/commands/warmup.mjs src/cli.mjs src/commands/doctor.mjs test/warmup.test.mjs test/doctor.test.mjs README.md
git commit -m "feat: warmup 命令与 doctor 启动项提示（登录时预热 holder）"
```

---

### 任务 6：真实后端冒烟 + 收尾验证

**文件：**
- 修改：`test/real-openwiki.test.mjs` 或新建 `test/real-holder.test.mjs`（`LAUNCHER_REAL_SMOKE=1` 门控）

- [ ] **步骤 1：编写冒烟测试（门控，默认跳过）**

```js
// - 起 holder（真实 openwiki 后端）→ 等 holder/status backendReady
// - 模拟两个 wrapper 会话先后连接同一管道，各发一个真实 tools/call → 都成功
// - 第二个会话的首调耗时应远小于冷启动（不做硬断言，打印耗时供人工判定）
// - 会话 1 断开 → holder 存活（lockfile 仍在）；holder/shutdown → 全部退出且 lockfile 删除
```

- [ ] **步骤 2：实现冒烟**

- [ ] **步骤 3：验证**

运行：`LAUNCHER_REAL_SMOKE=1 npx vitest run test/real-holder.test.mjs`（需真实后端环境；在用户终端执行）

- [ ] **步骤 4：全量回归**

运行：`npx vitest run`
预期：PASS（含既有全部用例）

- [ ] **步骤 5：逐宿主验收（人工，规格 §8 门槛）**

对 CodeBuddy、Claude Code 等首批支持宿主：`LAUNCHER_HOLDER=1` 配置 MCP → 建会话 → 关宿主 → 检查 holder 进程与 lockfile 存活 → 重开宿主确认第二会话首调秒回。不成立的宿主在 `src/registry.mjs` 标注降级。

- [ ] **步骤 6：Commit**

```bash
git add test/real-holder.test.mjs
git commit -m "test: holder 真实后端冒烟（LAUNCHER_REAL_SMOKE 门控）"
```

---

## 自检记录

- 规格覆盖度：§5.1 进程模型（任务 3/4）、§5.2 lockfile（任务 1/4）、§5.3 wrapper 接入与回退（任务 4）、§5.4 多路复用（任务 2）、§5.5 TTL 与版本换血（任务 3/4）、§5.6 warmup 与 doctor（任务 5）、§8 验收（任务 6）——无遗漏
- 步骤扫描：协议四方法、管道名、lockfile 字段与路径、TTL 默认、回退阈值、文案复用均已钉死；函数体留给实现者
- 类型一致性：`createHolderCore`/`runHolder`/`resolveHolderSession`/`createHolderSupervisorAdapter`/`acquireLock` 跨任务引用一致
- 审查重点：5 条分别由任务 4（1/2/5）、任务 2（3/4）测试钉住
- 比例：计划约为规格 §5 的 1.2 倍长度，无函数体照抄
