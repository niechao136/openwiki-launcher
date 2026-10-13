import { resolveOpenwikiRuntime } from "../paths.mjs";
import { bundleDirFor } from "../skill-install.mjs";
import { resolveSelfBin, resolveNodeCommand } from "../self-path.mjs";
import { runInstall } from "../install.mjs";
import { runUninstall } from "../uninstall.mjs";
import { runWarmCommand } from "./warm.mjs";
import { ensureBundleForActive } from "../ensure-bundle.mjs";

/**
 * install / uninstall 的命令层：参数解析、路径解析、打印、预热。
 *
 * 这里是唯一需要 await 的地方 —— bundle 路径依赖 src/paths.mjs 的
 * resolveOpenwikiRuntime()，它是 async；安装后的自动预热也是 async。
 * runInstall / runUninstall 本身是同步的（fs 操作本就同步），
 * 它们的同步契约不能为了预热而改：28 家 e2e、回滚逻辑与纯函数决策面都依赖它。
 */

/** 会被接受的命令行标志。白名单外的以 - 开头的参数一律报错，不静默忽略。 */
const BOOL_FLAGS = new Set([
  "--global", "--uninstall", "--force", "--no-takeover", "--bootstrap", "--no-warm",
]);

/**
 * 解析 install / uninstall 的参数。
 *
 * @param {string[]} args
 * @returns {{ error?: string, uninstall?: boolean,
 *             flags?: { tool: string | null, global: boolean, uninstall: boolean,
 *                       force: boolean, noTakeover: boolean, bootstrap: boolean,
 *                       noWarm: boolean } }}
 */
export function parseInstallArgs(args) {
  const flags = {
    tool: null,
    global: false,
    uninstall: false,
    force: false,
    noTakeover: false,
    bootstrap: false,
    noWarm: false,
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
      if (arg === "--no-warm") flags.noWarm = true;
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
    noWarm: flags.noWarm,
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

  // 规格 5：安装成功后自动预热一次，让第一次工具调用不用等 openwiki 的导入。
  // 预热是优化不是安装的一部分 —— 失败只告警，退出码仍然是安装的结果。
  if (result.exitCode === 0 && !flags.uninstall && !flags.noWarm) {
    await warmAfterInstall({ logger, env: deps.env ?? process.env, ensureBundleFn: deps.ensureBundleFn, warmFn: deps.warmFn });
  }

  return result.exitCode;
}

/**
 * 安装成功后的收尾：先 ensureBundle（§9，预热即顺带验证 bundle 可启动），
 * 再预热后端。两步都只告警，不影响安装退出码。
 *
 * @param {{ logger: object, env?: object, ensureBundleFn?: Function, warmFn?: Function }} options
 * @returns {Promise<number>} 预热退出码
 */
export async function warmAfterInstall({ logger, env = process.env, ensureBundleFn, warmFn }) {
  const ensure = ensureBundleFn ?? ensureBundleForActive;
  const bundleResult = await ensure({ logger }).catch((error) => ({ ok: false, reason: error.message }));
  if (bundleResult.ok !== true) {
    logger.warn(`bundle 未就绪（${bundleResult.reason ?? "未知原因"}），后端将以源码入口启动。`);
  }
  const warm = warmFn ?? runWarmCommand;
  const warmCode = await warm({ logger, env, hostId: "warm" });
  if (warmCode !== 0) {
    logger.warn("预热未成功，不影响本次安装结果；可稍后单独运行 `openwiki-launcher warm`。");
  }
  return warmCode;
}
