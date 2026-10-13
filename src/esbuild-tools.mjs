import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runNpm } from "./npm-runner.mjs";

// esbuild 钉确切版本（不用范围）：换版必须显式改这里并重测。
const PINNED_EBUILD_VERSION = "0.28.2";

/**
 * esbuild 的懒安装目录。用户级数据目录（非 pkgRoot）：pkgRoot 随 Node 版本与
 * 重装漂移，工具链放那里会在升级时丢失或分叉成多份。
 *
 * @param {string} dataDir 用户级数据目录
 * @returns {string}
 */
export function esbuildToolsDir(dataDir) {
  return path.join(dataDir, "tools", "esbuild");
}

async function loadEsbuild(toolsDir) {
  const entry = path.join(toolsDir, "node_modules", "esbuild", "lib", "main.js");
  if (!existsSync(entry)) return null;
  try {
    return await import(pathToFileURL(entry).href);
  } catch {
    return null;
  }
}

/**
 * 确保 esbuild 在用户级数据目录可用；缺失则用 runNpm 安装钉死版本。
 * 网络失败/离线返回 { ok: false, reason }——调用方降级，绝不抛出。
 *
 * @param {{
 *   dataDir: string,
 *   logger: object,
 *   runNpmFn?: (args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 * }} options
 * @returns {Promise<{ ok: true, esbuildModule: object } | { ok: false, reason: string }>}
 */
export async function ensureEsbuild({ dataDir, logger, runNpmFn = runNpm }) {
  const toolsDir = esbuildToolsDir(dataDir);
  let esbuildModule = await loadEsbuild(toolsDir);
  if (esbuildModule) return { ok: true, esbuildModule };

  const args = ["install", "--prefix", toolsDir, `esbuild@${PINNED_EBUILD_VERSION}`];
  const result = await runNpmFn(args);
  if (result.code !== 0) {
    return { ok: false, reason: `esbuild 安装失败：${(result.stderr || result.stdout || "npm 非零退出").slice(0, 200)}` };
  }
  esbuildModule = await loadEsbuild(toolsDir);
  if (!esbuildModule) {
    return { ok: false, reason: `esbuild 安装后无法加载（${toolsDir}）` };
  }
  logger.debug(`esbuild ${PINNED_EBUILD_VERSION} 已就绪（${toolsDir}）`);
  return { ok: true, esbuildModule };
}
