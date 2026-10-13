import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHolder } from "../src/holder-runtime.mjs";
import { createHolderSupervisorAdapter } from "../src/holder-session.mjs";
import { readLock } from "../src/lockfile.mjs";

// 真实后端冒烟：付一次 openwiki 的真实冷启动（实测 5-120s），验证 holder 全链路。
// LAUNCHER_REAL_SMOKE=1 时才跑。
const REAL = process.env.LAUNCHER_REAL_SMOKE === "1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(!REAL)("real backend holder smoke", () => {
  it("serves two consecutive wrapper sessions from one holder", async () => {
    const holder = await runHolder({
      hostId: "real-smoke",
      version: "0.6.0",
      cliJs: path.join(REPO_ROOT, "node_modules", "openwiki", "dist", "cli", "cli.js"),
      logger: { debug() {}, warn() {}, error() {} },
      ttlMinutes: 30,
    });

    // 等真实后端就绪（冷启动可达分钟级）
    const adapter1 = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: { debug() {}, warn() {}, error() {} } });
    const session1 = await adapter1.ensureReady();
    const started = Date.now();
    for (;;) {
      const status = await session1.request("holder/status", {});
      if (status.backendReady) break;
      if (Date.now() - started > 180000) throw new Error("真实后端 180s 内未就绪");
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 会话 1：真实工具调用
    const r1 = await session1.request("tools/call", { name: "openwiki_list_wikis", arguments: {} });
    expect(r1).toBeTruthy();

    // 会话 2：第二个 wrapper 接入同一个 holder（热后端，首调应远快于冷启动）
    const t2 = Date.now();
    const adapter2 = createHolderSupervisorAdapter({ pipeName: holder.pipeName, logger: { debug() {}, warn() {}, error() {} } });
    const session2 = await adapter2.ensureReady();
    const r2 = await session2.request("tools/call", { name: "openwiki_list_wikis", arguments: {} });
    console.log(`会话 2 首调耗时 ${Date.now() - t2}ms（应远小于冷启动）`);
    expect(r2).toBeTruthy();

    // 会话 1 断开 → holder 存活
    adapter1.stop();
    expect(readLock(holder.lockPath)).not.toBe(null);

    // 全部断开 + shutdown → 干净退出
    adapter2.stop();
    await holder.shutdown();
    expect(existsSync(holder.lockPath)).toBe(false);
  }, 300000);
});
