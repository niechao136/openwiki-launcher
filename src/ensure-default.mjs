import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundleStatus, ensureBundle } from "./ensure-bundle.mjs";
import { manifestFilePath } from "./manifest.mjs";
import { defaultRunNpm, installAndSnapshot, installVersion } from "./openwiki-install.mjs";
import { bundledOpenwikiVersion } from "./paths.mjs";
import { isInstalled, launcherPackageRoot, versionsRoot } from "./versions.mjs";

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
 * 默认版本此刻处于哪一态。doctor 与 check 共用同一份判定，两个界面口径不会分叉。
 *
 * @param {string} [pkgRoot]
 * @param {{ now?: number }} [options]
 * @returns {{
 *   version: string | null,
 *   state: "unknown" | "removed" | "backoff" | "missing" | "installed-no-bundle" | "ready",
 *   nextRetryAt?: number, reason?: string,
 * }}
 */
export function defaultVersionState(pkgRoot = launcherPackageRoot(), { now = Date.now() } = {}) {
  const version = bundledOpenwikiVersion(pkgRoot);
  if (!version) return { version: null, state: "unknown" };

  const installed = isInstalled(pkgRoot, version);
  if (!installed) {
    const removed = readMarker(pkgRoot, DEFAULT_REMOVED_FILE);
    if (removed?.version === version) return { version, state: "removed" };
    const failed = readMarker(pkgRoot, PREPARE_FAILED_FILE);
    if (failed?.version === version && typeof failed.nextRetryAt === "number" && failed.nextRetryAt > now) {
      return { version, state: "backoff", nextRetryAt: failed.nextRetryAt, reason: failed.reason };
    }
    return { version, state: "missing" };
  }
  return { version, state: bundleStatus(pkgRoot, version) === "ready" ? "ready" : "installed-no-bundle" };
}

/**
 * 把 `defaultVersionState` 的结果翻成一行可读文案。
 *
 * @param {ReturnType<typeof defaultVersionState>} state
 * @returns {string}
 */
export function defaultVersionStateLabel(state) {
  switch (state.state) {
    case "ready":
      return "✓ 已就绪";
    case "installed-no-bundle":
      return "! 已物化但无 bundle（冷启动较慢）";
    case "missing":
      return "! 未就绪（还没进版本仓库）";
    case "removed":
      return "已删除（不会自动重建）";
    case "backoff": {
      const when = typeof state.nextRetryAt === "number" ? new Date(state.nextRetryAt).toISOString() : "稍后";
      return `上次就绪失败，退避中（${when} 后重试）`;
    }
    case "unknown":
      return "无法确定（node_modules/openwiki 不可读）";
    default:
      return "状态未知";
  }
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
  pkgRoot = launcherPackageRoot(),
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

  // `warm` / `warmup` / `mcp` 后台自愈这三个触发点没有执行器可传，必须在这里兜底：
  // 少了它，物化会静默失败，而自愈还会把这次失败记进 24h 退避，把修复通道彻底堵死。
  const runNpmFn = runNpm ?? defaultRunNpm;

  const started = Date.now();
  if (background) logger?.info?.(`开始后台就绪默认版本 openwiki@${version}（低优先级）`);

  const snapshotExists = existsSync(manifestFilePath(version, pkgRoot));
  const installedAlready = isInstalled(pkgRoot, version);

  let installed = false;
  let snapshot = false;
  let outcome;
  try {
    if (snapshotExists && installedAlready) {
      // 出厂版本的快照随包发布，已就绪时连后端都不该启一次。
      outcome = { ok: true };
    } else if (snapshotExists) {
      installed = true;
      outcome = await installVersionFn({ pkgRoot, version, runNpm: runNpmFn, logger, priority, deps });
    } else {
      installed = !installedAlready;
      snapshot = true;
      outcome = await installAndSnapshotFn({ pkgRoot, version, runNpm: runNpmFn, logger, hostId, priority, deps });
    }
  } catch (error) {
    // 安装内核自己就会软着陆；能落到这里的是没被兜住的抛错（如 rename 被占用）。
    // 就绪动作永远不许把异常丢给宿主——否则宿主看到的是栈，而不是可诊断的原因。
    outcome = { ok: false, stage: "install", reason: error.message };
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

/**
 * MCP 会话的后台自愈：等后端就绪之后，按运行时来源决定补什么。
 *
 * 为什么延后到后端就绪之后：冷启动的瓶颈是文件 IO，构建与 npm install 的
 * CPU/磁盘占用与它同时发生只会互相拖慢（规格 §9「后台构建的时机」）。用户
 * 那一侧已经用起来了，这些活儿排在后面做、而且降优先级。
 *
 * 分流：
 * - `source === "bundled"`：默认版本还没进版本仓库 → 就绪它（物化 + bundle）；
 * - `source === "versions" && backend === "source"`：条目齐全但缺 bundle → 只补 bundle；
 * - 其余（已在用 bundle）什么都不做。
 *
 * @param {{
 *   runtime: { source?: string, backend?: string, version?: string },
 *   pkgRoot: string, logger: object, supervisor: { ensureReady(): Promise<object> },
 *   env?: Record<string, string>,
 *   deps?: { ensureDefaultVersionFn?: Function, ensureBundleFn?: Function },
 * }} options
 */
export function scheduleBackgroundPrepare({ runtime, pkgRoot, logger, supervisor, env = process.env, deps = {} }) {
  if (!prepareEnabled(env)) return;

  supervisor
    .ensureReady()
    .then(() => {
      if (runtime.source === "bundled") {
        return (deps.ensureDefaultVersionFn ?? ensureDefaultVersion)({
          mode: "self-heal",
          priority: "below-normal",
          pkgRoot,
          logger,
          env,
        });
      }
      if (runtime.backend === "source") {
        return (deps.ensureBundleFn ?? ensureBundle)({ version: runtime.version, pkgRoot, logger });
      }
      return null;
    })
    .then((result) => {
      if (result && result.ok !== true) {
        logger?.warn?.(`后台就绪未完成：${result.reason ?? "未知原因"}`);
      }
    })
    .catch((error) => logger?.warn?.(`后台就绪未完成：${error.message}`));
}
