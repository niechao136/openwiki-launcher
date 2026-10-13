import { spawn } from "node:child_process";
import net from "node:net";
import { formatMessage } from "./jsonrpc.mjs";
import { acquireLock, readLock, releaseLock } from "./lockfile.mjs";
import { createHolderSupervisorAdapter } from "./holder-session.mjs";
import { holderLockPath } from "./paths.mjs";

const CONNECT = { attempts: 3, intervalMs: 500 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeNameFor(hostId, version) {
  return `\\\\.\\pipe\\openwiki-launcher-${hostId}-${version}`;
}

/**
 * 探活一个 holder 管道。成功返回已建立的 socket（调用方负责关闭——
 * 它可能只用于探活或发 shutdown），重试用尽后返回 null 而不是抛错。
 *
 * @param {string} pipeName
 * @param {{ attempts?: number, intervalMs?: number }} [options]
 * @returns {Promise<import("node:net").Socket | null>}
 */
export async function connectToHolder(pipeName, { attempts = CONNECT.attempts, intervalMs = CONNECT.intervalMs } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const socket = await new Promise((resolve) => {
      const s = net.connect(pipeName);
      const timer = setTimeout(() => {
        s.destroy();
        resolve(null);
      }, 1000);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (socket) return socket;
    if (attempt < attempts) await sleep(intervalMs);
  }
  return null;
}

/**
 * detached 拉起 holder。spawn 本身的同步异常向上抛（回退触发点之一）；
 * 异步失败（如 bin 路径错误）由随后的探活兜底。
 *
 * @param {{ hostId: string, cliJs: string, selfBin: string, logger: object }} options
 */
export function spawnHolder({ hostId, cliJs, selfBin, logger }) {
  const child = spawn(process.execPath, [selfBin, "holder", "--host", hostId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, LAUNCHER_BACKEND_CLI: cliJs },
  });
  child.unref();
  child.on("error", (error) => logger.warn(`holder 子进程错误: ${error.message}`));
}

/**
 * wrapper 启动时的 holder 仲裁（规格 §5.2/§5.3）：
 * 探活接入 → 残留 force 重启 → 并发竞争接入 → 版本换血 → 任何失败回退进程内。
 *
 * @param {{
 *   hostId: string,
 *   version: string,
 *   cliJs: string,
 *   logger: object,
 *   pkgRoot?: string,
 *   selfBin?: string,
 *   deps?: { connectFn?: Function, spawnFn?: Function },
 * }} options
 * @returns {Promise<{ mode: "holder", adapter: object } | { mode: "inprocess", reason: string }>}
 */
export async function resolveHolderSession({
  hostId,
  version,
  cliJs,
  logger,
  pkgRoot,
  selfBin,
  deps = {},
}) {
  const connectFn = deps.connectFn ?? connectToHolder;
  const spawnFn = deps.spawnFn ?? spawnHolder;
  const pipeName = pipeNameFor(hostId, version);

  const tryAdopt = async (targetPipe) => {
    const socket = await connectFn(targetPipe);
    if (!socket) return null;
    socket.destroy(); // 探活用；adapter 内部自行建连
    return createHolderSupervisorAdapter({ pipeName: targetPipe, logger });
  };

  const launchAndAdopt = async (ownedLockPath) => {
    try {
      spawnFn({ hostId, cliJs, selfBin, logger });
    } catch (error) {
      // spawn 同步失败（权限、路径）：回退触发点之一（规格 §5.3）
      if (ownedLockPath) releaseLock(ownedLockPath);
      return { mode: "inprocess", reason: `holder 拉起失败: ${error.message}` };
    }
    const adapter = await tryAdopt(pipeName);
    if (adapter) return { mode: "holder", adapter };
    // holder 没起来：释放自己 acquire 的 lockfile，避免给下一个 wrapper 留残留
    if (ownedLockPath) releaseLock(ownedLockPath);
    return { mode: "inprocess", reason: "holder 拉起后管道仍不可达" };
  };

  const lockPath = holderLockPath(hostId, pkgRoot);
  let lock = readLock(lockPath);

  if (lock && lock.version !== version) {
    // 版本换血：礼貌请求旧 holder 退出；连不上才按残留 pid 兜底击杀。
    let oldHolderDown = false;
    if (lock.pipeName) {
      const socket = await connectFn(lock.pipeName, { attempts: 1, intervalMs: 0 });
      if (socket) {
        socket.write(formatMessage({ jsonrpc: "2.0", id: 1, method: "holder/shutdown", params: {} }));
        await sleep(300);
        socket.destroy();
        oldHolderDown = true;
      }
    }
    if (!oldHolderDown && typeof lock.pid === "number") {
      try {
        process.kill(lock.pid);
      } catch {
        // 进程已死——正是我们要的。
      }
    }
    releaseLock(lockPath);
    lock = null;
  }

  if (lock) {
    if (lock.pipeName) {
      const adapter = await tryAdopt(lock.pipeName);
      if (adapter) return { mode: "holder", adapter };
    }
    // 探活失败：残留 lockfile（holder 已死）→ force 覆盖并重启
    acquireLock(lockPath, { pid: process.pid, pipeName, version, startedAt: Date.now() }, { force: true });
    const launched = await launchAndAdopt(lockPath);
    if (launched.mode === "holder") return launched;
    return { mode: "inprocess", reason: launched.reason ?? "残留 lockfile 清理后 holder 仍不可达" };
  }

  const acquired = acquireLock(lockPath, { pid: process.pid, pipeName, version, startedAt: Date.now() });
  if (!acquired.acquired) {
    // 并发对手赢了：探活对手并接入
    if (acquired.existing?.pipeName) {
      const adapter = await tryAdopt(acquired.existing.pipeName);
      if (adapter) return { mode: "holder", adapter };
    }
    // 对手也探活失败：双方都活着但 holder 不在——force 接管
    acquireLock(lockPath, { pid: process.pid, pipeName, version, startedAt: Date.now() }, { force: true });
    const launched = await launchAndAdopt(lockPath);
    if (launched.mode === "holder") return launched;
    return { mode: "inprocess", reason: launched.reason ?? "并发竞争后 holder 仍不可达" };
  }

  const launched = await launchAndAdopt(lockPath);
  if (launched.mode === "holder") return launched;
  return { mode: "inprocess", reason: launched.reason ?? "holder 无法拉起" };
}
