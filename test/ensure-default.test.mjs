import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REMOVED_FILE,
  PREPARE_FAILED_FILE,
  backoffMsFromEnv,
  clearMarker,
  defaultVersionState,
  ensureDefaultVersion,
  markDefaultRemoved,
  prepareEnabled,
  readMarker,
  scheduleBackgroundPrepare,
  writeMarker,
} from "../src/ensure-default.mjs";
import { versionsRoot } from "../src/versions.mjs";

/**
 * 默认版本就绪：把出厂依赖物化成一个真实版本条目并备好 bundle。
 *
 * 这个模块要回答的问题全是"该不该做、什么时候不该做"：幂等、快照不重复录、
 * 用户删过的不要自己长回来、失败过就退避。
 */

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot({ bundled = "0.6.0", snapshot = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "openwiki-default-"));
  roots.push(root);
  if (bundled !== null) {
    const dir = path.join(root, "node_modules", "openwiki");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openwiki", version: bundled }));
  }
  if (snapshot && bundled !== null) {
    mkdirSync(path.join(root, "manifest"), { recursive: true });
    writeFileSync(path.join(root, "manifest", `openwiki-${bundled}.json`), JSON.stringify({ tools: [{}] }));
  }
  return root;
}

/** 种一个已安装的版本目录。 */
function plantInstalled(root, version) {
  const pkg = path.join(versionsRoot(root), version, "node_modules", "openwiki");
  mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openwiki", version }));
  writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;

/** 三件套桩：记录调用并返回可配置的结果。 */
function stubs({ install = { ok: true, entryVersion: "0.6.0" }, snapshot = { ok: true, snapshot: {} }, bundle = { ok: true } } = {}) {
  const calls = { install: [], installAndSnapshot: [], bundle: [] };
  return {
    calls,
    deps: {
      installVersionFn: async (options) => {
        calls.install.push(options);
        return install;
      },
      installAndSnapshotFn: async (options) => {
        calls.installAndSnapshot.push(options);
        return snapshot;
      },
      ensureBundleFn: async (options) => {
        calls.bundle.push(options);
        return bundle;
      },
    },
  };
}

describe("prepareEnabled", () => {
  it("is on by default and off only for the explicit switches", () => {
    expect(prepareEnabled({})).toBe(true);
    expect(prepareEnabled({ LAUNCHER_PREPARE: "1" })).toBe(true);
    expect(prepareEnabled({ LAUNCHER_PREPARE: "0" })).toBe(false);
    expect(prepareEnabled({}, { noPrepare: true })).toBe(false);
  });
});

describe("backoffMsFromEnv", () => {
  it("defaults to 24 hours and accepts an override", () => {
    expect(backoffMsFromEnv({})).toBe(24 * HOUR);
    expect(backoffMsFromEnv({ LAUNCHER_PREPARE_BACKOFF_HOURS: "2" })).toBe(2 * HOUR);
  });

  it("treats zero as disabled and ignores garbage", () => {
    expect(backoffMsFromEnv({ LAUNCHER_PREPARE_BACKOFF_HOURS: "0" })).toBe(0);
    expect(backoffMsFromEnv({ LAUNCHER_PREPARE_BACKOFF_HOURS: "abc" })).toBe(24 * HOUR);
    expect(backoffMsFromEnv({ LAUNCHER_PREPARE_BACKOFF_HOURS: "-3" })).toBe(24 * HOUR);
  });
});

describe("ensureDefaultVersion", () => {
  it("does nothing but ensure the bundle when the version is installed and the snapshot exists", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, deps });

    expect(result).toEqual({ ok: true, version: "0.6.0", installed: false, snapshot: false });
    expect(calls.install).toEqual([]);
    expect(calls.installAndSnapshot).toEqual([]);
    expect(calls.bundle).toHaveLength(1);
    expect(calls.bundle[0]).toMatchObject({ version: "0.6.0", pkgRoot: root });
  });

  it("only installs when the snapshot is already shipped with the package", async () => {
    const root = freshRoot();
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, deps });

    expect(result).toMatchObject({ ok: true, installed: true, snapshot: false });
    expect(calls.install).toHaveLength(1);
    expect(calls.installAndSnapshot).toEqual([]);
  });

  it("records the snapshot when it is missing", async () => {
    const root = freshRoot({ snapshot: false });
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, hostId: "prepare-x", deps });

    expect(result).toMatchObject({ ok: true, installed: true, snapshot: true });
    expect(calls.installAndSnapshot).toHaveLength(1);
    expect(calls.installAndSnapshot[0]).toMatchObject({ version: "0.6.0", hostId: "prepare-x" });
  });

  it("reports a version that cannot be determined instead of guessing", async () => {
    const root = freshRoot({ bundled: null });
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, deps });

    expect(result).toMatchObject({ ok: false, stage: "version" });
    expect(calls.install).toEqual([]);
  });

  it("keeps the default version deleted during self-heal", async () => {
    const root = freshRoot();
    markDefaultRemoved(root, "0.6.0");
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", deps });

    expect(result).toEqual({ ok: true, version: "0.6.0", skipped: "removed" });
    expect(calls.install).toEqual([]);
    expect(calls.installAndSnapshot).toEqual([]);
    expect(calls.bundle).toEqual([]);
  });

  it("rebuilds on an explicit command and clears the removed marker", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    markDefaultRemoved(root, "0.6.0");
    const { deps, calls } = stubs();

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "explicit", deps });

    expect(result.ok).toBe(true);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toBeNull();
    expect(calls.bundle).toHaveLength(1);
  });

  it("ignores the marker of a different version", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    markDefaultRemoved(root, "0.5.0");
    const { deps, calls } = stubs();

    await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", deps });

    expect(calls.bundle).toHaveLength(1);
  });

  it("backs off after a self-heal failure and stops retrying", async () => {
    const root = freshRoot();
    const failing = stubs({ install: { ok: false, stage: "install", reason: "network down" } });

    const first = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", deps: failing.deps });

    expect(first).toMatchObject({ ok: false, stage: "install" });
    const marker = readMarker(root, PREPARE_FAILED_FILE);
    expect(marker).toMatchObject({ version: "0.6.0" });
    expect(marker.nextRetryAt).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(marker.reason).toContain("network down");

    // 退避期内不再起 npm。
    const second = stubs();
    const again = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", deps: second.deps });
    expect(again).toEqual({ ok: true, version: "0.6.0", skipped: "backoff" });
    expect(second.calls.install).toEqual([]);
  });

  it("does not back off on explicit commands and clears the marker when they succeed", async () => {
    const root = freshRoot();
    const failing = stubs({ install: { ok: false, stage: "install", reason: "network down" } });
    await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", deps: failing.deps });

    const explicit = stubs();
    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "explicit", deps: explicit.deps });

    expect(result.ok).toBe(true);
    expect(explicit.calls.install).toHaveLength(1);
    expect(readMarker(root, PREPARE_FAILED_FILE)).toBeNull();
  });

  it("writes no backoff marker when backoff is disabled", async () => {
    const root = freshRoot();
    const failing = stubs({ install: { ok: false, stage: "install", reason: "network down" } });

    await ensureDefaultVersion({
      pkgRoot: root,
      logger: noopLogger,
      mode: "self-heal",
      env: { LAUNCHER_PREPARE_BACKOFF_HOURS: "0" },
      deps: failing.deps,
    });

    expect(readMarker(root, PREPARE_FAILED_FILE)).toBeNull();
  });

  it("passes a locked install through to the caller", async () => {
    const root = freshRoot();
    const locked = stubs({ install: { ok: false, stage: "locked", reason: "另一个进程正在安装同一个版本" } });

    const result = await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, deps: locked.deps });

    expect(result).toMatchObject({ ok: false, stage: "locked" });
  });

  it("stays successful when only the bundle fails", async () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    const { lines, logger } = (() => {
      const collected = [];
      return { lines: collected, logger: { debug() {}, info: (m) => collected.push(m), warn: (m) => collected.push(m), error: (m) => collected.push(m) } };
    })();
    const { deps } = stubs({ bundle: { ok: false, reason: "offline" } });

    const result = await ensureDefaultVersion({ pkgRoot: root, logger, deps });

    expect(result.ok).toBe(true);
    expect(lines.join("\n")).toContain("offline");
  });

  it("asks npm for a below-normal priority only for the background path", async () => {
    const root = freshRoot();
    const background = stubs();
    const foreground = stubs();

    await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "self-heal", priority: "below-normal", deps: background.deps });
    await ensureDefaultVersion({ pkgRoot: root, logger: noopLogger, mode: "explicit", deps: foreground.deps });

    expect(background.calls.install[0].priority).toBe("below-normal");
    expect(foreground.calls.install[0].priority).toBe("normal");
  });

  it("writes markers under versions/ and clears them idempotently", () => {
    const root = freshRoot();
    markDefaultRemoved(root, "0.6.0");

    expect(existsSync(path.join(versionsRoot(root), DEFAULT_REMOVED_FILE))).toBe(true);
    clearMarker(root, DEFAULT_REMOVED_FILE);
    clearMarker(root, DEFAULT_REMOVED_FILE);
    expect(readMarker(root, DEFAULT_REMOVED_FILE)).toBeNull();
  });
});

