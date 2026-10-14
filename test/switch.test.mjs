import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSwitchCommand } from "../src/commands/switch.mjs";
import { readActive, versionDir, writeActiveAtomic } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

const okSnapshot = {
  openwikiVersion: "0.7.0",
  protocolVersion: "2024-11-05",
  tools: [{ name: "openwiki_a" }],
};

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-switch-"));
}

/** 在任意目录里种出可解析的 openwiki 入口树（`npm install --prefix` 的产物形状）。 */
function plantOpenwikiAt(dir, version) {
  const pkg = path.join(dir, "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
}

/** 种一个可解析的已安装版本。 */
function plantVersion(root, version) {
  plantOpenwikiAt(versionDir(root, version), version);
}

/** npm 执行器假件：install 按配置成败；记录全部调用。 */
function fakeNpm({ installCode = 0 } = {}) {
  const calls = [];
  const runNpm = async (args) => {
    calls.push(args);
    if (args[0] === "install") {
      if (installCode !== 0) {
        return { code: 1, stdout: "", stderr: "npm ERR! fake install failure" };
      }
      // 成功时必须把入口树种进 --prefix：安装内核会在入库前校验入口与版本号。
      plantOpenwikiAt(args[args.indexOf("--prefix") + 1], args[1].replace(/^openwiki@/, ""));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
  return { runNpm, calls };
}

describe("runSwitchCommand", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  const runtimeAt = (version, source = "versions") => async () => ({ version, source, cliJs: "/fake/cli.js" });

  it("switches to an installed version", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    plantVersion(root, "0.7.0");
    writeActiveAtomic(root, "0.7.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "0.6.0", runNpm,
      confirm: async () => {
        throw new Error("must not prompt for an installed version");
      },
      resolveRuntime: runtimeAt("0.7.0"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(readActive(root).version).toBe("0.6.0");
    expect(text()).toContain("0.7.0 → 0.6.0");
  });

  it("refuses an invalid version name", async () => {
    const root = freshRoot();
    plantVersion(root, "0.6.0");
    writeActiveAtomic(root, "0.6.0");
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "latest", runNpm,
      confirm: async () => true,
      resolveRuntime: runtimeAt("0.6.0"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(readActive(root).version).toBe("0.6.0");
    expect(calls).toHaveLength(0);
  });

  it("offers to install a version that is not installed", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "0.7.0", runNpm,
      confirm: async () => false,
      resolveRuntime: runtimeAt("0.6.0", "bundled"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(calls.find((args) => args[0] === "install")).toBeUndefined();
    expect(readActive(root)).toBeNull();
    expect(text()).toContain("未安装");
  });

  it("installs on confirmation and then switches", async () => {
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "0.7.0", runNpm,
      confirm: async () => true,
      resolveRuntime: runtimeAt("0.6.0", "bundled"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(calls.find((args) => args[0] === "install")).toContain("openwiki@0.7.0");
    expect(readActive(root).version).toBe("0.7.0");
    expect(existsSync(path.join(root, "manifest", "openwiki-0.7.0.json"))).toBe(true);
  });

  it("leaves the pointer untouched when the confirmed install fails", async () => {
    const root = freshRoot();
    writeActiveAtomic(root, "0.6.0");
    const { runNpm } = fakeNpm({ installCode: 1 });
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "0.7.0", runNpm,
      confirm: async () => true,
      resolveRuntime: runtimeAt("0.6.0"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(readActive(root).version).toBe("0.6.0");
  });

  it("refuses a version directory without the openwiki entry", async () => {
    const root = freshRoot();
    mkdirSync(path.join(root, "versions", "9.9.9"), { recursive: true });
    writeActiveAtomic(root, "0.6.0");
    const { runNpm } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runSwitchCommand({
      logger, pkgRoot: root, version: "9.9.9", runNpm,
      confirm: async () => true,
      resolveRuntime: runtimeAt("0.6.0"),
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(readActive(root).version).toBe("0.6.0");
    expect(text()).toContain("无法解析");
  });
});
