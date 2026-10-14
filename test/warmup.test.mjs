import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runWarmupCommand } from "../src/commands/warmup.mjs";
import { runDoctorCommand } from "../src/commands/doctor.mjs";
import { runHolder } from "../src/holder-runtime.mjs";
import { releaseLock } from "../src/lockfile.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_BACKEND = path.join(REPO_ROOT, "test", "fixtures", "fake-openwiki.mjs");

const holders = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.shutdown().catch(() => {});
  releaseLock(path.join(REPO_ROOT, "versions", "holder-warmup-host.json"));
});

const noopLogger = { debug() {}, warn() {}, error() {} };
function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      debug() {},
      info: (m) => lines.push(`info: ${m}`),
      warn: (m) => lines.push(`warn: ${m}`),
      error: (m) => lines.push(`error: ${m}`),
    },
  };
}

describe("runWarmupCommand", () => {
  it("waits for the holder backend and exits 0", async () => {
    const holder = await runHolder({
      hostId: "warmup-host",
      version: "0.6.0",
      cliJs: FAKE_BACKEND,
      logger: noopLogger,
      env: { FAKE_STARTUP_DELAY_MS: "600" },
      ttlMinutes: 30,
    });
    holders.push(holder);

    const { code } = await captureAndRun({ hostId: "warmup-host" });
    expect(code).toBe(0);
  });

  it("reports failure when the holder cannot be launched", async () => {
    const { lines, code } = await captureAndRun({
      hostId: "warmup-dead-host",
      holderDeps: { connectFn: async () => null, spawnFn: () => {} },
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("无法拉起"))).toBe(true);
  });

  it("prepares the default version before touching the holder", async () => {
    const order = [];
    const { code } = await captureAndRun({
      hostId: "warmup-dead-host",
      holderDeps: { connectFn: async () => null, spawnFn: () => {} },
      env: {},
      ensureDefaultVersionFn: async (options) => {
        order.push(options.mode);
        return { ok: true, version: "0.6.0" };
      },
    });

    // 登录启动项是"当天第一个会话别付全款冷启动"的通道：默认版本没就绪时先补上。
    expect(order).toEqual(["explicit"]);
    expect(code).toBe(1);
  });
});

async function captureAndRun({ hostId, holderDeps, env, ensureDefaultVersionFn }) {
  const { logger, lines } = captureLogger();
  const code = await runWarmupCommand({
    hostId,
    logger,
    env: env ?? { LAUNCHER_BACKEND_CLI: FAKE_BACKEND },
    timeoutMs: 15000,
    ensureDefaultVersionFn,
    deps: { holderDeps },
  });
  return { code, lines };
}

describe("doctor warmup hint", () => {
  it("prints a copyable schtasks template when node and selfBin are known", async () => {
    const { logger, lines } = captureLogger();
    await runDoctorCommand({
      logger,
      nodeVersion: "22.22.0",
      resolveRuntime: async () => ({
        packageRoot: REPO_ROOT,
        version: "0.6.0",
        cliJs: FAKE_BACKEND,
        source: "bundled",
      }),
      createSupervisor: () => ({
        ensureReady: () => Promise.reject(new Error("skip")),
        stop() {},
      }),
      hostId: "doctor",
      nodeCommand: { command: "C:\\node\\node.exe", warning: null },
      selfBin: "C:\\launcher\\bin\\openwiki-launcher.mjs",
      resolveGlobalRoot: async () => null,
    });
    expect(lines.some((l) => l.includes("schtasks") && l.includes("warmup --host"))).toBe(true);
  });
});
