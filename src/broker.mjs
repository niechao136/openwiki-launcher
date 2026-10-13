const DEFAULT_QUEUE_TIMEOUT_MS = 25000;
const DEFAULT_CALL_DEADLINE_MS = 180000;
const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 30000;
const DEFAULT_PROGRESS_INTERVAL_MS = 2000;

const CANCELLED = "host disconnected";
const QUEUE_TIMEOUT = "queue timeout";
const CALL_DEADLINE = "call deadline";

/**
 * MCP front end of the launcher.
 *
 * The broker answers a host from a recorded manifest whenever it can, so the
 * handshake costs milliseconds instead of openwiki's import time. Anything that
 * needs real work is queued until the backend is up, and every failure is
 * reported as a bounded tool error the host can act on.
 *
 * @param {{
 *   manifest: object | null,
 *   supervisor: { ensureReady(): Promise<object>, current(): object|null, onSessionExit(fn: Function): void, stop(): void },
 *   logger: { debug(message: string): void, warn(message: string): void },
 *   send(message: object): void,
 *   queueTimeoutMs?: number,
 * }} options
 * @returns {{ handleClientMessage(message: object): void, handleClientEof(): void }}
 */
export function createBroker({
  manifest,
  supervisor,
  logger,
  send,
  queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
  callDeadlineMs = DEFAULT_CALL_DEADLINE_MS,
  unavailableCooldownMs = DEFAULT_UNAVAILABLE_COOLDOWN_MS,
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
  now = () => Date.now(),
}) {
  const timers = new Set();
  const inFlight = new Set();
  // 与 commands/mcp.mjs 的预热日志同一时间起点，两条日志的差值就是
  // “宿主第一次调用比后端就绪早到了多少”。
  const startedAt = now();
  let firstCallLogged = false;
  let unavailable = null;
  let unavailableAt = 0;
  let mismatchWarned = false;

  // A failed start is remembered only for a cooldown. openwiki's cold import can
  // outlast any fixed budget on a scanned filesystem, and a permanent latch would
  // keep every later call failing for a host session that lives for hours.
  const unavailableActive = () =>
    unavailable !== null && now() - unavailableAt < unavailableCooldownMs;

  const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });

  const sendToolError = (id, text) =>
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: true },
    });

  const unavailableText = (error) => {
    const detail = error && error.message ? error.message : "unknown";
    return `openwiki 后端不可用：${detail}`;
  };

  function initializeResult(info) {
    return {
      protocolVersion: info.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: info.serverInfo,
      instructions: info.instructions ?? "",
    };
  }

  // Bounds how long a host request may wait. The timer is tracked so host
  // disconnect can clear every one of them.
  function withDeadline(promise, ms, reason) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reject(new Error(reason));
      }, ms);
      timers.add(timer);
      promise.then(
        (value) => {
          clearTimeout(timer);
          timers.delete(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          timers.delete(timer);
          reject(error);
        },
      );
    });
  }

  // Lets host disconnect settle requests that are waiting on the backend,
  // instead of leaving their promises dangling until the process dies.
  function withCancellation(promise) {
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error(CANCELLED));
    });
    const record = { cancel };
    inFlight.add(record);
    return Promise.race([promise, cancelled]).finally(() => inFlight.delete(record));
  }

  // A host that supports resetTimeoutOnProgress keeps its request alive as long
  // as progress keeps arriving; the token travels in the request's _meta. Only
  // scalar tokens are usable (MCP allows string or number); anything else means
  // the host cannot match notifications and we stay silent.
  function progressTokenOf(entry) {
    const token = entry.params?._meta?.progressToken;
    return typeof token === "string" || typeof token === "number" ? token : null;
  }

  // While a call waits for the backend to start, report progress on its token.
  // The interval is registered in `timers` so host disconnect clears it; the
  // promise settling (ready, queue timeout, or failure) stops it.
  function withQueueProgress(entry, pending) {
    const token = progressTokenOf(entry);
    if (token === null) return pending;
    let progress = 0;
    const timer = setInterval(() => {
      progress += 1;
      send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress, message: "等待 openwiki 后端启动" },
      });
    }, progressIntervalMs);
    timers.add(timer);
    return pending.finally(() => {
      clearInterval(timer);
      timers.delete(timer);
    });
  }

  function sameToolList(expected, actual) {
    if (!Array.isArray(expected)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((tool, index) => {
      const other = actual[index];
      if (!other || tool.name !== other.name) return false;
      // The broker serves the recorded inputSchema to the host, so a schema
      // change is drift even when the tool name is unchanged.
      return (
        JSON.stringify(tool.inputSchema ?? null) ===
        JSON.stringify(other.inputSchema ?? null)
      );
    });
  }

  async function toolsFromBackend(session) {
    const result = await session.request("tools/list", {});
    const tools = result.tools ?? [];
    const drifted = manifest && !mismatchWarned && !sameToolList(manifest.tools, tools);
    if (drifted) {
      mismatchWarned = true;
      logger.warn("后端工具清单不一致，已以后端为准；请重新生成 manifest");
    }
    return tools;
  }

  async function dispatch(entry) {
    if (unavailableActive()) {
      sendToolError(entry.id, unavailableText(unavailable));
      return;
    }

    let session;
    try {
      session = await withQueueProgress(
        entry,
        withCancellation(
          withDeadline(supervisor.ensureReady(), queueTimeoutMs, QUEUE_TIMEOUT),
        ),
      );
    } catch (error) {
      if (error.message === QUEUE_TIMEOUT) {
        sendToolError(entry.id, "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试");
        return;
      }
      if (error.message === CANCELLED) {
        sendToolError(entry.id, "宿主已断开，调用已取消");
        return;
      }
      unavailable = error;
      unavailableAt = now();
      logger.error(`openwiki 后端不可用：${error.message}`);
      sendToolError(entry.id, unavailableText(error));
      return;
    }

    try {
      if (entry.method === "initialize") {
        sendResult(entry.id, initializeResult(await session.ready));
        return;
      }
      if (entry.method === "tools/list") {
        sendResult(entry.id, { tools: await toolsFromBackend(session) });
        return;
      }
      const result = await withCancellation(
        withDeadline(
          session.request("tools/call", entry.params),
          callDeadlineMs,
          CALL_DEADLINE,
        ),
      );
      send({ jsonrpc: "2.0", id: entry.id, result });
    } catch (error) {
      if (error.message === CALL_DEADLINE) {
        sendToolError(entry.id, "openwiki 后端调用超时，请重试");
        return;
      }
      if (error.message === CANCELLED) {
        sendToolError(entry.id, "宿主已断开，调用已取消");
        return;
      }
      let restarted = false;
      if (typeof session.isRunning === "function") restarted = !session.isRunning();
      sendToolError(
        entry.id,
        restarted
          ? "openwiki 后端已重启，请重试"
          : `openwiki 后端调用失败：${error.message}`,
      );
    }
  }

  // `dispatch` is async and fires without await; without this guard an internal
  // failure would surface as an unhandled rejection, which terminates the
  // broker process on Node 22 and costs the host its whole MCP session.
  function dispatchSafely(entry) {
    dispatch(entry).catch((error) => {
      logger.error(`处理宿主请求时发生内部错误: ${error && error.message}`);
      try {
        sendToolError(entry.id, "openwiki-launcher 内部错误，请查看 stderr");
      } catch {
        // The host pipe is already gone; nothing left to report to.
      }
    });
  }

  return {
    handleClientMessage(message) {
      if (!message) return;
      if (typeof message !== "object") return;

      if (message.invalid !== undefined) {
        logger.debug(`忽略宿主发来的非 JSON 行: ${String(message.invalid).slice(0, 200)}`);
        return;
      }

      if (message.id === undefined) {
        const session = supervisor.current();
        if (session) session.notify(message.method, message.params);
        else logger.debug(`后端未就绪，丢弃宿主通知 ${message.method}`);
        return;
      }

      if (message.method === "initialize") {
        if (manifest) {
          sendResult(message.id, initializeResult(manifest));
          return;
        }
        dispatchSafely({ id: message.id, method: "initialize" });
        return;
      }

      if (message.method === "tools/list") {
        if (manifest && !supervisor.current()) {
          sendResult(message.id, { tools: manifest.tools });
          return;
        }
        dispatchSafely({ id: message.id, method: "tools/list" });
        return;
      }

      if (message.method === "tools/call") {
        if (!firstCallLogged) {
          firstCallLogged = true;
          logger.debug(`首次 tools/call 到达，距启动 ${now() - startedAt}ms`);
        }
        dispatchSafely({ id: message.id, method: "tools/call", params: message.params });
        return;
      }

      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    },

    handleClientEof() {
      // timers 里既有 setTimeout 也有 setInterval 句柄，两种 clear 都调，
      // 不依赖 Node 内部两者互通的实现细节。
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      for (const record of inFlight) record.cancel();
      inFlight.clear();
      supervisor.stop();
    },
  };
}
