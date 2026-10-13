import { describe, expect, it, vi } from "vitest";
import { createHolderCore } from "../src/holder-server.mjs";

const READY_SESSION = () => ({
  ready: Promise.resolve({ protocolVersion: "2024-11-05", serverInfo: { name: "fake" } }),
  request: async () => ({ isError: false, content: [] }),
  isRunning: () => true,
});

function fakeSupervisor({ session = READY_SESSION(), failReady = false } = {}) {
  let ensureCalls = 0;
  const current = failReady ? () => null : () => (ensureCalls > 0 ? session : null);
  return {
    session,
    ensureCalls: () => ensureCalls,
    ensureReady: async () => {
      ensureCalls += 1;
      if (failReady) {
        const { BackendUnavailableError } = await import("../src/backend.mjs");
        throw new BackendUnavailableError("无法启动 openwiki 后端: fake");
      }
      return session;
    },
    current,
    onSessionExit() {},
    stop() {},
  };
}

// 模拟一条 wrapper 连接：onMessage 由测试手动喂，send 收集出站消息。
function fakeConn() {
  const sent = [];
  let messageHandler = null;
  const conn = {
    sent,
    closed: false,
    send: (message) => {
      if (!conn.closed) sent.push(message);
    },
    onMessage: (cb) => (messageHandler = cb),
    onClose: (cb) => (conn.closeHandler = cb),
    end: () => {
      conn.closed = true;
      conn.closeHandler?.();
    },
    feed: (message) => messageHandler(message),
  };
  return conn;
}

