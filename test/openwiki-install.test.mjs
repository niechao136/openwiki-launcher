import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledOpenwikiVersion } from "../src/paths.mjs";
import { cleanupStaleTempDirs, withVersionLock } from "../src/openwiki-install.mjs";
import { versionsRoot } from "../src/versions.mjs";

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
