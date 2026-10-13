import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * holder lockfile 的一等操作。
 *
 * lockfile 是「谁该拉起 holder」的仲裁：两个 wrapper 同时发现没有 holder 时，
 * 只有一方能以独占语义创建文件，另一方从文件里读到对手并接入。探活失败后的
 * 清理路径用 force 覆盖。
 */

/**
 * 独占创建 lockfile。
 *
 * @param {string} lockPath
 * @param {{ pid: number, pipeName: string, version: string, startedAt: number }} data
 * @param {{ force?: boolean }} [options] force 先删除残留再创建（探活失败后的清理路径）。
 * @returns {{ acquired: true } | { acquired: false, existing: object | null }}
 */
export function acquireLock(lockPath, data, { force = false } = {}) {
  if (force) rmSync(lockPath, { force: true });
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      return { acquired: false, existing: readLock(lockPath) };
    }
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return { acquired: true };
}

/**
 * 读取 lockfile 内容。文件缺失或 JSON 损坏都返回 null——调用方把两种情况
 * 同样视为「没有可接入的 holder」，交给独占创建或 force 清理。
 *
 * @param {string} lockPath
 * @returns {object | null}
 */
export function readLock(lockPath) {
  let text;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 幂等删除 lockfile。
 *
 * @param {string} lockPath
 */
export function releaseLock(lockPath) {
  rmSync(lockPath, { force: true });
}
