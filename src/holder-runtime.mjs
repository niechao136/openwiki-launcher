import net from "node:net";
import { createBackendSupervisor } from "./backend.mjs";
import { createHolderCore } from "./holder-server.mjs";
import { acquireLock, releaseLock } from "./lockfile.mjs";
import { holderLockPath } from "./paths.mjs";
import { formatMessage, createLineParser } from "./jsonrpc.mjs";

const DEFAULT_TTL_MINUTES = 30;

function pipeNameFor(hostId, version) {
  return `\\\\.\\pipe\\openwiki-launcher-${hostId}-${version}`;
}

// 探活一个 pid：进程存在返回 true（EPERM 视作存在——那是别人的进程）。
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * holder 进程的运行时装配。
 *
 * 启动顺序遵循规格 §5.3：先监听命名管道，再独占 lockfile，最后后台预热
 * openwiki——wrapper 一连上就能排队，不需要等后端就绪。上游预热失败不退出
 * holder：后续调用的 ensureReady 会重试（wrapper 侧的冷却机制约束重试频率）。
 *
 * @param {{
 *   hostId: string,
 *   version: string,
 *   cliJs: string,
 *   logger: { debug(message: string): void, warn(message: string): void, error(message: string): void },
 *   env?: Record<string, string>,
 *   ttlMinutes?: number,
 *   forceLaunch?: boolean,
 *   pkgRoot?: string,
 * }} options
 * @returns {Promise<{ pipeName: string, lockPath: string, exited: Promise<number>, shutdown(): Promise<number> }>}
 * @throws {Error} lockfile 被其他 holder 占用（forceLaunch 未开启）。
 */
export async function runHolder({
  hostId,
  version,
  cliJs,
  logger,
  env = {},
  ttlMinutes = DEFAULT_TTL_MINUTES,
  forceLaunch = false,
  pkgRoot,
}) {
  const pipeName = pipeNameFor(hostId, version);
  const lockPath = holderLockPath(hostId, pkgRoot);

  let lockResult = acquireLock(
    lockPath,
    {
      pid: process.pid,
      pipeName,
      version,
      startedAt: Date.now(),
    },
    { force: forceLaunch },
  );
  if (!lockResult.acquired) {
    // 残留锁（持有者进程已死：上次崩溃、被 kill、worker 自杀）会让 holder 永远
    // 起不来。探活 pid：不存在就强制重取——与 bundle.lock 同一套思路。
    const stalePid = lockResult.existing?.pid;
    if (!forceLaunch && typeof stalePid === "number" && !pidAlive(stalePid)) {
      releaseLock(lockPath);
      lockResult = acquireLock(
        lockPath,
        {
          pid: process.pid,
          pipeName,
          version,
          startedAt: Date.now(),
        },
        { force: true },
      );
    }
  }
  if (!lockResult.acquired) {
    throw new Error(
      `holder lockfile 已被占用（pid=${lockResult.existing?.pid}）；先探活接入，探活失败用 forceLaunch 覆盖`,
    );
  }

  let activeConns = 0;
  let ttlTimer = null;
  let shutdownPromise = null;
  const exitWaiters = [];

  const supervisor = createBackendSupervisor({ cliJs, hostId, logger, env });
  const sockets = new Set();

  const server = net.createServer((socket) => {
    activeConns += 1;
    sockets.add(socket);
    armTtl();
    const parser = createLineParser((message) => messageHandler(message));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => parser.write(chunk));
    const conn = {
      send: (message) => socket.write(formatMessage(message)),
      onMessage: (cb) => (messageHandler = cb),
      onClose: (cb) => socket.on("close", cb),
    };
    let messageHandler = null;
    core.handleConnection(conn);
    socket.on("close", () => {
      sockets.delete(socket);
      activeConns -= 1;
      armTtl();
    });
  });

  const core = createHolderCore({
    supervisor,
    logger,
    version,
    onShutdown: () => shutdown(),
  });

  const armTtl = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
    if (activeConns > 0 || ttlMinutes <= 0) return;
    ttlTimer = setTimeout(() => shutdown(), ttlMinutes * 60_000);
    ttlTimer.unref?.();
  };

  let exitedResolve;
  const exited = new Promise((resolve) => (exitedResolve = resolve));

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise((resolve) => {
      if (ttlTimer) clearTimeout(ttlTimer);
      releaseLock(lockPath);
      supervisor.stop();
      // 销毁所有连接：wrapper 侧要靠 socket close 感知 holder 消失并重连/回退。
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve(0));
      // 有活跃连接时 server.close 等连接排空；给一个宽限，避免永久挂起。
      setTimeout(() => resolve(0), 2000).unref?.();
    });
    exitedResolve(shutdownPromise);
    return shutdownPromise;
  }

  async function awaitShutdown(promise) {
    const code = await promise;
    return code;
  }

  const listenError = await new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(pipeName, () => resolve(null));
  });
  if (listenError) {
    releaseLock(lockPath);
    throw new Error(`holder 管道监听失败: ${listenError.message}`);
  }

  // 后台预热：失败不是致命的（规格 §5.3），首个调用会重试。
  supervisor
    .ensureReady()
    .then(() => logger.debug("holder 上游预热完成"))
    .catch((error) => logger.warn(`holder 上游预热失败，首次调用将重试: ${error.message}`));

  armTtl();

  return {
    pipeName,
    lockPath,
    exited,
    shutdown: () => shutdown(),
  };
}
