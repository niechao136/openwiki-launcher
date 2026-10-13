import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendUnavailableError, createBackendSupervisor } from "../src/backend.mjs";
import { createBroker } from "../src/broker.mjs";
import { loadManifest } from "../src/manifest.mjs";

const FAKE_BACKEND = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-openwiki.mjs",
);

function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(message) {
        lines.push(`warn: ${message}`);
      },
    },
  };
}

const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeBroker({ manifest = loadManifest("0.6.0"), env = {}, queueTimeoutMs, callDeadlineMs, spawnFn } = {}) {
  const { logger, lines } = captureLogger();
  const supervisor = createBackendSupervisor({
    spawnFn,
    cliJs: FAKE_BACKEND,
    hostId: "test",
    logger,
    env,
    sleep: async () => {},
  });
  const sent = [];
  const broker = createBroker({
    manifest,
    supervisor,
    logger,
    send: (message) => sent.push(message),
    ...(queueTimeoutMs === undefined ? {} : { queueTimeoutMs }),
    ...(callDeadlineMs === undefined ? {} : { callDeadlineMs }),
  });
  cleanups.push(() => supervisor.stop());
  return { broker, sent, lines, supervisor };
}

function makeBrokerWithSupervisor(supervisor, manifest = null, brokerOptions = {}) {
  const { logger, lines } = captureLogger();
  const sent = [];
  const broker = createBroker({
    manifest,
    supervisor,
    logger,
    send: (m) => sent.push(m),
    ...brokerOptions,
  });
  return { broker, sent, lines };
}

const byId = (sent, id) => sent.find((message) => message.id === id);
const toolCall = (broker, id, args = {}) =>
  broker.handleClientMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "openwiki_search", arguments: args },
  });

