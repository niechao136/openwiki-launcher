import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isValidVersion,
  launcherPackageRoot,
  readActive,
  versionDir,
  versionsRoot,
} from "./versions.mjs";

/**
 * Raised when the openwiki dependency cannot be located.
 *
 * The launcher never guesses a global installation path: a wrong guess starts
 * the wrong backend, or none at all, and the host sees a timeout instead of
 * a diagnosis.
 */
export class OpenwikiNotFoundError extends Error {}

const silentLogger = { warn() {} };

/**
 * holder lockfile 的落点：versions/ 目录已随包存在且由 launcher 自管，
 * 与版本指针同处一处便于整体清理。
 *
 * @param {string} hostId
 * @param {string} [pkgRoot]
 * @returns {string}
 */
export function holderLockPath(hostId, pkgRoot = launcherPackageRoot()) {
  if (!/^[a-z0-9-]{1,64}$/.test(hostId)) {
    throw new Error(
      `非法的 hostId: ${JSON.stringify(hostId)}（应为 1-64 位小写字母、数字或连字符）`,
    );
  }
  return path.join(versionsRoot(pkgRoot), `holder-${hostId}.json`);
}

/**
 * 解析一个候选 openwiki 包目录；package.json 与 CLI 入口不全时返回 null。
 *
 * @param {string} dir 候选 openwiki 包目录。
 * @returns {{ packageJson: string, cliJs: string } | null}
 */
function resolveEntry(dir) {
  const packageJson = path.join(dir, "package.json");
  const cliJs = path.join(dir, "dist", "cli", "cli.js");
  if (!existsSync(packageJson) || !existsSync(cliJs)) return null;
  return { packageJson, cliJs };
}

/**
 * bundle 产物（versions/<版本>/bundle.mjs）存在即优先：单文件把模块图加载的
 * 文件 IO 与编译从数千文件降到一个。bundle 缺失或属于别的版本目录时静默
 * 降级 node_modules 的 cliJs——bundle 只是优化，缺失绝不能致命（规格 §6.1）。
 *
 * @param {string} pkgRoot
 * @param {string} version 解析出的 openwiki 版本号
 * @param {string} sourceCliJs node_modules 侧的 cliJs
 * @returns {{ cliJs: string, backend: "bundle" | "source" }}
 */
function preferBundle(pkgRoot, version, sourceCliJs) {
  const bundlePath = path.join(versionDir(pkgRoot, version), "bundle.mjs");
  return existsSync(bundlePath)
    ? { cliJs: bundlePath, backend: "bundle" }
    : { cliJs: sourceCliJs, backend: "source" };
}

/**
 * @param {string} packageJson package.json 路径。
 * @returns {string | null} version 字段；读不出或不是字符串时为 null。
 */
function readDeclaredVersion(packageJson) {
  try {
    const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the openwiki the launcher should run, and where it came from.
 *
 * Resolution order: an explicit version (used while recording a snapshot for a
 * version that is not active yet), then the active pointer under versions/,
 * then the bundled dependency. The bundled fallback only ever looks inside
 * this package's own node_modules — never up the directory tree. A globally
 * installed openwiki sits one level above a global install of this package,
 * so a walk-up would silently adopt it whenever the bundled dependency went
 * missing, and every version report would start lying.
 *
 * A missing or damaged pointer is never fatal: the caller gets the bundled
 * dependency and a warning, so the broker keeps serving.
 *
 * @param {{
 *   explicitVersion?: string,
 *   pkgRoot?: string,
 *   logger?: { warn(message: string): void },
 * }} [options]
 * @returns {Promise<{ packageRoot: string, version: string, cliJs: string, backend: "bundle" | "source", source: "versions" | "bundled" }>}
 */
export async function resolveOpenwikiRuntime({
  explicitVersion,
  pkgRoot = launcherPackageRoot(),
  logger = silentLogger,
} = {}) {
  if (explicitVersion !== undefined && !isValidVersion(explicitVersion)) {
    throw new OpenwikiNotFoundError(
      `非法的 openwiki 版本名: ${JSON.stringify(explicitVersion)}（应为 x.y.z）`,
    );
  }

  const active = readActive(pkgRoot);
  if (explicitVersion === undefined && existsSync(path.join(versionsRoot(pkgRoot), "active.json")) && !active) {
    logger.warn("versions/active.json 损坏或内容非法，回退出厂依赖");
  }

  // explicitVersion 是「给还没激活的版本录快照」的入口：解析不到就明说，
  // 绝不回退出厂依赖——否则录出来的快照会自称 requested 版本、内容是出厂版，
  // 一份对不上的工具清单正是规格要避免的。
  if (explicitVersion !== undefined) {
    const entry = resolveEntry(path.join(versionDir(pkgRoot, explicitVersion), "node_modules", "openwiki"));
    const version = entry && readDeclaredVersion(entry.packageJson);
    if (!version) {
      throw new OpenwikiNotFoundError(
        `versions/${explicitVersion} 下找不到可解析的 openwiki（package.json 或 dist/cli/cli.js 缺失）`,
      );
    }
    return { packageRoot: path.dirname(entry.packageJson), version, cliJs: entry.cliJs, backend: "source", source: "versions" };
  }

  /** @type {{ dir: string, source: "versions" | "bundled", pointerMiss?: string }[]} */
  const candidates = [];
  if (active) {
    candidates.push({
      dir: path.join(versionDir(pkgRoot, active.version), "node_modules", "openwiki"),
      source: "versions",
      pointerMiss: `版本指针指向 ${active.version}，但该版本未安装或入口缺失，回退出厂依赖`,
    });
  }
  candidates.push({ dir: path.join(pkgRoot, "node_modules", "openwiki"), source: "bundled" });

  for (const candidate of candidates) {
    const entry = resolveEntry(candidate.dir);
    if (entry) {
      const version = readDeclaredVersion(entry.packageJson);
      if (version) {
        const preferred = preferBundle(pkgRoot, version, entry.cliJs);
        return {
          packageRoot: candidate.dir,
          version,
          cliJs: preferred.cliJs,
          backend: preferred.backend,
          source: candidate.source,
        };
      }
    }
    if (candidate.pointerMiss) logger.warn(candidate.pointerMiss);
  }
  throw new OpenwikiNotFoundError(`cannot resolve openwiki dependency under ${pkgRoot}`);
}
