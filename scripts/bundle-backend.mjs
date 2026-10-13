import * as esbuild from "esbuild";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPackageRoot, readActive } from "../src/versions.mjs";

// react-devtools-core 只服务 React DevTools 调试，openwiki 运行时不可达；
// 用空模块替换，避免为它引入真实依赖。
const stubDevtools = {
  name: "stub-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default undefined;",
      loader: "js",
    }));
  },
};

/**
 * 把 openwiki CLI 打成单文件 ESM bundle。
 *
 * 配置来源（探路实测固化，改动前先重测）：
 * - format esm：openwiki dist 有 top-level await，CJS 输出直接报错；
 * - banner createRequire：ESM 产物内 CJS 依赖（signal-exit 等）require node 内置模块；
 * - external better-sqlite3：原生模块无法入包；jsdom：mermaid dom-shim 的动态
 *   import，MCP 路径不触达；jsonc-parser：UMD 动态 require 相对路径在 bundle 内失效；
 * - stub react-devtools-core：ink 调试依赖，静态 import 但运行时不可达。
 *
 * @param {{
 *   logger: { debug(m: string): void, info(m: string): void, warn(m: string): void, error(m: string): void },
 *   pkgRoot?: string,
 *   version?: string,
 *   outDir?: string,
 *   esbuildModule?: object | null,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runBundleBackend({
  logger,
  pkgRoot = launcherPackageRoot(),
  version,
  outDir,
  outFile: resolvedOutFile,
  esbuildModule: esbuildModuleOverride = esbuild,
}) {
  if (!esbuildModuleOverride) {
    logger.error("esbuild 不可用：请先 npm install（esbuild 为 devDependency）");
    return 1;
  }
  let active;
  try {
    active = readActive(pkgRoot);
  } catch {
    active = null;
  }
  // 目标版本目录必须与运行时解析出的版本号一致（preferBundle 按 version 查找）：
  // 有指针用指针；无指针时读 openwiki 包自身的声明——"bundled" 不是版本号，
  // 落到 versions/bundled/ 的 bundle 永远不会被运行时找到。
  let targetVersion = version ?? active?.version;
  if (!targetVersion) {
    const backendPkg = path.join(pkgRoot, "node_modules", "openwiki", "package.json");
    try {
      targetVersion = JSON.parse(readFileSync(backendPkg, "utf8")).version;
    } catch {
      targetVersion = null;
    }
  }
  targetVersion = targetVersion ?? "bundled";
  const targetDir = outDir ?? path.join(pkgRoot, "versions", targetVersion);
  // ensureBundle 走内容寻址：先构建到临时/指定路径，再由它 rename 到最终名
  const outfile = resolvedOutFile ?? path.join(targetDir, "bundle.mjs");
  const entry = path.join(pkgRoot, "node_modules", "openwiki", "dist", "cli", "cli.js");
  if (!existsSync(entry)) {
    logger.error(`未找到 openwiki CLI 入口：${entry}`);
    return 1;
  }

  const started = Date.now();
  try {
    mkdirSync(targetDir, { recursive: true });
    const result = await esbuildModuleOverride.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile,
      external: ["better-sqlite3", "jsdom", "jsonc-parser"],
      plugins: [stubDevtools],
      banner: {
        js: 'import { createRequire as __cReq } from "node:module"; const require = __cReq(import.meta.url);',
      },
      metafile: true,
      minify: false,
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
    });
    const key = Object.keys(result.metafile.outputs)[0];
    const bytes = result.metafile.outputs[key]?.bytes ?? 0;
    logger.info(`bundle 完成：${outfile}（${(bytes / 1024 / 1024).toFixed(1)}MB，${Date.now() - started}ms）`);
    return 0;
  } catch (error) {
    logger.error(`bundle 构建失败：${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const logger = {
    debug() {},
    info: (m) => process.stdout.write(`${m}\n`),
    warn: (m) => process.stderr.write(`[launcher] warn: ${m}\n`),
    error: (m) => process.stderr.write(`[launcher] ${m}\n`),
  };
  // CLI 入口也走 ensureBundle：meta / 内容寻址 / bundle.bad 清除只有它管
  const { readActive } = await import("../src/versions.mjs");
  const { ensureBundle } = await import("../src/ensure-bundle.mjs");
  const pkgRoot = launcherPackageRoot();
  let version = readActive(pkgRoot)?.version;
  if (!version) {
    const backendPkg = path.join(pkgRoot, "node_modules", "openwiki", "package.json");
    version = JSON.parse(readFileSync(backendPkg, "utf8")).version;
  }
  ensureBundle({ version, pkgRoot, logger }).then((result) =>
    process.exit(result.ok ? 0 : 1),
  );
}
