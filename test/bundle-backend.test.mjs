import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { runBundleBackend } from "../scripts/bundle-backend.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const cleanups = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempOutDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  cleanups.push(dir);
  return dir;
}

/** 建一个临时 pkgRoot 夹具（含 versions/ 与 node_modules/）。 */
function tempPkgRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bundle-root-"));
  cleanups.push(dir);
  return dir;
}

/** 在任意目录里种出一个可解析的 openwiki 入口树。 */
function plantOpenwikiAt(dir, version) {
  const pkg = path.join(dir, "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openwiki", version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
  return path.join(pkg, "dist", "cli", "cli.js");
}

/** 只记录 build 参数的假 esbuild。 */
function recordingEsbuild() {
  const captured = [];
  return {
    captured,
    module: {
      build: async (options) => {
        captured.push(options);
        return { metafile: { outputs: { "out.mjs": { bytes: 100 } } } };
      },
    },
  };
}

describe("runBundleBackend", () => {
  // 真实 esbuild 构建：单独跑约 3s，但全量套件并发下（ Defender 扫描 + 多 worker
  // 抢 IO）实测可到 60s+。给足上限，超时是环境信号不是代码信号。
  it("builds a bundle over 1MB into the output dir", { timeout: 180000 }, async () => {
    const outDir = tempOutDir();
    const result = await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    expect(result.ok).toBe(true);
    const bundlePath = path.join(outDir, "bundle.mjs");
    expect(existsSync(bundlePath)).toBe(true);
    expect(statSync(bundlePath).size).toBeGreaterThan(1024 * 1024);
  });

  it("overwrites a previous build idempotently", { timeout: 180000 }, async () => {
    const outDir = tempOutDir();
    await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    const result = await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    expect(result.ok).toBe(true);
  });

  it("fails with a clear message when esbuild is unavailable", async () => {
    const lines = [];
    const logger = { debug() {}, info() {}, warn() {}, error: (m) => lines.push(m) };
    const result = await runBundleBackend({
      logger,
      pkgRoot: REPO_ROOT,
      outDir: tempOutDir(),
      esbuildModule: null,
    });
    expect(result.ok).toBe(false);
    expect(lines.some((l) => l.includes("esbuild"))).toBe(true);
  });

  it("passes the pinned build options to esbuild", { timeout: 60000 }, async () => {
    const outDir = tempOutDir();
    const { module, captured } = recordingEsbuild();
    const result = await runBundleBackend({
      logger: noopLogger,
      pkgRoot: REPO_ROOT,
      outDir,
      esbuildModule: module,
    });
    expect(result.ok).toBe(true);
    const options = captured[0];
    expect(options.format).toBe("esm");
    expect(options.platform).toBe("node");
    expect(options.bundle).toBe(true);
    for (const name of ["better-sqlite3", "jsdom", "jsonc-parser"]) {
      expect(options.external).toContain(name);
    }
    expect(options.banner.js).toContain("createRequire");
    const stubPlugin = options.plugins?.[0];
    expect(stubPlugin?.name).toBe("stub-devtools");
  });

  it("bundles the target version's own entry, not the bundled dependency", { timeout: 60000 }, async () => {
    const pkgRoot = tempPkgRoot();
    plantOpenwikiAt(pkgRoot, "0.6.0");
    const ownEntry = plantOpenwikiAt(path.join(pkgRoot, "versions", "0.7.0"), "0.7.0");
    const { module, captured } = recordingEsbuild();

    const result = await runBundleBackend({
      logger: noopLogger,
      pkgRoot,
      version: "0.7.0",
      outDir: tempOutDir(),
      esbuildModule: module,
    });

    expect(result).toEqual({ ok: true, entryVersion: "0.7.0" });
    expect(captured[0].entryPoints).toEqual([ownEntry]);
  });

  it("falls back to the bundled dependency only for the bundled version", { timeout: 60000 }, async () => {
    const pkgRoot = tempPkgRoot();
    const bundledEntry = plantOpenwikiAt(pkgRoot, "0.6.0");
    const { module, captured } = recordingEsbuild();

    const result = await runBundleBackend({
      logger: noopLogger,
      pkgRoot,
      version: "0.6.0",
      outDir: tempOutDir(),
      esbuildModule: module,
    });

    expect(result).toEqual({ ok: true, entryVersion: "0.6.0" });
    expect(captured[0].entryPoints).toEqual([bundledEntry]);
  });

  it("refuses to build a non-bundled version out of the bundled dependency", async () => {
    const pkgRoot = tempPkgRoot();
    plantOpenwikiAt(pkgRoot, "0.6.0");
    const { module, captured } = recordingEsbuild();

    const result = await runBundleBackend({
      logger: noopLogger,
      pkgRoot,
      version: "0.7.0",
      outDir: tempOutDir(),
      esbuildModule: module,
    });

    // 用出厂代码冒名 v0.7.0 会产出一份"声称是 0.7.0、内容是 0.6.0"的 bundle，
    // 比慢更糟：它会被 meta 校验永久复用。宁可失败。
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("0.7.0");
    expect(captured).toEqual([]);
  });

  // 回归护栏（2026-10-13）：全局安装下 esbuild 不是 dependencies，静态 import
  // 会在模块加载时抛 ERR_MODULE_NOT_FOUND，ensureEsbuild 的懒安装设计被整个
  // 击穿（update/switch/安装的 bundle 全部失败）。workspace 内 esbuild 始终可
  // 解析，运行时测试复现不了该失败模式，故以源文件不变量钉住。
  it("does not statically import esbuild (injection only)", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts", "bundle-backend.mjs"), "utf8");
    expect(source).not.toMatch(/^\s*import\b[^;]*\bfrom\s*["']esbuild["']/m);
    expect(source).not.toMatch(/require\(\s*["']esbuild["']\s*\)/);
  });
});
