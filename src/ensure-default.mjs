import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureBundle } from "./ensure-bundle.mjs";
import { manifestFilePath } from "./manifest.mjs";
import { installAndSnapshot, installVersion } from "./openwiki-install.mjs";
import { bundledOpenwikiVersion } from "./paths.mjs";
import { isInstalled, versionsRoot } from "./versions.mjs";

/**
 * 「默认版本」（出厂依赖 `node_modules/openwiki`）的就绪动作。
 *
 * 它把出厂依赖物化成 `versions/<版本>/` 里的一个真实条目并备好 bundle，使默认
 * 版本在版本仓库里与其它版本平权：`switch` 回去是毫秒级指针翻转，`check` /
 * `doctor` 口径一致，bundle 也落在解析层真正会读的位置。
 *
 * 两种模式：
 * - `explicit`（用户显式命令：install / warm / warmup / switch）——无视删除标记
 *   与失败退避，成功后清掉它们；
 * - `self-heal`（后台自愈：mcp 会话 / update 前置）——尊重删除标记（用户删过的
 *   不要自己长回来）与失败退避（离线时不要每个新会话都重试几百 MB）。
 *
 * 所有失败都软着陆：不写版本指针、不改变 `install` / `update` 的退出码。
 */

/** 用户显式删除默认版本后留下的标记文件（versions/ 下）。 */
export const DEFAULT_REMOVED_FILE = "default-removed.json";
/** 上一次就绪失败与下次允许重试的时间（versions/ 下）。 */
export const PREPARE_FAILED_FILE = "prepare-failed.json";
/** 自愈失败后的默认退避时长（小时）。 */
export const DEFAULT_BACKOFF_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * 就绪动作是否被允许。
 *
 * `--no-prepare`（install 命令）与环境变量 `LAUNCHER_PREPARE=0` 等价，风格与既有的
 * `LAUNCHER_EAGER_START=0` 一致——运行时的自愈路径没有命令行参数可传。
 *
 * @param {Record<string, string>} [env]
 * @param {{ noPrepare?: boolean }} [options]
 * @returns {boolean}
 */
export function prepareEnabled(env = process.env, { noPrepare = false } = {}) {
  if (noPrepare) return false;
  return env?.LAUNCHER_PREPARE !== "0";
}

/**
 * 失败退避时长（毫秒）。`0` 表示关闭退避；非法值回退默认值。
 *
 * @param {Record<string, string>} [env]
 * @returns {number}
 */
export function backoffMsFromEnv(env = process.env) {
  const raw = env?.LAUNCHER_PREPARE_BACKOFF_HOURS;
  if (raw === undefined) return DEFAULT_BACKOFF_HOURS * HOUR_MS;
  const hours = Number.parseInt(raw, 10);
  if (!Number.isInteger(hours) || hours < 0) return DEFAULT_BACKOFF_HOURS * HOUR_MS;
  return hours * HOUR_MS;
}

function markerPath(pkgRoot, name) {
  return path.join(versionsRoot(pkgRoot), name);
}

/**
 * 读一个标记；文件缺失或损坏都返回 null（调用方按"没有标记"处理）。
 *
 * @param {string} pkgRoot
 * @param {string} name
 * @returns {object | null}
 */
