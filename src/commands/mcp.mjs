import { createBackendSupervisor } from "../backend.mjs";
import { createBroker } from "../broker.mjs";
import { createLineParser, formatMessage } from "../jsonrpc.mjs";
import { loadManifest } from "../manifest.mjs";
import path from "node:path";
import { OpenwikiNotFoundError, resolveOpenwikiRuntime } from "../paths.mjs";
import { scheduleBackgroundBundle, createBundleFallbackSupervisor } from "../ensure-bundle.mjs";
import { resolveHolderSession } from "../holder-client.mjs";
import { resolveSelfBin } from "../self-path.mjs";

const DEFAULT_QUEUE_TIMEOUT_MS = 25000;

/**
 * 解析 tools/call 排队上限。宿主对单个请求的超时普遍在 30~60 秒量级，
 * 排队上限必须小于它，宿主才能在放弃前收到 wrapper 的可重试错误而不是
 * 自己先超时。非法配置回退默认值。
 *
 * @param {Record<string, string>} env
 * @returns {number}
 */
export function queueTimeoutFromEnv(env) {
  const raw = env.LAUNCHER_QUEUE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_QUEUE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_QUEUE_TIMEOUT_MS;
  return parsed;
}

/**
 * Runs the launcher as the MCP server a coding host talks to.
 *
 * The handshake is answered from the manifest, so the host is unblocked in
 * milliseconds; the openwiki backend starts in the background and serves tool
 * calls as soon as it is up.
 *
 * @param {{
 *   hostId: string,
 *   logger: object,
 *   env?: Record<string, string>,
 *   spawnFn?: Function,
 * }} options
 * @returns {Promise<number>} Process exit code.
 */
export async function runMcpCommand({ hostId, logger, env = process.env, spawnFn, deps = {} }) {
  const startedAt = Date.now();
  let runtime;
  try {
    runtime = await resolveOpenwikiRuntime();
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
  const cliJs = override ? override : runtime.cliJs;
  if (override) {
    logger.debug(`使用 LAUNCHER_BACKEND_CLI 指定的后端入口: ${override}`);
  }

  const manifest = loadManifest(runtime.version);
  if (!manifest) {
    logger.warn(
      `未找到 openwiki ${runtime.version} 的 manifest，改为直通模式：首次工具调用需等待后端启动`,
    );
  }

  // LAUNCHER_HOLDER=1 时尝试接入/拉起常驻 holder（规格 §5.3）。
  // 默认关闭：逐宿主 detached 存活验收（规格 §8）完成后再改默认。
  let supervisor;
  if (env.LAUNCHER_HOLDER === "1") {
    const resolved = await resolveHolderSession({
      hostId,
      version: runtime.version,
      cliJs,
      logger,
      selfBin: resolveSelfBin(import.meta.url),
    });
    if (resolved.mode === "holder") {
      logger.debug(`已接入 openwiki holder（host=${hostId}）`);
      supervisor = resolved.adapter;
    } else {
      logger.warn(`holder 不可用，回退进程内 supervisor：${resolved.reason}`);
      supervisor = createBackendSupervisor({ spawnFn, cliJs, hostId, logger });
    }
  } else {
    supervisor = createBackendSupervisor({ spawnFn, cliJs, hostId, logger });
    // §9：bundle 启动失败（就绪前崩溃）时换源码入口兜底一次，并写 bundle.bad。
    // override（LAUNCHER_BACKEND_CLI，测试/排障）不掺和 bundle 语义。
    if (runtime.backend === "bundle" && !override) {
      supervisor = createBundleFallbackSupervisor({
        primary: supervisor,
        makeFallback: () =>
          createBackendSupervisor({ spawnFn, cliJs: runtime.sourceCliJs, hostId, logger }),
        bundleCliJs: runtime.cliJs,
        sourceCliJs: runtime.sourceCliJs,
        badPath: path.join(path.dirname(runtime.cliJs), "bundle.bad"),
        logger,
      });
    }
  }
  // §9：缺 bundle（backend=source）时，等后端就绪后后台补打，不占冷启动关键路径。
  // override 模式下不补打：测试/排障显式指定了入口，不该触发真构建。
  if (!override) {
    scheduleBackgroundBundle({
      runtime,
      pkgRoot: runtime.packageRoot,
      logger,
      supervisor,
      ensureBundleFn: deps?.ensureBundleFn,
    });
  }
  const broker = createBroker({
    manifest,
    supervisor,
    logger,
    send: (message) => process.stdout.write(formatMessage(message)),
    queueTimeoutMs: queueTimeoutFromEnv(env),
  });

  // Prewarm the backend in the background. The handshake and the tool list are
  // answered from the manifest, so the backend's cold start (tens of seconds on
  // Windows) overlaps with the time the host spends between connecting and the
  // first tool call. Without this the first tools/call of every session waits
  // out the full import and trips the host's own request timeout. A failure
  // here is not fatal: the call queues and retries when it actually arrives.
  if (env.LAUNCHER_EAGER_START !== "0") {
    const prewarmStarted = Date.now();
    supervisor
      .ensureReady()
      .then(() =>
        logger.debug(
          `后端预热完成，耗时 ${Date.now() - prewarmStarted}ms（距启动 ${Date.now() - startedAt}ms）`,
        ),
      )
      .catch((error) =>
        logger.warn(`后端预热失败，首次工具调用将重试: ${error.message}`),
      );
  }

  const parser = createLineParser((message) => broker.handleClientMessage(message));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => parser.write(chunk));

  // A host that tears the pipe down must not surface as an uncaught exception:
  // that would kill the process instead of shutting it down cleanly.
  process.stdin.on("error", (error) => logger.debug(`stdin 结束: ${error.message}`));
  process.stdout.on("error", (error) => logger.debug(`stdout 结束: ${error.message}`));

  await new Promise((resolve) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      // Flush a trailing message that arrived without a newline before tearing
      // the broker down.
      parser.end();
      broker.handleClientEof();
      resolve();
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    // Hosts usually end the session by closing stdin, but a signal must not
    // leave the openwiki backend running as an orphan.
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    process.on("exit", () => supervisor.stop());
  });

  return 0;
}
