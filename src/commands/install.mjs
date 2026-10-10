import { resolveOpenwikiRuntime } from "../paths.mjs";
import { bundleDirFor } from "../skill-install.mjs";
import { resolveSelfBin, resolveNodeCommand } from "../self-path.mjs";
import { runInstall } from "../install.mjs";
import { runUninstall } from "../uninstall.mjs";

/**
 * install / uninstall 的命令层：参数解析、路径解析、打印。
 *
 * 这里是唯一需要 await 的地方 —— bundle 路径依赖 src/paths.mjs 的
 * resolveOpenwikiRuntime()，它是 async。runInstall / runUninstall 本身是同步的
 * （fs 操作本就同步），所以只需要 await 这一处依赖。
 */

/** 会被接受的命令行标志。白名单外的以 - 开头的参数一律报错，不静默忽略。 */
const BOOL_FLAGS = new Set(["--global", "--uninstall", "--force", "--no-takeover", "--bootstrap"]);

/**
 * 解析 install / uninstall 的参数。
 *
 * @param {string[]} args
 * @returns {{ error?: string, uninstall?: boolean,
 *             flags?: { tool: string | null, global: boolean, uninstall: boolean,
 *                       force: boolean, noTakeover: boolean, bootstrap: boolean } }}
 */
export function parseInstallArgs(args) {
  const flags = {
    tool: null,
    global: false,
    uninstall: false,
    force: false,
    noTakeover: false,
    bootstrap: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--tool" || arg === "--tool=") {
      if (arg === "--tool=") {
        flags.tool = "";
      } else {
        const value = args[i + 1];
        if (!value || value.startsWith("-")) return { error: "--tool 需要一个宿主 id" };
        flags.tool = value;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--tool=")) {
      flags.tool = arg.slice("--tool=".length);
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      if (arg === "--global") flags.global = true;
      if (arg === "--uninstall") flags.uninstall = true;
      if (arg === "--force") flags.force = true;
      if (arg === "--no-takeover") flags.noTakeover = true;
      if (arg === "--bootstrap") flags.bootstrap = true;
      continue;
    }
    return { error: `无法识别的参数: ${arg}` };
  }

  return { uninstall: flags.uninstall, flags };
}

/**
 * 执行 install / uninstall。
 *
 * @param {ReturnType<typeof parseInstallArgs>["flags"]} flags
 * @param {object} deps
 * @returns {Promise<number>} 进程退出码
 */
export async function runInstallCommand(flags, deps) {
  const logger = deps.logger;

  let bundleDir = deps.bundleDir;
  if (!bundleDir) {
    let runtime;
    try {
      // 注意是 await：resolveOpenwikiRuntime 是 async，直接取 .packageRoot 会拿到 undefined
      runtime = await resolveOpenwikiRuntime();
    } catch (error) {
      logger.error(`找不到 openwiki 依赖，无法安装 skill：${error.message}`);
      logger.error("本包通过 node 模块解析定位 openwiki，不做任何全局路径探测。");
      return 1;
    }
    bundleDir = bundleDirFor(runtime.packageRoot);
  }

  const run = flags.uninstall ? runUninstall : runInstall;
  const result = run({
    logger,
    tool: flags.tool,
    global: flags.global,
    force: flags.force,
    noTakeover: flags.noTakeover,
    bootstrap: flags.bootstrap,
    cwd: deps.cwd,
    homeDir: deps.homeDir,
    env: deps.env,
    platform: deps.platform,
    exists: deps.exists,
    nodeCommand: deps.nodeCommand ?? resolveNodeCommand(),
    selfBin: deps.selfBin ?? resolveSelfBin(import.meta.url),
    launcherVersion: deps.launcherVersion,
    bundleDir,
    now: deps.now,
  });

  return result.exitCode;
}
