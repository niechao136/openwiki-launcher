import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendSession, initializeParams } from "../src/backend.mjs";

const LAUNCHER_PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

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
      info(message) {
        lines.push({ level: "info", message });
      },
      debug(message) {
        lines.push({ level: "debug", message });
      },
      warn(message) {
        lines.push({ level: "warn", message });
      },
      error(message) {
        lines.push({ level: "error", message });
      },
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
  it("向 openwiki 报的是本包的真实版本，而不是写死的字符串", () => {
    // 写死的 "0.1.0" 不会让功能出错，但它会出现在 openwiki 的 run metadata 里 ——
    // 版本对不上时，排查的人先怀疑 openwiki 的数据，而不是这个包。
    expect(initializeParams().clientInfo).toEqual({
      name: "openwiki-launcher",
      version: LAUNCHER_PKG.version,
    });
  });

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

    // A dirty line means the spawned process may not be openwiki at all, so it
    // has to be visible without LAUNCHER_DEBUG.
    expect(
      lines.some((line) => line.level === "warn" && line.message.includes("不是 JSON")),
    ).toBe(true);
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
