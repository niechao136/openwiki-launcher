import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { isValidVersion, versionDir, writeActiveAtomic } from "../versions.mjs";
import { generateManifest } from "../gen-manifest.mjs";
import { defaultConfirm, defaultRunNpm, installAndSnapshot } from "./update.mjs";

/**
 * 切换当前生效的 openwiki 版本。
 *
 * 已安装的版本之间是毫秒级指针改写，可反复横跳——这是它相对 update 的存在理由：
 * 回滚不应该再走一遍「装依赖 + 录快照」。没装过的版本可以顺手代装，但装不好
 * 就原样放弃：switch 的语义是「现在就让 X 生效」，容不下没有快照的降级。
 */

/** 版本目录里有可解析的 openwiki 入口，才算「已安装」。 */
function isInstalled(pkgRoot, version) {
  const pkg = path.join(versionDir(pkgRoot, version), "node_modules", "openwiki");
  return existsSync(path.join(pkg, "package.json"))
    && existsSync(path.join(pkg, "dist", "cli", "cli.js"));
}

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
  runNpm = defaultRunNpm,
  confirm = defaultConfirm,
  resolveRuntime = resolveOpenwikiRuntime,
  writeSnapshot = generateManifest,
  install = installAndSnapshot,
}) {
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

  // 目录存在但入口不全：不是「没装」，是「装坏了」。在坏目录上重装只会合并出
  // 更难诊断的状态——拒绝并指路清理。
  if (existsSync(versionDir(pkgRoot, version)) && !isInstalled(pkgRoot, version)) {
    logger.error(
      `versions/${version} 目录存在但 openwiki 无法解析（缺 package.json 或 dist/cli/cli.js）；`
      + `请先 openwiki-launcher versions remove ${version} 清理后重试`,
    );
    return 1;
  }

  if (!isInstalled(pkgRoot, version)) {
    const proceed = await confirm(`openwiki@${version} 未安装，是否现在安装？`);
    if (!proceed) {
      logger.error(`已取消：openwiki@${version} 未安装`);
      return 1;
    }
    const outcome = await install({ pkgRoot, version, runNpm, logger, writeSnapshot, hostId: "switch" });
    if (!outcome.ok) return 1;
  }

  try {
    writeActiveAtomic(pkgRoot, version);
  } catch (error) {
    logger.error(`切换失败：${error.message}（指针未改动）`);
    return 1;
  }
  logger.info(`✓ 已切换：${current} → ${version}`);
  logger.info("提醒：宿主持有的旧会话不受影响，新连接即用新版本；可运行 openwiki-launcher warm 预热");
  return 0;
}
