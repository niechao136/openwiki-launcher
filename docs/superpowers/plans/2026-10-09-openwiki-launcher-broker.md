# openwiki-launcher Broker 核心 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付一个毫秒级完成 MCP 握手的 stdio 代理进程，把 openwiki 官方 MCP 服务作为黑盒后端托管，让短超时宿主（如 CodeBuddy）不再报 `-32001: Request timed out`。

**架构：** 零构建 ESM 包，唯一运行时依赖 `openwiki@0.6.0`。broker 对宿主以内置 manifest（即答 serverInfo / instructions / 10 个工具 schema）秒回 `initialize` 与 `tools/list`；对后端则作为 MCP 客户端完成真实握手。`tools/call` 在后端未就绪时排队（120s 兜底），就绪后按 id 映射透传；无匹配 manifest 时降级为直通模式（排队等真实响应），绝不返回与后端不一致的清单。

**技术栈：** Node.js ≥22.22.0、纯 ESM（`.mjs`，零构建）、vitest、MCP stdio 传输（行分隔 JSON-RPC 2.0）

**规格：** `docs/specs/2026-10-09-openwiki-launcher-design.md`（本计划实现第 1.2、2、3、5、6、7、8 节；第 4 节宿主注册表与安装器属计划二）

---

## 全局约束

以下要求来自规格，每个任务的步骤都隐含包含这些约束，不再逐条重复：

- Node ≥22.22.0；`engines.node = ">=22.22.0"`，启动前检查并给可读报错
- 唯一运行时依赖 `openwiki` 精确锁版 `0.6.0`；禁止 peerDependencies / optionalDependencies
- 后端启动一律 `spawn(process.execPath, [<依赖解析出的绝对 cli.js 路径>, "mcp", "--host", hostId])`；**禁止裸调 `openwiki`**（Windows nvm `.exe` shim 不转发 stdio）
- stdout 只允许 JSON-RPC 协议消息；一切诊断走 stderr，前缀 `[launcher]`；`LAUNCHER_DEBUG=1` 开详细档
- 排队兜底超时固定 `120000ms`；spawn 失败重试恰好 1 次，退避 `1000ms`
- manifest 与后端不一致时以后端为准并 stderr 告警；无匹配 manifest 必须降级直通
- 包为纯 `.mjs` 零构建；`npm i github:<仓库所有者>/openwiki-launcher` 可直接运行
- 返回给宿主的错误只含 `isError: true` + 一句可读原因，不泄露堆栈
- CI 必跑 ubuntu + windows
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）

## 审查重点（Review Focus）

规格是愿景文档，以下五类输入/失败模式规格未穷举，但最可能伤到真实用户。每条都在下方对应任务里补了钉住它的测试：

1. **宿主发来的非 JSON / 半行 / 超大行**（>1MB 单行）→ 必须不崩溃、不吞掉后续合法消息（任务 1、5）
2. **后端 stdout 混入非 JSON 行**（崩溃时 Node 可能把内容写进 stdout）→ 忽略该行并 stderr 记录，绝不当作协议消息（任务 3）
3. **宿主在排队期间断开（stdin EOF）** → 队列与 120s 定时器必须清理，进程要能退出，不得因悬挂引用永不退出（任务 5）
4. **Windows spawn ENOENT**（node 路径或权限问题）→ 必须在 2 次尝试内失败并给可读错误，不得无限重试或静默挂起（任务 4）
5. **后端 spawn 成功但立即以非 0 退出**（如 openwiki 要求更高 node 版本）→ 识别为“早退”，与 spawn 失败同等处理，并把截断后的 stderr 尾部带给用户（任务 4）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 包元数据、bin、engines、精确锁版 openwiki、scripts |
| `vitest.config.mjs` | 测试配置（Node 环境、include `test/**/*.test.mjs`） |
| `bin/openwiki-launcher.mjs` | 可执行入口，仅转发到 `src/cli.mjs` 的 `main(process.argv.slice(2))` |
| `src/cli.mjs` | 参数解析与命令分发（mcp / warm / doctor / 其余报用法） |
| `src/jsonrpc.mjs` | 行分隔 JSON-RPC：增量解析器 `createLineParser(onMessage)`、`formatMessage(obj)` |
| `src/log.mjs` | stderr 日志器 `createLogger({ debug })`，统一 `[launcher]` 前缀 |
| `src/paths.mjs` | `resolveOpenwikiRuntime()` → `{ packageRoot, version, cliJs }` |
| `src/manifest.mjs` | `loadManifest(version)` → manifest \| null（缺失即降级） |
| `src/backend.mjs` | `createBackendSession()`（单进程握手/请求/通知/退出）、`createBackendSupervisor()`（spawn/重试/重启） |
| `src/broker.mjs` | MCP 语义：manifest 即答、排队、直通降级、id 映射、错误映射 |
| `src/commands/mcp.mjs` | broker 进程：绑定 stdin/stdout，EOF 时清理 |
| `src/commands/warm.mjs` | 拉起后端至就绪后退出 |
| `src/commands/doctor.mjs` | 环境体检 + manifest 与真实后端差异报告 |
| `scripts/gen-manifest.mjs` | 对真实后端做握手，生成 `manifest/openwiki-<version>.json` |
| `manifest/openwiki-0.6.0.json` | 已提交的响应快照（一致性哨兵，任务 2 产出） |
| `test/fixtures/fake-openwiki.mjs` | 可控假后端（启动延迟 / 定时崩溃 / 自定义 serverInfo） |
| `test/*.test.mjs` | 单元与集成测试 |

