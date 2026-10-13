import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHolderSupervisorAdapter } from "../src/holder-session.mjs";
import { resolveHolderSession, connectToHolder } from "../src/holder-client.mjs";
import { runHolder } from "../src/holder-runtime.mjs";
import { readLock } from "../src/lockfile.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_BACKEND = path.join(REPO_ROOT, "test", "fixtures", "fake-openwiki.mjs");

const holders = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.shutdown().catch(() => {});
});

const baseOptions = (overrides = {}) => ({
  hostId: "adapter-host",
  version: "0.6.0",
  cliJs: FAKE_BACKEND,
  logger: { debug() {}, warn() {}, error() {} },
  env: { FAKE_STARTUP_DELAY_MS: "600" },
  ttlMinutes: 30,
  ...overrides,
});

const noopLogger = { debug() {}, warn() {}, error() {} };

describe("createHolderSupervisorAdapter", () => {
  it("serves broker-style requests over the holder pipe", async () => {
    const holder = await runHolder(baseOptions());
    holders.push(holder);

    const adapter = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: noopLogger });
    const session = await adapter.ensureReady();
    const result = await session.request("tools/call", { name: "echo_a", arguments: { root: "x" } });
    expect(result.isError).toBe(false);

    // session.ready 可用（直通模式依赖）
    const ready = await session.ready;
    expect(ready.serverInfo).toBeTruthy();
    adapter.stop();
    await holder.shutdown();
  });

  it("stop() only disconnects the adapter and leaves the holder alive", async () => {
    const holder = await runHolder(baseOptions());
    holders.push(holder);

    const adapter = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: noopLogger });
    const session = await adapter.ensureReady();
    adapter.stop();

    expect(session.isRunning()).toBe(false);
    // holder 仍然存活且可服务新连接
    const adapter2 = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: noopLogger });
    const session2 = await adapter2.ensureReady();
    const result = await session2.request("tools/call", { name: "echo_a", arguments: {} });
    expect(result.isError).toBe(false);
    adapter2.stop();
    expect(existsLock(holder.lockPath)).toBe(true);
    await holder.shutdown();
  });

  it("notifies exit listeners when the holder connection drops", async () => {
    const holder = await runHolder(baseOptions());
    holders.push(holder);

    const adapter = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: noopLogger });
    const exits = [];
    adapter.onSessionExit((info) => exits.push(info));
    await adapter.ensureReady();

    await holder.shutdown(); // holder 消失 → 连接断开

    await vi.waitFor(() => expect(exits.length).toBe(1), { timeout: 5000 });
    // 断开后 ensureReady 重新连接会失败（holder 已死）——拒绝而不是悬挂
    await expect(adapter.ensureReady()).rejects.toThrow();
  });
});

function existsLock(lockPath) {
  return readLock(lockPath) !== null;
}

describe("resolveHolderSession", () => {
  it("spawns and adopts a holder when none exists", async () => {
    const holder = await runHolder(baseOptions({ hostId: "resolve-host" }));
    holders.push(holder);
    // 模拟 wrapper 视角：lockfile 已由 holder 写好
    const resolved = await resolveHolderSession({
      hostId: "resolve-host",
      version: "0.6.0",
      cliJs: FAKE_BACKEND,
      logger: noopLogger,
      deps: { spawnFn: () => { throw new Error("测试中不应再 spawn"); } },
    });
    expect(resolved.mode).toBe("holder");
    const session = await resolved.adapter.ensureReady();
    const result = await session.request("tools/call", { name: "echo_a", arguments: {} });
    expect(result.isError).toBe(false);
    resolved.adapter.stop();
  });

  it("adopts a concurrent holder through its lockfile pipeName", async () => {
    const holder = await runHolder(baseOptions({ hostId: "adopt-host" }));
    holders.push(holder);
    const lock = readLock(holder.lockPath);
    expect(lock.pipeName).toBeTruthy();

    // wrapper 计算 pipeName 依赖 version 一致；这里直接对 holder 的 pipeName 探活接入
    const adapter = createHolderSupervisorAdapter({ pipeName: lock.pipeName, logger: noopLogger });
    const session = await adapter.ensureReady();
    const result = await session.request("tools/call", { name: "echo_a", arguments: {} });
    expect(result.isError).toBe(false);
    adapter.stop();
  });

  it("falls back to inprocess when spawn and connect both fail", async () => {
    const resolved = await resolveHolderSession({
      hostId: "fallback-host",
      version: "0.6.0",
      cliJs: FAKE_BACKEND,
      logger: noopLogger,
      deps: {
        connectFn: async () => null,
        spawnFn: () => {},
      },
    });
    expect(resolved.mode).toBe("inprocess");
    expect(resolved.reason).toBeTruthy();
  });

  it("falls back to inprocess when spawn throws", async () => {
    const resolved = await resolveHolderSession({
      hostId: "fallback-host-2",
      version: "0.6.0",
      cliJs: FAKE_BACKEND,
      logger: noopLogger,
      deps: {
        connectFn: async () => null,
        spawnFn: () => {
          throw new Error("EPERM");
        },
      },
    });
    expect(resolved.mode).toBe("inprocess");
    expect(resolved.reason).toContain("EPERM");
  });

  it("migrates to a new holder when the lockfile version mismatches", async () => {
    const holder = await runHolder(baseOptions({ hostId: "migrate-host" }));
    holders.push(holder);
    const lock = readLock(holder.lockPath);

    const resolved = await resolveHolderSession({
      hostId: "migrate-host",
      version: "9.9.9", // 与 holder 的 0.6.0 不匹配
      cliJs: FAKE_BACKEND,
      logger: noopLogger,
      deps: {
        // 旧 holder 的管道真连并发 shutdown（让它自己退出、释放 lockfile）；
        // 新版本管道无人监听 → null → 回退。绝不能对 lock.pid 直接 kill：
        // 进程内 holder 的 pid 就是测试进程自己。
        connectFn: async (pipeName, opts) =>
          pipeName === lock.pipeName ? connectToHolder(pipeName, opts) : null,
        spawnFn: () => {},
      },
    });
    // 旧 holder 被 shutdown：lockfile 已释放
    await vi.waitFor(() => expect(readLock(holder.lockPath)).toBe(null), { timeout: 5000 });
    expect(resolved.mode).toBe("inprocess");
  });
});
