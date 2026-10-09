import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "openwiki-launcher.mjs");

/**
 * Drives the CLI against the real openwiki dependency.
 *
 * Gated behind LAUNCHER_REAL_SMOKE because openwiki's import tree takes tens of
 * seconds on a cold Windows cache; the assertions here are about the launcher's
 * handshake, not about openwiki's speed.
 */
function startRealHost() {
  const child = spawn(process.execPath, [BIN, "mcp", "--host", "codebuddy"], {
    env: { ...process.env, LAUNCHER_BACKEND_CLI: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses = new Map();
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
    }
  });

  const request = (id, method) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);

  const waitFor = async (id, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for id ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return responses.get(id);
  };

  return { child, request, waitFor };
}

describe.skipIf(!process.env.LAUNCHER_REAL_SMOKE)("real openwiki backend", () => {
  it("answers initialize from the manifest without waiting for openwiki", async () => {
    const host = startRealHost();
    const started = Date.now();
    try {
      host.request(1, "initialize");
      const response = await host.waitFor(1, 30000);

      expect(response.result.serverInfo.name).toBe("openwiki");
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      host.child.stdin.end();
    }
  }, 60000);

  it("lists the ten openwiki tools", async () => {
    const host = startRealHost();
    try {
      host.request(2, "tools/list");
      const response = await host.waitFor(2, 30000);

      expect(response.result.tools).toHaveLength(10);
      for (const tool of response.result.tools) {
        expect(tool.name.startsWith("openwiki_")).toBe(true);
      }
    } finally {
      host.child.stdin.end();
    }
  }, 60000);
});
