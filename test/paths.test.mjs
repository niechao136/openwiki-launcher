import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenwikiNotFoundError, resolveOpenwikiRuntime } from "../src/paths.mjs";
import { writeActiveAtomic } from "../src/versions.mjs";

/** 在指定相对目录种一个可解析的假 openwiki；返回其 cli.js 绝对路径。 */
function plantFakeOpenwiki(root, relDir, version) {
  const pkg = path.join(root, relDir);
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
  return path.join(pkg, "dist", "cli", "cli.js");
}

describe("resolveOpenwikiRuntime", () => {
  it("resolves the pinned openwiki package and its CLI entry", async () => {
    const runtime = await resolveOpenwikiRuntime();

    expect(runtime.version).toBe("0.6.0");
    expect(existsSync(runtime.cliJs)).toBe(true);
    expect(runtime.cliJs.endsWith(path.join("openwiki", "dist", "cli", "cli.js"))).toBe(true);
  });

  it("reports the package root that contains package.json", async () => {
    const runtime = await resolveOpenwikiRuntime();

    expect(existsSync(path.join(runtime.packageRoot, "package.json"))).toBe(true);
  });

  it("prefers the version the active pointer names", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      const cliJs = plantFakeOpenwiki(root, path.join("versions", "0.7.0", "node_modules", "openwiki"), "0.7.0");
      writeActiveAtomic(root, "0.7.0");

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root });

      expect(runtime.version).toBe("0.7.0");
      expect(runtime.source).toBe("versions");
      expect(runtime.cliJs).toBe(cliJs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bundled dependency when no pointer exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("node_modules", "openwiki"), "0.6.0");

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root });

      expect(runtime.version).toBe("0.6.0");
      expect(runtime.source).toBe("bundled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("忽略 entryVersion 缺失的 bundle：那可能是用出厂代码冒名打出来的", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      const cliJs = plantFakeOpenwiki(root, path.join("versions", "0.7.0", "node_modules", "openwiki"), "0.7.0");
      writeActiveAtomic(root, "0.7.0");
      writeFileSync(path.join(root, "versions", "0.7.0", "bundle-alpha.mjs"), "// 冒名产物");
      writeFileSync(
        path.join(root, "versions", "0.7.0", "bundle.meta.json"),
        JSON.stringify({ openwikiVersion: "0.7.0", file: "bundle-alpha.mjs" }),
      );

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root });

      expect(runtime.backend).toBe("source");
      expect(runtime.cliJs).toBe(cliJs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("entryVersion 与请求版本一致的 bundle 才被采用", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("versions", "0.7.0", "node_modules", "openwiki"), "0.7.0");
      writeActiveAtomic(root, "0.7.0");
      const bundlePath = path.join(root, "versions", "0.7.0", "bundle-beta.mjs");
      writeFileSync(bundlePath, "// bundle");
      writeFileSync(
        path.join(root, "versions", "0.7.0", "bundle.meta.json"),
        JSON.stringify({ openwikiVersion: "0.7.0", entryVersion: "0.7.0", file: "bundle-beta.mjs" }),
      );

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root });

      expect(runtime.backend).toBe("bundle");
      expect(runtime.cliJs).toBe(bundlePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back with a warning when the pointer is corrupted", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("node_modules", "openwiki"), "0.6.0");
      mkdirSync(path.join(root, "versions"), { recursive: true });
      writeFileSync(path.join(root, "versions", "active.json"), "not json");
      const warnings = [];
      const logger = { warn: (message) => warnings.push(message) };

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root, logger });

      expect(runtime.source).toBe("bundled");
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back when the pointed version is not installed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("node_modules", "openwiki"), "0.6.0");
      writeActiveAtomic(root, "9.9.9");
      const warnings = [];
      const logger = { warn: (message) => warnings.push(message) };

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root, logger });

      expect(runtime.source).toBe("bundled");
      expect(runtime.version).toBe("0.6.0");
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves an explicit version without consulting the pointer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("versions", "0.6.0", "node_modules", "openwiki"), "0.6.0");
      const cliJs = plantFakeOpenwiki(root, path.join("versions", "0.7.0", "node_modules", "openwiki"), "0.7.0");
      writeActiveAtomic(root, "0.6.0");

      const runtime = await resolveOpenwikiRuntime({ pkgRoot: root, explicitVersion: "0.7.0" });

      expect(runtime.version).toBe("0.7.0");
      expect(runtime.cliJs).toBe(cliJs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never resolves an openwiki found by walking up the tree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      // 模拟 npm 全局根：openwiki 装在 pkgRoot 的父目录里。
      plantFakeOpenwiki(path.dirname(root), path.join("node_modules", "openwiki"), "9.9.9");

      await expect(resolveOpenwikiRuntime({ pkgRoot: root })).rejects.toThrow(OpenwikiNotFoundError);
    } finally {
      rmSync(path.join(path.dirname(root), "node_modules"), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to fall back to the bundled dependency for an explicit version", async () => {
    // explicitVersion 是「给这个还没激活的版本录快照」的入口。解析不到时若
    // 静默回退出厂版，录出来的快照会自称 9.9.9、内容是 0.6.0——一份对不上的
    // 工具清单正是规格要避免的。宁可不录。
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-paths-"));
    try {
      plantFakeOpenwiki(root, path.join("node_modules", "openwiki"), "0.6.0");

      await expect(
        resolveOpenwikiRuntime({ pkgRoot: root, explicitVersion: "9.9.9" }),
      ).rejects.toThrow(OpenwikiNotFoundError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