---

### 任务 1：包骨架、行协议与日志

**文件：**
- 创建：`package.json`、`vitest.config.mjs`、`.gitignore`
- 创建：`src/jsonrpc.mjs`、`src/log.mjs`
- 测试：`test/jsonrpc.test.mjs`、`test/log.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/jsonrpc.test.mjs` 断言（`createLineParser(onMessage)` 的 `onMessage` 收到已解析对象；无法解析的行收到 `{ invalid: 原始字符串 }`）：

```js
const p = createLineParser(onMessage);
p.write('{"jsonrpc":"2.0","id":1');
p.write(',"result":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
// 期望：onMessage 先收到 { jsonrpc:"2.0", id:1, result:{} }，再收到 { method:"notifications/initialized" }
```

同文件另三例：单 chunk 含两条完整消息 → 收到两个对象；单行 2MB JSON → 正常解析（不截断、不 OOM）；`p.write("not json\n")` → 收到 `{ invalid: "not json" }` 且后续合法消息仍能解析（审查重点 1）。

`formatMessage({ a: 1 })` 断言返回字符串 `"{\"a\":1}\n"`（末尾换行，单行可解析）。

`test/log.test.mjs`：注入 `sink` 数组，`createLogger({ debug: false, sink })` 的 `info("x")` 产出 `[launcher] x\n`；`debug("y")` 在 `debug: false` 时不产出，`debug: true` 时产出 `[launcher] debug: y\n`；`error("z")` 始终产出。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm install`（首次约 2 分钟，openwiki 依赖较大；Windows 若被 Defender 拖慢属正常，后续任务会再次用到缓存）
运行：`npx vitest run test/jsonrpc.test.mjs test/log.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/jsonrpc.mjs`

- [ ] **步骤 3：实现 `src/jsonrpc.mjs`**

```js
export function createLineParser(onMessage) → { write(chunk: string): void, end(): void }
// 行分隔协议：以 "\n" 切分；保留不完整尾行到下次 write；
// 空行忽略；JSON.parse 失败 → onMessage({ invalid: line })
export function formatMessage(message) → string  // JSON.stringify + "\n"
```

`src/log.mjs`：

```js
export function createLogger({ debug = false, sink = process.stderr } = {})
  → { info(msg: string): void, debug(msg: string): void, error(msg: string): void }
```

- [ ] **步骤 4：`package.json` 与配置**

```json
{
  "name": "openwiki-launcher",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "bin": { "openwiki-launcher": "./bin/openwiki-launcher.mjs" },
  "engines": { "node": ">=22.22.0" },
  "files": ["bin", "src", "manifest", "scripts"],
  "scripts": { "test": "vitest run", "manifest": "node scripts/gen-manifest.mjs" },
  "dependencies": { "openwiki": "0.6.0" },
  "devDependencies": { "vitest": "^4.1.11" }
}
```

`vitest.config.mjs`：`test: { include: ["test/**/*.test.mjs"], testTimeout: 20000 }`
`.gitignore`：`node_modules/`、`*.log`

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run test/jsonrpc.test.mjs test/log.test.mjs`
预期：PASS，2 个测试文件全部通过

- [ ] **步骤 6：Commit**

```bash
git add package.json vitest.config.mjs .gitignore src/jsonrpc.mjs src/log.mjs test/jsonrpc.test.mjs test/log.test.mjs
git commit -m "feat: scaffold package with JSON-RPC line protocol and stderr logger"
```

---

### 任务 2：依赖解析与 manifest 生成

