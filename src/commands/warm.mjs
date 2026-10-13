import { createBackendSupervisor } from "../backend.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { ensureBundleForActive } from "../ensure-bundle.mjs";

/**
 * 预热等待上限。
 *
 * 冷启动实测 5-50s，60s 留了余量；supervisor 内部最坏是 2×120s + 1s 重试，没有上限时
 * `warm` 在后端卡死的情况下会一直挂着，用户只能强杀。install 的自动预热也走这条路径。
 */
const DEFAULT_WARM_TIMEOUT_MS = 60000;

/**
 * 给 promise 加一个上限。超时后原 promise 仍会继续跑，但它的 settle 已被 race 订阅，
 * 不会变成 unhandled rejection。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`预热超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Starts the openwiki backend once, then shuts it down again.
 *
 * This exists so the cost of openwiki's cold import is paid before a host
 * connects, instead of inside the first tool call the user is waiting for.
 *
 * @param {{
 *   logger: object,
 *   resolveRuntime?: Function,
 *   createSupervisor?: Function,
 *   ensureBundleFn?: Function,
 *   hostId?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runWarmCommand({
  logger,
  env = process.env,
  resolveRuntime = resolveOpenwikiRuntime,
  createSupervisor = createBackendSupervisor,
  ensureBundleFn = ensureBundleForActive,
  hostId = "warm",
  timeoutMs = DEFAULT_WARM_TIMEOUT_MS,
}) {
  // §9：先补打当前生效版本的 bundle，再解析运行时——预热直接走 bundle 入口，
  // 顺带验证 bundle 可启动（与 install 收尾 warmAfterInstall 同一顺序）。
  // bundle 失败只警告：它是优化，预热仍以源码入口完成。LAUNCHER_BACKEND_CLI
  // 覆盖（排障路径）时打 bundle 没有意义，跳过。
  if (!env.LAUNCHER_BACKEND_CLI) {
    try {
      const bundleResult = await ensureBundleFn({ logger });
      if (bundleResult && bundleResult.ok === false) {
        logger.warn(`bundle 未就绪（${bundleResult.reason ?? "未知原因"}），本次预热走源码入口`);
      }
    } catch (error) {
      logger.warn(`bundle 补打失败：${error.message}，本次预热走源码入口`);
    }
  }

  let runtime;
  try {
    runtime = await resolveRuntime();
  } catch (error) {
    logger.error(`未找到 openwiki 依赖：${error.message}`);
    return 1;
  }

  const override = env.LAUNCHER_BACKEND_CLI;
  const supervisor = createSupervisor({
    cliJs: override ? override : runtime.cliJs,
    hostId,
    logger,
  });
  const started = Date.now();

  try {
    await withTimeout(supervisor.ensureReady(), timeoutMs);
    logger.info(`openwiki 后端就绪（${Date.now() - started}ms）`);
    return 0;
  } catch (error) {
    logger.error(`预热失败：${error.message}`);
    if (error.stderrTail) logger.error(`后端 stderr：${error.stderrTail}`);
    return 1;
  } finally {
    supervisor.stop();
  }
}
