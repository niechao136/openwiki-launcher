import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REMOVED_FILE, ensureDefaultVersion, readMarker } from "../src/ensure-default.mjs";
import { bundleStatus } from "../src/ensure-bundle.mjs";
import { runSwitchCommand } from "../src/commands/switch.mjs";
import { runVersionsCommand } from "../src/commands/versions.mjs";
import { isInstalled, readActive, versionDir, versionsRoot, writeActiveAtomic } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

/**
 * 端到端验收：把真实的模块串起来跑一遍两个现象。
 *
 * - 现象 A：默认版本（出厂依赖）就绪后，`versions/<版本>/` 里同时有实体安装与 bundle；
 * - 现象 B：切回默认版本是零下载的指针翻转，而不是重新 npm install。
 *
 * 只替换两处外部依赖：npm（种出入口树）与 bundle 构建（种出 bundle 产物）。
 * 安装内核、原子替换、锁、标记、状态判定全部走真实实现——这正是要验收的东西。
 */

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一个"刚装好 launcher"的 pkgRoot：出厂依赖 + 随包发布的快照。 */
function freshRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "openwiki-e2e-default-"));
  roots.push(root);
  plantBundled(root, "0.6.0");
  mkdirSync(path.join(root, "manifest"), { recursive: true });
  writeFileSync(path.join(root, "manifest", "openwiki-0.6.0.json"), JSON.stringify({ tools: [{}] }));
  return root;
}

