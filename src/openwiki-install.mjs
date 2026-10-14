import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { acquireLock, pidAlive, releaseLock } from "./lockfile.mjs";
import { isValidVersion, versionsRoot } from "./versions.mjs";

/**
 * 「往 versions/<版本>/ 写一个 openwiki 版本」的唯一入口。
 *
 * 本模块存在的理由是两条不变量（规格 I5）：
 *
 * 1. **原子性**——安装过程发生在 `versions/.tmp-<版本>-<pid>/`，通过完整性校验
 *    之后才以一次 rename 出现在 `versions/<版本>/`。任何时刻该目录要么不存在、
 *    要么是完整条目；被打断的安装（宿主退出、进程被杀）不会留下一个「看起来装
 *    好了」的版本目录。
 * 2. **互斥**——锁按版本键控。`update` 装 0.7.0、`switch` 装 0.7.0、后台物化
 *    0.7.0 三者互斥，而装 0.6.0 与装 0.7.0 互不影响。
 *
 * 残留判定只有一条规则：持锁进程不在了就是残留（`pidAlive`）。同一个过程里顺带
 * 清掉上一个被杀进程留下的临时目录与原子替换中转目录。
 */

/** 临时目录与替换中转目录的命名：`.tmp-<x.y.z>-<pid>` / `.bak-<x.y.z>-<pid>`。 */
const TEMP_DIR_PATTERN = /^\.(tmp|bak)-(\d+\.\d+\.\d+)-(\d+)$/;

/**
 * 删除上一个进程留下的安装临时目录与替换中转目录。
 *
 * 只认名字匹配且 pid 已消失的目录：名字不匹配的（用户自己放进来的 README、
 * 真正的版本目录）一律不碰，pid 还在的（另一个进程正在装）也一律不碰。
 *
 * @param {string} pkgRoot launcher 包根。
 * @param {{ isPidAlive?: (pid: number) => boolean }} [options] 探活实现（测试注入）。
 * @returns {{ removed: string[] }} 被删除目录的绝对路径。
 */
export function cleanupStaleTempDirs(pkgRoot, { isPidAlive = pidAlive } = {}) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(versionsRoot(pkgRoot));
  } catch (error) {
    if (error.code === "ENOENT") return { removed };
    throw error;
  }

  for (const name of entries) {
    const match = TEMP_DIR_PATTERN.exec(name);
    if (!match) continue;
    const full = path.join(versionsRoot(pkgRoot), name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (isPidAlive(Number(match[3]))) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // 清理失败不影响调用方：它挡不住真正的安装，只是多占一点磁盘。
    }
  }
  return { removed };
}

/**
 * 某个版本的安装锁路径。
 *
 * @param {string} pkgRoot
 * @param {string} version
 * @returns {string}
 */
export function versionLockPath(pkgRoot, version) {
  if (!isValidVersion(version)) {
    throw new Error(`非法的 openwiki 版本名: ${JSON.stringify(version)}（应为 x.y.z）`);
  }
  return path.join(versionsRoot(pkgRoot), `install-${version}.lock`);
}

/**
 * 以版本键控的独占锁运行一段安装逻辑。
 *
 * 拿不到锁不是错误，是「另一个进程正在装同一个版本」——调用方据此降级（等待
 * 下一次触发），而不是排队或重试。锁一定释放：无论 `fn` 正常返回还是抛出。
 *
 * @param {{ pkgRoot: string, version: string, logger?: object,
 *           deps?: { isPidAlive?: (pid: number) => boolean } }} options
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ ok: true, value: any } | { ok: false, reason: "locked" }>}
 */
export async function withVersionLock({ pkgRoot, version, logger, deps = {} }, fn) {
  const isPidAlive = deps.isPidAlive ?? pidAlive;
  cleanupStaleTempDirs(pkgRoot, { isPidAlive });

  const lockPath = versionLockPath(pkgRoot, version);
  const payload = { pid: process.pid, version, startedAt: Date.now() };
  let lock = acquireLock(lockPath, payload);

  if (!lock.acquired) {
    // 残留锁（持锁进程已死，或文件内容损坏读不出 pid）会让这个版本永远装不上，
    // 必须能强制重取。持有者还活着才是真的「别人在装」。
    const holder = lock.existing?.pid;
    if (typeof holder !== "number" || !isPidAlive(holder)) {
      releaseLock(lockPath);
      lock = acquireLock(lockPath, payload);
    }
  }

  if (!lock.acquired) {
    logger?.debug?.(`另一个进程正在安装 openwiki@${version}，本次跳过`);
    return { ok: false, reason: "locked" };
  }

  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseLock(lockPath);
  }
}
