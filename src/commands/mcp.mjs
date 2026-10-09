import { createBackendSupervisor } from "../backend.mjs";
import { createBroker } from "../broker.mjs";
import { createLineParser, formatMessage } from "../jsonrpc.mjs";
import { loadManifest } from "../manifest.mjs";
import { OpenwikiNotFoundError, resolveOpenwikiRuntime } from "../paths.mjs";

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
export async function runMcpCommand({ hostId, logger, env = process.env, spawnFn }) {
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

  const supervisor = createBackendSupervisor({ spawnFn, cliJs, hostId, logger });
  const broker = createBroker({
    manifest,
    supervisor,
    logger,
    send: (message) => process.stdout.write(formatMessage(message)),
  });

  const parser = createLineParser((message) => broker.handleClientMessage(message));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => parser.write(chunk));

  await new Promise((resolve) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      broker.handleClientEof();
      resolve();
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });

  return 0;
}
