import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * openwiki skill bundle 的安装与收据。
 *
 * bundle 只有一个 skill（SKILL.md + agents/*.yaml），安装动作本身很轻；
 * 真正的设计重量在两件事上：
 *
 *   1. **白名单**：bundle 里的文件树来自 npm 依赖，复制到宿主的 skills 目录等于
 *      让依赖的内容进入用户的仓库。只允许 SKILL.md 与白名单目录，不允许 scripts/。
 *   2. **收据 + 逐文件 sha256**：卸载时据此判断「这堆文件还是不是我们放进去的」。
 *      用户可能手改过 SKILL.md，哈希不符就不删 —— 宁可留垃圾也不丢用户数据。
 */

/** 本安装器的收据文件名。与 openwiki 原生的 .openwiki-install.json 严格区分。 */
export const RECEIPT_FILE = ".openwiki-launcher.json";

/** openwiki 原生安装器写的收据文件名，只在接管时被读取并删除。 */
export const NATIVE_RECEIPT_FILE = ".openwiki-install.json";

// 白名单移植 openwiki/src/integrations/install/skill-bundle.ts:13。
// 文件与目录分开声明：语义不同，混在一个数组里「顶层段是否在白名单内」说不清。
export const ALLOWED_BUNDLE_FILES = ["SKILL.md"];
export const ALLOWED_BUNDLE_DIRS = ["agents", "references"];

/**
 * skill bundle 在 openwiki 包内的位置。
 *
 * 只做拼接，不做存在性判断、不做任何路径探测 —— 唯一允许的入参来源是
 * resolveOpenwikiRuntime() 的 packageRoot（见 src/paths.mjs）。
 *
 * @param {string} openwikiPackageRoot
 * @returns {string}
 */
export function bundleDirFor(openwikiPackageRoot) {
  return path.join(openwikiPackageRoot, "integrations", "openwiki");
}

/**
 * 收集 bundle 内所有文件的相对路径，并校验整棵树都在白名单内。
 *
 * 必须整棵树校验完再开始写任何文件：半途发现一个 scripts/ 就已经写了三个文件，
 * 用户目录会停在「装了一半」的状态。
 *
 * @param {string} bundleDir
 * @returns {string[]} 用 / 分隔的相对路径
 * @throws 当出现 ".." 或不在白名单内的路径时抛错，错误信息含「不允许的路径」
 */
export function listBundleFiles(bundleDir) {
  /** @type {string[]} */
  const found = [];

  const walk = (dirAbs, relBase) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dirAbs, entry.name);

      if (rel.split("/").includes("..")) {
        throw new Error(`bundle 内出现不允许的路径: ${rel}`);
      }

      if (entry.isDirectory()) {
        if (relBase === "" && !ALLOWED_BUNDLE_DIRS.includes(entry.name)) {
          throw new Error(`bundle 内出现不允许的路径: ${rel}`);
        }
        walk(abs, rel);
        continue;
      }

      if (relBase === "") {
        if (!ALLOWED_BUNDLE_FILES.includes(entry.name)) {
          throw new Error(`bundle 内出现不允许的路径: ${rel}`);
        }
      }
      found.push(rel);
    }
  };

  walk(bundleDir, "");
  return found.sort();
}

/**
 * 计算文件内容的 sha256 hex。
 *
 * @param {string} filePath
 * @returns {string}
 */
function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * 复制 bundle 到目标目录并写出收据。
 *
 * @param {{ bundleDir: string, targetDir: string, hostId: string, scope: string,
 *           mcpCommand: { command: string, args: string[] }, launcherVersion: string,
 *           logger: { info(m: string): void }, takeover?: boolean }} options
 * @returns {{ receiptPath: string, files: Record<string, string>, tookOver: boolean }}
 */
export function installSkill(options) {
  const { bundleDir, targetDir, hostId, scope, mcpCommand, launcherVersion, logger } = options;
  const takeover = options.takeover === true;

  // 先把整棵树校验完，一个字都还没写
  const relatives = listBundleFiles(bundleDir);

  let tookOver = false;
  if (existsSync(targetDir)) {
    if (!existsSync(path.join(targetDir, RECEIPT_FILE))) {
      logger.info(
        `已存在同名目录但没有安装收据，将覆盖: ${targetDir}`
        + "（里面的文件会被本安装器的 bundle 替换）",
      );
    }
    if (takeover && existsSync(path.join(targetDir, NATIVE_RECEIPT_FILE))) {
      rmSync(path.join(targetDir, NATIVE_RECEIPT_FILE), { force: true });
      tookOver = true;
      logger.info(`已删除 openwiki 原生安装收据，改为本安装器接管: ${targetDir}`);
    }
  }

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of relatives) {
    const dest = path.join(targetDir, ...rel.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(bundleDir, ...rel.split("/")), dest);
    files[rel] = sha256(dest);
  }

  const receipt = {
    package: "openwiki-launcher",
    version: launcherVersion,
    target: hostId,
    scope,
    skillDir: targetDir,
    mcpServerCommand: mcpCommand,
    files,
  };
  const receiptPath = path.join(targetDir, RECEIPT_FILE);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return { receiptPath, files, tookOver };
}

/**
 * 读取收据。
 *
 * 收据不存在或解析失败都返回 null：用户不该因为安装器的收据文件损坏而无法卸载。
 *
 * @param {string} targetDir
 * @returns {object | null}
 */
export function readReceipt(targetDir) {
  const receiptPath = path.join(targetDir, RECEIPT_FILE);
  if (!existsSync(receiptPath)) return null;
  try {
    return JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 校验已安装的 skill 是否仍与收据一致。
 *
 * @param {string} targetDir
 * @returns {{ ok: boolean, missing: boolean, mismatches: string[] }}
 */
export function verifySkill(targetDir) {
  const receipt = readReceipt(targetDir);
  if (!receipt || typeof receipt.files !== "object" || receipt.files === null) {
    return { ok: false, missing: true, mismatches: [] };
  }
  const mismatches = [];
  for (const [rel, expected] of Object.entries(receipt.files)) {
    const abs = path.join(targetDir, ...rel.split("/"));
    if (!existsSync(abs) || sha256(abs) !== expected) mismatches.push(rel);
  }
  return { ok: mismatches.length === 0, missing: false, mismatches };
}

/**
 * 删除已安装的 skill 目录，仅当收据存在且逐文件哈希全匹配。
 *
 * @param {string} targetDir
 * @param {{ warn(m: string): void }} logger
 * @returns {{ removed: boolean, reason?: "missing" | "modified" }}
 */
export function removeSkill(targetDir, logger) {
  const verdict = verifySkill(targetDir);
  if (verdict.missing) return { removed: false, reason: "missing" };
  if (!verdict.ok) {
    logger.warn(
      `文件已被修改，未删除: ${targetDir}`
      + `（改动过的文件: ${verdict.mismatches.join(", ")}）`,
    );
    return { removed: false, reason: "modified" };
  }
  rmSync(targetDir, { recursive: true, force: true });
  return { removed: true };
}