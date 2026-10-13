# 排队策略（冷启动治理第一步）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `tools/call` 的排队行为从"静默等 120 秒"改成"25 秒可配上限 + 明确可重试文案 + progress 通知 + 宿主取消处理"。

**架构：** 全部改动集中在 broker（`src/broker.mjs`）与命令入口（`src/commands/mcp.mjs`）。排队上限从 mcp 命令读取环境变量传入 createBroker；progress 通知与取消处理是 broker 内部的请求级机制，不触碰 supervisor 与后端生命周期。

**技术栈：** Node ESM（零运行时依赖）、vitest。

**规格：** `docs/superpowers/specs/2026-10-13-cold-start-mitigation-design.md` §4（本计划实现其全部内容）

## 全局约束

- Node ≥ 22.22.0（`engines`），零运行时依赖
- stdout 只承载 MCP 线协议，任何诊断走 stderr（`src/log.mjs` 既有约定）
- 排队上限默认 **25000ms**，环境变量 `LAUNCHER_QUEUE_TIMEOUT_MS`，非法值回退默认
- 超时文案逐字：`openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试`
- progress 通知间隔 **2000ms**，`params: { progressToken, progress, message: "等待 openwiki 后端启动" }`，progress 从 1 递增
- progressToken 只认 `string | number`（MCP 规范），其余类型视为未提供
- 取消（`notifications/cancelled`）只终结该请求的等待，不产生应答、不中断预热、不重启后端
- 现有测试全部保持通过（`npx vitest run test/broker.test.mjs test/e2e-mcp.test.mjs`）

## 审查重点（Review Focus）

1. `_meta.progressToken` 缺失、为 `null` 或为对象时 → 不发 progress、不抛错（任务 3 测试钉住）
2. `notifications/cancelled` 的 requestId 不存在或请求已完成 → 静默忽略，不崩、不误伤其他请求（任务 4 测试钉住）
3. 取消后预热继续有效 → 后续同 hostId 调用正常拿到结果（任务 4 测试钉住）
4. `LAUNCHER_QUEUE_TIMEOUT_MS` 为 `"abc"`、`"0"`、`"-5"` → 回退 25000 并 warn 一次（任务 1 测试钉住）
5. 宿主断开（EOF）时 progress 定时器与取消映射必须清空，不留悬挂 timer（任务 3/4 测试钉住）

---

### 任务 1：排队上限可配（`LAUNCHER_QUEUE_TIMEOUT_MS`，默认 25000）

**文件：**
- 修改：`src/broker.mjs:1`（`DEFAULT_QUEUE_TIMEOUT_MS` 常量）
- 修改：`src/commands/mcp.mjs`（解析环境变量并传入 createBroker）
- 修改：`README.md`（环境变量表加一行）
- 测试：`test/broker.test.mjs`、`test/mcp-command.test.mjs`（新建，仅测解析函数）

- [ ] **步骤 1：编写失败的测试**

`test/broker.test.mjs` 中现有用例 `"gives up on a queued call after the queue timeout"` 已显式传 `queueTimeoutMs`，无需改。新建解析函数测试（`test/mcp-command.test.mjs`）：

```js
import { describe, expect, it } from "vitest";
import { queueTimeoutFromEnv } from "../src/commands/mcp.mjs";

describe("queueTimeoutFromEnv", () => {
  it("defaults to 25000 when the variable is absent", () => {
    expect(queueTimeoutFromEnv({})).toBe(25000);
  });
  it("parses a valid override", () => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: "40000" })).toBe(40000);
  });
  it.each(["abc", "0", "-5", ""])("falls back to 25000 for %s", (value) => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: value })).toBe(25000);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/mcp-command.test.mjs`
预期：FAIL，`queueTimeoutFromEnv` 不是导出成员

- [ ] **步骤 3：实现**

