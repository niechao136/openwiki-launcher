import os from "node:os";
import { createLogger } from "./log.mjs";
import { runDoctorCommand } from "./commands/doctor.mjs";
import { runMcpCommand } from "./commands/mcp.mjs";
import { runWarmCommand } from "./commands/warm.mjs";
import { runInstallCommand, parseInstallArgs } from "./commands/install.mjs";
import { runCheckCommand } from "./commands/check.mjs";
import { runUpdateCommand } from "./commands/update.mjs";
import { runSwitchCommand } from "./commands/switch.mjs";
import { runVersionsCommand } from "./commands/versions.mjs";
import { resolveSelfBin } from "./self-path.mjs";
import { nodeVersionSupported } from "./node-version.mjs";
import { launcherVersion } from "./pkg.mjs";
import { launcherPackageRoot } from "./versions.mjs";

const HOST_ID = /^[a-z0-9-]{1,64}$/u;

const HELP = [
  "用法:",
  "  openwiki-launcher [install]              安装到自动检测到的宿主（项目级）",
  "  openwiki-launcher --global               用户级安装",
  "  openwiki-launcher --tool <id>            指定宿主安装",
  "  openwiki-launcher --uninstall [--global] 卸载",
  "  openwiki-launcher --force                允许项目级安装落到用户主目录",
  "  openwiki-launcher --no-takeover          遇到 openwiki 原生安装时跳过而非接管",
  "  openwiki-launcher --bootstrap            额外写引导文件（0.2.0 未启用，仅提示）",
  "  openwiki-launcher --no-warm              安装后不自动预热（默认会预热一次）",
  "  openwiki-launcher mcp [--host <id>]      作为 MCP 服务器运行（宿主 MCP 配置指向这里）",
  "  openwiki-launcher warm                    预热 openwiki 后端后退出",
  "  openwiki-launcher doctor                  检查环境、manifest 与已写入的 MCP 命令",
  "  openwiki-launcher check                   查看本地 openwiki 版本状态（当前/已装/registry）",
  "  openwiki-launcher update [--version <v>]  升级 openwiki（交互确认；--no-switch 只装不切）",
  "  openwiki-launcher switch <version>        切换当前生效的 openwiki 版本",
  "  openwiki-launcher versions remove <v>     删除一个已安装的 openwiki 版本",
  "  openwiki-launcher help                    显示本帮助",
  "  openwiki-launcher version                 显示版本",
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
    logger.info(`openwiki-launcher ${launcherVersion()}`);
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
    const installDeps = cliDeps(deps, logger);
    return runDoctorCommand({
      logger,
      nodeVersion,
      resolveRuntime: deps.resolveRuntime,
      createSupervisor: deps.createSupervisor,
      scope: installDeps.scope ?? "project",
      baseDir: installDeps.cwd,
      homeDir: installDeps.homeDir,
      platform: installDeps.platform,
      nodeCommand: installDeps.nodeCommand,
      selfBin: installDeps.selfBin,
    });
  }

  if (command === "install" || command === "uninstall") {
    const parsed = parseInstallArgs(command === "uninstall" ? [...rest, "--uninstall"] : rest);
    if (parsed.error) {
      logger.error(parsed.error);
      return 1;
    }
    return runInstallCommand(parsed.flags, cliDeps(deps, logger));
  }

  if (command === "check") {
    return runCheckCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      resolveRuntime: deps.resolveRuntime,
      runNpm: deps.runNpm,
    });
  }

  if (command === "update") {
    return runUpdateCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      args: rest,
      runNpm: deps.runNpm,
      confirm: deps.confirm,
      resolveRuntime: deps.resolveRuntime,
      writeSnapshot: deps.writeSnapshot,
    });
  }

  if (command === "switch") {
    return runSwitchCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      version: rest[0],
      runNpm: deps.runNpm,
      confirm: deps.confirm,
      resolveRuntime: deps.resolveRuntime,
      writeSnapshot: deps.writeSnapshot,
    });
  }

  if (command === "versions") {
    return runVersionsCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      args: rest,
    });
  }

  // 裸用法：`openwiki-launcher` 或 `openwiki-launcher --tool claude` 都走安装
  if (command === undefined || command.startsWith("-")) {
    const parsed = parseInstallArgs(argv);
    if (parsed.error) {
      logger.error(parsed.error);
      return 1;
    }
    return runInstallCommand(parsed.flags, cliDeps(deps, logger));
  }

  logger.info(HELP);
  logger.error(`未知命令: ${command}`);
  return 1;
}

/**
 * 把 main 的 deps 组装成 install / uninstall 需要的形状，并补齐缺省值。
 *
 * @param {object} deps main 的 deps
 * @param {object} logger
 * @returns {object}
 */
function cliDeps(deps, logger) {
  return {
    logger,
    cwd: deps.cwd ?? process.cwd(),
    homeDir: deps.homeDir ?? os.homedir(),
    // doctor 用它决定去哪里读已写入的 MCP 配置；install/uninstall 不用这个字段。
    scope: deps.scope,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    exists: deps.exists,
    nodeCommand: deps.nodeCommand,
    selfBin: deps.selfBin ?? resolveSelfBin(import.meta.url),
    launcherVersion: deps.launcherVersion ?? launcherVersion(),
    bundleDir: deps.bundleDir,
    // install 的自动预热要能被测试替掉，否则每个安装用例都会去 spawn 真实后端。
    warmFn: deps.warmFn,
    now: deps.now,
  };
}