function plantBundled(root, version) {
  const dir = path.join(root, "node_modules", "openwiki");
  mkdirSync(path.join(dir, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openwiki", version }));
  writeFileSync(path.join(dir, "dist", "cli", "cli.js"), "// entry");
}

/** 在任意目录里种出可解析的 openwiki 入口树（`npm install --prefix` 的形状）。 */
function plantOpenwikiAt(dir, version) {
  const pkg = path.join(dir, "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openwiki", version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
}

/** 种一个可解析的已安装版本。 */
function plantVersion(root, version) {
  plantOpenwikiAt(versionDir(root, version), version);
}

/** npm 假件：成功时按 --prefix 种入口树，记录全部参数。 */
function fakeNpm() {
  const calls = [];
  const runNpm = async (args) => {
    calls.push(args);
    if (args[0] !== "install") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    plantOpenwikiAt(args[args.indexOf("--prefix") + 1], args[1].replace(/^openwiki@/, ""));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runNpm, calls, installs: () => calls.filter((args) => args[0] === "install") };
}

/** bundle 假件：直接种出产物与 meta（真实构建由 bundle-backend 的单测覆盖）。 */
function fakeEnsureBundle() {
  const calls = [];
  const ensureBundleFn = async ({ version, pkgRoot }) => {
    calls.push(version);
    const dir = versionDir(pkgRoot, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle-abc.mjs"), "// bundle");
    writeFileSync(path.join(dir, "bundle.meta.json"), JSON.stringify({ file: "bundle-abc.mjs" }));
    return { ok: true, file: "bundle-abc.mjs" };
  };
  return { ensureBundleFn, calls };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const leftovers = (root) =>
  readdirSync(versionsRoot(root)).filter((name) => name.startsWith(".tmp-") || name.startsWith(".bak-"));

describe("现象 A：默认版本就绪后同时有实体安装与 bundle", () => {
  it("物化 + 生成 bundle，且不留下任何临时目录", async () => {
    const root = freshRoot();
    const npm = fakeNpm();
    const bundle = fakeEnsureBundle();

    const result = await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      env: {},
      runNpm: npm.runNpm,
      deps: { ensureBundleFn: bundle.ensureBundleFn },
    });

    expect(result).toMatchObject({ ok: true, version: "0.6.0", installed: true, snapshot: false });
    expect(isInstalled(root, "0.6.0")).toBe(true);
    expect(existsSync(path.join(versionDir(root, "0.6.0"), "install.meta.json"))).toBe(true);
    expect(bundleStatus(root, "0.6.0")).toBe("ready");
    expect(bundle.calls).toEqual(["0.6.0"]);
    expect(npm.installs()).toHaveLength(1);
    expect(leftovers(root)).toEqual([]);
  });

  it("幂等：再跑一次不重复下载、不重复构建", async () => {
    const root = freshRoot();
    const first = fakeNpm();
    const bundle = fakeEnsureBundle();
    const options = {
      pkgRoot: root,
      logger: noopLogger,
      env: {},
      deps: { ensureBundleFn: bundle.ensureBundleFn },
    };

    await ensureDefaultVersion({ ...options, runNpm: first.runNpm });
    const second = fakeNpm();
    await ensureDefaultVersion({ ...options, runNpm: second.runNpm });

    expect(second.installs()).toEqual([]);
    expect(bundle.calls).toEqual(["0.6.0", "0.6.0"]);
  });

  it("历史遗留的 bundle-only 目录被就地补全，bundle 产物不丢", async () => {
    const root = freshRoot();
    // 升级前的畸形状态：目录里只有 bundle，没有 node_modules。
    mkdirSync(versionDir(root, "0.6.0"), { recursive: true });
    writeFileSync(path.join(versionDir(root, "0.6.0"), "bundle-abc.mjs"), "// 老 bundle");
    writeFileSync(path.join(versionDir(root, "0.6.0"), "bundle.meta.json"), JSON.stringify({ file: "bundle-abc.mjs" }));
    const npm = fakeNpm();

    const result = await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      env: {},
      runNpm: npm.runNpm,
      // bundle 已是 ready，真实 ensureBundle 会毫秒级命中：这里不注入也能自愈。
      deps: { ensureBundleFn: async () => ({ ok: true, reused: true, file: "bundle-abc.mjs" }) },
    });

    expect(result.ok).toBe(true);
    expect(isInstalled(root, "0.6.0")).toBe(true);
    expect(existsSync(path.join(versionDir(root, "0.6.0"), "bundle-abc.mjs"))).toBe(true);
    expect(existsSync(path.join(versionDir(root, "0.6.0"), "bundle.meta.json"))).toBe(true);
    expect(leftovers(root)).toEqual([]);
  });
});

describe("现象 B：切回默认版本是零下载的指针翻转", () => {
  it("物化之后 switch 回去不再调 npm install", async () => {
    const root = freshRoot();
    const { logger, text } = collectLogger();
    const bundle = fakeEnsureBundle();
    await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      env: {},
      runNpm: fakeNpm().runNpm,
      deps: { ensureBundleFn: bundle.ensureBundleFn },
    });
    // 用户升级到 0.7.0 并切了过去。
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");

    const npm = fakeNpm();
    const code = await runSwitchCommand({
      logger,
      pkgRoot: root,
      version: "0.6.0",
      env: {},
      runNpm: npm.runNpm,
      resolveRuntime: async () => ({ version: "0.7.0", source: "versions", cliJs: "/fake/cli.js" }),
      ensureBundleFn: bundle.ensureBundleFn,
    });

    expect(code).toBe(0);
    expect(npm.installs()).toEqual([]);
    expect(readActive(root).version).toBe("0.6.0");
    expect(text()).toContain("已切换");
    expect(text()).toContain("该版本有 bundle");
  });
});

describe("删除默认版本之后", () => {
  it("自愈不重建，显式命令重建并清掉标记", async () => {
    const root = freshRoot();
    const bundle = fakeEnsureBundle();
    const npm = fakeNpm();
    const deps = { ensureBundleFn: bundle.ensureBundleFn };
    await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, env: {}, runNpm: npm.runNpm, deps });

    // 先把指针挪到别的版本，再删默认版本（激活版本不允许删）。
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    const removed = await runVersionsCommand({
      logger: noopLogger,
      pkgRoot: root,
      args: ["remove", "0.6.0"],
    });

    expect(removed).toBe(0);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toMatchObject({ version: "0.6.0" });

    const selfHeal = await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      mode: "self-heal",
      env: {},
      runNpm: npm.runNpm,
      deps,
    });
    expect(selfHeal).toMatchObject({ ok: true, skipped: "removed" });
    expect(isInstalled(root, "0.6.0")).toBe(false);

    const rebuilt = await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      mode: "explicit",
      env: {},
      runNpm: npm.runNpm,
      deps,
    });
    expect(rebuilt.ok).toBe(true);
    expect(isInstalled(root, "0.6.0")).toBe(true);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toBeNull();
  });
});