**文件：**
- 创建：`src/paths.mjs`、`src/manifest.mjs`、`scripts/gen-manifest.mjs`
- 创建（生成物入库）：`manifest/openwiki-0.6.0.json`
- 测试：`test/paths.test.mjs`、`test/manifest.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/paths.test.mjs`：

```js
const rt = await resolveOpenwikiRuntime();
expect(rt.version).toBe("0.6.0");
expect(existsSync(rt.cliJs)).toBe(true);
expect(rt.cliJs.endsWith(path.join("openwiki", "dist", "cli", "cli.js"))).toBe(true);
```

`test/manifest.test.mjs`：

```js
expect(loadManifest("0.0.0")).toBeNull();                 // 缺失版本 → 降级
const m = loadManifest("0.6.0");
expect(m.openwikiVersion).toBe("0.6.0");
expect(m.serverInfo.name).toBe("openwiki");
expect(m.tools.map(t => t.name)).toEqual([
  "openwiki_list_workspaces", "openwiki_list_wikis", "openwiki_search", "openwiki_read",
  "openwiki_begin", "openwiki_submit_plan", "openwiki_next_page",
  "openwiki_inspect_page_claims", "openwiki_submit_page", "openwiki_finish",
]);
expect(typeof m.instructions).toBe("string");
expect(m.tools.every(t => t.inputSchema && t.description)).toBe(true);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/paths.test.mjs test/manifest.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/paths.mjs`

- [ ] **步骤 3：实现 `src/paths.mjs` 与 `src/manifest.mjs`**

```js
// src/paths.mjs
export async function resolveOpenwikiRuntime()
  → Promise<{ packageRoot: string, version: string, cliJs: string }>
// 实现要点：用 import.meta.resolve("openwiki/package.json") 与
// import.meta.resolve("openwiki/dist/cli/cli.js")；前者 fs.readFileSync 取 version。
// 解析失败抛 OpenwikiNotFoundError（message 含尝试过的 specifier）。

// src/manifest.mjs
export function loadManifest(version: string)
  → manifest | null   // 读 manifest/<version>.json；ENOENT 返回 null；JSON 解析失败抛错
export function manifestFilePath(version: string) → string
```

- [ ] **步骤 4：实现 `scripts/gen-manifest.mjs` 并生成快照**

脚本行为：解析 `cliJs` → `spawn(process.execPath, [cliJs, "mcp", "--host", "manifest"])` → 向其 stdin 写 `initialize` 与 `notifications/initialized`、`tools/list` → 收集两条响应 → 组装

```json
{ "openwikiVersion": "0.6.0", "protocolVersion": "<initialize 响应的 protocolVersion>",
  "serverInfo": { "name": "openwiki", "version": "0.6.0" },
  "instructions": "<initialize 响应的 instructions 原文>",
  "tools": [{ "name": "...", "description": "...", "inputSchema": { } }] }
```

以 2 空格缩进 + 末尾换行写入 `manifest/openwiki-0.6.0.json`；30s 内未收到 `tools/list` 则非零退出并打印 stderr。