- `src/commands/mcp.mjs` 导出 `queueTimeoutFromEnv(env)`：读 `LAUNCHER_QUEUE_TIMEOUT_MS`，`Number.parseInt` 后须为 `Number.isInteger(v) && v > 0`，否则回退 `25000`；
- `runMcpCommand` 里 `createBroker({ ..., queueTimeoutMs: queueTimeoutFromEnv(env) })`；
- `src/broker.mjs` 的 `DEFAULT_QUEUE_TIMEOUT_MS` 改为 `25000`（保持参数默认语义一致）；
- `README.md` 环境变量表追加：`LAUNCHER_QUEUE_TIMEOUT_MS | tools/call 排队等待后端就绪的上限（毫秒，默认 25000）`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/mcp-command.test.mjs test/broker.test.mjs`
预期：全部 PASS（现有 broker 用例显式传参，不受默认值变化影响）

- [ ] **步骤 5：Commit**

```bash
git add src/broker.mjs src/commands/mcp.mjs test/mcp-command.test.mjs README.md
git commit -m "feat: tools/call 排队上限可配（LAUNCHER_QUEUE_TIMEOUT_MS，默认 25s）"
```

---

### 任务 2：排队超时返回明确可重试文案

**文件：**
- 修改：`src/broker.mjs`（`dispatch` 内 `QUEUE_TIMEOUT` 分支，约 145-147 行）
- 测试：`test/broker.test.mjs`

- [ ] **步骤 1：编写失败的测试**

修改现有用例 `"gives up on a queued call after the queue timeout"` 的断言：

```js
expect(byId(sent, 8).result.content[0].text).toBe(
  "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试",
);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/broker.test.mjs -t "queue timeout"`
预期：FAIL，实际文本是 `openwiki 后端排队超时，请重试`

- [ ] **步骤 3：实现**

`src/broker.mjs` 中 `sendToolError(entry.id, "openwiki 后端排队超时，请重试")` 替换为全局约束里的逐字文案。该分支其余逻辑（`withDeadline` 只 reject 排队侧、预热继续）不动。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/broker.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/broker.mjs test/broker.test.mjs
git commit -m "feat: 排队超时文案给出冷启动时长与明确的重试间隔"
```

---

### 任务 3：排队期间发送 progress 通知

**文件：**
- 修改：`src/broker.mjs`
- 测试：`test/broker.test.mjs`

- [ ] **步骤 1：编写失败的测试**

新增用例（用 `makeBrokerWithSupervisor` + 手动 resolve 的 supervisor，fake timers）：

```js
it("sends progress notifications while a call waits for the backend", async () => {
  vi.useFakeTimers();
  try {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const supervisor = {
      ensureReady: () => gate,
      current: () => null,
      onSessionExit() {},
      stop() {},
    };
    const { broker, sent } = makeBrokerWithSupervisor(supervisor, null, {
      progressIntervalMs: 1000,
    });

    broker.handleClientMessage({
      jsonrpc: "2.0", id: 30, method: "tools/call",
      params: { name: "openwiki_search", arguments: {}, _meta: { progressToken: "tok-1" } },
    });
    await vi.advanceTimersByTimeAsync(2000);

    const progress = sent.filter((m) => m.method === "notifications/progress");
    expect(progress).toHaveLength(2);
    expect(progress[0].params).toMatchObject({ progressToken: "tok-1", progress: 1, message: "等待 openwiki 后端启动" });
    expect(progress[1].params.progress).toBe(2);

    release({ ready: Promise.resolve({ protocolVersion: "2024-11-05", serverInfo: { name: "x" } }), request: async () => ({ isError: false, content: [] }), isRunning: () => true });
    await vi.advanceTimersByTimeAsync(100);
    expect(byId(sent, 30).result.isError).toBe(false);
    // 就绪后不再发 progress
    expect(sent.filter((m) => m.method === "notifications/progress")).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not send progress when the request has no usable progressToken", async () => {
  // supervisor pending + progressIntervalMs: 10，推进 50ms
  // params 无 _meta / _meta.progressToken 为 {} 两种形态
  // 断言：sent 里没有任何 notifications/progress
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/broker.test.mjs -t "progress"`
预期：FAIL，`notifications/progress` 数量为 0

- [ ] **步骤 3：实现**

`src/broker.mjs`：

- 新增参数 `progressIntervalMs = 2000`（与 `queueTimeoutMs` 并列）；
- `handleClientMessage` 的 `tools/call` 分支把 `message.params` 原样带入 entry（已如此）；
- `dispatch` 内新增局部帮助函数：当 `entry.params?._meta?.progressToken` 为 `string | number` 时，在等待 `ensureReady` 的 promise 上挂 `setInterval`（间隔 `progressIntervalMs`），每次发送
  `{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: <自增>, message: "等待 openwiki 后端启动" } }`；
  interval 句柄登记进既有 `timers` 集合（`handleClientEof` 已统一清理，无需新机制），promise settle（resolve 或 reject 任一路径）时清除；
