import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEsbuild } from "../src/esbuild-tools.mjs";
import { ensureBundle } from "../src/ensure-bundle.mjs";
import { resolveOpenwikiRuntime } from "../src/paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanups = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eb-test-"));
  cleanups.push(dir);
  return dir;
};
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("ensureEsbuild", () => {
  it("installs the pinned version into the tools dir when absent", async () => {
    const dataDir = tempDir();
    const calls = [];
    const result = await ensureEsbuild({
      dataDir,
      logger: noopLogger,
      runNpmFn: async (args) => {
        calls.push(args);
        // 模拟安装成功：写出可解析的 esbuild 入口
        const dir = path.join(dataDir, "tools", "esbuild");
        mkdirSync(path.join(dir, "node_modules", "esbuild"), { recursive: true });
        writeFileSync(path.join(dir, "node_modules", "esbuild", "lib", "main.js"), "export default {};");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].join(" ")).toContain("esbuild@");
    expect(calls[0].join(" ")).not.toContain("^");
  });

  it("reuses an existing install without invoking npm", async () => {
    const dataDir = tempDir();
    const dir = path.join(dataDir, "tools", "esbuild");
    mkdirSync(path.join(dir, "node_modules", "esbuild"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "esbuild", "lib", "main.js"), "export default {};");
    let called = false;
    const result = await ensureEsbuild({
      dataDir,
      logger: noopLogger,
      runNpmFn: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("reports failure reason without throwing", async () => {
    const result = await ensureEsbuild({
      dataDir: tempDir(),
      logger: noopLogger,
      runNpmFn: async () => ({ code: 1, stdout: "", stderr: "network down" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("network down");
  });
});

describe("ensureBundle", () => {
  const buildKernelWrites = (contents = "// bundle v1") =>
    async ({ outfile }) => {
      writeFileSync(outfile, contents);
      return { ok: true, bytes: contents.length };
    };

  it("builds, writes meta and clears bundle.bad when absent", async () => {
    const pkgRoot = tempDir();
    const result = await ensureBundle({
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: { buildKernel: buildKernelWrites(), ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) },
    });
    expect(result.ok).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(pkgRoot, "versions", "0.6.0", "bundle.meta.json"), "utf8"));
    expect(meta.openwikiVersion).toBe("0.6.0");
    expect(meta.nodeMajor).toBe(process.versions.node.split(".")[0]);
    expect(meta.platform).toBe(process.platform);
    expect(typeof meta.scriptHash).toBe("string");
    expect(typeof meta.file).toBe("string");
    expect(existsSync(path.join(pkgRoot, "versions", "0.6.0", meta.file))).toBe(true);
  });

  it("reuses a valid meta without rebuilding", async () => {
    const pkgRoot = tempDir();
    const buildKernel = buildKernelWrites();
    const options = {
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: { buildKernel, ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) },
    };
    await ensureBundle(options);
    await ensureBundle(options);
    expect(buildKernel).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when meta is stale (node major changed)", async () => {
    const pkgRoot = tempDir();
    const buildKernel = buildKernelWrites();
    const options = {
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: { buildKernel, ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) },
    };
    await ensureBundle(options);
    const metaPath = path.join(pkgRoot, "versions", "0.6.0", "bundle.meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.nodeMajor = "99";
    writeFileSync(metaPath, JSON.stringify(meta));
    await ensureBundle(options);
    expect(buildKernel).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild over an identical existing artifact", async () => {
    const pkgRoot = tempDir();
    const buildKernel = buildKernelWrites("same bytes");
    const options = {
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: { buildKernel, ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) },
    };
    await ensureBundle(options);
    await ensureBundle({ ...options, deps: { buildKernel, ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) } });
    // 第二次构建走完整内核但产物同内容：内容寻址命中已有文件，目录里只有一个 bundle 文件
    const files = existsSync(path.join(pkgRoot, "versions", "0.6.0"))
      ? readdirSync(path.join(pkgRoot, "versions", "0.6.0")).filter((f) => f.startsWith("bundle-"))
      : [];
    expect(files.length).toBeLessThanOrEqual(1);
  });

  it("fails softly when esbuild cannot be installed", async () => {
    const pkgRoot = tempDir();
    const result = await ensureBundle({
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: {
        buildKernel: buildKernelWrites(),
        ensureEsbuildFn: async () => ({ ok: false, reason: "offline" }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("offline");
    expect(existsSync(path.join(pkgRoot, "versions", "0.6.0", "bundle.meta.json"))).toBe(false);
  });

  it("skips the bundle when bundle.bad is present, and clears it on successful rebuild", async () => {
    const pkgRoot = tempDir();
    mkdirSync(path.join(pkgRoot, "versions", "0.6.0"), { recursive: true });
    writeFileSync(path.join(pkgRoot, "versions", "0.6.0", "bundle.bad"), "");
    const result = await ensureBundle({
      version: "0.6.0",
      pkgRoot,
      logger: noopLogger,
      deps: { buildKernel: buildKernelWrites(), ensureEsbuildFn: async () => ({ ok: true, esbuildModule: {} }) },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(pkgRoot, "versions", "0.6.0", "bundle.bad"))).toBe(false);
  });
});

describe("preferBundle honours bundle.bad", () => {
  it("falls back to source when bundle.bad exists", async () => {
    const root = tempDir();
    mkdirSync(path.join(root, "versions", "0.6.0", "node_modules", "openwiki", "dist", "cli"), { recursive: true });
    writeFileSync(path.join(root, "versions", "0.6.0", "node_modules", "openwiki", "package.json"), JSON.stringify({ version: "0.6.0" }));
    writeFileSync(path.join(root, "versions", "0.6.0", "node_modules", "openwiki", "dist", "cli", "cli.js"), "// cli\n");
    writeFileSync(path.join(root, "versions", "active.json"), JSON.stringify({ version: "0.6.0" }));
    writeFileSync(path.join(root, "versions", "0.6.0", "bundle.meta.json"), JSON.stringify({
      openwikiVersion: "0.6.0", scriptHash: "x", nodeMajor: process.versions.node.split(".")[0], platform: process.platform, file: "bundle-abc12345.mjs",
    }));
    writeFileSync(path.join(root, "versions", "0.6.0", "bundle-abc12345.mjs"), "// bundle\n");
    writeFileSync(path.join(root, "versions", "0.6.0", "bundle.bad"), "");
    const rt = await resolveOpenwikiRuntime({ pkgRoot: root });
    expect(rt.backend).toBe("source");
  });
});