describe("defaultVersionState", () => {
  /** 种一个 bundle 产物与 meta。 */
  function plantBundle(root, version) {
    const dir = path.join(versionsRoot(root), version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle-abc.mjs"), "// bundle");
    writeFileSync(path.join(dir, "bundle.meta.json"), JSON.stringify({ file: "bundle-abc.mjs" }));
  }

  it("unknown：读不到出厂依赖的版本", () => {
    expect(defaultVersionState(freshRoot({ bundled: null, snapshot: false })).state).toBe("unknown");
  });

  it("missing：出厂依赖还没进版本仓库", () => {
    const root = freshRoot();
    expect(defaultVersionState(root)).toEqual({ version: "0.6.0", state: "missing" });
  });

  it("installed-no-bundle：物化了但还没有 bundle", () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    expect(defaultVersionState(root).state).toBe("installed-no-bundle");
  });

  it("ready：物化了且有 bundle", () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    plantBundle(root, "0.6.0");
    expect(defaultVersionState(root).state).toBe("ready");
  });

  it("removed：用户删过且当前没装", () => {
    const root = freshRoot();
    markDefaultRemoved(root, "0.6.0");
    expect(defaultVersionState(root).state).toBe("removed");
  });

  it("backoff：上次失败还在退避期内", () => {
    const root = freshRoot();
    writeMarker(root, PREPARE_FAILED_FILE, {
      version: "0.6.0",
      at: new Date().toISOString(),
      nextRetryAt: Date.now() + 60 * 1000,
      reason: "offline",
    });
    const state = defaultVersionState(root);
    expect(state.state).toBe("backoff");
    expect(state.reason).toBe("offline");
  });

  it("退避已过期就不再算退避", () => {
    const root = freshRoot();
    writeMarker(root, PREPARE_FAILED_FILE, {
      version: "0.6.0",
      at: new Date().toISOString(),
      nextRetryAt: Date.now() - 1000,
      reason: "offline",
    });
    expect(defaultVersionState(root).state).toBe("missing");
  });

  it("装好之后，陈旧的删除标记不再影响判定", () => {
    const root = freshRoot();
    plantInstalled(root, "0.6.0");
    markDefaultRemoved(root, "0.6.0");
    expect(defaultVersionState(root).state).toBe("installed-no-bundle");
  });

  it("另一个版本的标记不干扰", () => {
    const root = freshRoot();
    markDefaultRemoved(root, "0.9.9");
    expect(defaultVersionState(root).state).toBe("missing");
  });
});

