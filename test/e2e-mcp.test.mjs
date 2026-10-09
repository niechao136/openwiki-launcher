import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "openwiki-launcher.mjs");
const FAKE_BACKEND = path.join(ROOT, "test", "fixtures", "fake-openwiki.mjs");

/**
 * Drives the real CLI over stdio exactly like a coding host would.
 */
function startHost() {
  const child = spawn(process.execPath, [BIN, "mcp", "--host", "codebuddy"], {
    env: {
      ...process.env,
      LAUNCHER_BACKEND_CLI: FAKE_BACKEND,
      FAKE_STARTUP_DELAY_MS: "800",
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

  const methodOf = () => "response";

  return { child, request, waitFor };
}

describe("openwiki-launcher mcp (end to end)", () => {
  it("answers initialize from the manifest long before the backend is ready", async () => {
    const host = startHost();
    const started = Date.now();
    try {
      host.request(1, "initialize", {});
      const response = await host.waitFor(1);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(response.result.serverInfo.name).toBe("openwiki");
    } finally {
      host.child.stdin.end();
    }
  });

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

    const exitCode = await new Promise((resolve) => {
      host.child.on("exit", (code) => resolve(code));
      host.child.stdin.end();
    });

    expect(exitCode).toBe(0);
  }, 30000);
});
