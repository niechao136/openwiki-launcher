import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendSession } from "../src/backend.mjs";

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
      debug(message) {
        lines.push(message);
      },
      error() {},
    },
  };
}

const started = [];

function start(options = {}) {
  const session = createBackendSession({
    cliJs: FAKE_BACKEND,
    hostId: "test",
    logger: captureLogger().logger,
    ...options,
  });
  started.push(session);
  return session;
}

afterEach(() => {
  for (const session of started.splice(0)) session.stop();
});

describe("createBackendSession", () => {
  it("completes the MCP handshake and exposes the backend serverInfo", async () => {
    const session = start({ env: { FAKE_SERVER_NAME: "fake-openwiki" } });

    await expect(session.ready).resolves.toMatchObject({
      serverInfo: { name: "fake-openwiki" },
      protocolVersion: "2024-11-05",
    });
  });

  it("returns a tool call result to the caller", async () => {
    const session = start();

    const result = await session.request("tools/call", {
      name: "echo_a",
      arguments: { v: 1 },
    });

    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: { v: 1 } });
  });

  it("keeps concurrent request ids separate", async () => {
    const session = start();

    const results = await Promise.all([
      session.request("tools/call", { name: "echo_a", arguments: { v: 1 } }),
      session.request("tools/call", { name: "echo_b", arguments: { v: 2 } }),
      session.request("tools/call", { name: "echo_a", arguments: { v: 3 } }),
    ]);

    expect(
      results.map((result) => JSON.parse(result.content[0].text).echoed.v),
    ).toEqual([1, 2, 3]);
  });

  it("ignores non-JSON backend output without breaking the session", async () => {
    const { logger, lines } = captureLogger();
    const session = start({ logger, env: { FAKE_STDOUT_NOISE: "garbage line" } });

    await expect(session.ready).resolves.toBeTruthy();

    expect(lines.some((line) => line.includes("忽略非 JSON"))).toBe(true);
  });

  it("rejects later requests once the backend exited", async () => {
    const session = start({ env: { FAKE_EXIT_AFTER_MS: "150" } });

    await expect(session.exited).resolves.toMatchObject({ code: 0 });
    await expect(session.request("tools/list", {})).rejects.toThrow(/backend exited/);
  });

  it("terminates the backend on stop", async () => {
    const session = start();
    await session.ready;

    session.stop();

    const exit = await session.exited;
    expect(exit.code !== 0 || exit.signal !== null).toBe(true);
  });
});
