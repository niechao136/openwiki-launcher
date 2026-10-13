import { runHolder } from "../holder-runtime.mjs";
import { OpenwikiNotFoundError, resolveOpenwikiRuntime } from "../paths.mjs";

const DEFAULT_TTL_MINUTES = 30;

/**
 * `openwiki-launcher holder --host <id>`：以 detached 方式被 wrapper 拉起的
 * 常驻进程。持有 openwiki 后端、服务命名管道上的多个 wrapper 连接，空闲
 * 超过 TTL 自动退出。不作为用户手敲的入口（预热请用 `warm` / `warmup`）。
 *
 * @param {{
 *   hostId: string,
 *   logger: object,
 *   env?: Record<string, string>,
 *   pkgRoot?: string,
 *   forceLaunch?: boolean,
 * }} options
 * @returns {Promise<number>} Process exit code.
 */
export async function runHolderCommand({ hostId, logger, env = process.env, pkgRoot, forceLaunch = false }) {
  // 排障/测试钩子：把 holder 的锁与管道指向另一个包根（lockfile 与版本目录都在 pkgRoot/versions/ 下）
  pkgRoot = env.LAUNCHER_HOLDER_PKG_ROOT || pkgRoot;
  let runtime;
  try {
    runtime = await resolveOpenwikiRuntime({ pkgRoot });
  } catch (error) {
    if (error instanceof OpenwikiNotFoundError) {
      logger.error(error.message);
      logger.error("openwiki-launcher 自带 openwiki 依赖，请重新安装本包。");
    } else {
      logger.error(`解析 openwiki 运行时失败: ${error.message}`);
    }
    return 1;
  }

  const override = env.LAUNCHER_BACKEND_CLI;
  const cliJs = override ?? runtime.cliJs;

  const rawTtl = env.LAUNCHER_HOLDER_TTL_MINUTES;
  const parsedTtl = Number(rawTtl);
  const ttlMinutes = rawTtl !== undefined && Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TTL_MINUTES;

  try {
    const holder = await runHolder({
      hostId,
      version: runtime.version,
      cliJs,
      logger,
      env: { LAUNCHER_BACKEND_CLI: cliJs },
      ttlMinutes,
      forceLaunch,
      pkgRoot,
    });
    logger.debug(`holder 已就绪：${holder.pipeName}（TTL ${ttlMinutes} 分钟）`);
    const code = await holder.exited;
    return code;
  } catch (error) {
    logger.error(`holder 启动失败: ${error.message}`);
    return 1;
  }
}
