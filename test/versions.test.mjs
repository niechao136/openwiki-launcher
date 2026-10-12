import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERSION_PATTERN,
  isValidVersion,
  listInstalled,
  readActive,
  removeVersion,
  versionDir,
  writeActiveAtomic,
} from "../src/versions.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-versions-"));
}

/** 造一个可解析的已安装版本：package.json + dist/cli/cli.js。 */
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

describe("versions storage", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  it("rejects version names that are not strict semver", () => {
    expect(VERSION_PATTERN.test("0.6.0")).toBe(true);
    for (const bad of ["0.6", "v0.6.0", "0.6.0-beta", "../../etc", "0.6.0\n", ""]) {
      expect(isValidVersion(bad)).toBe(false);
    }
  });

  it("refuses to build a directory for an invalid version", () => {
    const root = freshRoot();
    expect(() => versionDir(root, "../evil")).toThrow();
  });

  it("reports no active pointer when active.json is missing", () => {
    expect(readActive(freshRoot())).toBeNull();
  });

  it("reports no active pointer when active.json is corrupted", () => {
    const root = freshRoot();
    mkdirSync(path.join(root, "versions"), { recursive: true });
    writeFileSync(path.join(root, "versions", "active.json"), "not json");

    expect(readActive(root)).toBeNull();
  });

  it("round-trips the active pointer", () => {
    const root = freshRoot();
    writeActiveAtomic(root, "0.7.0");

    expect(readActive(root).version).toBe("0.7.0");
  });

  it("replaces an existing pointer", () => {
    const root = freshRoot();
    writeActiveAtomic(root, "0.6.0");
    writeActiveAtomic(root, "0.7.0");

    expect(readActive(root).version).toBe("0.7.0");
  });

  it("leaves no temporary file behind after an atomic replace", () => {
    const root = freshRoot();
    writeActiveAtomic(root, "0.6.0");
    writeActiveAtomic(root, "0.7.0");

    expect(existsSync(path.join(root, "versions", "active.json.tmp"))).toBe(false);
  });

  it("lists installed versions with manifest presence", () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0", { withManifest: true });
    plantVersion(root, "0.7.0");

    const listed = listInstalled(root);

    expect(listed.map((entry) => entry.version)).toEqual(["0.6.0", "0.7.0"]);
    expect(listed[0].hasManifest).toBe(true);
    expect(listed[1].hasManifest).toBe(false);
    expect(typeof listed[0].sizeBytes).toBe("number");
    expect(listed[0].sizeBytes).toBeGreaterThan(0);
  });

  it("ignores non-version entries in the versions directory", () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeFileSync(path.join(root, "versions", "README.md"), "notes");
    mkdirSync(path.join(root, "versions", ".tmp"), { recursive: true });

    expect(listInstalled(root).map((entry) => entry.version)).toEqual(["0.6.0"]);
  });

  it("refuses to remove the active version", () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeActiveAtomic(root, "0.6.0");

    expect(removeVersion(root, "0.6.0")).toEqual({ removed: false, reason: "active" });
    expect(existsSync(versionDir(root, "0.6.0"))).toBe(true);
  });

  it("removes an inactive version and keeps its manifest snapshot", () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0", { withManifest: true });
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");

    expect(removeVersion(root, "0.6.0")).toEqual({ removed: true });
    expect(existsSync(versionDir(root, "0.6.0"))).toBe(false);
    expect(existsSync(path.join(root, "manifest", "openwiki-0.6.0.json"))).toBe(true);
  });

  it("reports removing a version that is not installed", () => {
    const root = freshRoot();

    expect(removeVersion(root, "9.9.9")).toEqual({ removed: false, reason: "not-installed" });
  });
});