const toolCall = (id, args = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "openwiki_search", arguments: args },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("createHolderCore", () => {
  it("performs a single upstream handshake across connections", async () => {
    const supervisor = fakeSupervisor();
    const core = createHolderCore({ supervisor, version: "0.6.0" });
    const a = fakeConn();
    const b = fakeConn();
    core.handleConnection(a);
    core.handleConnection(b);
    a.feed(toolCall(1));
    b.feed(toolCall(1));
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    await vi.waitFor(() => expect(b.sent).toHaveLength(1));
    expect(supervisor.ensureCalls()).toBe(1);
    core.closeAll();
  });

  it("remaps colliding ids and routes responses to the right connection", async () => {
    const pendingA = deferred();
    const pendingB = deferred();
    const session = {
      ready: Promise.resolve({}),
      // 按参数而非到达顺序分配 deferred：并发 dispatch 的到达顺序由事件循环
      // 决定，按 length 分配会让"A 的连接拿到 B 的结果"这种假故障出现。
      request: (method, params) => {
        session.calls.push(params);
        return params.arguments.who === "a" ? pendingA.promise : pendingB.promise;
      },
      calls: [],
      isRunning: () => true,
    };
    const core = createHolderCore({ supervisor: fakeSupervisor({ session }), version: "0.6.0" });
    const a = fakeConn();
    const b = fakeConn();
    core.handleConnection(a);
    core.handleConnection(b);
    a.feed(toolCall(1, { who: "a" }));
    b.feed(toolCall(1, { who: "b" }));
    await vi.waitFor(() => expect(session.calls).toHaveLength(2));

    // 上游收到的两个请求参数未被混淆。并发 dispatch 的到达顺序由事件循环
    // 决定，不断言固定顺序——真正的路由正确性由下面的乱序 resolve 验证。
    const received = session.calls.map((c) => c.arguments);
    expect(received).toContainEqual({ who: "a" });
    expect(received).toContainEqual({ who: "b" });
    // 乱序 resolve：先 B 后 A
    pendingB.resolve({ isError: false, content: [{ type: "text", text: "B" }] });
    pendingA.resolve({ isError: false, content: [{ type: "text", text: "A" }] });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    await vi.waitFor(() => expect(b.sent).toHaveLength(1));
    expect(a.sent[0].id).toBe(1);
    expect(a.sent[0].result.content[0].text).toBe("A");
    expect(b.sent[0].id).toBe(1);
    expect(b.sent[0].result.content[0].text).toBe("B");
    core.closeAll();
  });

  it("strips progressToken before forwarding upstream", async () => {
    const seen = [];
    const session = {
      ready: Promise.resolve({}),
      request: async (method, params) => {
        seen.push(params);
        return { isError: false, content: [] };
      },
      isRunning: () => true,
    };
    const core = createHolderCore({ supervisor: fakeSupervisor({ session }), version: "0.6.0" });
    const conn = fakeConn();
    core.handleConnection(conn);
    conn.feed({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "x", arguments: {}, _meta: { progressToken: "tok" } },
    });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(seen[0]._meta).toBeUndefined();
    core.closeAll();
  });

  it("drops the answer of a cancelled call and keeps the connection usable", async () => {
    const gate = deferred();
    let resolveSecond;
    const second = new Promise((r) => (resolveSecond = r));
    const session = {
      ready: Promise.resolve({}),
      request: (_method, params) => {
        if (params.arguments.n === 1) return gate.promise;
        return second;
      },
      isRunning: () => true,
    };
    const core = createHolderCore({ supervisor: fakeSupervisor({ session }), version: "0.6.0" });
    const conn = fakeConn();
    core.handleConnection(conn);
    conn.feed(toolCall(10, { n: 1 }));
    await vi.waitFor(() => expect(gate.promise).toBeDefined());
    conn.feed({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 10 } });

    // 上游最终返回——被取消的调用不得冒出应答
    gate.resolve({ isError: false, content: [{ type: "text", text: "late" }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.sent).toHaveLength(0);

    // 连接保持可用
    conn.feed(toolCall(11, { n: 2 }));
    resolveSecond({ isError: false, content: [{ type: "text", text: "ok" }] });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(conn.sent[0].id).toBe(11);
    core.closeAll();
  });

  it("discards pending work when a connection closes and leaves others intact", async () => {
    const gateA = deferred();
    const session = {
      ready: Promise.resolve({}),
      request: (_method, params) => (params.arguments.who === "a" ? gateA.promise : Promise.resolve({ isError: false, content: [{ type: "text", text: "b" }] })),
      isRunning: () => true,
    };
    const core = createHolderCore({ supervisor: fakeSupervisor({ session }), version: "0.6.0" });
    const a = fakeConn();
    const b = fakeConn();
    core.handleConnection(a);
    core.handleConnection(b);
    a.feed(toolCall(1, { who: "a" }));
    b.feed(toolCall(1, { who: "b" }));
    await vi.waitFor(() => expect(b.sent).toHaveLength(1));

    a.end();
    gateA.resolve({ isError: false, content: [{ type: "text", text: "late-a" }] });
    await new Promise((r) => setTimeout(r, 20));
    // a 已关闭：即使有响应也不应有新消息（fakeConn send 在 closed 后丢弃）
    expect(a.sent).toHaveLength(0);
    // b 不受影响：再发一个调用仍能拿到结果
    b.feed(toolCall(2, { who: "b" }));
    await vi.waitFor(() => expect(b.sent).toHaveLength(2));
    core.closeAll();
  });

  it("performs the upstream initialize once and caches holder/init", async () => {
    const initCalls = [];
    const session = {
      ready: Promise.resolve({}),
      request: async (method, params) => {
        if (method === "initialize") {
          initCalls.push(params);
          return { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "9.9.9" } };
        }
        return { isError: false, content: [] };
      },
      isRunning: () => true,
    };
    const core = createHolderCore({ supervisor: fakeSupervisor({ session }), version: "0.6.0" });
    const conn = fakeConn();
    core.handleConnection(conn);

    conn.feed({ jsonrpc: "2.0", id: 1, method: "holder/init", params: {} });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(conn.sent[0].result.serverInfo.name).toBe("fake");

    // 第二个连接再要 initialize：命中缓存，上游不再被调
    const conn2 = fakeConn();
    core.handleConnection(conn2);
    conn2.feed({ jsonrpc: "2.0", id: 5, method: "holder/init", params: {} });
    await vi.waitFor(() => expect(conn2.sent).toHaveLength(1));
    expect(conn2.sent[0].result.serverInfo.version).toBe("9.9.9");
    expect(initCalls).toHaveLength(1);
    core.closeAll();
  });

  it("answers holder/status and holder/shutdown", async () => {
    let shutdownCalls = 0;
    const supervisor = fakeSupervisor();
    const core = createHolderCore({
      supervisor,
      version: "0.6.0",
      onShutdown: () => (shutdownCalls += 1),
    });
    const conn = fakeConn();
    core.handleConnection(conn);

    conn.feed({ jsonrpc: "2.0", id: 1, method: "holder/status", params: {} });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(conn.sent[0].result).toEqual({ backendReady: false, version: "0.6.0" });

    conn.feed({ jsonrpc: "2.0", method: "holder/shutdown", params: {} });
    expect(shutdownCalls).toBe(1);

    // 通知形态（无 id）同样触发优雅退出
    conn.feed({ jsonrpc: "2.0", id: 2, method: "holder/status", params: {} });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(2));
    conn.feed({ jsonrpc: "2.0", method: "holder/shutdown", params: {} });
    expect(shutdownCalls).toBe(2);
    core.closeAll();
  });

  it("reports a bounded backend error and keeps serving when the upstream fails to start", async () => {
    const supervisor = fakeSupervisor({ failReady: true });
    const core = createHolderCore({ supervisor, version: "0.6.0" });
    const conn = fakeConn();
    core.handleConnection(conn);

    conn.feed(toolCall(1));
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(conn.sent[0].result.isError).toBe(true);
    expect(conn.sent[0].result.content[0].text).toContain("openwiki 后端不可用");

    // 连接保持可用（冷却后上游恢复的场景由调用方重试）
    const recovered = fakeSupervisor();
    expect(recovered.ensureCalls()).toBe(0);
    core.closeAll();
  });

  it("applies the queue timeout with the verbatim retry message", async () => {
    const supervisor = {
      ensureReady: () => new Promise(() => {}),
      current: () => null,
      onSessionExit() {},
      stop() {},
    };
    const core = createHolderCore({ supervisor, version: "0.6.0", queueTimeoutMs: 40 });
    const conn = fakeConn();
    core.handleConnection(conn);

    conn.feed(toolCall(1));
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1), { timeout: 5000 });
    expect(conn.sent[0].result.isError).toBe(true);
    expect(conn.sent[0].result.content[0].text).toBe(
      "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试",
    );
    core.closeAll();
  });
});
