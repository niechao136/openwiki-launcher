import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installVersion, runUpdateCommand, summarizeInstallFailure } from "../src/commands/update.mjs";
import { readActive, versionDir } from "../src/versions.mjs";
import { collectLogger } from "./helpers.mjs";

const REGISTRY_VERSIONS = '["0.6.0","0.6.3","0.7.0"]';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "openwiki-update-"));
}

/** npm 执行器假件：view 返回版本表，install 按配置成败；记录全部调用。 */
function fakeNpm({ installCode = 0, versions = REGISTRY_VERSIONS, plantPartial = false } = {}) {
  const calls = [];
  const runNpm = async (args) => {
    calls.push(args);
    if (args[0] === "view") return { code: 0, stdout: versions, stderr: "" };
    if (args[0] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1];
      if (installCode !== 0) {
        // 模拟一个装了一半的版本目录：npm 退出非 0 时它必须被清掉。
        if (plantPartial) {
          mkdirSync(path.join(prefix, "node_modules", "openwiki"), { recursive: true });
          writeFileSync(path.join(prefix, "node_modules", "openwiki", "partial.txt"), "half installed");
        }
        return { code: 1, stdout: "", stderr: "npm ERR! fake install failure" };
      }
      // 成功时必须种出可解析的入口树：安装内核会在入库前校验入口与版本号。
      plantOpenwikiAt(prefix, args[1].replace(/^openwiki@/, ""));
      return { code: 0, stdout: "", stderr: "" };
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

/** 在任意目录里种出可解析的 openwiki 入口树（`npm install --prefix` 的产物形状）。 */
function plantOpenwikiAt(dir, version) {
  const pkg = path.join(dir, "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
}

/** 种一个「安装成功」的版本目录，让失败路径的目录断言有意义。 */
function plantInstalled(root, version) {
  plantOpenwikiAt(versionDir(root, version), version);
}

/** 真实失败的 stderr 形状：预编译下载被重置 → gyp 回退 → 上百行 find Python → notice 收尾。 */
const GYP_STDERR = [
  "npm warn cleanup Failed to remove some directories [",
  "npm warn cleanup   [Error: EPERM: operation not permitted, rmdir '...\\@azure'] { code: 'EPERM' }",
  "npm error code 1",
  "npm error path C:\\some\\path\\versions\\0.7.2\\node_modules\\better-sqlite3",
  "npm error command failed",
  "npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c prebuild-install || node-gyp rebuild --release",
  "npm error prebuild-install warn install read ECONNRESET",
  "npm error gyp info it worked if it ends with ok",
  "npm error gyp ERR! find Python",
  "npm error gyp ERR! find Python You need to install the latest version of Python.",
  "npm error gyp ERR! find Python **********************************************************",
  "npm error gyp ERR! configure error",
  "npm notice",
  "npm notice New major version of npm available! 11.19.0 -> 12.2.0",
  "npm notice To update run: npm install -g npm@12.2.0",
  "npm error A complete log of this run can be found in: C:\\logs\\debug-0.log",
].join("\n");

describe("summarizeInstallFailure", () => {
  it("surfaces the root cause and the mirror hint instead of notice noise", () => {
    // 真实案例：摘要取 stderr 最后 3 行，显示的是 npm notice 垃圾，
    // 真正的失败原因（gyp find Python）被淹没——用户无从下手。
    const lines = summarizeInstallFailure(GYP_STDERR);
    const joined = lines.join("\n");

    expect(joined).toContain("ECONNRESET");
    expect(joined).toContain("better_sqlite3_binary_host_mirror");
    expect(joined).not.toContain("npm notice");
    expect(joined).not.toContain("find Python");
    expect(joined).not.toContain("A complete log");
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("hints at the toolchain when gyp fails without a prebuild download", () => {
    const lines = summarizeInstallFailure(
      ["npm error code 1", "npm error gyp ERR! find Python", "npm error gyp ERR! configure error"].join("\n"),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("源码编译");
    expect(joined).toContain("better_sqlite3_binary_host_mirror");
  });

  it("hints at file locks on EPERM", () => {
    const lines = summarizeInstallFailure(
      ["npm error code 1", "npm warn cleanup [Error: EPERM: operation not permitted, rmdir '...']"].join("\n"),
    );
    expect(lines.join("\n")).toContain("杀毒");
  });

  it("falls back to the raw tail when nothing recognizable", () => {
    const lines = summarizeInstallFailure("npm error code 1\nnpm error some other failure\nnpm error code 2");
    expect(lines.join("\n")).toContain("some other failure");
  });

  it("says so when stderr is empty", () => {
    expect(summarizeInstallFailure("")).toEqual(["npm install 失败，无详细错误输出"]);
  });
});

describe("installVersion", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("surfaces the mirror hint when a native prebuild download fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openwiki-installv-"));
    roots.push(root);
    const { text, logger } = collectLogger();

    const outcome = await installVersion({
      pkgRoot: root,
      version: "0.7.2",
      runNpm: async () => ({ code: 1, stdout: "", stderr: GYP_STDERR }),
      logger,
    });

    expect(outcome).toMatchObject({ ok: false, stage: "install" });
    expect(text()).toContain("better_sqlite3_binary_host_mirror");
    expect(text()).not.toContain("npm notice");
  });
});

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
    const { runNpm } = fakeNpm({ installCode: 1, plantPartial: true });
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

  it("ignores prereleases when choosing the latest version", async () => {
    // npm view 的版本表按发布顺序排列且混有 prerelease：直接取末位会把
    // 0.7.0-beta.1 当升级目标，随后版本名校验抛错——用户看到一截栈跟踪。
    const root = freshRoot();
    plantInstalled(root, "0.6.3");
    const { runNpm, calls } = fakeNpm({ versions: '["0.6.0","0.6.3","0.7.0-beta.1"]' });
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: async () => true,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => ({ ...okSnapshot, openwikiVersion: "0.6.3" }),
    });

    expect(code).toBe(0);
    expect(calls.find((args) => args[0] === "install")).toBeUndefined();
    expect(readActive(root).version).toBe("0.6.3");
  });

  it("skips the download when the target version is already installed", async () => {
    // 重装一个完好版本，网络一失败就把它删了——一次无关的抖动销毁回滚目标。
    const root = freshRoot();
    plantInstalled(root, "0.7.0");
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: [],
      runNpm,
      confirm: async () => true,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(0);
    expect(calls.find((args) => args[0] === "install")).toBeUndefined();
    expect(readActive(root).version).toBe("0.7.0");
    expect(existsSync(path.join(root, "manifest", "openwiki-0.7.0.json"))).toBe(true);
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

  it("rejects --version without a value instead of falling back to interactive mode", async () => {
    // `update --version` 缺值若被当成「没给版本」，会静默进入交互模式——
    // 用户在脚本里调 update 时就卡在了一个看不见的提示上。
    const root = freshRoot();
    const { runNpm, calls } = fakeNpm();
    const { text, logger } = collectLogger();

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version"],
      runNpm,
      confirm: async () => {
        throw new Error("must not prompt");
      },
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => okSnapshot,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(text()).toContain("--version");
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

describe("升级前就绪当前版本", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = tempRoot();
    roots.push(root);
    return root;
  }

  it("当前跑出厂依赖时先物化它，好让升级之后还能切回来", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpm();
    const { logger } = collectLogger();
    const prepared = [];

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version", "0.6.3"],
      runNpm,
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => ({ ...okSnapshot, openwikiVersion: "0.6.3" }),
      ensureDefaultVersionFn: async (options) => {
        prepared.push(options);
        return { ok: true, version: "0.6.0" };
      },
    });

    expect(code).toBe(0);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ mode: "self-heal", pkgRoot: root });
  });

  it("已经跑 versions 条目时不再重复就绪", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpm();
    const { logger } = collectLogger();
    let called = false;

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version", "0.6.3"],
      runNpm,
      resolveRuntime: async () => ({ version: "0.6.0", source: "versions", cliJs: "/fake/cli.js" }),
      writeSnapshot: async () => ({ ...okSnapshot, openwikiVersion: "0.6.3" }),
      ensureDefaultVersionFn: async () => {
        called = true;
        return { ok: true, version: "0.6.0" };
      },
    });

    expect(code).toBe(0);
    expect(called).toBe(false);
  });

  it("LAUNCHER_PREPARE=0 时跳过就绪，升级照常成功", async () => {
    const root = freshRoot();
    const { runNpm } = fakeNpm();
    const { logger } = collectLogger();
    let called = false;

    const code = await runUpdateCommand({
      logger, pkgRoot: root, args: ["--version", "0.6.3"],
      runNpm,
      env: { LAUNCHER_PREPARE: "0" },
      resolveRuntime: async () => bundledRuntime,
      writeSnapshot: async () => ({ ...okSnapshot, openwikiVersion: "0.6.3" }),
      ensureDefaultVersionFn: async () => {
        called = true;
        return { ok: true, version: "0.6.0" };
      },
    });

    expect(code).toBe(0);
    expect(called).toBe(false);
  });
});
