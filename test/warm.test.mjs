import { describe, expect, it } from "vitest";
import { BackendUnavailableError } from "../src/backend.mjs";
import { runWarmCommand } from "../src/commands/warm.mjs";

const RUNTIME = { packageRoot: "root", version: "0.6.0", cliJs: "/abs/cli.js" };
const BUNDLE_OK = async () => ({ ok: true, file: "bundle-abc.mjs" });
// 就绪动作必须注入：不注入时它会去 npm install 几百 MB（真实路径）。
const PREPARE_OK = async () => ({ ok: true, version: "0.6.0" });

function capture() {
  const lines = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      debug: () => {},
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  };
}

describe("runWarmCommand", () => {
  it("reports readiness and returns 0", async () => {
    const { lines, logger } = capture();
    const stopped = [];
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => ({ ok: true }),
        stop: () => stopped.push(true),
      }),
      ensureBundleFn: BUNDLE_OK,
      ensureDefaultVersionFn: PREPARE_OK,
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/后端就绪（\d+ms）/);
    expect(stopped).toHaveLength(1);
  });

  it("ensures the bundle before warming the backend", async () => {
    const { lines, logger } = capture();
    const order = [];
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => {
        order.push("resolveRuntime");
        return RUNTIME;
      },
      createSupervisor: () => ({
        ensureReady: async () => {
          order.push("ensureReady");
          return { ok: true };
        },
        stop: () => {},
      }),
      ensureDefaultVersionFn: async () => {
        order.push("prepareDefault");
        return { ok: true, version: "0.6.0" };
      },
      ensureBundleFn: async () => {
        order.push("ensureBundle");
        return { ok: true, file: "bundle-abc.mjs" };
      },
    });

    expect(code).toBe(0);
    // 就绪 → bundle → 预热：就绪先把默认版本落成实体条目，否则 ensureBundle 会
    // 把 bundle 打进一个 bundle-only 的畸形目录。
    expect(order).toEqual(["prepareDefault", "ensureBundle", "resolveRuntime", "ensureReady"]);
  });

  it("skips the prepare step when LAUNCHER_PREPARE=0 or --no-prepare", async () => {
    const { lines, logger } = capture();
    let prepared = false;
    const run = (extra) => runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => ({ ok: true }),
        stop: () => {},
      }),
      ensureBundleFn: BUNDLE_OK,
      ensureDefaultVersionFn: async () => {
        prepared = true;
        return { ok: true, version: "0.6.0" };
      },
      ...extra,
    });

    expect(await run({ env: { LAUNCHER_PREPARE: "0" } })).toBe(0);
    expect(prepared).toBe(false);
    expect(await run({ skipPrepare: true })).toBe(0);
    expect(prepared).toBe(false);
  });

  it("still warms when the default version cannot be prepared", async () => {
    const { lines, logger } = capture();
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => ({ ok: true }),
        stop: () => {},
      }),
      ensureDefaultVersionFn: async () => ({ ok: false, stage: "install", reason: "offline" }),
      ensureBundleFn: BUNDLE_OK,
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("offline");
    expect(lines.join("\n")).toMatch(/后端就绪（\d+ms）/);
  });

  it("still warms when the bundle cannot be built", async () => {
    const { lines, logger } = capture();
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => ({ ok: true }),
        stop: () => {},
      }),
      ensureDefaultVersionFn: PREPARE_OK,
      ensureBundleFn: async () => ({ ok: false, reason: "esbuild 安装失败" }),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("esbuild 安装失败");
    expect(lines.join("\n")).toMatch(/后端就绪（\d+ms）/);
  });

  it("skips bundling when LAUNCHER_BACKEND_CLI overrides the entry", async () => {
    const { logger } = capture();
    let bundleCalled = false;
    let prepareCalled = false;
    const code = await runWarmCommand({
      logger,
      env: { LAUNCHER_BACKEND_CLI: "/tmp/fake-cli.js" },
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => ({ ok: true }),
        stop: () => {},
      }),
      ensureDefaultVersionFn: async () => {
        prepareCalled = true;
        return { ok: true, version: "0.6.0" };
      },
      ensureBundleFn: async () => {
        bundleCalled = true;
        return { ok: true };
      },
    });

    expect(code).toBe(0);
    expect(bundleCalled).toBe(false);
    expect(prepareCalled).toBe(false);
  });

  it("surfaces backend stderr when the backend cannot start", async () => {
    const { lines, logger } = capture();
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: async () => {
          throw new BackendUnavailableError("无法启动 openwiki 后端: /abs/cli.js", {
            stderrTail: "boom: cannot load native module",
          });
        },
        stop: () => {},
      }),
      ensureBundleFn: BUNDLE_OK,
      ensureDefaultVersionFn: PREPARE_OK,
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("boom: cannot load native module");
  });

  it("gives up on a backend that never becomes ready and still stops it", async () => {
    // 冷启动实测 5-50s，而 supervisor 内部最坏是 2×120s + 1s 重试。没有上限时
    // `openwiki-launcher warm` 在后端卡住的情况下会一直挂着，用户只能强杀。
    const { lines, logger } = capture();
    const stopped = [];
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => RUNTIME,
      createSupervisor: () => ({
        ensureReady: () => new Promise(() => {}),
        stop: () => stopped.push(true),
      }),
      ensureBundleFn: BUNDLE_OK,
      ensureDefaultVersionFn: PREPARE_OK,
      timeoutMs: 20,
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("预热超时");
    expect(stopped).toHaveLength(1);
  });

  it("returns 1 when openwiki cannot be resolved at all", async () => {
    const { lines, logger } = capture();
    const code = await runWarmCommand({
      logger,
      resolveRuntime: async () => {
        throw new Error("未找到 openwiki 依赖");
      },
      createSupervisor: () => {
        throw new Error("must not be called");
      },
      ensureBundleFn: BUNDLE_OK,
      ensureDefaultVersionFn: PREPARE_OK,
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未找到");
  });
});
