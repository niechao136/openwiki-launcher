#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLineParser, formatMessage } from "../src/jsonrpc.mjs";
import { manifestFilePath } from "../src/manifest.mjs";
import { resolveOpenwikiRuntime } from "../src/paths.mjs";

/**
 * Asks the real openwiki MCP server for its initialize result and tool list.
 *
 * The snapshot this produces is what lets the broker answer a host in
 * milliseconds; recording it from the real server keeps it honest.
 *
 * @param {{ hostId?: string, timeoutMs?: number }} options
 * @returns {Promise<object>} Manifest for the resolved openwiki version.
 */
export async function generateManifest({ hostId = "manifest", timeoutMs = 600000 } = {}) {
  const runtime = await resolveOpenwikiRuntime();
  const started = Date.now();
  process.stderr.write(
    `[gen-manifest] 握手 openwiki ${runtime.version}：${runtime.cliJs}\n`,
  );
  const child = spawn(process.execPath, [runtime.cliJs, "mcp", "--host", hostId], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const pending = new Map();
  const settleAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const parser = createLineParser((message) => {
    if (!message || message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`openwiki mcp 返回错误：${message.error.message}`));
    else resolve(message.result);
  });
  child.stdout.on("data", (chunk) => parser.write(chunk.toString()));
  child.on("exit", (code, signal) => {
    settleAll(
      new Error(
        `openwiki mcp 在返回清单前退出 code=${code} signal=${signal}: ${stderr.slice(-800)}`,
      ),
    );
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(formatMessage({ jsonrpc: "2.0", id, method, params }));
    });

  const timer = setTimeout(() => {
    child.kill();
    settleAll(new Error(`生成 manifest 超时 ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const initialize = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openwiki-launcher-manifest", version: "0.1.0" },
    });
    child.stdin.write(
      formatMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    const tools = await request("tools/list", {});

    process.stderr.write(
      `[gen-manifest] 后端就绪，耗时 ${Date.now() - started}ms，工具 ${(tools.tools ?? []).length} 个\n`,
    );

    return {
      openwikiVersion: runtime.version,
      protocolVersion: initialize.protocolVersion,
      serverInfo: initialize.serverInfo,
      instructions: initialize.instructions ?? "",
      tools: tools.tools ?? [],
    };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

/**
 * Generates the manifest and writes it into the package snapshot directory.
 *
 * @param {object} options - Forwarded to generateManifest.
 * @returns {Promise<object>} The written manifest.
 */
export async function writeManifest(options = {}) {
  const manifest = await generateManifest(options);
  writeFileSync(
    manifestFilePath(manifest.openwikiVersion),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const manifest = await writeManifest();
  console.log(
    `wrote ${manifestFilePath(manifest.openwikiVersion)} (${manifest.tools.length} tools)`,
  );
}
