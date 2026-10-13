import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, readLock, releaseLock } from "../src/lockfile.mjs";
import { runHolder } from "../src/holder-runtime.mjs";
import { createLineParser, formatMessage } from "../src/jsonrpc.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_BACKEND = path.join(REPO_ROOT, "test", "fixtures", "fake-openwiki.mjs");
const BIN = path.join(REPO_ROOT, "bin", "openwiki-launcher.mjs");

const holders = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.shutdown().catch(() => {});
});

function connect(pipeName) {
  const socket = net.connect(pipeName);
  const sent = [];
  let handler = null;
  const parser = createLineParser((message) => {
    if (message.invalid !== undefined) return;
    sent.push(message);
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => parser.write(chunk));
  const conn = {
    socket,
    sent,
    feed: (message) => socket.write(formatMessage(message)),
    onNext: () =>
      new Promise((resolve) => {
        const check = () => {
          if (sent.length > 0) {
            resolve(sent.shift());
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      }),
    close: () => socket.destroy(),
    handlerSetter: (cb) => (handler = cb),
  };
  conn.handlerSetter((m) => handler?.(m));
  return conn;
}

const baseOptions = (overrides = {}) => ({
  hostId: "test-host",
  version: "0.6.0",
  cliJs: FAKE_BACKEND,
  logger: { debug() {}, warn() {}, error() {} },
  env: { FAKE_STARTUP_DELAY_MS: "800" },
  ttlMinutes: 30,
  ...overrides,
});

describe("runHolder", () => {
  it("writes the lockfile and serves tool calls over the named pipe", async () => {
    const holder = await runHolder(baseOptions());
    holders.push(holder);

    const lock = readLock(holder.lockPath);
    expect(lock).not.toBe(null);
    expect(lock.version).toBe("0.6.0");
    expect(lock.pipeName).toBe(holder.pipeName);
    expect(typeof lock.pid).toBe("number");
    expect(lock.pipeName).toContain("openwiki-launcher-test-host-0.6.0");

    const conn = connect(holder.pipeName);
    conn.feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_a", arguments: { root: "x" } } });
    const answer = await conn.onNext();
    expect(answer.id).toBe(1);
    expect(answer.result.isError).toBe(false);
    conn.close();
  });

  it("reports backendReady false before warmup and true after", async () => {
    const holder = await runHolder(baseOptions({ hostId: "test-host-2", env: { FAKE_STARTUP_DELAY_MS: "1200" } }));
    holders.push(holder);

    const conn = connect(holder.pipeName);
    conn.feed({ jsonrpc: "2.0", id: 1, method: "holder/status", params: {} });
    const before = await conn.onNext();
    expect(before.result.backendReady).toBe(false);

    await new Promise((r) => setTimeout(r, 1800));
    conn.feed({ jsonrpc: "2.0", id: 2, method: "holder/status", params: {} });
    const after = await conn.onNext();
    expect(after.result.backendReady).toBe(true);
    conn.close();
  });

  it("shuts down gracefully: exit path removes the lockfile and stops the backend", async () => {
    const holder = await runHolder(baseOptions({ hostId: "test-host-3" }));
    holders.push(holder);
    expect(existsSync(holder.lockPath)).toBe(true);

    const conn = connect(holder.pipeName);
    conn.feed({ jsonrpc: "2.0", id: 9, method: "holder/shutdown", params: {} });
    const ack = await conn.onNext();
    expect(ack.result.shutdown).toBe(true);

    const exit = await holder.exited;
    expect(exit).toBe(0);
    expect(existsSync(holder.lockPath)).toBe(false);
    conn.close();
  });

  it("refuses to start when the lockfile is already owned", async () => {
    const holder = await runHolder(baseOptions({ hostId: "test-host-4" }));
    holders.push(holder);

    await expect(runHolder(baseOptions({ hostId: "test-host-4" }))).rejects.toThrow();
  });

  it("forceLaunch overwrites a stale lockfile (dead holder, file remains)", async () => {
    const options = baseOptions({ hostId: "test-host-5" });
    // 生产语义：旧 holder 已死、lockfile 残留（pid 指向不存在的进程）。
    acquireLock(path.join(REPO_ROOT, "versions", "holder-test-host-5.json"), {
      pid: 999999,
      pipeName: "\\\\.\\pipe\\openwiki-launcher-test-host-5-0.6.0",
      version: "0.6.0",
      startedAt: 1,
    });

    const replacement = await runHolder({ ...options, forceLaunch: true });
    holders.push(replacement);

    const lock = readLock(replacement.lockPath);
    expect(lock.pid).not.toBe(999999);
    expect(lock.pid).toBe(process.pid);
  });

  it("exits by itself once idle beyond the TTL", async () => {
    const holder = await runHolder(baseOptions({ hostId: "test-host-6", ttlMinutes: 0.01 }));
    expect(existsSync(holder.lockPath)).toBe(true);

    const exit = await holder.exited;
    expect(exit).toBe(0);
    expect(existsSync(holder.lockPath)).toBe(false);
  });
});

describe("holder CLI (subprocess)", () => {
  it("exits with code 1 without overwriting a foreign lockfile", async () => {
    const holder = await runHolder(baseOptions());
    holders.push(holder);
    const lock = readLock(holder.lockPath);

    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, "holder", "--host", "test-host"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          LAUNCHER_BACKEND_CLI: FAKE_BACKEND,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => (stderr += c));
      child.on("exit", (code) => {
        if (code !== 1) console.error(`unexpected exit ${code}: ${stderr}`);
        resolve(code);
      });
    });

    expect(code).toBe(1);
    // 原 holder 的 lockfile 未被覆盖
    expect(readLock(holder.lockPath).pid).toBe(lock.pid);
  });

  it("auto-exits when idle beyond the TTL from the environment", async () => {
    const uniqueHost = "ttl-host";
    const pipeName = `\\\\.\\pipe\\openwiki-launcher-${uniqueHost}-0.6.0`;
    const lockPath = path.join(REPO_ROOT, "versions", `holder-${uniqueHost}.json`);
    releaseLock(lockPath);

    const child = spawn(process.execPath, [BIN, "holder", "--host", uniqueHost], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LAUNCHER_BACKEND_CLI: FAKE_BACKEND,
        LAUNCHER_HOLDER_TTL_MINUTES: "0.01",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });

    const outcome = await Promise.race([
      new Promise((resolve) => child.on("exit", (code) => resolve({ code }))),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 15000)),
    ]);

    expect(outcome.timeout).toBeUndefined();
    expect(outcome.code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    releaseLock(lockPath);
  });

  it("starts serving a real pipe connection end to end", async () => {
    const uniqueHost = "e2e-host";
    const lockPath = path.join(REPO_ROOT, "versions", `holder-${uniqueHost}.json`);
    releaseLock(lockPath);
    const child = spawn(process.execPath, [BIN, "holder", "--host", uniqueHost], {
      cwd: REPO_ROOT,
      env: { ...process.env, LAUNCHER_BACKEND_CLI: FAKE_BACKEND },
      stdio: ["ignore", "ignore", "ignore"],
    });
    holders.push({ shutdown: async () => child.kill(), exited: new Promise(() => {}), lockPath });

    // 等 lockfile 出现（上游预热在后台进行，不阻塞连接）
    await new Promise((r) => setTimeout(r, 500));
    const lock = readLock(lockPath);
    expect(lock).not.toBe(null);

    const conn = connect(lock.pipeName);
    conn.feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_a", arguments: { ping: 1 } } });
    const answer = await conn.onNext();
    expect(answer.id).toBe(1);
    expect(answer.result.isError).toBe(false);
    conn.close();
    child.kill();
  });
});
