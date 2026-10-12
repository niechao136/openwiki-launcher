import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "openwiki-launcher.mjs");
const FAKE_BACKEND = path.join(ROOT, "test", "fixtures", "fake-openwiki.mjs");

/**
 * Drives the real CLI over stdio exactly like a coding host would.
 */
function startHost({ env = {} } = {}) {
  const pidFile = path.join(
    os.tmpdir(),
    `openwiki-launcher-backend-${process.pid}-${Math.random().toString(16).slice(2)}.pid`,
  );
  const child = spawn(process.execPath, [BIN, "mcp", "--host", "codebuddy"], {
    env: {
      ...process.env,
      LAUNCHER_BACKEND_CLI: FAKE_BACKEND,
      FAKE_STARTUP_DELAY_MS: "800",
      FAKE_PID_FILE: pidFile,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses = new Map();
  const waiters = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      responses.set(message.id, message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });

  const request = (id, method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

  const waitFor = async (id, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (!responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${methodOf(id)}`);
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return responses.get(id);
  };

  const methodOf = (id) => `id ${id}`;

  /** Reads the backend pid once the fixture has written it. */
  const backendPid = async (timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("backend pid was never recorded");
  };

  /** Resolves true once the pid is gone from the process table. */
  const backendGone = async (pid, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  return { child, request, waitFor, backendPid, backendGone, pidFile };
}

describe("openwiki-launcher mcp (end to end)", () => {
  it("answers initialize from the manifest long before the backend is ready", async () => {
    const host = startHost();
    const started = Date.now();
    try {
      host.request(1, "initialize", {});
      const response = await host.waitFor(1);

      // The wall-clock bound covers this machine's process startup, not the
      // broker: Node takes seconds to launch here. The behavioural proof that
      // no backend was consulted is the server name, because the fake backend
      // would answer "fake-openwiki". The bound is 5s (not 3s) because the
      // broker prewarms a CPU-burning backend child during startup and vitest
      // runs files in parallel: on a loaded machine the parent's own launch
      // stretches. A regression that made initialize wait for the backend
      // would cost tens of seconds and still fail this bound.
      expect(response.result.serverInfo.name).toBe("openwiki");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      host.child.stdin.end();
    }
  }, 30000);

  it("lists the ten openwiki tools from the manifest", async () => {
    const host = startHost();
    try {
      host.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );
      const response = await host.waitFor(2);

      expect(response.result.tools).toHaveLength(10);
      for (const tool of response.result.tools) {
        expect(tool.name.startsWith("openwiki_")).toBe(true);
      }
    } finally {
      host.child.stdin.end();
    }
  });

  it("passes a tool call through to the backend and returns the result", async () => {
    const host = startHost();
    try {
      host.request(3, "tools/call", {
        name: "openwiki_search",
        arguments: { root: "d:/tmp", query: "x" },
      });
      const response = await host.waitFor(3, 30000);

      expect(response.result.isError).toBe(false);
    } finally {
      host.child.stdin.end();
    }
  });

  it("exits and leaves no backend behind when the host closes stdin", async () => {
    const host = startHost();
    host.request(4, "initialize", {});
    await host.waitFor(4);
    host.request(5, "tools/call", { name: "openwiki_search", arguments: {} });

    const backendPid = await host.backendPid();

    const exitCode = await new Promise((resolve) => {
      host.child.on("exit", (code) => resolve(code));
      host.child.stdin.end();
    });

    expect(exitCode).toBe(0);
    expect(await host.backendGone(backendPid)).toBe(true);
  }, 40000);

  it("keeps serving after the host writes a malformed line", async () => {
    const host = startHost();
    try {
      host.child.stdin.write("not json\n");
      host.child.stdin.write("also not json\n");
      host.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} })}\n`,
      );

      const response = await host.waitFor(6);

      expect(response.result.tools).toHaveLength(10);
    } finally {
      host.child.stdin.end();
    }
  }, 30000);

  it("starts the backend in the background without waiting for a tool call", async () => {
    const host = startHost();
    try {
      host.request(1, "initialize", {});
      await host.waitFor(1);
      host.request(2, "tools/list", {});
      await host.waitFor(2);

      // No tools/call has been sent. A lazily started backend would never
      // spawn, so the pid file staying absent is what makes this test red
      // before eager prewarming exists.
      const pid = await host.backendPid(10000);
      expect(pid).toBeGreaterThan(0);
    } finally {
      host.child.stdin.end();
    }
  }, 30000);

  it("keeps the session alive when the eager backend refuses to start", async () => {
    const host = startHost({ env: { FAKE_REFUSE: "1" } });
    try {
      host.request(1, "initialize", {});
      const initialize = await host.waitFor(1);
      expect(initialize.result.serverInfo.name).toBe("openwiki");

      // The prewarm rejection lands here (spawn fails, one retry, ~1.5s). A
      // fire-and-forget promise without a catch would take the process down
      // as an unhandled rejection; the session must survive it and answer.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      host.request(2, "tools/call", { name: "openwiki_search", arguments: {} });
      const call = await host.waitFor(2, 30000);
      expect(call.error !== undefined || call.result?.isError === true).toBe(true);
    } finally {
      host.child.stdin.end();
    }
  }, 30000);

  it("does not pre-start the backend when LAUNCHER_EAGER_START=0", async () => {
    const host = startHost({ env: { LAUNCHER_EAGER_START: "0" } });
    try {
      host.request(1, "initialize", {});
      await host.waitFor(1);
      host.request(2, "tools/list", {});
      await host.waitFor(2);

      // Well past the fixture's startup delay: with prewarming off the backend
      // stays unspawned until the first tools/call.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(existsSync(host.pidFile)).toBe(false);
    } finally {
      host.child.stdin.end();
    }
  }, 30000);
});