- 转发给后端的 params 保持原样（含 `_meta`），上游忽略之；
- `initialize` / `tools/list` 快照路径不挂 progress（不排队）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/broker.test.mjs`
预期：PASS；并扩展现有 `"clears queued timers ... when the host disconnects"` 用例：先发一个带 progressToken 的调用再 EOF，断言 `vi.getTimerCount()` 归零（覆盖审查重点 5 的 progress 部分）

- [ ] **步骤 5：Commit**

```bash
git add src/broker.mjs test/broker.test.mjs
git commit -m "feat: 排队等待期间按宿主 progressToken 发送 progress 通知"
```

---

### 任务 4：处理 notifications/cancelled

**文件：**
- 修改：`src/broker.mjs`
- 测试：`test/broker.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
it("drops a queued call when the host cancels it without disturbing prewarm", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stop = vi.fn();
  const supervisor = {
    ensureReady: () => gate, current: () => null,
    onSessionExit() {}, stop,
  };
  const { broker, sent } = makeBrokerWithSupervisor(supervisor, null);

  toolCall(broker, 40);
  await Promise.resolve();
  broker.handleClientMessage({
    jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 40 },
  });

  // 取消不产生应答
  await new Promise((r) => setTimeout(r, 50));
  expect(byId(sent, 40)).toBeUndefined();
  // 取消不波及预热
  expect(stop).not.toHaveBeenCalled();

  // 预热仍在：解除 gate 后，后续调用正常完成
  release({ ready: Promise.resolve({ protocolVersion: "2024-11-05", serverInfo: { name: "x" } }), request: async () => ({ isError: false, content: [] }), isRunning: () => true });
  toolCall(broker, 41);
  await vi.waitFor(() => expect(byId(sent, 41)).toBeTruthy(), { timeout: 5000 });
  expect(byId(sent, 41).result.isError).toBe(false);
});

it("ignores cancellation for unknown or finished requests", async () => {
  // 发 notifications/cancelled { requestId: 999 } 与一个已完成调用的 id
  // 断言：不抛错、不产生任何应答、其他在途调用不受影响
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/broker.test.mjs -t "cancel"`
预期：FAIL——当前实现把 `notifications/cancelled` 当宿主通知转发/丢弃，id 40 的调用会在 gate resolve 后照常应答，`byId(sent, 40)` 不为 undefined

- [ ] **步骤 3：实现**

`src/broker.mjs`：

- `withCancellation(promise)` 扩展为 `withCancellation(id, promise)`：内部 Map `cancelById` 登记 `id → cancel`，settle 时自删；
- `handleClientMessage` 在"无 id 的通知"分支之前拦截 `message.method === "notifications/cancelled"`：取 `message.params?.requestId`，命中 `cancelById` 则以新原因 `HOST_CANCELLED = "host cancelled"` 调 cancel，未命中则 `logger.debug` 后返回；
- `dispatch` 的两处 catch（等待就绪、调用透传）识别 `HOST_CANCELLED`：**不发送任何应答**，只 `logger.debug("宿主已取消该调用")`；
- 取消路径不得调用 `supervisor.stop()`，也不得使 `starting`/预热 promise 进入失败状态（`withCancellation` 只 reject 排队侧，`ensureReady` 原样继续，与既有 `withDeadline` 语义一致）；
- `handleClientEof` 清空 `cancelById`（现有 inFlight 遍历已覆盖，补 Map.clear）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/broker.test.mjs test/e2e-mcp.test.mjs`
预期：PASS（e2e 确认取消机制未破坏真实进程路径）

- [ ] **步骤 5：Commit**

```bash
git add src/broker.mjs test/broker.test.mjs
git commit -m "feat: 处理 notifications/cancelled，取消仅终结请求不波及预热"
```

---

## 收尾验证

- [ ] `npx vitest run`（全量，注意本环境 vitest worker 可能超时，需在正常终端跑或用 `--pool=forks`）
- [ ] 手动冒烟：`LAUNCHER_DEBUG=1 node bin/openwiki-launcher.mjs mcp --host smoke`，发一个排队超时的调用确认新文案，再发带 `_meta.progressToken` 的调用确认 progress 出现在 stdout
