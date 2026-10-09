import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BackendUnavailableError, createBackendSupervisor } from "../src/backend.mjs";

const FAKE_BACKEND = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-openwiki.mjs",
);

function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info() {},
      debug(message) {
        lines.push(message);
      },
      error() {},
    },
  };
}

function makeSupervisor(overrides = {}) {
  const sleepCalls = [];
  let spawnCount = 0;
  const { logger } = captureLogger();
  const supervisor = createBackendSupervisor({
    spawnFn(...args) {
      spawnCount += 1;
      return spawn(...args);
    },
    cliJs: FAKE_BACKEND,
    hostId: "test",
    logger,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    ...overrides,
  });
  return {
    supervisor,
    sleepCalls,
    spawnCount: () => spawnCount,
  };
}

describe("createBackendSupervisor", () => {
  it("gives up after exactly two spawn attempts", async () => {
    let attempts = 0;
    const { supervisor } = makeSupervisor({
      spawnFn() {
        attempts += 1;
        const error = new Error("spawn ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(attempts).toBe(2);
  });

  it("waits the retry delay once between attempts", async () => {
    const { supervisor, sleepCalls } = makeSupervisor({
      spawnFn() {
        const error = new Error("spawn ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(sleepCalls).toEqual([1000]);
  });

  it("starts one session on a healthy backend", async () => {
    const { supervisor, spawnCount } = makeSupervisor({
      env: { FAKE_STARTUP_DELAY_MS: "300" },
    });

    await supervisor.ensureReady();

    expect(spawnCount()).toBe(1);
    supervisor.stop();
  });

  it("restarts the backend after a crash and notifies listeners", async () => {
    const { supervisor, spawnCount } = makeSupervisor({
      env: { FAKE_EXIT_AFTER_MS: "150" },
    });
    const exits = [];
    supervisor.onSessionExit((info) => exits.push(info));

    const first = await supervisor.ensureReady();
    await first.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exits).toHaveLength(1);
    expect(supervisor.current()).toBeNull();

    const second = await supervisor.ensureReady();
    expect(second).not.toBe(first);
    expect(spawnCount()).toBe(2);
    supervisor.stop();
  });

  it("shares a single startup across concurrent callers", async () => {
    const { supervisor, spawnCount } = makeSupervisor();

    const sessions = await Promise.all([
      supervisor.ensureReady(),
      supervisor.ensureReady(),
      supervisor.ensureReady(),
    ]);

    expect(spawnCount()).toBe(1);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[1]).toBe(sessions[2]);
    supervisor.stop();
  });

  it("reports backend stderr when the process dies before it is ready", async () => {
    const { supervisor } = makeSupervisor({
      env: { FAKE_REFUSE: "1", FAKE_EXIT_CODE: "1", FAKE_STDERR: "boom: cannot load native module" },
    });

    const error = await supervisor.ensureReady().catch((caught) => caught);

    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect(error.stderrTail).toContain("boom: cannot load native module");
  });
});
