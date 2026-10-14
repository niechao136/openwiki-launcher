import { resolveHolderSession } from "../holder-client.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { resolveSelfBin } from "../self-path.mjs";
import { ensureDefaultVersion, prepareEnabled } from "../ensure-default.mjs";

const DEFAULT_WARMUP_TIMEOUT_MS = 60000;
const STATUS_POLL_MS = 500;

/**
 * 登录时预热：确保指定宿主的 holder 已拉起且 openwiki 后端就绪。
 *
 * 与 `warm` 的区别：warm 拉起后端就退出（只留 OS 文件缓存），warmup 拉起的是
 * 常驻 holder（TTL 内的所有会话直接接入热后端）。挂到登录启动项即可在每天
 * 第一次会话前把冷启动付掉。
 *
 * @param {{
 *   hostId: string,
 *   logger: object,
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 *   deps?: { holderDeps?: { connectFn?: Function, spawnFn?: Function } },
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runWarmupCommand({
  hostId,
  logger,
  env = process.env,
  timeoutMs = DEFAULT_WARMUP_TIMEOUT_MS,
  ensureDefaultVersionFn = ensureDefaultVersion,
  deps = {},
}) {
  // 与 warm 同一顺序：就绪动作先行，再解析运行时。登录启动项是"让当天第一个
  // 会话别付全款冷启动"的通道，默认版本没就绪时它也该把就绪补上。
  if (!env.LAUNCHER_BACKEND_CLI && prepareEnabled(env)) {
    try {
      const prepared = await ensureDefaultVersionFn({ mode: "explicit", logger, env });
      if (prepared?.ok !== true) {
        logger.warn(`默认版本未就绪（${prepared?.reason ?? "未知原因"}）`);
      }
    } catch (error) {
      logger.warn(`默认版本就绪失败：${error.message}`);
    }
  }

  let runtime;
  try {
    runtime = await resolveOpenwikiRuntime();
  } catch (error) {
    logger.error(`未找到 openwiki 依赖：${error.message}`);
    return 1;
  }

  const override = env.LAUNCHER_BACKEND_CLI;
  const cliJs = override ? override : runtime.cliJs;
  const started = Date.now();

  let adapter;
  try {
    const resolved = await resolveHolderSession({
      hostId,
      version: runtime.version,
      cliJs,
      logger,
      selfBin: resolveSelfBin(import.meta.url),
      deps: deps.holderDeps ?? {},
    });
    if (resolved.mode !== "holder") {
      logger.error(`holder 无法拉起：${resolved.reason ?? "未知原因"}（可改用 openwiki-launcher warm 预热）`);
      return 1;
    }
    adapter = resolved.adapter;
  } catch (error) {
    logger.error(`holder 接入失败：${error.message}`);
    return 1;
  }

  try {
    const session = await adapter.ensureReady();
    const deadline = started + timeoutMs;
    for (;;) {
      const status = await session.request("holder/status", {});
      if (status.backendReady) {
        logger.info(`openwiki holder 后端就绪（${Date.now() - started}ms）`);
        return 0;
      }
      if (Date.now() > deadline) {
        logger.error(`预热超时（${timeoutMs}ms）：holder 已就绪但后端未在时限内启动`);
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }
  } catch (error) {
    logger.error(`预热失败：${error.message}`);
    return 1;
  } finally {
    // 断开自己的连接；holder 的空闲 TTL 从此刻重新起算
    adapter.stop();
  }
}
