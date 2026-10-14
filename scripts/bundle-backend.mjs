import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledOpenwikiVersion } from "../src/paths.mjs";
import { launcherPackageRoot, readActive } from "../src/versions.mjs";

// 注意：本文件**不得**静态 import esbuild。esbuild 不是本包的运行时依赖
// （全局安装只有 dependencies），由 ensureBundle 经 ensureEsbuild 懒安装到
// 用户数据目录后以 esbuildModule 参数注入。顶部静态 import 会在模块加载时
// 直接抛 ERR_MODULE_NOT_FOUND，把整套懒加载设计击穿（2026-10-13 实测：
// 全局安装下 update 的 bundle 全部失败于此）。回归测试见
// test/bundle-backend.test.mjs 的源文件不变量用例。

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
 *   outFile?: string,
 *   esbuildModule: object,
 * }} options
 * @returns {Promise<{ ok: true, entryVersion: string | null } | { ok: false, reason: string }>}
 *   `entryVersion` 是实际被打包的入口包声明的版本，调用方必须拿它与请求版本
 *   比对后才允许写 meta。
 */
export async function runBundleBackend({
  logger,
  pkgRoot = launcherPackageRoot(),
  version,
  outDir,
  outFile: resolvedOutFile,
  esbuildModule,
}) {
  if (!esbuildModule) {
    const reason = "esbuild 模块缺失：应由 ensureBundle 经 ensureEsbuild 注入（本脚本不静态引入 esbuild）";
    logger.error(reason);
    return { ok: false, reason };
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

  // 入口必须来自**目标版本自己**的包目录。回退出厂依赖只在目标版本就是出厂
  // 版本时成立——否则打出来的是"声称 v0.7.0、内容是 v0.6.0"的产物，而 meta
  // 校验会把它当成合法产物永久复用。宁可失败，也要慢而正确。
  const bundledEntry = path.join(pkgRoot, "node_modules", "openwiki", "dist", "cli", "cli.js");
  const candidates = [path.join(pkgRoot, "versions", targetVersion, "node_modules", "openwiki", "dist", "cli", "cli.js")];
  if (targetVersion === bundledOpenwikiVersion(pkgRoot)) candidates.push(bundledEntry);
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) {
    const reason = `versions/${targetVersion} 下找不到可解析的 openwiki 入口`;
    logger.error(reason);
    return { ok: false, reason };
  }
  const entryVersion = readEntryVersion(entry);

  const started = Date.now();
  try {
    mkdirSync(targetDir, { recursive: true });
    const result = await esbuildModule.build({
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
    return { ok: true, entryVersion };
  } catch (error) {
    logger.error(`bundle 构建失败：${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/** 入口包声明的版本号：dist/cli/cli.js 往上三级就是 openwiki 包目录。 */
function readEntryVersion(entry) {
  const packageJson = path.join(path.resolve(entry, "..", "..", ".."), "package.json");
  try {
    return JSON.parse(readFileSync(packageJson, "utf8")).version ?? null;
  } catch {
    return null;
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
  ensureBundle({ version, pkgRoot, logger })
    .then((result) => {
      if (result.ok) process.exit(0);
      // 失败必须留下原因：静默 exit 1 会让使用者（和 npm run bundle）无从判断
      logger.error(`bundle 未就绪：${result.reason ?? "未知原因"}`);
      process.exit(1);
    })
    .catch((error) => {
      logger.error(`bundle 失败：${error.message}`);
      process.exit(1);
    });
}
