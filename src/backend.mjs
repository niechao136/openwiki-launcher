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

  return { ready, exited, request, notify, stop, stderrTail: () => stderrTail, isRunning: () => !hasExited };
}

/**
 * Raised when the openwiki backend cannot be started.
 *
 * `stderrTail` carries what the failed process printed, because the most common
 * cause (a native module that did not build, a Node version mismatch) explains
 * itself only there.
 */
export class BackendUnavailableError extends Error {
  constructor(message, { stderrTail = "" } = {}) {
    super(message);
    this.name = "BackendUnavailableError";
    this.stderrTail = stderrTail;
  }
}

/**
 * Owns the lifecycle of the openwiki backend process.
 *
 * Startup is attempted at most `maxSpawnAttempts` times with a fixed delay: a
 * host that cannot get an answer retries the connection anyway, and unbounded
 * retries would turn a broken install into an apparently hung agent.
 *
 * @param {{
 *   spawnFn?: Function,
 *   cliJs: string,
 *   hostId: string,
 *   logger: { debug(message: string): void },
 *   env?: Record<string, string>,
 *   retryDelayMs?: number,
 *   maxSpawnAttempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 * @returns {{
 *   ensureReady(): Promise<object>,
 *   current(): object | null,
 *   onSessionExit(listener: (info: object) => void): void,
 *   stop(): void,
 * }}
 */
export function createBackendSupervisor({
  spawnFn = spawn,
  cliJs,
  hostId,
  logger,
  env = {},
  retryDelayMs = 1000,
  maxSpawnAttempts = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let session = null;
  let starting = null;
  let stopped = false;
  const exitListeners = new Set();

  async function startSession() {
    let lastError = null;
    let stderrTail = "";

    for (let attempt = 1; attempt <= maxSpawnAttempts; attempt += 1) {
      let candidate = null;
      try {
        candidate = createBackendSession({ spawnFn, cliJs, hostId, logger, env });
      } catch (error) {
        lastError = error;
      }

      if (candidate) {
        try {
          await candidate.ready;
          // A host can disconnect while the backend is still importing. Without
          // this check the freshly started process would outlive the broker as
          // an orphan and keep the event loop alive.
          if (stopped) {
            candidate.stop();
            throw new BackendUnavailableError("openwiki 后端已停止");
          }
          return candidate;
        } catch (error) {
          // A process that dies before the handshake answers is a startup
          // failure, not a runtime crash: it counts against the attempts.
          lastError = error;
          stderrTail = candidate.stderrTail();
          candidate.stop();
        }
      }

      if (stopped) throw new BackendUnavailableError("openwiki 后端已停止");

      if (attempt < maxSpawnAttempts) {
        logger.debug(
          `后端启动失败，${retryDelayMs}ms 后重试 (${attempt}/${maxSpawnAttempts}): ${lastError && lastError.message}`,
        );
        await sleep(retryDelayMs);
      }
    }

    throw new BackendUnavailableError(
      `无法启动 openwiki 后端: ${cliJs}${lastError ? ` (${lastError.message})` : ""}`,
      { stderrTail },
    );
  }

  function ensureReady() {
    if (stopped) {
      return Promise.reject(new BackendUnavailableError("openwiki 后端已停止"));
    }
    if (session) return Promise.resolve(session);
    if (starting) return starting;

    starting = startSession()
      .then((created) => {
        starting = null;
        session = created;
        created.exited.then((info) => {
          if (session === created) session = null;
          for (const listener of exitListeners) listener(info);
        });
        return created;
      })
      .catch((error) => {
        starting = null;
        throw error;
      });

    return starting;
  }

  return {
    ensureReady,
    current: () => session,
    onSessionExit(listener) {
      exitListeners.add(listener);
    },
    stop() {
      stopped = true;
      starting = null;
      if (session) {
        session.stop();
        session = null;
      }
    },
  };
}
