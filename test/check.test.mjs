import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckCommand } from "../src/commands/check.mjs";
import { OpenwikiNotFoundError } from "../src/paths.mjs";
import { versionDir } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-check-"));
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

describe("runCheckCommand", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  /** registry 返回两个版本；调用方可按需覆盖。 */
  function registryOk(versions = ["0.6.0", "0.7.0"]) {
    return async () => ({ code: 0, stdout: JSON.stringify(versions), stderr: "" });
  }

  const bundledRuntime = { version: "0.6.0", source: "bundled", cliJs: "/fake/cli.js" };

  it("prints the active version and its source", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => ({ version: "0.7.0", source: "versions", cliJs: "/fake/cli.js" }),
      runNpm: registryOk(),
    });

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("当前生效版本：0.7.0（versions 指针）");
    expect(out).toContain("registry 最新版本：0.7.0");
  });

  it("prints the bundled fallback when no pointer is set", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: registryOk(),
    });

    expect(code).toBe(0);
    expect(text()).toContain("当前生效版本：0.6.0（出厂依赖）");
  });

  it("lists installed versions with snapshot status and disk usage", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();
    plantVersion(root, "0.6.0", { withManifest: true });
    plantVersion(root, "0.7.0");

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: registryOk(),
    });

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("0.6.0");
    expect(out).toContain("0.7.0");
    expect(out).toContain("快照 ✓");
    expect(out).toContain("快照 ✗");
    expect(out).toContain("磁盘占用");
  });

  it("shows the registry latest version", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();

    await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: registryOk(["0.6.0", "0.6.1", "0.7.0"]),
    });

    expect(text()).toContain("registry 最新版本：0.7.0");
  });

  it("degrades gracefully when the registry query fails", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: async () => ({ code: 1, stdout: "", stderr: "network unreachable" }),
    });

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("registry 查询失败");
    expect(out).toContain("当前生效版本");
  });

  it("reports a corrupted pointer", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();
    mkdirSync(path.join(root, "versions"), { recursive: true });
    writeFileSync(path.join(root, "versions", "active.json"), "not json");

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: registryOk(),
    });

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("版本指针损坏");
    expect(out).toContain("switch");
  });

  it("queries the registry through the default npm runner when none is injected", async () => {
    // 不注入 runNpm：cli 在生产里传的是 undefined，默认执行器接不上时
    // registry 行会以「runNpm is not a function」的形式恒死——一个 wiring bug
    // 被伪装成网络故障。registry 真的挂了也只该降级，不该报这句话。
    const { text, logger } = collectLogger();
    const root = freshRoot();

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
    });

    expect(code).toBe(0);
    expect(text()).not.toContain("is not a function");
  }, 30000);

  it("shows the registry latest stable version, ignoring prereleases", async () => {
    const { text, logger } = collectLogger();
    const root = freshRoot();

    await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => bundledRuntime,
      runNpm: registryOk(["0.6.0", "0.7.0-beta.1", "0.6.3"]),
    });

    expect(text()).toContain("registry 最新版本：0.6.3");
  });

  it("reports a failed runtime resolution instead of crashing", async () => {
    // check 是用户出问题时第一个跑的命令；node_modules 被清掉时它该说人话，
    // 而不是以一截栈跟踪收场。
    const { text, logger } = collectLogger();
    const root = freshRoot();

    const code = await runCheckCommand({
      logger,
      pkgRoot: root,
      resolveRuntime: async () => {
        throw new OpenwikiNotFoundError("cannot resolve openwiki dependency under /x");
      },
      runNpm: registryOk(),
    });

    expect(code).toBe(1);
    expect(text()).toContain("未找到 openwiki");
  });
});
