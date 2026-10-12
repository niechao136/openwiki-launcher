import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdateCommand } from "../src/commands/update.mjs";
import { readActive, versionDir } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

const REGISTRY_VERSIONS = '["0.6.0","0.6.3","0.7.0"]';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-update-"));
}

/** npm 执行器假件：view 返回版本表，install 按配置成败；记录全部调用。 */
function fakeNpm({ installCode = 0 } = {}) {
  const calls = [];
  const runNpm = async (args) => {
    calls.push(args);
    if (args[0] === "view") return { code: 0, stdout: REGISTRY_VERSIONS, stderr: "" };
    if (args[0] === "install") {
      return installCode === 0
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "npm ERR! fake install failure" };
    }
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
  return { runNpm, calls };
}

const okSnapshot = {
  openwikiVersion: "0.7.0",
  protocolVersion: "2024-11-05",
  tools: [{ name: "openwiki_a" }],
};

const bundledRuntime = { version: "0.6.0", source: "bundled", cliJs: "/fake/cli.js" };

/** 种一个「安装成功」的版本目录，让失败路径的目录断言有意义。 */
function plantInstalled(root, version) {
  const pkg = path.join(versionDir(root, version), "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
}

describe("runUpdateCommand", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  /** 按序回答的 confirm：answers 用完返回 false。 */
  function scriptedConfirm(answers) {
    const asked = [];
    const queue = [...answers];
    return {
      asked,
      confirm: async (question) => {
        asked.push(question);
        return queue.length > 0 ? queue.shift() : false;
      },
    };
  }

  it("installs the chosen version, writes a snapshot and activates it", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();
    const { confirm, asked } = scriptedConfirm([true]);

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    const installCall = calls.find((args) => args[0] === "install");
    expect(installCall).toBeDefined();
    expect(installCall).toContain("openwiki@0.7.0");
    expect(readActive(root).version).toBe("0.7.0");

    const snapshotPath = path.join(root, "manifest", "openwiki-0.7.0.json");
    expect(existsSync(snapshotPath)).toBe(true);
    expect(readFileSync(snapshotPath, "utf8")).toContain("openwiki_a");
    expect(asked).toHaveLength(1);
  });

  it("does nothing when the user declines the prompt", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: async () => false,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(calls.find((args) => args[0] === "install")).toBeUndefined();
    expect(readActive(root)).toBeNull();
  });

  it("does nothing when already on the latest version", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: async () => {
        throw new Error("must not prompt when already latest");
      },
      resolveRuntime: async () => ({ version: "0.7.0", source: "versions", cliJs: "/fake/cli.js" }),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(text()).toContain("已是最新");
    expect(calls.find((args) => args[0] === "install")).toBeUndefined();
  });

  it("cleans up the version directory when npm install fails", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm } = fakeNpm({ installCode: 1 });
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: async () => true,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(false);
    expect(readActive(root)).toBeNull();
  });

  it("keeps the version but does not activate it when snapshot generation fails", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: scriptedConfirm([true, false]).confirm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => {
        throw new Error("backend refused the handshake");
      },
    });

    expect(code).toBe(1);
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(true);
    expect(readActive(root)).toBeNull();
    expect(text()).toContain("直通模式");
  });

  it("activates anyway when the user accepts a snapshot-less version", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: scriptedConfirm([true, true]).confirm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => {
        throw new Error("backend refused the handshake");
      },
    });

    expect(code).toBe(0);
    expect(readActive(root).version).toBe("0.7.0");
  });

  it("treats a snapshot with no tools as a failed snapshot", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: scriptedConfirm([true, false]).confirm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => ({ openwikiVersion: "0.7.0", protocolVersion: "2024-11-05", tools: [] }),
    });

    expect(code).toBe(1);
    expect(readActive(root)).toBeNull();
    expect(existsSync(path.join(root, "manifest", "openwiki-0.7.0.json"))).toBe(false);
  });

  it("skips activation with --no-switch", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--no-switch"],
      runNpm,
      confirm: scriptedConfirm([true]).confirm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(readActive(root)).toBeNull();
    expect(existsSync(versionDir(root, "0.7.0"))).toBe(true);
    expect(existsSync(path.join(root, "manifest", "openwiki-0.7.0.json"))).toBe(true);
  });

  it("rejects an invalid --version value without touching npm", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version", "latest"],
      runNpm,
      confirm: async () => true,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(text()).toContain("x.y.z");
  });

  it("installs an explicit --version without prompting", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version", "0.6.3"],
      runNpm,
      confirm: async () => {
        throw new Error("must not prompt with an explicit version");
      },
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => ({ ...okSnapshot, openwikiVersion: "0.6.3" }),
    });

    expect(code).toBe(0);
    const installCall = calls.find((args) => args[0] === "install");
    expect(installCall).toContain("openwiki@0.6.3");
    expect(readActive(root).version).toBe("0.6.3");
  });
});
