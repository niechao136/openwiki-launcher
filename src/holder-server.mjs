const QUEUE_TIMEOUT = "queue timeout";
const QUEUE_TIMEOUT_TEXT = "openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试";
const INITIALIZE_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "openwiki-launcher-holder", version: "holder" },
};

/**
 * holder 的多路复用核心。
 *
 * openwiki 是 stdio MCP server，一个进程只有一对 stdin/stdout。holder 对上游
 * 只做一次 initialize（由 supervisor 的单会话语义保证），对每个接入的 wrapper
 * 连接做 id 重映射：连接内的原始 id 与全局唯一 id 一一对应，响应回来按映射
 * 送回正确的连接。progressToken 在进 holder 前就该被剥掉（wrapper 适配器负责），
 * 这里对通知只认取消，其余一律丢弃——openwiki 不发 server→client 请求。
 *
 * @param {{
 *   supervisor: { ensureReady(): Promise<object>, current(): object | null, onSessionExit(fn: Function): void, stop(): void },
 *   logger: { debug(message: string): void, warn(message: string): void, error(message: string): void },
 *   version: string,
 *   queueTimeoutMs?: number,
 *   onShutdown?: () => void,
 * }} options
 * @returns {{
 *   handleConnection(conn: object): void,
 *   connectionCount(): number,
 *   closeAll(): void,
 * }}
 */
export function createHolderCore({
  supervisor,
  logger,
  version,
  queueTimeoutMs = 120000,
  onShutdown,
}) {
  let nextId = 1;
  /** @type {Set<object>} */
  const conns = new Set();
  /** @type {Set<{ closed: boolean, cancelled: Set<any> }>} */
  const connStates = new Set();
  let starting = null;

  // 上游会话的共享入口：current() 命中直接用，否则让 supervisor 的单会话
  // 语义去重并发 ensureReady。失败后清空 starting，让下一次调用重试——
  // 冷却由 wrapper 侧 broker 的 unavailable 冷却承担，这里不重复造。
  function getSession() {
    const current = supervisor.current();
    if (current) return Promise.resolve(current);
    if (!starting) {
      starting = supervisor.ensureReady().finally(() => {
        starting = null;
      });
      starting.catch(() => {});
    }
    return starting;
  }

  function withDeadline(promise, ms, reason) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(reason)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function isCancelled(connState, connId) {
    if (!connState.cancelled.has(connId)) return false;
    connState.cancelled.delete(connId);
    return true;
  }

  function toolError(id, text) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  }

  // 直通模式（无 manifest）下 wrapper 需要上游的 initialize 结果。规格 §5.4：
  // initialize 只对上游做一次，holder 缓存后所有连接共用。
  let initCache = null;

  async function dispatchInit(conn, connState, message) {
    try {
      const session = await withDeadline(getSession(), queueTimeoutMs, QUEUE_TIMEOUT);
      if (connState.closed) return;
      if (!initCache) {
        initCache = await session.request("initialize", INITIALIZE_PARAMS);
      }
      conn.send({ jsonrpc: "2.0", id: message.id, result: initCache });
    } catch (error) {
      if (connState.closed) return;
      if (error.message === QUEUE_TIMEOUT) {
        conn.send(toolError(message.id, QUEUE_TIMEOUT_TEXT));
        return;
      }
      logger.error(`openwiki 后端不可用：${error.message}`);
      conn.send(toolError(message.id, `openwiki 后端不可用：${error.message}`));
    }
  }

  async function dispatch(conn, connState, message) {
    const connId = message.id;
    const params = { ...message.params };
    delete params._meta; // 上游不发 progress，token 进 holder 没有下游
    try {
      const session = await withDeadline(getSession(), queueTimeoutMs, QUEUE_TIMEOUT);
      if (connState.closed || isCancelled(connState, connId)) return;
      const result = await session.request("tools/call", params);
      if (connState.closed || isCancelled(connState, connId)) return;
      conn.send({ jsonrpc: "2.0", id: connId, result });
    } catch (error) {
      if (connState.closed || isCancelled(connState, connId)) return;
      if (error.message === QUEUE_TIMEOUT) {
        conn.send(toolError(connId, QUEUE_TIMEOUT_TEXT));
        return;
      }
      logger.error(`openwiki 后端不可用：${error.message}`);
      conn.send(toolError(connId, `openwiki 后端不可用：${error.message}`));
    }
  }

  function handleMessage(conn, connState, message) {
    if (!message || typeof message !== "object" || message.invalid !== undefined) return;

    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") {
        connState.cancelled.add(message.params?.requestId);
        return;
      }
      // shutdown 允许以通知形态到达（发送方不需要应答）。
      if (message.method === "holder/shutdown") {
        onShutdown?.();
        return;
      }
      logger.debug(`holder 忽略通知 ${message.method}`);
      return;
    }

    if (message.method === "holder/init") {
      dispatchInit(conn, connState, message);
      return;
    }
    if (message.method === "holder/status") {
      conn.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { backendReady: supervisor.current() != null, version },
      });
      return;
    }
    if (message.method === "holder/shutdown") {
      conn.send({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } });
      onShutdown?.();
      return;
    }
    if (message.method === "tools/call") {
      dispatch(conn, connState, message);
      return;
    }
    conn.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }

  return {
    /**
     * @param {{ send(message: object): void, onMessage(cb: Function): void, onClose(cb: Function): void }} conn
     */
    handleConnection(conn) {
      const connState = { closed: false, cancelled: new Set() };
      connStates.add(connState);
      conn.onMessage((message) => handleMessage(conn, connState, message));
      conn.onClose(() => {
        connState.closed = true;
        connStates.delete(connState);
      });
    },

    connectionCount() {
      return connStates.size;
    },

    closeAll() {
      for (const connState of [...connStates]) connState.closed = true;
      connStates.clear();
    },
  };
}
