import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { versionDir, versionsRoot } from "./versions.mjs";
import { acquireLock, releaseLock } from "./lockfile.mjs";
import { ensureEsbuild } from "./esbuild-tools.mjs";

const PINNED = { esbuildVersion: "0.28.2" };

// 打包脚本相对本模块定位（同仓库），不随被测 pkgRoot 漂移
const BUNDLE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bundle-backend.mjs");

function scriptHashOf() {
  return createHash("sha256").update(readFileSync(BUNDLE_SCRIPT)).digest("hex");
}

function readMeta(bundleDir) {
  try {
    return JSON.parse(readFileSync(path.join(bundleDir, "bundle.meta.json"), "utf8"));
  } catch {
    return null;
  }
}

function metaValid(meta, { version, scriptHash, bundleDir }) {
  return (
    meta &&
    meta.openwikiVersion === version &&
    meta.scriptHash === scriptHash &&
    meta.nodeMajor === process.versions.node.split(".")[0] &&
    meta.platform === process.platform &&
    typeof meta.file === "string" &&
    existsSync(path.join(bundleDir, meta.file))
  );
}

/**
 * bundle 生产与保鲜的唯一入口（规格 §9）。
 *
 * 语义：meta 有效即复用；过期/缺失则经构建锁独占构建——产物按内容哈希寻址
 * （`bundle-<hash8>.mjs`，避免 rename 覆盖被运行中后端占用的文件），临时文件
 * 写入后 rename，meta 记录实际文件名；成功后清除 bundle.bad。任何失败都
 * 软着陆为 { ok: false, reason }，由调用方降级到源码入口。
 *
 * @param {{
 *   version: string,
 *   pkgRoot: string,
 *   logger: { debug(m: string): void, info(m: string): void, warn(m: string): void, error(m: string): void },
 *   deps?: {
 *     buildKernel?: ({ outfile: string, esbuildModule: object }) => Promise<{ ok: boolean, bytes?: number }>,
 *     ensureEsbuildFn?: (options: object) => Promise<{ ok: boolean, esbuildModule?: object, reason?: string }>,
 *   },
 * }} options
 * @returns {Promise<{ ok: true, reused?: boolean, file?: string } | { ok: false, reason: string }>}
 */
export async function ensureBundle({ version, pkgRoot, logger, deps = {} }) {
  const bundleDir = versionDir(pkgRoot, version);
  const metaPath = path.join(bundleDir, "bundle.meta.json");
  const sHash = scriptHashOf(pkgRoot);
  const buildKernel = deps.buildKernel ?? null;
  const ensureEsbuildFn = deps.ensureEsbuildFn ?? ensureEsbuild;

  const existingMeta = readMeta(bundleDir);
  if (metaValid(existingMeta, { version, scriptHash: sHash, bundleDir })) {
    return { ok: true, reused: true, file: existingMeta.file };
  }

  const esbuild = await ensureEsbuildFn({ dataDir: pkgRoot, logger, pinnedVersion: PINNED.esbuildVersion });
  if (!esbuild.ok) return { ok: false, reason: esbuild.reason };

  const lockPath = path.join(versionsRoot(pkgRoot), "bundle.lock");
  const lock = acquireLock(lockPath, { pid: process.pid, startedAt: Date.now() });
  if (!lock.acquired) {
    // 另一个进程正在构建：本次降级源码，锁释放后的下一次触发自然补上
    return { ok: false, reason: "另一进程正在构建 bundle" };
  }

  try {
    mkdirSync(bundleDir, { recursive: true });
    const tmpOut = path.join(bundleDir, `bundle.mjs.tmp-${process.pid}`);
    let buildResult;
    if (buildKernel) {
      buildResult = await buildKernel({ outfile: tmpOut, esbuildModule: esbuild.esbuildModule });
    } else {
      const { runBundleBackend } = await import("../scripts/bundle-backend.mjs");
      // runBundleBackend 返回退出码（0/1），适配为内核契约 { ok }
      const code = await runBundleBackend({
        logger,
        pkgRoot,
        outDir: bundleDir,
        outFile: tmpOut,
        esbuildModule: esbuild.esbuildModule,
      });
      buildResult = { ok: code === 0, reason: code === 0 ? undefined : "bundle 构建退出码非 0" };
    }
    if (!buildResult || buildResult.ok !== true || !existsSync(tmpOut)) {
      try {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch {
        // 临时文件清理失败不影响结论
      }
      return { ok: false, reason: buildResult?.reason ?? "bundle 构建失败" };
    }

    const contents = readFileSync(tmpOut);
    const hash8 = createHash("sha256").update(contents).digest("hex").slice(0, 8);
    const finalName = `bundle-${hash8}.mjs`;
    const finalPath = path.join(bundleDir, finalName);
    if (existsSync(finalPath)) unlinkSync(tmpOut);
    else renameSync(tmpOut, finalPath);

    const meta = {
      openwikiVersion: version,
      scriptHash: sHash,
      nodeMajor: process.versions.node.split(".")[0],
      platform: process.platform,
      bundleHash: hash8,
      file: finalName,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const badPath = path.join(bundleDir, "bundle.bad");
    if (existsSync(badPath)) unlinkSync(badPath);
    logger.info(`bundle 已就绪：${finalName}（${(contents.length / 1024 / 1024).toFixed(1)}MB）`);
    return { ok: true, file: finalName };
  } finally {
    releaseLock(lockPath);
  }
}