export function readMarker(pkgRoot, name) {
  try {
    return JSON.parse(readFileSync(markerPath(pkgRoot, name), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 写一个标记。写失败只是丢一层保护，不该让就绪动作本身失败。
 *
 * @param {string} pkgRoot
 * @param {string} name
 * @param {object} data
 */
export function writeMarker(pkgRoot, name, data) {
  try {
    mkdirSync(versionsRoot(pkgRoot), { recursive: true });
    writeFileSync(markerPath(pkgRoot, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：标记只是优化与保护，不是正确性前提。
  }
}

/**
 * 幂等删除标记。
 *
 * @param {string} pkgRoot
 * @param {string} name
 */
export function clearMarker(pkgRoot, name) {
  rmSync(markerPath(pkgRoot, name), { force: true });
}

/**
 * 记录"用户显式删除了默认版本"，让自愈类触发点不再把它重建。
 *
 * @param {string} pkgRoot
 * @param {string} version
 */
export function markDefaultRemoved(pkgRoot, version) {
  writeMarker(pkgRoot, DEFAULT_REMOVED_FILE, { version, removedAt: new Date().toISOString() });
}

/**
 * 记录一次就绪失败与下次允许自动重试的时间。
 *
 * @param {string} pkgRoot
 * @param {string} version
 * @param {string} reason
 * @param {Record<string, string>} [env]
 * @param {number} [now]
 * @returns {boolean} 是否真的写了标记（退避关闭时为 false）。
 */
export function markPrepareFailed(pkgRoot, version, reason, env = process.env, now = Date.now()) {
  const backoffMs = backoffMsFromEnv(env);
  if (backoffMs <= 0) return false;
  writeMarker(pkgRoot, PREPARE_FAILED_FILE, {
    version,
    at: new Date(now).toISOString(),
    nextRetryAt: now + backoffMs,
    reason,
  });
  return true;
}

/**
 * 确保默认版本在版本仓库里就绪（物化 + 快照 + bundle）。
 *
 * @param {{
 *   pkgRoot: string, logger: object,
 *   mode?: "explicit" | "self-heal",
 *   hostId?: string, env?: Record<string, string>, runNpm?: Function,
 *   priority?: "normal" | "below-normal",
 *   deps?: {
 *     installVersionFn?: Function, installAndSnapshotFn?: Function,
 *     ensureBundleFn?: Function, now?: () => number,
 *   },
 * }} options
 * @returns {Promise<
 *   { ok: true, version: string, installed?: boolean, snapshot?: boolean, skipped?: "removed" | "backoff" }
 *   | { ok: false, stage: "version" | "locked" | "install" | "verify", reason: string }
 * >}
 */
export async function ensureDefaultVersion({
  pkgRoot,
  logger,
  mode = "explicit",
  hostId = "prepare",
  env = process.env,
  runNpm,
  priority = "normal",
  deps = {},
}) {
  const installVersionFn = deps.installVersionFn ?? installVersion;
  const installAndSnapshotFn = deps.installAndSnapshotFn ?? installAndSnapshot;
  const ensureBundleFn = deps.ensureBundleFn ?? ensureBundle;
  const now = deps.now ? deps.now() : Date.now();
  const background = priority === "below-normal";

  const version = bundledOpenwikiVersion(pkgRoot);
  if (!version) {
    return {
      ok: false,
      stage: "version",
      reason: "无法确定出厂依赖的版本（node_modules/openwiki/package.json 不可读）",
    };
  }

  if (mode === "self-heal") {
    const removed = readMarker(pkgRoot, DEFAULT_REMOVED_FILE);
    if (removed?.version === version) return { ok: true, version, skipped: "removed" };
    const failed = readMarker(pkgRoot, PREPARE_FAILED_FILE);
    if (failed?.version === version && typeof failed.nextRetryAt === "number" && failed.nextRetryAt > now) {
      return { ok: true, version, skipped: "backoff" };
    }
  }

  if (!runNpm && (typeof deps.installVersionFn !== "function" || typeof deps.installAndSnapshotFn !== "function")) {
    return { ok: false, stage: "install", reason: "未提供 npm 执行器" };
  }

  const started = Date.now();
  if (background) logger?.info?.(`开始后台就绪默认版本 openwiki@${version}（低优先级）`);

  const snapshotExists = existsSync(manifestFilePath(version, pkgRoot));
  const installedAlready = isInstalled(pkgRoot, version);

  let installed = false;
  let snapshot = false;
  let outcome;
  if (snapshotExists && installedAlready) {
    // 出厂版本的快照随包发布，已就绪时连后端都不该启一次。
    outcome = { ok: true };
  } else if (snapshotExists) {
    installed = true;
    outcome = await installVersionFn({ pkgRoot, version, runNpm, logger, priority, deps });
  } else {
    installed = !installedAlready;
    snapshot = true;
    outcome = await installAndSnapshotFn({ pkgRoot, version, runNpm, logger, hostId, priority, deps });
  }

  if (outcome.ok !== true) {
    if (outcome.stage === "snapshot") {
      // 快照录不到不阻塞就绪：没有快照的版本以直通模式运行，是设计好的兜底。
      const reason = outcome.error?.message ?? "未知原因";
      logger?.warn?.(`快照录制失败：${reason}（openwiki@${version} 将以直通模式运行）`);
      snapshot = false;
    } else {
      const reason = outcome.reason ?? outcome.error?.message ?? "未知原因";
      if (background) logger?.info?.(`后台就绪失败：${reason}`);
      logger?.warn?.(`默认版本 openwiki@${version} 就绪失败（${outcome.stage ?? "install"}）：${reason}`);
      if (mode === "self-heal") markPrepareFailed(pkgRoot, version, reason, env, now);
      return { ok: false, stage: outcome.stage ?? "install", reason };
    }
  }

  if (mode === "explicit") {
    clearMarker(pkgRoot, PREPARE_FAILED_FILE);
    clearMarker(pkgRoot, DEFAULT_REMOVED_FILE);
  }

  const bundleResult = await ensureBundleFn({ version, pkgRoot, logger }).catch((error) => ({
    ok: false,
    reason: error.message,
  }));
  if (bundleResult?.ok !== true) {
    logger?.warn?.(`bundle 未就绪（${bundleResult?.reason ?? "未知原因"}），该版本将以源码入口启动，冷启动较慢`);
  }

  if (background) logger?.info?.(`后台就绪完成（${Date.now() - started}ms）`);
  return { ok: true, version, installed, snapshot };
}
