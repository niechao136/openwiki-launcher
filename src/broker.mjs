const DEFAULT_QUEUE_TIMEOUT_MS = 120000;

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
}) {
  const timers = new Set();
  let unavailable = null;
  let mismatchWarned = false;

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

  // Bounds how long a host request may wait for the backend. The timer is
  // tracked so host disconnect can clear every one of them.
  function withinQueueBudget(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reject(new Error("queue timeout"));
      }, queueTimeoutMs);
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

  function sameToolList(expected, actual) {
    if (!Array.isArray(expected)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((tool, index) => tool.name === actual[index].name);
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
    if (unavailable) {
      sendToolError(entry.id, unavailableText(unavailable));
      return;
    }

    let session;
    try {
      session = await withinQueueBudget(supervisor.ensureReady());
    } catch (error) {
      if (error.message === "queue timeout") {
        sendToolError(entry.id, "openwiki 后端排队超时，请重试");
        return;
      }
      unavailable = error;
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
      const result = await session.request("tools/call", entry.params);
      send({ jsonrpc: "2.0", id: entry.id, result });
    } catch (error) {
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
        void dispatch({ id: message.id, method: "initialize" });
        return;
      }

      if (message.method === "tools/list") {
        if (manifest && !supervisor.current()) {
          sendResult(message.id, { tools: manifest.tools });
          return;
        }
        void dispatch({ id: message.id, method: "tools/list" });
        return;
      }

      if (message.method === "tools/call") {
        void dispatch({ id: message.id, method: "tools/call", params: message.params });
        return;
      }

      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    },

    handleClientEof() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      supervisor.stop();
    },
  };
}
