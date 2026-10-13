import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPackageRoot, readActive, versionDir, versionsRoot } from "./versions.mjs";
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

/**
 * 当前生效版本的 bundle 状态："ready" / "bad" / "missing"。
 *
 * @param {string} pkgRoot
 * @param {string} version
 * @returns {"ready" | "bad" | "missing"}
 */
export function bundleStatus(pkgRoot, version) {
  const bundleDir = versionDir(pkgRoot, version);
  if (existsSync(path.join(bundleDir, "bundle.bad"))) return "bad";
  try {
    const meta = JSON.parse(readFileSync(path.join(bundleDir, "bundle.meta.json"), "utf8"));
    if (typeof meta.file === "string" && existsSync(path.join(bundleDir, meta.file))) return "ready";
  } catch {
    // meta 缺失/损坏 → missing
  }
  return "missing";
}

/**
 * 对当前生效版本执行 ensureBundle（版本号探测：指针优先，回退 openwiki 包声明）。
 *
 * @param {{ pkgRoot?: string, logger: object, deps?: object }} options
 */
export async function ensureBundleForActive({ pkgRoot = launcherPackageRoot(), logger, deps }) {
  let version = readActive(pkgRoot)?.version;
  if (!version) {
    const backendPkg = path.join(pkgRoot, "node_modules", "openwiki", "package.json");
    try {
      version = JSON.parse(readFileSync(backendPkg, "utf8")).version;
    } catch {
      return { ok: false, reason: "无法确定 openwiki 版本（指针缺失且 node_modules 不可读）" };
    }
  }
  return ensureBundle({ version, pkgRoot, logger, deps });
}

/**
 * §9：mcp 运行中发现缺 bundle（backend=source）时，等后端就绪后再后台补打——
 * 补打的 IO 不得与冷启动抢资源。backend=bundle（当前会话已在用）则不调度。
 *
 * @param {{
 *   runtime: { backend: string, version: string },
 *   pkgRoot: string,
 *   logger: object,
 *   supervisor: { ensureReady(): Promise<object> },
 *   ensureBundleFn?: Function,
 * }} options
 */
export function scheduleBackgroundBundle({ runtime, pkgRoot, logger, supervisor, ensureBundleFn }) {
  if (runtime.backend !== "source") return;
  supervisor
    .ensureReady()
    .then(() => (ensureBundleFn ?? ensureBundle)({ version: runtime.version, pkgRoot, logger }))
    .then((result) => {
      if (result.ok) logger.info(`bundle 已在后台生成：${result.file}（下次会话生效）`);
      else logger.warn(`后台补打 bundle 未成功：${result.reason ?? "未知原因"}`);
    })
    .catch((error) => logger.warn(`后台补打 bundle 失败：${error.message}`));
}

/**
 * bundle 启动失败的运行时兜底（§9）：就绪前崩溃时改用源码入口重试一次；
 * **只有源码随后成功**才写 bundle.bad——磁盘满、杀毒拦截等与 bundle 无关的
 * 失败不污染标记。标记在下一次 ensureBundle 成功时清除（解析层见 bundle.bad
 * 自动跳过 bundle）。
 *
 * @param {{
 *   primary: object,
 *   makeFallback: (sourceCliJs: string) => object,
 *   bundleCliJs: string,
 *   sourceCliJs: string,
 *   badPath: string,
 *   logger: object,
 * }} options
 */
export function createBundleFallbackSupervisor({
  primary,
  makeFallback,
  bundleCliJs,
  sourceCliJs,
  badPath,
  logger,
}) {
  let recovered = false;
  let fallback = null;
  const exitListeners = [];
  const forwardExit = (target) => {
    try {
      target.onSessionExit((info) => {
        for (const fn of exitListeners) fn(info);
      });
    } catch {
      // 目标不提供 onSessionExit 时静默
    }
  };
  forwardExit(primary);

  return {
    ensureReady() {
      if (recovered) return fallback.ensureReady();
      return primary.ensureReady().catch(async (error) => {
        recovered = true;
        logger.warn(`bundle 启动的后端失败，改用源码入口重试：${error.message}`);
        fallback = fallback ?? makeFallback(sourceCliJs);
        forwardExit(fallback);
        try {
          const session = await fallback.ensureReady();
          try {
            writeFileSync(badPath, "");
          } catch {
            // 标记写失败不影响兜底运行
          }
          return session;
        } catch (fallbackError) {
          // 源码也失败：问题不在 bundle，不写标记
          logger.warn(`源码入口同样失败：${fallbackError.message}`);
          throw fallbackError;
        }
      });
    },
    current() {
      return (recovered ? fallback : primary).current();
    },
    onSessionExit(fn) {
      exitListeners.push(fn);
    },
    stop() {
      primary.stop();
      if (fallback) fallback.stop();
    },
  };
}
