import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVersionsCommand } from "../src/commands/versions.mjs";
import { DEFAULT_REMOVED_FILE, readMarker } from "../src/ensure-default.mjs";
import { versionDir, writeActiveAtomic } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-versions-cmd-"));
}

/** 种一个可解析的已安装版本。 */
function plantVersion(root, version, { withManifest = false } = {}) {
  const pkg = path.join(versionDir(root, version), "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
  if (withManifest) {
    mkdirSync(path.join(root, "manifest"), { recursive: true });
    writeFileSync(path.join(root, "manifest", `openwiki-${version}.json`), "{}");
  }
}

describe("runVersionsCommand", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  it("removes an inactive version and reports it", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0", { withManifest: true });
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(code).toBe(0);
    expect(existsSync(versionDir(root, "0.6.0"))).toBe(false);
    expect(text()).toContain("已删除");
  });

  it("refuses to remove the active version", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeActiveAtomic(root, "0.6.0");
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(code).toBe(1);
    expect(existsSync(versionDir(root, "0.6.0"))).toBe(true);
    const out = text();
    expect(out).toContain("当前激活");
    expect(out).toContain("先 switch");
  });

  it("rejects an invalid version name", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeActiveAtomic(root, "0.7.0");
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", ".."] });

    expect(code).toBe(1);
    expect(existsSync(versionDir(root, "0.6.0"))).toBe(true);
    expect(text()).toContain("x.y.z");
  });

  it("reports a version that is not installed", async () => {
    const root = freshRoot();
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "9.9.9"] });

    expect(code).toBe(1);
    expect(text()).toContain("未安装");
  });

  it("keeps the manifest snapshot after removal", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0", { withManifest: true });
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    const { logger } = collectLogger();

    await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(existsSync(path.join(root, "manifest", "openwiki-0.6.0.json"))).toBe(true);
  });

  it("prints usage when no subcommand is given", async () => {
    const root = freshRoot();
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: [] });

    expect(code).toBe(1);
    expect(text()).toContain("versions remove <version>");
  });
});

describe("删除默认版本后的标记", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  /** 种一个出厂依赖，让 pkgRoot 知道自己"默认版本"是谁。 */
  function plantBundled(root, version) {
    const dir = path.join(root, "node_modules", "openwiki");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openwiki", version }));
  }

  it("把默认版本标记为已删除，阻止自动就绪把它长回来", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    plantBundled(root, "0.6.0");
    const { text, logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(code).toBe(0);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toMatchObject({ version: "0.6.0" });
    expect(text()).toContain("不再自动重建");
  });

  it("删除非默认版本不写标记", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    plantBundled(root, "0.8.0");
    const { logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(code).toBe(0);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toBeNull();
  });

  it("删除被拒绝时（当前激活）不写标记", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeActiveAtomic(root, "0.6.0");
    plantBundled(root, "0.6.0");
    const { logger } = collectLogger();

    const code = await runVersionsCommand({ logger, pkgRoot: root, args: ["remove", "0.6.0"] });

    expect(code).toBe(1);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toBeNull();
  });
});
