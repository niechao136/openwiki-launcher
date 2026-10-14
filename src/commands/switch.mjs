import { existsSync } from "node:fs";
import path from "node:path";
import { bundledOpenwikiVersion, resolveOpenwikiRuntime } from "../paths.mjs";
import { isValidVersion, isInstalled, versionDir, writeActiveAtomic } from "../versions.mjs";
import { generateManifest } from "../gen-manifest.mjs";
import { bundleStatus, ensureBundle } from "../ensure-bundle.mjs";
import { ensureDefaultVersion, prepareEnabled } from "../ensure-default.mjs";
import { defaultConfirm, defaultRunNpm, installAndSnapshot } from "./update.mjs";

/**
 * 切换当前生效的 openwiki 版本。
 *
 * 已安装的版本之间是毫秒级指针改写，可反复横跳——这是它相对 update 的存在理由：
 * 回滚不应该再走一遍「装依赖 + 录快照」。没装过的版本可以顺手代装，但装不好
 * 就原样放弃：switch 的语义是「现在就让 X 生效」，容不下没有快照的降级。
 */

/**
 * @param {{
 *   logger: object,
 *   pkgRoot: string,
 *   version: string,
 *   runNpm?: Function,
 *   confirm?: (question: string) => Promise<boolean>,
 *   resolveRuntime?: Function,
 *   writeSnapshot?: Function,
 *   install?: Function,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runSwitchCommand({
  logger,
  pkgRoot,
  version,
  env = process.env,
  runNpm = defaultRunNpm,
  confirm = defaultConfirm,
  resolveRuntime = resolveOpenwikiRuntime,
  writeSnapshot = generateManifest,
  install = installAndSnapshot,
  ensureBundleFn = ensureBundle,
  ensureDefaultVersionFn = ensureDefaultVersion,
}) {
  if (version === undefined) {
    logger.error("switch 需要一个版本名（x.y.z），例如: openwiki-launcher switch 0.6.0");
    return 1;
  }
  if (!isValidVersion(version)) {
    logger.error(`版本名必须是 x.y.z 形式的三段数字，收到: ${JSON.stringify(version)}`);
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
  if (version === current && runtime.source === "versions") {
    logger.info(`当前生效版本已是 ${version}`);
    return 0;
  }

  const isBundledVersion = version === bundledOpenwikiVersion(pkgRoot);

  // 目录存在但入口不全：不是「没装」，是「装坏了」。在坏目录上重装只会合并出
  // 更难诊断的状态——拒绝并指路清理。默认版本例外：它的目录里可能只剩历史
  // bundle（物化之前的畸形状态），而就绪动作会在这个目录里补齐实体条目。
  if (!isBundledVersion && existsSync(versionDir(pkgRoot, version)) && !isInstalled(pkgRoot, version)) {
    logger.error(
      `versions/${version} 目录存在但 openwiki 无法解析（缺 package.json 或 dist/cli/cli.js）；`
      + `请先 openwiki-launcher versions remove ${version} 清理后重试`,
    );
    return 1;
  }

  if (!isInstalled(pkgRoot, version)) {
    if (isBundledVersion) {
      // 出厂依赖不在版本仓库里：就地物化它，绝不让「切回默认版本」变成一次重下载。
      if (!prepareEnabled(env)) {
        logger.error("就绪动作已被 LAUNCHER_PREPARE=0 关闭，无法就绪尚未物化的默认版本；移除该变量后重试");
        return 1;
      }
      const prepared = await ensureDefaultVersionFn({ mode: "explicit", pkgRoot, logger, runNpm }).catch((error) => ({
        ok: false,
        reason: error.message,
      }));
      if (prepared?.ok !== true || !isInstalled(pkgRoot, version)) {
        // 指针只允许指向真实条目（规格 I3）：物化失败就必须拒绝切换。
        logger.error(`无法就绪默认版本 openwiki@${version}：${prepared?.reason ?? "未知原因"}`);
        return 1;
      }
    } else {
      const proceed = await confirm(`openwiki@${version} 未安装，是否现在安装？`);
      if (!proceed) {
        logger.error(`已取消：openwiki@${version} 未安装`);
        return 1;
      }
      const outcome = await install({ pkgRoot, version, runNpm, logger, writeSnapshot, hostId: "switch" });
      if (!outcome.ok) return 1;
    }
  }

  try {
    writeActiveAtomic(pkgRoot, version);
  } catch (error) {
    logger.error(`切换失败：${error.message}（指针未改动）`);
    return 1;
  }
  logger.info(`✓ 已切换：${current} → ${version}`);

  // §9：bundle 状态不静默。缺失时后台尽力补打（本进程若先退出，下次触发再补）；
  // 补打成功前新会话以源码入口启动。
  const status = bundleStatus(pkgRoot, version);
  if (status === "ready") {
    logger.info("✓ 该版本有 bundle（冷启动已优化）");
  } else if (status === "bad") {
    logger.warn("! 该版本的 bundle 被标记不可用，新会话将以源码入口启动（npm run bundle 重建后自动恢复）");
  } else {
    logger.warn("! 该版本无 bundle，冷启动较慢；正在后台尝试生成，下次会话生效");
    ensureBundleFn({ version, pkgRoot, logger }).catch((error) =>
      logger.debug(`后台补打 bundle 失败: ${error.message}`),
    );
  }

  logger.info("提醒：宿主持有的旧会话不受影响，新连接即用新版本；可运行 openwiki-launcher warm 预热");
  return 0;
}
