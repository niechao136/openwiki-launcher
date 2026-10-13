import net from "node:net";
import { createLineParser, formatMessage } from "./jsonrpc.mjs";

/**
 * 把 holder 的管道连接适配成 broker 期望的 supervisor 接口。
 *
 * broker（createBroker）的排队、progress、超时、冷却逻辑原样复用——它只看得到
 * 一个"会话还没就绪"的 supervisor。适配器不负责杀 holder：stop() 只断开自己的
 * 连接（宿主会话结束时 holder 要继续为后续会话服务）。
 *
 * @param {{
 *   pipeName: string,
 *   logger: { debug(message: string): void, warn(message: string): void, error(message: string): void },
 * }} options
 * @returns {{
 *   ensureReady(): Promise<object>,
 *   current(): object | null,
 *   onSessionExit(fn: Function): void,
 *   stop(): void,
 * }}
 */
export function createHolderSupervisorAdapter({ pipeName, logger }) {
  let session = null;
  let starting = null;
  let stopped = false;
  const exitListeners = new Set();

  function notifyExit(info) {
    for (const listener of exitListeners) listener(info);
  }

  function connectSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipeName);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 holder 管道超时: ${pipeName}`));
      }, 1500);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function wireSocket(socket, sessionRecord) {
    const pending = sessionRecord.pending;
    const parser = createLineParser((message) => {
      if (message.invalid !== undefined || message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => parser.write(chunk));
    socket.on("error", (error) => logger.debug(`holder 管道错误: ${error.message}`));
    socket.on("close", () => {
      if (session?.socket === socket) session = null;
      for (const [, entry] of pending) entry.reject(new Error("holder 连接已断开"));
      pending.clear();
      notifyExit({ reason: "holder 连接断开" });
    });
  }

  function requestOverSocket(sessionRecord, method, params) {
    return new Promise((resolve, reject) => {
      const id = sessionRecord.nextId++;
      sessionRecord.pending.set(id, { resolve, reject });
      sessionRecord.socket.write(formatMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async function startSession() {
    const socket = await connectSocket();
    const sessionRecord = { socket, pending: new Map(), nextId: 1 };
    wireSocket(socket, sessionRecord);
    session = sessionRecord;

    const pending = sessionRecord.pending;
    const request = (method, params) => {
      if (socket.destroyed) return Promise.reject(new Error("holder 连接已断开"));
      return requestOverSocket(sessionRecord, method, params);
    };
    // 直通模式（无 manifest）需要上游 initialize 结果；holder 端缓存，
    // 首次调用会触发真正的上游握手。消费者可能不观察 ready（快照模式不读它），
    // 先挂一个空 catch 防 unhandled rejection——backend.mjs 同款处理。
    const ready = request("holder/init", {}).catch((error) => {
      throw new Error(`holder 上游初始化失败: ${error.message}`);
    });
    ready.catch(() => {});

    return {
      socket,
      ready,
      request,
      notify: (method, params) => {
        if (!socket.destroyed) socket.write(formatMessage({ jsonrpc: "2.0", method, params }));
      },
      isRunning: () => !socket.destroyed && session?.socket === socket,
      stop: () => {
        try {
          socket.end();
        } catch {
          // 管道已死时 end 也可能抛；连接本来就要断。
        }
      },
    };
  }

  function ensureReady() {
    if (stopped) return Promise.reject(new Error("adapter 已停止"));
    if (session) return Promise.resolve(session);
    if (starting) return starting;
    starting = startSession()
      .then((created) => {
        starting = null;
        session = created;
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
      if (session) {
        try {
          session.socket.destroy();
        } catch {
          // 管道已死时 destroy 也可能抛；连接本来就要断。
        }
        session = null;
      }
      starting = null;
      // 只断自己的连接；holder 的生死不归 wrapper 管（规格 §5.3）。
    },
  };
}
