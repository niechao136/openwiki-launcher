import { createBackendSupervisor } from "../backend.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";

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
 *   hostId?: string,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runWarmCommand({
  logger,
  env = process.env,
  resolveRuntime = resolveOpenwikiRuntime,
  createSupervisor = createBackendSupervisor,
  hostId = "warm",
}) {
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
    await supervisor.ensureReady();
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
