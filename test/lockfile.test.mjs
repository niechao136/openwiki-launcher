import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, readLock, releaseLock } from "../src/lockfile.mjs";
import { holderLockPath } from "../src/paths.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "launcher-lockfile-"));
  dirs.push(dir);
  return dir;
}

const sample = { pid: 123, pipeName: "\\\\.\\pipe\\p", version: "0.6.0", startedAt: 42 };

describe("acquireLock / readLock / releaseLock", () => {
  it("acquires a fresh lock and records the payload", () => {
    const lockPath = path.join(fixtureDir(), "holder-codebuddy.json");

    const first = acquireLock(lockPath, sample);

    expect(first).toEqual({ acquired: true });
    expect(readLock(lockPath)).toEqual(sample);
  });

  it("refuses a second acquire and reports the existing content", () => {
    const lockPath = path.join(fixtureDir(), "holder-codebuddy.json");
    acquireLock(lockPath, sample);

    const second = acquireLock(lockPath, { pid: 999 });

    expect(second.acquired).toBe(false);
    expect(second.existing).toEqual(sample);
  });

  it("release deletes the lock and allows re-acquire", () => {
    const lockPath = path.join(fixtureDir(), "holder-codebuddy.json");
    acquireLock(lockPath, sample);

    releaseLock(lockPath);

    expect(existsSync(lockPath)).toBe(false);
    expect(acquireLock(lockPath, { pid: 2 }).acquired).toBe(true);
  });

  it("reads a missing lock as null", () => {
    expect(readLock(path.join(fixtureDir(), "absent.json"))).toBe(null);
  });

  it("reads a corrupt lock as null", () => {
    const lockPath = path.join(fixtureDir(), "holder-corrupt.json");
    writeFileSync(lockPath, "{not json", "utf8");

    expect(readLock(lockPath)).toBe(null);
  });

  it("force-acquire overwrites a stale lock", () => {
    const lockPath = path.join(fixtureDir(), "holder-codebuddy.json");
    acquireLock(lockPath, sample);

    const forced = acquireLock(lockPath, { pid: 777 }, { force: true });

    expect(forced.acquired).toBe(true);
    expect(readLock(lockPath).pid).toBe(777);
  });
});

describe("holderLockPath", () => {
  it("places the lock under versions/ with the hostId", () => {
    const pkgRoot = fixtureDir();
    const lockPath = holderLockPath("codebuddy", pkgRoot);
    expect(lockPath).toBe(path.join(pkgRoot, "versions", "holder-codebuddy.json"));
  });

  it.each(["bad host", "../escape", "a/b", ""])("rejects an invalid hostId: %j", (hostId) => {
    expect(() => holderLockPath(hostId, fixtureDir())).toThrow();
  });

  it("accepts lowercase letters, digits and hyphens", () => {
    expect(() => holderLockPath("claude-code-1", fixtureDir())).not.toThrow();
  });
});