describe("scheduleBackgroundPrepare", () => {
  /** 假 supervisor：记录 ensureReady 是否被调用，并可按需拒绝。 */
  function fakeSupervisor({ reject = null, order = [] } = {}) {
    return {
      ensureReady: () => {
        order.push("ensureReady");
        return reject ? Promise.reject(reject) : Promise.resolve({ ok: true });
      },
    };
  }

  /** 等所有微任务排空：调度是 fire-and-forget 的。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("waits for the backend before doing anything", async () => {
    const order = [];
    const supervisor = fakeSupervisor({ order });
    const deps = {
      ensureDefaultVersionFn: async () => {
        order.push("prepare");
        return { ok: true };
      },
    };

    scheduleBackgroundPrepare({
      runtime: { source: "bundled", backend: "source" },
      pkgRoot: "/pkg",
      logger: noopLogger,
      supervisor,
      deps,
    });
    // 同步阶段只发出 ensureReady；真正的活儿排在它 resolve 之后。
    expect(order).toEqual(["ensureReady"]);
    await settle();
    expect(order).toEqual(["ensureReady", "prepare"]);
  });

  it("prepares the default version, at below-normal priority, when running the bundled dependency", async () => {
    const called = [];
    const deps = {
      ensureDefaultVersionFn: async (options) => {
        called.push(options);
        return { ok: true };
      },
      ensureBundleFn: async () => {
        called.push("bundle");
        return { ok: true };
      },
    };

    scheduleBackgroundPrepare({
      runtime: { source: "bundled", backend: "source" },
      pkgRoot: "/pkg",
      logger: noopLogger,
      supervisor: fakeSupervisor(),
      deps,
    });
    await settle();

    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({ mode: "self-heal", priority: "below-normal", pkgRoot: "/pkg" });
  });

  it("only补 bundle when the active version is a real entry running from source", async () => {
    const called = [];
    const deps = {
      ensureDefaultVersionFn: async () => {
        called.push("prepare");
        return { ok: true };
      },
      ensureBundleFn: async (options) => {
        called.push(options);
        return { ok: true };
      },
    };

    scheduleBackgroundPrepare({
      runtime: { source: "versions", backend: "source", version: "0.7.0" },
      pkgRoot: "/pkg",
      logger: noopLogger,
      supervisor: fakeSupervisor(),
      deps,
    });
    await settle();

    expect(called).toEqual([{ version: "0.7.0", pkgRoot: "/pkg", logger: noopLogger }]);
  });

  it("does nothing when the backend already runs from a bundle", async () => {
    const called = [];
    scheduleBackgroundPrepare({
      runtime: { source: "versions", backend: "bundle", version: "0.7.0" },
      pkgRoot: "/pkg",
      logger: noopLogger,
      supervisor: fakeSupervisor(),
      deps: {
        ensureDefaultVersionFn: async () => {
          called.push("prepare");
          return { ok: true };
        },
        ensureBundleFn: async () => {
          called.push("bundle");
          return { ok: true };
        },
      },
    });
    await settle();

    expect(called).toEqual([]);
  });

  it("returns immediately when the prepare step is disabled", async () => {
    const order = [];
    scheduleBackgroundPrepare({
      runtime: { source: "bundled", backend: "source" },
      pkgRoot: "/pkg",
      logger: noopLogger,
      env: { LAUNCHER_PREPARE: "0" },
      supervisor: fakeSupervisor({ order }),
      deps: {
        ensureDefaultVersionFn: async () => {
          order.push("prepare");
          return { ok: true };
        },
      },
    });
    await settle();

    expect(order).toEqual([]);
  });

  it("warns instead of throwing when the backend never becomes ready", async () => {
    const { lines, logger } = (() => {
      const collected = [];
      return {
        lines: collected,
        logger: { debug() {}, info: (m) => collected.push(m), warn: (m) => collected.push(m), error: (m) => collected.push(m) },
      };
    })();

    scheduleBackgroundPrepare({
      runtime: { source: "bundled", backend: "source" },
      pkgRoot: "/pkg",
      logger,
      supervisor: fakeSupervisor({ reject: new Error("backend down") }),
      deps: { ensureDefaultVersionFn: async () => ({ ok: true }) },
    });
    await settle();

    expect(lines.join("\n")).toContain("backend down");
  });

  it("warns when the background work itself reports failure", async () => {
    const { lines, logger } = (() => {
      const collected = [];
      return {
        lines: collected,
        logger: { debug() {}, info: (m) => collected.push(m), warn: (m) => collected.push(m), error: (m) => collected.push(m) },
      };
    })();

    scheduleBackgroundPrepare({
      runtime: { source: "bundled", backend: "source" },
      pkgRoot: "/pkg",
      logger,
      supervisor: fakeSupervisor(),
      deps: { ensureDefaultVersionFn: async () => ({ ok: false, reason: "offline" }) },
    });
    await settle();

    expect(lines.join("\n")).toContain("offline");
  });
});
