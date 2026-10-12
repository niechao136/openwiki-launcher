import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { listInstalled, readActive, versionsRoot } from "../versions.mjs";

/**
 * 本地 openwiki 版本状态的一屏总览。
 *
 * 回答三个问题：现在跑的是哪个版本（指针还是出厂）、本机还装着哪些版本、
 * registry 上有没有更新的。registry 查询失败只降级提示——这个命令的存在意义
 * 就是把状态讲清楚，不该因为查不到网上的信息就拒绝报告本地状态。
 *
 * @param {{
 *   logger: object,
 *   pkgRoot: string,
 *   resolveRuntime?: Function,
 *   runNpm: (args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 * }} options
 * @returns {Promise<number>} 恒 0：只读命令，查不到 registry 也不是错误。
 */
export async function runCheckCommand({
  logger,
  pkgRoot,
  resolveRuntime = resolveOpenwikiRuntime,
  runNpm,
}) {
  const runtime = await resolveRuntime({ pkgRoot });
  const sourceLabel = runtime.source === "versions" ? "versions 指针" : "出厂依赖";
  logger.info(`当前生效版本：${runtime.version}（${sourceLabel}）`);

  const active = readActive(pkgRoot);
  const pointerFile = path.join(versionsRoot(pkgRoot), "active.json");
  if (existsSync(pointerFile) && !active) {
    logger.warn("! 版本指针损坏（versions/active.json 无法解析），已回退出厂依赖；修复：重跑 switch 或删除该文件");
  }

  const installed = listInstalled(pkgRoot);
  if (installed.length === 0) {
    logger.info("已安装版本：无（versions/ 目录为空，当前使用出厂依赖）");
  } else {
    logger.info("已安装版本：");
    let totalBytes = 0;
    for (const entry of installed) {
      totalBytes += entry.sizeBytes;
      const snapshot = entry.hasManifest ? "快照 ✓" : "快照 ✗";
      logger.info(`  ${entry.version}  ${snapshot}  ${formatBytes(entry.sizeBytes)}`);
    }
    logger.info(`磁盘占用：合计 ${formatBytes(totalBytes)}`);
  }

  try {
    const result = await runNpm(["view", "openwiki", "versions", "--json"]);
    if (result.code !== 0) {
      throw new Error(result.stderr?.trim() || `npm 退出码 ${result.code}`);
    }
    const versions = JSON.parse(result.stdout);
    const latest = Array.isArray(versions) ? versions[versions.length - 1] : versions;
    logger.info(`registry 最新版本：${latest}`);
    if (latest === runtime.version) {
      logger.info("（当前已是最新版本）");
    }
  } catch (error) {
    logger.warn(`registry 查询失败：${error.message}（不影响本地版本状态）`);
  }

  return 0;
}

/** 字节数格式化成 MB / KB；版本目录都是几百 MB 量级，KB 精度没有意义。 */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