运行：`node scripts/gen-manifest.mjs`（真实后端冷启动，本机可能 30-50s，属预期）
预期：输出 `wrote manifest/openwiki-0.6.0.json (10 tools)`

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run test/paths.test.mjs test/manifest.test.mjs`
预期：PASS

- [ ] **步骤 6：加一条升级一致性守卫测试**

在 `test/manifest.test.mjs` 追加：调用 `scripts/gen-manifest.mjs` 导出的 `generateManifest()`，断言其返回对象与 `loadManifest("0.6.0")` 深度相等（上游 openwiki 改版导致差异时，本测试失败即提示需要重新生成快照）。

- [ ] **步骤 7：Commit**

```bash
git add src/paths.mjs src/manifest.mjs scripts/gen-manifest.mjs manifest/openwiki-0.6.0.json test/paths.test.mjs test/manifest.test.mjs
git commit -m "feat: resolve openwiki runtime and generate versioned manifest snapshot"
```

---

### 任务 3：后端会话（单个子进程的完整 MCP 客户端）

**文件：**
- 创建：`test/fixtures/fake-openwiki.mjs`
- 创建：`src/backend.mjs`（本任务只含 `createBackendSession`，`createBackendSupervisor` 留到任务 4）
- 测试：`test/backend-session.test.mjs`

- [ ] **步骤 1：写假后端夹具**

`test/fixtures/fake-openwiki.mjs`：读环境变量 `FAKE_STARTUP_DELAY_MS`（默认 0，attach 前延迟以模拟慢 import）、`FAKE_SERVER_NAME`（默认 `fake-openwiki`）、`FAKE_EXIT_AFTER_MS`（就绪后定时退出）、`FAKE_EXIT_CODE`（默认 0）、`FAKE_STDOUT_NOISE`（非空时在每条协议响应前插入一行非 JSON 文本）。行为：`initialize` → 回 `{ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: $FAKE_SERVER_NAME, version: "9.9.9" }, instructions: "fake instructions" }`；`tools/list` → 两个工具 `echo_a` / `echo_b`；`tools/call`（name 含 `echo`）→ 回 `{ echoed: params.arguments }`；收到 `notifications/*` → 不响应。

- [ ] **步骤 2：写失败的测试**

`test/backend-session.test.mjs`，用 `spawnFn` 注入 `spawn`（可传 `env` 控制假后端），断言：

```js
const s = createBackendSession({ cliJs: fakePath, hostId: "test", logger, env: { FAKE_SERVER_NAME: "fake-openwiki" } });
await expect(s.ready).resolves.toMatchObject({ serverInfo: { name: "fake-openwiki" } });
```

同文件另五例：
1. `request("tools/call", { name: "echo", arguments: { v: 1 } })` → `{ echoed: { v: 1 } }`
2. 并发三个 `request`（不同参数）各自拿到与参数匹配的结果，id 不串
3. `FAKE_STDOUT_NOISE="garbage"` → `ready` 仍成功，且 `logger.debug` 收到含 `忽略非 JSON` 的记录（审查重点 2）
4. `FAKE_EXIT_AFTER_MS=150` → `exited` resolve 且 `code === 0`；此后 `request()` reject，message 含 `backend exited`
5. `stop()` 后 `exited` resolve（`signal` 非 null 或 `code` 非 0）

- [ ] **步骤 3：运行测试验证失败**

运行：`npx vitest run test/backend-session.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/backend.mjs`

- [ ] **步骤 4：实现 `createBackendSession`**

```js
// src/backend.mjs
export function createBackendSession({
  spawnFn = spawn, cliJs, hostId, logger, env = {}, callReadyTimeoutMs = 120000,
})
// → { ready: Promise<{serverInfo, protocolVersion, instructions}>,
//     exited: Promise<{code, signal, stderrTail}>,
//     request(method: string, params: unknown): Promise<unknown>,
//     notify(method: string, params: unknown): void,
//     stop(): void }
```

实现要点（规格 2 的 spawn 硬约束在此落地）：
- 启动命令固定 `spawnFn(process.execPath, [cliJs, "mcp", "--host", hostId], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })`；
- 用任务 1 的 `createLineParser` + `formatMessage` 处理协议；内部 id 自增，pending 请求以 `Map<id, {resolve, reject}>` 结算；无匹配 id 的响应 `logger.debug` 后忽略；
- 非 JSON 行：`logger.debug(\`忽略非 JSON 输出行: ${line.slice(0, 200)}\`)` 后忽略（审查重点 2）；
- stderr 持续收集，仅保留尾部 8KB 存入 `stderrTail`，并写入 `logger.debug`；
- `ready` = 自身发出 `initialize` 并收到响应后 resolve；随后自动发 `notifications/initialized`；
- 会话结束（`exited` resolve）时 reject 所有未结算请求，错误 message 固定包含 `backend exited`；
- `stop()` 先 SIGTERM，3s 后仍未退出则 SIGKILL；`callReadyTimeoutMs` 超时则 reject `backend ready timeout`。

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run test/backend-session.test.mjs`
预期：PASS，6 个用例通过

- [ ] **步骤 6：Commit**

```bash
git add src/backend.mjs test/backend-session.test.mjs test/fixtures/fake-openwiki.mjs
git commit -m "feat: add backend session with MCP client handshake and id mapping"
```

---

### 任务 4：后端监管（spawn 重试、崩溃重启）

**文件：**
- 修改：`src/backend.mjs`（追加 `createBackendSupervisor`，不改已有导出）
- 测试：`test/backend-supervisor.test.mjs`

- [ ] **步骤 1：写失败的测试**

```js
export class BackendUnavailableError extends Error {
  constructor(message, { stderrTail = "" } = {})   // message 固定含 "无法启动 openwiki 后端"
}
```

`test/backend-supervisor.test.mjs` 断言（`createSupervisor({ spawnFn, cliJs, hostId, logger, env, sleep })`，`sleep` 可注入以避免真实等待）：

1. `cliJs` 指向不存在路径 → `ensureReady()` reject `BackendUnavailableError`，且 `spawnFn` 调用次数 `=== 2`（审查重点 4：恰好两次尝试，不无限重试）
2. 上例中 `sleep` 被调用一次且入参为 `[1000]`（退避常量）
3. `FAKE_STARTUP_DELAY_MS=300` 的假后端 → `ensureReady()` resolve，`spawnFn` 调用次数 `=== 1`
4. 假后端就绪后崩溃（`FAKE_EXIT_AFTER_MS=150`）→ `onSessionExit` 回调被调用一次；随后 `ensureReady()` resolve 且 `spawnFn` 调用次数 `=== 2`（新会话）
5. 并发 `ensureReady()` ×3 → `spawnFn` 调用次数 `=== 1`，三者返回同一 session 对象
6. 后端立即以 `FAKE_EXIT_CODE=1` 退出 → `ensureReady()` reject，且 `error.stderrTail` 含假后端写出到 stderr 的片段（审查重点 5：早退识别 + 诊断信息）

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/backend-supervisor.test.mjs`
预期：FAIL，报错 `createBackendSupervisor is not a function`

- [ ] **步骤 3：实现 `createBackendSupervisor`**

```js
export function createBackendSupervisor({
  spawnFn = spawn, cliJs, hostId, logger, env = {},
  retryDelayMs = 1000, maxSpawnAttempts = 2, sleep = defaultSleep,
})
// → { ensureReady(): Promise<Session>, current(): Session | null,
//      onSessionExit(listener: (info: {code, signal, stderrTail}) => void): void,
//      stop(): void }
```

实现要点：
- `ensureReady` 幂等：已有就绪 session 直接返回；并发调用共享同一个启动 promise；
- 启动失败计数：spawn 抛错（ENOENT 等）或 session 在 ready 前退出，均计一次失败，退避 `retryDelayMs` 后重试，累计 `maxSpawnAttempts` 次后抛 `BackendUnavailableError`（message 含 cliJs，`stderrTail` 取自早退 session）；
- ready 之后的退出不算失败：置空 current、通知 `onSessionExit` 监听器；
- `stop()` 停止当前 session 并置空。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/backend-supervisor.test.mjs`
预期：PASS，6 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/backend.mjs test/backend-supervisor.test.mjs
git commit -m "feat: add backend supervisor with bounded spawn retry and crash restart"
```

---

### 任务 5：broker 状态机（MCP 语义与排队）

**文件：**
- 创建：`src/broker.mjs`
- 测试：`test/broker.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/broker.test.mjs` 用真实 `createBackendSupervisor` + 假后端（`env` 控制），注入 `send` 收集输出：

1. **manifest 即答**：`createBroker({ manifest: loadManifest("0.6.0"), supervisor, logger, send })` 处理 `initialize` 后，`send` 立即收到响应，`serverInfo.name === "openwiki"`，`result.tools` 不在 initialize 里；断言整个用例耗时 `< 200ms` 且 `spawnFn` 调用次数 `=== 0`（不因握手拉起后端）
2. `tools/list` 在后端未就绪时返回 manifest 的 10 个工具
3. `tools/call` 在 COLD 时排队：`FAKE_STARTUP_DELAY_MS=300` 下先发 `tools/call`，断言 300ms 内无响应、后端就绪后收到响应，且响应 `id` 等于客户端原始 id（id 映射）
4. **直通降级**：`manifest: null` 时 `initialize` 的响应 `serverInfo.name === "fake-openwiki"`（来自真实后端而非内置快照）
5. **清单不一致**：manifest 的 `tools` 数组改名一个，后端就绪后请求 `tools/list` → 返回真实清单（`echo_a`/`echo_b`）且 `logger.warn` 收到含 `清单不一致` 的记录；未就绪时仍返回 manifest 清单（即答优先）
6. 未知方法 → 响应 JSON-RPC error，code `-32601`
7. 在途调用遇后端崩溃：假后端 `FAKE_EXIT_AFTER_MS` 触发后，客户端先前发出的 `tools/call` 收到 `isError: true` 且文本含 `openwiki 后端已重启`；之后新的 `tools/call` 正常成功
8. 排队超时：`queueTimeoutMs: 50` + 慢后端 → 收到 `isError: true` 且文本含 `超时`
9. **EOF 清理**（审查重点 3）：先发一个 `tools/call`（后端未就绪），随即 `handleClientEof()` → 断言 `supervisor` 已 stop（注入的 fake spawn 返回的子进程被杀）且进程内无挂起定时器（用 vitest `vi.useFakeTimers()` 断言 `vi.getTimerCount() === 0`）
10. **脏消息容错**（审查重点 1）：`handleClientMessage({ invalid: "garbage" })` 不抛异常；随后一条合法 `tools/list` 仍能正常响应
11. **重试耗尽后快速失败**：注入的 supervisor 让 `ensureReady()` reject `BackendUnavailableError` → 第一个 `tools/call` 收到 `isError: true`；此后再次 `tools/call` **立即**收到同样的 `isError`，且 `ensureReady` 总调用次数为 2（不因新调用无限重试）

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/broker.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/broker.mjs`

- [ ] **步骤 3：实现 `createBroker`**

```js
// src/broker.mjs
export function createBroker({ manifest, supervisor, logger, send, queueTimeoutMs = 120000 })
// → { handleClientMessage(message: object): void, handleClientEof(): void }
```

实现要点（规格 3.1 / 3.2 的直接落地）：
- `initialize`：有 manifest → 立即 `send({ jsonrpc: "2.0", id, result: { protocolVersion: manifest.protocolVersion, capabilities: { tools: {} }, serverInfo: manifest.serverInfo, instructions: manifest.instructions } })`；无 manifest → 排队 `supervisor.ensureReady()`，用 `ready` 解析值组装同结构响应（直通）；
- `tools/list`：后端未就绪且有 manifest → 返回 `manifest.tools`；后端就绪 → 返回真实清单，且若与 manifest 不一致则 `logger.warn('后端工具清单与 manifest 不一致，以后端为准')`；
- `tools/call`：入队（每条一个 promise + `queueTimeoutMs` 定时器）→ 就绪后 `session.request("tools/call", params)` → 响应 id 映射回客户端 id → `send`；超时 → `send({ isError: true, content: [{ type: "text", text: "openwiki 后端排队超时，请重试" }] })` 形态的错误结果；
- 宿主通知（无 `id` 且有 `method`）：就绪后 `session.notify` 转发，不排队等响应；`{ invalid: ... }` 消息 `logger.debug` 后忽略；
- 未知方法 → `send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })`；
- `supervisor.onSessionExit`：把所有在途 `tools/call` 标记为 `isError: true`、文本 `openwiki 后端已重启，请重试`，清空在途表；
- `handleClientEof`：reject/清空全部队列 promise、`clearTimeout` 所有定时器、`supervisor.stop()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/broker.test.mjs`
预期：PASS，10 个用例通过

- [ ] **步骤 5：跑全量测试确认无回归**

运行：`npm test`
预期：全部通过（含任务 1-4 的用例）

- [ ] **步骤 6：Commit**

```bash
git add src/broker.mjs test/broker.test.mjs
git commit -m "feat: add broker state machine with manifest answers and call queueing"
```

---

### 任务 6：CLI 接线与端到端验证

**文件：**
- 创建：`bin/openwiki-launcher.mjs`、`src/cli.mjs`、`src/commands/mcp.mjs`
- 测试：`test/cli.test.mjs`、`test/e2e-mcp.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/cli.test.mjs`（直接调用 `main(argv)`，注入 logger sink 与可覆盖的 node 版本）：

| 输入 | 期望返回码 | 期望输出包含 |
|---|---|---|
| `["mcp", "--host", "codebuddy"]`，`LAUNCHER_BACKEND_CLI` 指向假后端，stdin 立即 end | 0 | — |
| `["mcp", "--host", "Bad_Host"]` | 1 | `1-64 lowercase letters, digits, or hyphens` |
| `["warm"]` 配假后端 | 0 | `后端就绪` |
| `["doctor"]` 依赖解析失败 | 1 | `openwiki` |
| `["install", "--tool", "codebuddy"]` | 1 | `0.2.0` |
| `["frobnicate"]` | 1 | `用法` |
| `["help"]` | 0 | `mcp` |
| node 版本注入为 `20.0.0`，执行 `["warm"]` | 1 | `22.22.0` |

`test/e2e-mcp.test.mjs`：以子进程方式运行 `node bin/openwiki-launcher.mjs mcp --host codebuddy`，env 传 `LAUNCHER_BACKEND_CLI=<test/fixtures/fake-openwiki.mjs>` 与 `FAKE_STARTUP_DELAY_MS=800`，按行读写 JSON-RPC，断言：

1. `initialize` 响应耗时 `< 1000ms`，且 `result.serverInfo.name === "openwiki"`（manifest 即答，未等假后端的 800ms）
2. `tools/list` 返回 10 个工具，name 以 `openwiki_` 开头
3. 随后一次 `tools/call`（`openwiki_search`）最终返回成功结果（假后端对未知工具名按 `echo` 规则回显，证明请求已透传到后端）
4. 结束 stdin（EOF）后，假后端进程在 3s 内退出（无孤儿进程）

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/cli.test.mjs test/e2e-mcp.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/cli.mjs`（或 ENOENT 启动失败）

- [ ] **步骤 3：实现 CLI 入口与分发**

```js
// src/cli.mjs
export async function main(argv: string[]): Promise<number>
// 命令：mcp [--host <id>] | warm | doctor | help | version
// install / uninstall 在计划二交付；此阶段命中时打印 "该命令将在 openwiki-launcher 0.2.0 提供" 并返回 1
// host 校验：/^[a-z0-9-]{1,64}$/，不合法返回 1 并给出可用格式说明
// 启动前置：process.versions.node 语义版本 < 22.22.0 → 打印可读报错并返回 1
// 未知命令 → 打印用法并返回 1
```

```js
// src/commands/mcp.mjs
export async function runMcpCommand({ hostId, logger, backendCliOverride })
// 1. resolveOpenwikiRuntime()；失败 → 打印诊断（含尝试过的 specifier）返回 1
// 2. backendCli = backendCliOverride ?? runtime.cliJs（LAUNCHER_BACKEND_CLI 为测试/内部 seam，须在 README 的 Troubleshooting 标注）
// 3. manifest = loadManifest(runtime.version)（null 即直通模式，logger.warn 一次）
// 4. send = (m) => process.stdout.write(formatMessage(m))
// 5. createBroker({ manifest, supervisor, logger, send })
// 6. process.stdin 以 createLineParser 接入 handleClientMessage；stdin 'end' → handleClientEof() → supervisor.stop()
// 7. 保持进程存活直到 stdin 结束
```

`bin/openwiki-launcher.mjs`：shebang + `process.exitCode = await main(process.argv.slice(2))`

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/cli.test.mjs test/e2e-mcp.test.mjs`
预期：PASS，cli 8 例 + e2e 4 例通过（总耗时约 2s）

- [ ] **步骤 5：Commit**

```bash
git add bin/openwiki-launcher.mjs src/cli.mjs src/commands/mcp.mjs test/cli.test.mjs test/e2e-mcp.test.mjs
git commit -m "feat: wire broker CLI and cover it with an end-to-end stdio test"
```

---

### 任务 7：warm 与 doctor 命令

**文件：**
- 创建：`src/commands/warm.mjs`、`src/commands/doctor.mjs`
- 修改：`src/cli.mjs`（把两个命令接到实现）
- 测试：`test/warm.test.mjs`、`test/doctor.test.mjs`

- [ ] **步骤 1：写失败的测试**

`test/warm.test.mjs`（注入 `resolveRuntime` 与 `createSupervisor` 工厂）：
1. 后端就绪 → 返回 0，且输出含 `后端就绪` 与耗时毫秒数
2. `BackendUnavailableError` → 返回 1，输出含 stderr 片段

`test/doctor.test.mjs`（同注入方式）四类断言：
3. 全部正常 → 返回 0，输出四行 `✓`：node 版本、openwiki 版本与 cliJs 路径、manifest 命中、真实握手成功
4. 无匹配 manifest → 仍返回 0，输出含 `manifest: 未找到 openwiki-9.9.9.json` 与 `建议：npm run manifest`
5. 清单差异：真实 `tools/list` 为 `["echo_a","echo_b"]`，manifest 为 `["a","b"]` → 输出含 `+ echo_b`、`- b` 形式的差异行，并提示 `需要更新 manifest`
6. openwiki 解析失败 → 返回 1，输出含 `openwiki` 与 `未找到`

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/warm.test.mjs test/doctor.test.mjs`
预期：FAIL，报错 `Cannot find module .../src/commands/warm.mjs`

- [ ] **步骤 3：实现两个命令**

```js
// src/commands/warm.mjs
export async function runWarmCommand({ logger, resolveRuntime = resolveOpenwikiRuntime, createSupervisor = createBackendSupervisor })
// ensureReady() 成功 → logger.info(`openwiki 后端就绪（${elapsedMs}ms）`) → stop() → 0
// BackendUnavailableError → logger.error(`预热失败：${error.message}${error.stderrTail}`) → 1

// src/commands/doctor.mjs
export async function runDoctorCommand({ logger, resolveRuntime = resolveOpenwikiRuntime, createSupervisor = createBackendSupervisor })
// 依次检查并输出：① node ≥22.22.0 ② openwiki 版本与 cliJs ③ manifest 命中
// ④ 真实握手 + tools/list 与 manifest 差异（逐项列出 + / -）
// 全部通过 → 0；解析失败或依赖缺失 → 1；manifest 缺失或差异 → 仍 0 但输出明确建议
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/warm.test.mjs test/doctor.test.mjs`
预期：PASS，6 个用例通过

- [ ] **步骤 5：Commit**

```bash
git add src/commands/warm.mjs src/commands/doctor.mjs src/cli.mjs test/warm.test.mjs test/doctor.test.mjs
git commit -m "feat: add warm and doctor commands for preheating and version auditing"
```

---

### 任务 8：真实后端冒烟与发布形态

**文件：**
- 创建：`test/real-openwiki.test.mjs`、`README.md`、`LICENSE`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`
- 修改：`package.json`（补 repository / keywords / homepage / bugs）

- [ ] **步骤 1：写冒烟测试**

`test/real-openwiki.test.mjs` 用 `describe.skipIf(!process.env.LAUNCHER_REAL_SMOKE)` 包裹（默认跳过，CI 中设置该变量）：

```js
// 子进程运行 bin 的 mcp 命令（不注入 LAUNCHER_BACKEND_CLI，用真实 openwiki）
// 断言：initialize 响应耗时 < 1000ms；tools/list 返回 10 个以 openwiki_ 开头的工具名
// 不调用检索类工具（openwiki_search 在部分机器上需 7-9s，属上游已知开销，不作为本包验收项）
```

- [ ] **步骤 2：本地跑一次真实冒烟**

运行：`$env:LAUNCHER_REAL_SMOKE=1; npx vitest run test/real-openwiki.test.mjs`
预期：PASS（initialize 秒回；后端在后台完成 5-7s 的冷/热导入，测试不等待它）

- [ ] **步骤 3：发布元数据与文档**

`package.json` 追加：`repository`、`homepage`、`bugs`、`keywords`（含 `openwiki`、`mcp`、`mcp-proxy`、`codebuddy`、`claude-code`、`cursor`）、`devEngines` 不需要。

`README.md` 必须含：① 一句定位说明（毫秒级握手的 openwiki MCP 代理）；② 快速开始（`npm i -g openwiki-launcher` → CodeBuddy 的 MCP 配置 JSON 片段，含 `command`/`args`/`type` 字段，args 指向 launcher 的 `mcp --host codebuddy`）；③ 命令表（mcp/warm/doctor）；④ 故障排查（`-32001` 超时 → 先跑 `warm`；Windows 建议 Defender 排除 openwiki 依赖目录；`LAUNCHER_BACKEND_CLI` 标注为测试 seam）；⑤ 明确说明 skill 自动安装属计划二。

`LICENSE`：MIT。

`.github/workflows/ci.yml`：矩阵 `ubuntu-latest` + `windows-latest`，node `22.22.0`，步骤 `npm ci` → `npm test` → `npm run test:smoke`（`LAUNCHER_REAL_SMOKE=1 npx vitest run test/real-openwiki.test.mjs`，Windows 步骤设 `continue-on-error: true` 并在 job summary 说明理由：真实后端导入耗时随 Defender 波动，仅作信号不作门禁）。
`.github/workflows/release.yml`：触发 `on: push tags: v*` → `npm ci` → `npm test` → `npm publish --provenance --access public`（`NODE_AUTH_TOKEN` 取自 secrets）。

- [ ] **步骤 4：写发布产物测试**

在 `test/release.test.mjs` 中执行 `npm pack --dry-run --json`，断言打包文件列表包含 `bin/openwiki-launcher.mjs`、`src/broker.mjs`、`manifest/openwiki-0.6.0.json`、`scripts/gen-manifest.mjs`，且不包含 `test/`、`node_modules/`。

- [ ] **步骤 5：运行全量验证**

运行：`npm test && npm run test:smoke`
预期：全部通过；`npm pack --dry-run` 产物清单符合断言

- [ ] **步骤 6：Commit**

```bash
git add package.json README.md LICENSE .github/workflows/ci.yml .github/workflows/release.yml test/real-openwiki.test.mjs test/release.test.mjs
git commit -m "chore: add release metadata, CI workflows, real-backend smoke test and docs"
```

---

## 计划边界与后续

- 本计划不含宿主注册表与 `install` / `uninstall`（规格第 4 节），属**计划二**；本计划交付后用户可手动配置 MCP 直接使用。
- 任务 1-8 全部完成后，`openwiki-launcher mcp` 即为可发布产物；计划二在此基础上追加安装自动化，不修改 broker 内部结构。
- 已知不在本计划验收范围：后端空闲回收（规格 v2）、`--backend=launcher` 覆写已注册宿主（规格 v2）、`openwiki_search` 检索延迟（上游 issue 线索）。
