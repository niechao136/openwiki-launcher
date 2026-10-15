import os from "node:os";
import { createLogger } from "./log.mjs";
import { runDoctorCommand } from "./commands/doctor.mjs";
import { runHolderCommand } from "./commands/holder.mjs";
import { runMcpCommand } from "./commands/mcp.mjs";
import { runWarmCommand } from "./commands/warm.mjs";
import { runWarmupCommand } from "./commands/warmup.mjs";
import { runInstallCommand, parseInstallArgs } from "./commands/install.mjs";
import { runCheckCommand } from "./commands/check.mjs";
import { runUpdateCommand } from "./commands/update.mjs";
import { runSwitchCommand } from "./commands/switch.mjs";
import { runVersionsCommand } from "./commands/versions.mjs";
import { resolveSelfBin } from "./self-path.mjs";
import { nodeVersionSupported } from "./node-version.mjs";
import { launcherVersion } from "./pkg.mjs";
import { launcherPackageRoot } from "./versions.mjs";
import { runOpenwikiCli } from "./openwiki-cli.mjs";

const HOST_ID = /^[a-z0-9-]{1,64}$/u;

const HELP = [
  "用法:",
  "  （owl 与 openwiki-launcher 是同一个命令；ow 是 openwiki 的透传入口）",
  "  owl [install]                 安装到自动检测到的宿主（项目级）",
  "  owl --global                  用户级安装",
  "  owl --tool <id>               指定宿主安装",
  "  owl --uninstall [--global]    卸载",
  "  owl --force                   允许项目级安装落到用户主目录",
  "  owl --no-takeover             遇到 openwiki 原生安装时跳过而非接管",
  "  owl --bootstrap               额外写引导文件（0.2.0 未启用，仅提示）",
  "  owl --no-warm                 安装后不自动预热（默认会预热一次）",
  "  owl --no-prepare              跳过默认版本就绪（物化与 bundle），仍会预热",
  "  owl mcp [--host <id>]         作为 MCP 服务器运行（宿主 MCP 配置指向这里）",
  "  owl warm                      预热 openwiki 后端后退出",
  "  owl warmup --host <id>        确保 holder 常驻且后端就绪（适合挂登录启动项）",
  "  owl doctor                    检查环境、manifest 与已写入的 MCP 命令",
  "  owl check                     查看本地 openwiki 版本状态（当前/已装/registry）",
  "  owl update [--version <v>]    升级 openwiki（交互确认；--no-switch 只装不切）",
  "  owl switch <version>          切换当前生效的 openwiki 版本",
  "  owl versions remove <v>       删除一个已安装的 openwiki 版本",
  "  owl ow <参数…>  /  ow <参数…>  透传执行 openwiki CLI（visualize、link…；直连 mcp 慢，宿主请用 owl mcp）",
  "  owl help                      显示本帮助",
  "  owl version                   显示版本",
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

  // 注意：这里**不能**把 `!command` 当"显示帮助"。裸跑（无参数）按下面的
  // 「裸用法」分支走安装：安装器常常是用户第一条、也可能是唯一一条命令，
  // 让 `openwiki-launcher` 直接干活而不是回一段说明书。
  if (command === "help" || command === "--help" || command === "-h") {
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

  if (command === "holder") {
    const hostId = readHostId(rest, logger);
    if (hostId === null) return 1;
    return runHolderCommand({ hostId, logger, env });
  }

  if (command === "warm") {
    return runWarmCommand({
      logger,
      resolveRuntime: deps.resolveRuntime,
      createSupervisor: deps.createSupervisor,
      ensureBundleFn: deps.ensureBundleFn,
      ensureDefaultVersionFn: deps.ensureDefaultVersionFn,
      env,
    });
  }

  if (command === "warmup") {
    const hostId = readHostId(rest, logger);
    if (hostId === null) return 1;
    return runWarmupCommand({ hostId, logger, env, ensureDefaultVersionFn: deps.ensureDefaultVersionFn });
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
      env,
      runNpm: deps.runNpm,
      confirm: deps.confirm,
      resolveRuntime: deps.resolveRuntime,
      writeSnapshot: deps.writeSnapshot,
      ensureDefaultVersionFn: deps.ensureDefaultVersionFn,
    });
  }

  if (command === "switch") {
    return runSwitchCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      version: rest[0],
      env,
      runNpm: deps.runNpm,
      confirm: deps.confirm,
      resolveRuntime: deps.resolveRuntime,
      writeSnapshot: deps.writeSnapshot,
      ensureDefaultVersionFn: deps.ensureDefaultVersionFn,
    });
  }

  if (command === "versions") {
    return runVersionsCommand({
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      args: rest,
    });
  }

  // `owl ow` 与独立 bin `ow` 走同一内核：launcher 自己的命令空间绝不与
  // openwiki 的子命令混合，纯透传是唯一语义（含 `ow mcp`，不拦截）。
  if (command === "ow") {
    const runOpenwikiCliFn = deps.runOpenwikiCliFn ?? runOpenwikiCli;
    return runOpenwikiCliFn({
      args: rest,
      logger,
      pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
      resolveRuntime: deps.resolveRuntime,
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
    // 同理：预热前的 ensureBundle（§9）也要可注入，否则安装用例会真去装 esbuild。
    ensureBundleFn: deps.ensureBundleFn,
    // 就绪动作（物化默认版本）同理：不注入桩它会去 npm install 几百 MB。
    ensureDefaultVersionFn: deps.ensureDefaultVersionFn,
    runNpm: deps.runNpm,
    now: deps.now,
  };
}
