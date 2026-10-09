import { createRequire } from "node:module";
import { createLogger } from "./log.mjs";
import { runDoctorCommand } from "./commands/doctor.mjs";
import { runMcpCommand } from "./commands/mcp.mjs";
import { runWarmCommand } from "./commands/warm.mjs";
import { nodeVersionSupported } from "./node-version.mjs";

const HOST_ID = /^[a-z0-9-]{1,64}$/u;

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const HELP = [
  "用法:",
  "  openwiki-launcher mcp [--host <id>]   作为 MCP 服务器运行（宿主 MCP 配置指向这里）",
  "  openwiki-launcher warm                 预热 openwiki 后端后退出",
  "  openwiki-launcher doctor               检查环境与 manifest 一致性",
  "  openwiki-launcher help                 显示本帮助",
  "  openwiki-launcher version              显示版本",
].join("\n");

/**
 * Parses `--host` for the mcp command.
 *
 * @param {string[]} args - Arguments after the command name.
 * @param {{ error(message: string): void }} logger - Diagnostics sink.
 * @returns {string | null} Host identifier, or null when input is invalid.
 */
function readHostId(args, logger) {
  let hostId = "unknown";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        logger.error("--host 需要一个宿主标识");
        return null;
      }
      hostId = value;
      index += 1;
    } else if (arg.startsWith("--host=")) {
      hostId = arg.slice("--host=".length);
    } else {
      logger.error(`mcp 命令无法识别的参数: ${arg}`);
      return null;
    }
  }

  if (!HOST_ID.test(hostId)) {
    logger.error("--host 必须是 1-64 lowercase letters, digits, or hyphens");
    return null;
  }
  return hostId;
}

/**
 * Entry point shared by the bin script and the tests.
 *
 * @param {string[]} argv - Arguments after the executable name.
 * @param {{ logger?: object, nodeVersion?: string, env?: Record<string, string> }} deps
 *   Injectable dependencies; tests override the logger and Node version.
 * @returns {Promise<number>} Exit code for the process.
 */
export async function main(argv, deps = {}) {
  const logger =
    deps.logger === undefined
      ? createLogger({ debug: process.env.LAUNCHER_DEBUG === "1" })
      : deps.logger;
  const nodeVersion = deps.nodeVersion === undefined ? process.versions.node : deps.nodeVersion;
  const env = deps.env === undefined ? process.env : deps.env;

  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    logger.info(HELP);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    logger.info(`openwiki-launcher ${pkg.version}`);
    return 0;
  }
  if (!nodeVersionSupported(nodeVersion)) {
    logger.error(
      `openwiki-launcher 需要 Node.js >= 22.22.0，当前 ${nodeVersion}`,
    );
    return 1;
  }

  if (command === "mcp") {
    const hostId = readHostId(rest, logger);
    if (hostId === null) return 1;
    return runMcpCommand({ hostId, logger, env, spawnFn: deps.spawnFn });
  }

  if (command === "warm") {
    return runWarmCommand({
      logger,
      resolveRuntime: deps.resolveRuntime,
      createSupervisor: deps.createSupervisor,
      env,
    });
  }

  if (command === "doctor") {
    return runDoctorCommand({
      logger,
      nodeVersion,
      resolveRuntime: deps.resolveRuntime,
      createSupervisor: deps.createSupervisor,
    });
  }

  if (["install", "uninstall"].includes(command)) {
    logger.info(`${command} 命令将在 openwiki-launcher 0.2.0 提供`);
    return 1;
  }

  logger.info(HELP);
  logger.error(`未知命令: ${command}`);
  return 1;
}
