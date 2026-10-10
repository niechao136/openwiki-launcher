import { describe, expect, it } from "vitest";
import { BackendUnavailableError } from "../src/backend.mjs";
import { runWarmCommand } from "../src/commands/warm.mjs";

const RUNTIME = { packageRoot: "root", version: "0.6.0", cliJs: "/abs/cli.js" };

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
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/后端就绪（\d+ms）/);
    expect(stopped).toHaveLength(1);
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
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未找到");
  });
});
