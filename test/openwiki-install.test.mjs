import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledOpenwikiVersion } from "../src/paths.mjs";
import { cleanupStaleTempDirs, installVersion, withVersionLock } from "../src/openwiki-install.mjs";
import { versionDir, versionsRoot } from "../src/versions.mjs";

/**
 * 安装内核的两块地基：出厂依赖版本号的公共契约，与「往 versions/ 写一个版本」的
 * 版本键控锁。锁与残留清理必须独立于安装本体先立住——安装本体的原子性靠它们。
 */

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "openwiki-install-"));
  roots.push(root);
  return root;
}

/** 种一个出厂依赖：<root>/node_modules/openwiki/package.json。 */
function plantBundled(root, version) {
  const dir = path.join(root, "node_modules", "openwiki");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openwiki", version }));
}

/** 种一个残留目录：versions/.<kind>-<version>-<pid>/。 */
function plantStale(root, kind, version, pid) {
  const dir = path.join(versionsRoot(root), `.${kind}-${version}-${pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "payload.txt"), "残留");
  return dir;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("bundledOpenwikiVersion", () => {
  it("reads the version declared by the bundled openwiki dependency", () => {
    const root = freshRoot();
    plantBundled(root, "0.6.0");

    expect(bundledOpenwikiVersion(root)).toBe("0.6.0");
  });

  it("returns null when the bundled dependency is absent", () => {
    expect(bundledOpenwikiVersion(freshRoot())).toBeNull();
  });

  it("returns null when package.json is unreadable or not JSON", () => {
    const root = freshRoot();
    const dir = path.join(root, "node_modules", "openwiki");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{ not json");

    expect(bundledOpenwikiVersion(root)).toBeNull();
  });
});

describe("cleanupStaleTempDirs", () => {
  it("removes .tmp and .bak dirs whose pid is gone", () => {
    const root = freshRoot();
    const tmp = plantStale(root, "tmp", "0.6.0", 4242);
    const bak = plantStale(root, "bak", "0.7.0", 4243);

    const result = cleanupStaleTempDirs(root, { isPidAlive: () => false });

    expect(result.removed.sort()).toEqual([tmp, bak].sort());
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(bak)).toBe(false);
  });

  it("keeps dirs whose pid is still alive", () => {
    const root = freshRoot();
    const alive = plantStale(root, "tmp", "0.6.0", 4244);

    const result = cleanupStaleTempDirs(root, { isPidAlive: () => true });

    expect(result.removed).toEqual([]);
    expect(existsSync(alive)).toBe(true);
  });

  it("ignores entries that are not install temp dirs", () => {
    const root = freshRoot();
    const versions = versionsRoot(root);
    mkdirSync(versions, { recursive: true });
    writeFileSync(path.join(versions, "README.md"), "说明");
    const badVersion = plantStale(root, "tmp", "not-a-version", 4245);
    const realDir = path.join(versions, "0.6.0");
    mkdirSync(realDir, { recursive: true });

    const result = cleanupStaleTempDirs(root, { isPidAlive: () => false });

    expect(result.removed).toEqual([]);
    expect(existsSync(path.join(versions, "README.md"))).toBe(true);
    expect(existsSync(badVersion)).toBe(true);
    expect(existsSync(realDir)).toBe(true);
  });

  it("returns an empty result when versions/ does not exist", () => {
    expect(cleanupStaleTempDirs(freshRoot(), { isPidAlive: () => false }).removed).toEqual([]);
  });
});

describe("withVersionLock", () => {
  it("runs the function and returns its value", async () => {
    const root = freshRoot();

    const result = await withVersionLock(
      { pkgRoot: root, version: "0.6.0", logger: noopLogger },
      async () => "done",
    );

    expect(result).toEqual({ ok: true, value: "done" });
  });

  it("removes the lockfile after the function resolves or throws", async () => {
    const root = freshRoot();
    const lockPath = path.join(versionsRoot(root), "install-0.6.0.lock");

    await withVersionLock({ pkgRoot: root, version: "0.6.0", logger: noopLogger }, async () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);

    await withVersionLock({ pkgRoot: root, version: "0.6.0", logger: noopLogger }, async () => {
      throw new Error("安装失败");
    }).catch(() => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses to run when a live process holds the lock", async () => {
    const root = freshRoot();
    const lockPath = path.join(versionsRoot(root), "install-0.6.0.lock");
    mkdirSync(versionsRoot(root), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: "0.6.0", startedAt: Date.now() }));
    let called = false;

    const result = await withVersionLock(
      { pkgRoot: root, version: "0.6.0", logger: noopLogger, deps: { isPidAlive: () => true } },
      async () => {
        called = true;
        return "never";
      },
    );

    expect(result).toEqual({ ok: false, reason: "locked" });
    expect(called).toBe(false);
  });

  it("takes over a stale lock left by a dead process", async () => {
    const root = freshRoot();
    const lockPath = path.join(versionsRoot(root), "install-0.6.0.lock");
    mkdirSync(versionsRoot(root), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, version: "0.6.0", startedAt: Date.now() }));

    const result = await withVersionLock(
      { pkgRoot: root, version: "0.6.0", logger: noopLogger, deps: { isPidAlive: () => false } },
      async () => "recovered",
    );

    expect(result).toEqual({ ok: true, value: "recovered" });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keys the lock by version so other versions are unaffected", async () => {
    const root = freshRoot();
    let inner;
    await withVersionLock({ pkgRoot: root, version: "0.6.0", logger: noopLogger }, async () => {
      inner = await withVersionLock(
        { pkgRoot: root, version: "0.7.0", logger: noopLogger, deps: { isPidAlive: () => true } },
        async () => "parallel",
      );
    });

    expect(inner).toEqual({ ok: true, value: "parallel" });
  });

  it("cleans stale temp dirs before taking the lock", async () => {
    const root = freshRoot();
    const stale = plantStale(root, "tmp", "0.6.0", 4246);

    await withVersionLock(
      { pkgRoot: root, version: "0.6.0", logger: noopLogger, deps: { isPidAlive: () => false } },
      async () => {
        expect(existsSync(stale)).toBe(false);
        return null;
      },
    );
  });

  it("propagates the error but still releases the lockfile", async () => {
    const root = freshRoot();
    const lockPath = path.join(versionsRoot(root), "install-0.6.0.lock");

    await expect(
      withVersionLock({ pkgRoot: root, version: "0.6.0", logger: noopLogger }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(lockPath)).toBe(false);
  });
});

/** npm 安装假件：成功时按 --prefix 种出可解析的入口树，记录全部参数。 */
function fakeNpmInstaller({ code = 0, plant = true, omitCli = false, entryVersion = null, native = false } = {}) {
  const calls = [];
  const runNpm = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] !== "install") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    if (code !== 0) return { code, stdout: "", stderr: "npm ERR! fake install failure" };
    if (plant) {
      const prefix = args[args.indexOf("--prefix") + 1];
      const requested = args[1].replace(/^openwiki@/, "");
      const pkg = path.join(prefix, "node_modules", "openwiki");
      mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openwiki", version: entryVersion ?? requested }));
      if (!omitCli) writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
      if (native) mkdirSync(path.join(prefix, "node_modules", "better-sqlite3"), { recursive: true });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runNpm, calls };
}

const TMP_OR_BAK = (root) =>
  readdirSync(versionsRoot(root)).filter((name) => name.startsWith(".tmp-") || name.startsWith(".bak-"));

describe("installVersion", () => {
  it("installs into a temp dir, verifies it, then promotes it atomically", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpmInstaller();

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome).toEqual({ ok: true, entryVersion: "0.7.0" });
    const installed = path.join(versionDir(root, "0.7.0"), "node_modules", "openwiki");
    expect(existsSync(path.join(installed, "package.json"))).toBe(true);
    expect(existsSync(path.join(installed, "dist", "cli", "cli.js"))).toBe(true);
    expect(TMP_OR_BAK(root)).toEqual([]);
    expect(calls[0].args).toEqual([
      "install",
      "openwiki@0.7.0",
      "--prefix",
      expect.stringMatching(/[\\/]\.tmp-0\.7\.0-\d+$/),
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("records the install metadata used by the drift check", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller();

    await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    const meta = JSON.parse(readFileSync(path.join(versionDir(root, "0.7.0"), "install.meta.json"), "utf8"));
    expect(meta.version).toBe("0.7.0");
    expect(meta.nodeMajor).toBe(process.versions.node.split(".")[0]);
    expect(typeof meta.installedAt).toBe("string");
  });

  it("leaves no version dir and no temp dir when npm fails", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller({ code: 1, plant: false });

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome).toMatchObject({ ok: false, stage: "install" });
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(false);
    expect(TMP_OR_BAK(root)).toEqual([]);
  });

  it("rejects a tree whose CLI entry is missing", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller({ omitCli: true });

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(false);
    expect(TMP_OR_BAK(root)).toEqual([]);
  });

  it("rejects a tree whose entry package declares another version", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller({ entryVersion: "0.6.0" });

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(false);
  });

  it("rejects the tree when better-sqlite3 cannot be loaded under this Node", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller({ native: true });

    const outcome = await installVersion({
      pkgRoot: root,
      version: "0.7.0",
      runNpm,
      logger: noopLogger,
      deps: { verifyNativeFn: () => false },
    });

    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(false);
    expect(TMP_OR_BAK(root)).toEqual([]);
  });

  it("skips the native probe when the tree has no native module", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpmInstaller();
    let probed = false;

    await installVersion({
      pkgRoot: root,
      version: "0.7.0",
      runNpm,
      logger: noopLogger,
      deps: { verifyNativeFn: () => { probed = true; return true; } },
    });

    expect(probed).toBe(false);
  });

  it("keeps the bundle artifacts of a legacy bundle-only dir", async () => {
    const root = freshRoot();
    const target = versionDir(root, "0.7.0");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "bundle-ad5d0f39.mjs"), "// bundle");
    writeFileSync(path.join(target, "bundle.meta.json"), JSON.stringify({ file: "bundle-ad5d0f39.mjs" }));
    const { runNpm } = fakeNpmInstaller();

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome.ok).toBe(true);
    expect(existsSync(path.join(target, "bundle-ad5d0f39.mjs"))).toBe(true);
    expect(existsSync(path.join(target, "bundle.meta.json"))).toBe(true);
    expect(existsSync(path.join(target, "node_modules", "openwiki", "package.json"))).toBe(true);
    expect(TMP_OR_BAK(root)).toEqual([]);
  });

  it("reports locked instead of installing when another process holds the version lock", async () => {
    const root = freshRoot();
    mkdirSync(versionsRoot(root), { recursive: true });
    writeFileSync(
      path.join(versionsRoot(root), "install-0.7.0.lock"),
      JSON.stringify({ pid: process.pid, version: "0.7.0", startedAt: Date.now() }),
    );
    const { runNpm, calls } = fakeNpmInstaller();

    const outcome = await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger });

    expect(outcome).toMatchObject({ ok: false, stage: "locked" });
    expect(calls).toEqual([]);
  });

  it("passes the low-priority spawn hook through to npm", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpmInstaller();

    await installVersion({ pkgRoot: root, version: "0.7.0", runNpm, logger: noopLogger, priority: "below-normal" });

    expect(typeof calls[0].options.onSpawn).toBe("function");
  });
});
