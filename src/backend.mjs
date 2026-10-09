import { spawn } from "node:child_process";
import { createLineParser, formatMessage } from "./jsonrpc.mjs";

const STDERR_TAIL_LIMIT = 8192;
const FORCE_KILL_AFTER_MS = 3000;

/**
 * Starts one openwiki MCP backend and speaks MCP to it.
 *
 * The launcher always spawns `process.execPath` with an absolute CLI path: on
 * Windows an nvm `openwiki.exe` shim does not forward stdio, which would look
 * exactly like a hung server to the host.
 *
 * @param {{
 *   spawnFn?: Function,
 *   cliJs: string,
 *   hostId: string,
 *   logger: { debug(message: string): void },
 *   env?: Record<string, string>,
 *   callReadyTimeoutMs?: number,
 * }} options
 * @returns {{
 *   ready: Promise<object>,
 *   exited: Promise<{ code: number|null, signal: string|null, stderrTail: string }>,
 *   request(method: string, params: unknown): Promise<any>,
 *   notify(method: string, params: unknown): void,
 *   stop(): void,
 * }}
 */
export function createBackendSession({
  spawnFn = spawn,
  cliJs,
  hostId,
  logger,
  env = {},
  callReadyTimeoutMs = 120000,
}) {
  const child = spawnFn(process.execPath, [cliJs, "mcp", "--host", hostId], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrTail = "";
  let hasExited = false;
  let nextId = 1;
  let forceKillTimer = null;
  const pending = new Map();

  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });

  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const parser = createLineParser((message) => {
    if (message.invalid !== undefined) {
      // Not a protocol message. Log it and keep the session usable: one dirty
      // line must not cost the host its backend.
      logger.debug(`忽略非 JSON 输出行: ${String(message.invalid).slice(0, 200)}`);
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) {
      logger.debug(`忽略无法对应的响应 id=${message.id}`);
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`openwiki mcp 返回错误: ${message.error.message}`));
    else resolve(message.result);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => parser.write(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    logger.debug(`后端 stderr: ${chunk.slice(0, 200)}`);
  });

  child.on("error", (error) => {
    logger.debug(`后端进程错误: ${error.message}`);
    rejectPending(new Error(`backend spawn failed: ${error.message}`));
  });

  child.on("exit", (code, signal) => {
    hasExited = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    rejectPending(new Error(`backend exited (code=${code} signal=${signal})`));
    resolveExited({ code, signal, stderrTail });
  });

  const request = (method, params) => {
    if (hasExited) return Promise.reject(new Error("backend exited"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(formatMessage({ jsonrpc: "2.0", id, method, params }));
    });
  };

  const notify = (method, params) => {
    if (hasExited) return;
    child.stdin.write(formatMessage({ jsonrpc: "2.0", method, params }));
  };

  const readyTimer = setTimeout(() => {
    child.kill();
  }, callReadyTimeoutMs);

  const ready = new Promise((resolve, reject) => {
    request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openwiki-launcher", version: "0.1.0" },
    })
      .then((result) => {
        notify("notifications/initialized", {});
        resolve(result);
      })
      .catch(reject)
      .finally(() => clearTimeout(readyTimer));
  });
  // Callers may attach to `ready` late; keep an unobserved rejection from
  // crashing the broker while preserving the rejection for real consumers.
  ready.catch(() => {});

  const stop = () => {
    if (hasExited) return;
    child.kill();
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
    forceKillTimer.unref?.();
  };

  return { ready, exited, request, notify, stop };
}
