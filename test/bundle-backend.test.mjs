import { existsSync, statSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("runBundleBackend", () => {
  // 真实 esbuild 构建：单独跑约 3s，但全量套件并发下（ Defender 扫描 + 多 worker
  // 抢 IO）实测可到 60s+。给足上限，超时是环境信号不是代码信号。
  it("builds a bundle over 1MB into the output dir", { timeout: 180000 }, async () => {
    const outDir = tempOutDir();
    const code = await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    expect(code).toBe(0);
    const bundlePath = path.join(outDir, "bundle.mjs");
    expect(existsSync(bundlePath)).toBe(true);
    expect(statSync(bundlePath).size).toBeGreaterThan(1024 * 1024);
  });

  it("overwrites a previous build idempotently", { timeout: 180000 }, async () => {
    const outDir = tempOutDir();
    await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    const code = await runBundleBackend({ logger: noopLogger, pkgRoot: REPO_ROOT, outDir, esbuildModule: esbuild });
    expect(code).toBe(0);
  });

  it("fails with a clear message when esbuild is unavailable", async () => {
    const { logger, lines } = { logger: { debug() {}, info() {}, warn() {}, error: (m) => lines.push(m) }, lines: [] };
    const code = await runBundleBackend({
      logger,
      pkgRoot: REPO_ROOT,
      outDir: tempOutDir(),
      esbuildModule: null,
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("esbuild"))).toBe(true);
  });

  it("passes the pinned build options to esbuild", { timeout: 60000 }, async () => {
    const outDir = tempOutDir();
    const captured = [];
    const fakeEsbuild = {
      build: async (options) => {
        captured.push(options);
        return { metafile: { outputs: { "out.mjs": { bytes: 100 } } } };
      },
    };
    const code = await runBundleBackend({
      logger: noopLogger,
      pkgRoot: REPO_ROOT,
      outDir,
      esbuildModule: fakeEsbuild,
    });
    expect(code).toBe(0);
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