describe("createBroker", () => {
  it("answers initialize from the manifest without starting the backend", () => {
    let spawnCount = 0;
    const { broker, sent } = makeBroker({
      spawnFn: (...args) => {
        spawnCount += 1;
        return spawn(...args);
      },
    });

    const started = Date.now();
    broker.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(Date.now() - started).toBeLessThan(200);
    expect(byId(sent, 1).result.serverInfo.name).toBe("openwiki");
    expect(spawnCount).toBe(0);
  });

  it("serves tools/list from the manifest before the backend is ready", () => {
    const { broker, sent } = makeBroker();

    broker.handleClientMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(byId(sent, 2).result.tools).toHaveLength(10);
  });

  it("queues a tool call until the backend is ready", async () => {
    const { broker, sent } = makeBroker({ env: { FAKE_STARTUP_DELAY_MS: "400" } });

    toolCall(broker, 3, { root: "x" });
    expect(byId(sent, 3)).toBeUndefined();

    await vi.waitFor(() => expect(byId(sent, 3)).toBeTruthy(), { timeout: 20000 });
    expect(byId(sent, 3).result.isError).toBe(false);
  });

  it("falls through to the real backend when no manifest exists", async () => {
    const { broker, sent } = makeBroker({ manifest: null });

    broker.handleClientMessage({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });

    await vi.waitFor(() => expect(byId(sent, 4)).toBeTruthy(), { timeout: 20000 });
    expect(byId(sent, 4).result.serverInfo.name).toBe("fake-openwiki");
  });

  it("prefers the backend tool list and warns when the manifest drifted", async () => {
    const snapshot = loadManifest("0.6.0");
    const drifted = {
      ...snapshot,
      tools: snapshot.tools.map((tool, index) =>
        index === 0 ? { ...tool, name: "drifted_tool" } : tool,
      ),
    };
    const { broker, sent, lines } = makeBroker({ manifest: drifted });

    toolCall(broker, 5);
    await vi.waitFor(() => expect(byId(sent, 5)).toBeTruthy(), { timeout: 20000 });

    broker.handleClientMessage({ jsonrpc: "2.0", id: 51, method: "tools/list" });
    await vi.waitFor(() => expect(byId(sent, 51)).toBeTruthy(), { timeout: 20000 });

    expect(byId(sent, 51).result.tools.map((tool) => tool.name)).toEqual(["echo_a", "echo_b"]);
    expect(lines.some((line) => line.includes("清单不一致"))).toBe(true);
  });

  it("rejects unknown methods with a JSON-RPC error", () => {
    const { broker, sent } = makeBroker();

    broker.handleClientMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" });

    expect(byId(sent, 6).error.code).toBe(-32601);
  });

  it("reports a restarted backend for a call that was in flight", async () => {
    const { broker, sent } = makeBroker({
      env: { FAKE_STALL_CALL: "1", FAKE_EXIT_AFTER_MS: "700" },
    });

    toolCall(broker, 7);

    await vi.waitFor(() => expect(byId(sent, 7)).toBeTruthy(), { timeout: 20000 });
    expect(byId(sent, 7).result.isError).toBe(true);
    expect(byId(sent, 7).result.content[0].text).toContain("已重启");
  });

  it("gives up on a queued call after the queue timeout", async () => {
    const { broker, sent } = makeBroker({
      env: { FAKE_STARTUP_DELAY_MS: "900" },
      queueTimeoutMs: 60,
    });

    toolCall(broker, 8);

    await vi.waitFor(() => expect(byId(sent, 8)).toBeTruthy(), { timeout: 10000 });
    expect(byId(sent, 8).result.isError).toBe(true);
    expect(byId(sent, 8).result.content[0].text).toBe(
      "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试",
    );
  });

  it("clears queued timers and stops the backend when the host disconnects", () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const supervisor = {
        ensureReady: () => new Promise(() => {}),
        current: () => null,
        onSessionExit() {},
        stop,
      };
      const { broker } = makeBrokerWithSupervisor(supervisor);

      toolCall(broker, 9);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      broker.handleClientEof();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a malformed host line and keeps serving", () => {
    const { broker, sent } = makeBroker();

    expect(() => broker.handleClientMessage({ invalid: "garbage" })).not.toThrow();

    broker.handleClientMessage({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    expect(byId(sent, 10).result.tools).toHaveLength(10);
  });

  it("fails fast once the backend cannot be started", async () => {
    let ensureCalls = 0;
    const supervisor = {
      ensureReady: async () => {
        ensureCalls += 1;
        throw new BackendUnavailableError("无法启动 openwiki 后端: fake", {
          stderrTail: "boom",
        });
      },
      current: () => null,
      onSessionExit() {},
      stop() {},
    };
    const { broker, sent } = makeBrokerWithSupervisor(supervisor);

    toolCall(broker, 11);
    await vi.waitFor(() => expect(byId(sent, 11)).toBeTruthy());
    toolCall(broker, 12);
    await vi.waitFor(() => expect(byId(sent, 12)).toBeTruthy());

    expect(byId(sent, 11).result.isError).toBe(true);
    expect(byId(sent, 12).result.isError).toBe(true);
    expect(ensureCalls).toBe(1);
  });

  it("retries the backend after the failure cooldown instead of latching", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const healthySession = {
      ready: Promise.resolve({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fake-openwiki", version: "9.9.9" },
        instructions: "fake instructions",
      }),
      request: async () => ({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
      isRunning: () => true,
    };
    const supervisor = {
      ensureReady: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new BackendUnavailableError("无法启动 openwiki 后端: fake", {
            stderrTail: "boom",
          });
        }
        return healthySession;
      },
      current: () => (attempts > 1 ? healthySession : null),
      onSessionExit() {},
      stop() {},
    };
    const { broker, sent } = makeBrokerWithSupervisor(supervisor, null, {
      now: () => clock,
      unavailableCooldownMs: 30000,
    });

    toolCall(broker, 13);
    await vi.waitFor(() => expect(byId(sent, 13)).toBeTruthy());
    expect(byId(sent, 13).result.isError).toBe(true);

    // Still inside the cooldown: fail fast instead of hammering spawn.
    toolCall(broker, 14);
    await vi.waitFor(() => expect(byId(sent, 14)).toBeTruthy());
    expect(byId(sent, 14).result.isError).toBe(true);
    expect(attempts).toBe(1);

    // A cold start on a scanned filesystem can outlive the cooldown with a
    // perfectly healthy backend; the session must not stay poisoned.
    clock += 31000;
    toolCall(broker, 15);
    await vi.waitFor(() => expect(byId(sent, 15)).toBeTruthy());
    expect(byId(sent, 15).result.isError).toBe(false);
    expect(attempts).toBe(2);
  });

  it("bounds a tool call the backend never answers", async () => {
    const { broker, sent } = makeBroker({
      manifest: null,
      env: { FAKE_STALL_CALL: "1" },
      callDeadlineMs: 90,
    });

    toolCall(broker, 16);

    await vi.waitFor(() => expect(byId(sent, 16)).toBeTruthy(), { timeout: 15000 });
    expect(byId(sent, 16).result.isError).toBe(true);
    expect(byId(sent, 16).result.content[0].text).toContain("超时");
  });

  it("settles in-flight calls when the host disconnects", async () => {
    const supervisor = {
      ensureReady: () => new Promise(() => {}),
      current: () => null,
      onSessionExit() {},
      stop() {},
    };
    const { broker, sent } = makeBrokerWithSupervisor(supervisor, null);

    toolCall(broker, 17);
    await Promise.resolve();
    broker.handleClientEof();

    await vi.waitFor(() => expect(byId(sent, 17)).toBeTruthy(), { timeout: 5000 });
    expect(byId(sent, 17).result.isError).toBe(true);
  });

  it("treats a changed input schema as snapshot drift", async () => {
    const snapshot = loadManifest("0.6.0");
    const mutatedTools = snapshot.tools.map((tool, index) =>
      index === 0
        ? { ...tool, inputSchema: { type: "object", properties: { changed: {} } } }
        : tool,
    );
    const drifted = { ...snapshot, tools: mutatedTools };
    const liveTools = snapshot.tools.map((tool, index) =>
      index === 0
        ? { ...tool, inputSchema: { type: "object", properties: { actual: {} } } }
        : tool,
    );
    const { broker, sent, lines } = makeBroker({
      manifest: drifted,
      env: { FAKE_TOOLS: JSON.stringify(liveTools) },
    });

    broker.handleClientMessage({ jsonrpc: "2.0", id: 18, method: "tools/list" });
    await vi.waitFor(() => expect(byId(sent, 18)).toBeTruthy(), { timeout: 20000 });
    // Start the backend: the manifest is only compared against a live list.
    toolCall(broker, 181);
    await vi.waitFor(() => expect(byId(sent, 181)).toBeTruthy(), { timeout: 20000 });
    broker.handleClientMessage({ jsonrpc: "2.0", id: 19, method: "tools/list" });
    await vi.waitFor(() => expect(byId(sent, 19)).toBeTruthy(), { timeout: 20000 });

    expect(lines.some((line) => line.includes("清单不一致"))).toBe(true);
  });
});
