import { createInterface } from "node:readline";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { ensureBundle } from "../ensure-bundle.mjs";
import { generateManifest } from "../gen-manifest.mjs";
import { compareVersions, isValidVersion, writeActiveAtomic } from "../versions.mjs";
import { pickLatestStable, runNpm } from "../npm-runner.mjs";
import { installAndSnapshot, installVersion, summarizeInstallFailure } from "../openwiki-install.mjs";

// 安装内核（锁 + 原子安装 + 完整性校验）住在 src/openwiki-install.mjs：它同时
// 服务 update、switch 与默认版本就绪三个调用方，只修一处。这里保留同名再导出，
// 既有 import 与测试不破。
export { installAndSnapshot, installVersion, summarizeInstallFailure };

/**
 * openwiki 升级：装新版本 → 录快照 → 切换指针，任何一步失败当前版本都不受影响。
 *
 * 目标版本默认交互确认（0.x 阶段每个版本都可能改工具清单，人工过目再装）；
 * `--version` 显式指定时跳过选择。快照录不到不阻塞升级：没有快照的版本会以
 * 直通模式运行，那是设计好的兜底，比回滚一个装好的版本更合理。
 */

/**
 * npm 执行器：install 的进度条在 stderr 上，原样透传——几百 MB 的依赖树
 * 要装几分钟，静默会让用户以为卡死了。
 */
export function defaultRunNpm(args, options = {}) {
  return runNpm(args, { ...options, onStderr: (text) => process.stderr.write(text) });
}

/** 交互确认的默认实现：readline 问一个是非题，只有明确的 y/yes 算同意。 */
export async function defaultConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * 解析 update 的参数。
 *
 * @param {string[]} args
 * @returns {{ flags: { version: string | null, noSwitch: boolean }, error?: string }}
 */
export function parseUpdateArgs(args) {
  const flags = { version: null, noSwitch: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-switch") {
      flags.noSwitch = true;
    } else if (arg === "--version") {
      const value = args[i + 1];
      // 缺值不能当成「没给版本」：那会静默滑进交互模式，脚本调用时卡在一个
      // 看不见的提示上。宁可报错。
      if (!value || value.startsWith("-")) {
        return { flags, error: "--version 需要一个 x.y.z 形式的三段数字版本名" };
      }
      flags.version = value;
      i += 1;
    } else if (arg.startsWith("--version=")) {
      flags.version = arg.slice("--version=".length);
    } else {
      return { flags, error: `无法识别的参数: ${arg}` };
    }
  }
  return { flags };
}

/**
 * @param {{
 *   logger: object,
 *   pkgRoot: string,
 *   args?: string[],
 *   runNpm?: Function,
 *   confirm?: (question: string) => Promise<boolean>,
 *   resolveRuntime?: Function,
 *   writeSnapshot?: (options: object) => Promise<object>,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runUpdateCommand({
  logger,
  pkgRoot,
  args = [],
  runNpm = defaultRunNpm,
  confirm = defaultConfirm,
  resolveRuntime = resolveOpenwikiRuntime,
  writeSnapshot = generateManifest,
  install = installAndSnapshot,
  ensureBundleFn = ensureBundle,
}) {
  const parsed = parseUpdateArgs(args);
  if (parsed.error) {
    logger.error(parsed.error);
    return 1;
  }
  const { version: requested, noSwitch } = parsed.flags;
  if (requested !== null && !isValidVersion(requested)) {
    logger.error(`--version 的值必须是 x.y.z 形式的三段数字版本名，收到: ${JSON.stringify(requested)}`);
    return 1;
  }

  let runtime;
  try {
    runtime = await resolveRuntime({ pkgRoot });
  } catch (error) {
    logger.error(`解析当前 openwiki 运行时失败: ${error.message}`);
    return 1;
  }
  const current = runtime.version;
  const currentLabel = runtime.source === "versions" ? "versions 指针" : "出厂依赖";

  // 目标版本：显式 --version 直接采用；否则查 registry 并列给用户选。
  let target = requested;
  if (target === null) {
    let versions;
    try {
      const result = await runNpm(["view", "openwiki", "versions", "--json"]);
      if (result.code !== 0) {
        throw new Error((result.stderr || "").trim() || `npm 退出码 ${result.code}`);
      }
      versions = JSON.parse(result.stdout);
    } catch (error) {
      logger.error(`无法查询 openwiki 版本：${error.message}`);
      return 1;
    }
    if (!Array.isArray(versions) || versions.length === 0) {
      logger.error("registry 返回的版本列表为空，无法决定升级目标");
      return 1;
    }
    // 版本表按发布顺序排列且混有 prerelease：取末位前先滤出稳定版并按
    // semver 排序，否则 0.7.0-beta.1 会当成升级目标，随后被版本名校验打掉。
    const latest = pickLatestStable(versions);
    if (latest === null) {
      logger.error("registry 没有可用的稳定版本（只有 prerelease）");
      return 1;
    }
    if (latest === current) {
      logger.info(`已是最新版本（${current}），无需更新`);
      return 0;
    }
    logger.info(`当前生效版本：${current}（${currentLabel}）`);
    logger.info(`registry 最新版本：${latest}`);
    logger.info(`最近版本：${versions.filter(isValidVersion).sort(compareVersions).slice(-10).reverse().join("、")}`);
    const proceed = await confirm(`安装 openwiki@${latest} 并切换为当前版本？`);
    if (!proceed) {
      logger.info("已取消，未做任何改动");
      return 0;
    }
    target = latest;
  } else if (target === current) {
    logger.info(`当前生效版本已是 ${target}，无需更新`);
    return 0;
  }

  const outcome = await install({
    pkgRoot, version: target, runNpm, logger, writeSnapshot, hostId: "update",
  });
  if (!outcome.ok && outcome.stage !== "snapshot") return 1;

  // 快照录不到不阻塞升级：没有快照的版本以直通模式运行，问一句是否仍要切换（默认否）。
  if (outcome.stage === "snapshot") {
    logger.warn(`快照生成失败：${outcome.error.message}`);
    logger.info(`openwiki@${target} 已安装但无快照，将以直通模式运行（首次工具调用等待后端启动）`);
    const proceed = await confirm(`仍要切换到 ${target} 吗？`);
    if (!proceed) {
      logger.error("已取消切换；版本已安装，可稍后重跑 update 或用 switch 切换");
      return 1;
    }
  }

  if (!noSwitch) {
    try {
      writeActiveAtomic(pkgRoot, target);
    } catch (error) {
      logger.error(`切换失败：${error.message}（版本已安装，指针未改动）`);
      return 1;
    }
    logger.info(`✓ 已切换：${current} → ${target}`);
  } else {
    logger.info(`已安装 openwiki@${target} 并生成快照（--no-switch，未切换）`);
  }

  logger.info("提醒：宿主持有的旧会话不受影响，新连接即用新版本；可运行 openwiki-launcher warm 预热");
  // §9：新版本装好后 best-effort 打 bundle；失败只提示，退出码不变
  try {
    const bundleResult = await ensureBundleFn({ version: target, pkgRoot, logger });
    if (bundleResult.ok !== true) {
      logger.warn(`bundle 未就绪（${bundleResult.reason ?? "未知原因"}），该版本将以源码入口启动，冷启动较慢`);
    }
  } catch (error) {
    logger.warn(`bundle 未就绪（${error.message}），该版本将以源码入口启动，冷启动较慢`);
  }
  if (outcome.ok) {
    logger.info("提醒：若 openwiki 的 skill 内容有更新，重跑 openwiki-launcher 安装器可刷新宿主技能目录");
  }
  return 0;
}
