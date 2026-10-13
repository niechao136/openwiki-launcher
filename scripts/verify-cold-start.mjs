// 任务 4 真实验收（v2）：删 bundle 模拟新机器 →
// 会话 1：快照应答 → tools/call 排队等后端就绪（冷态可能 5 分钟）→ 应答后
//   等后台补打写 meta → 优雅退出（退出时补打已完成，不杀任务）；
// 会话 2：应使用 bundle（initialize 应答 < 5s）。
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatMessage } from "../../../src/jsonrpc.mjs";

let failed = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` :: ${extra}`}`);
  if (!ok) failed += 1;
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VER_DIR = path.join(REPO_ROOT, "versions", "0.6.0");

for (const f of readdirSync(VER_DIR).filter((f) => f.startsWith("bundle-") || f === "bundle.meta.json" || f === "bundle.bad")) {
  unlinkSync(path.join(VER_DIR, f));
}
console.log("bundle 已清除（模拟新机器）");

function mcpSession({ label, toolCallTimeoutMs, onReady }) {
  return new Promise((resolve) => {
    const T0 = Date.now();
    const child = spawn(process.execPath, ["bin/openwiki-launcher.mjs", "mcp", "--host", "accept"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let phase = "init";
    const done = (result) => {
      child.stdin.end();
      setTimeout(() => child.kill(), onReady ? 5000 : 300);
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, ms: Date.now() - T0 }), toolCallTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buffer += c;
      if (phase === "init" && buffer.includes('"id":1')) {
        phase = "call";
        console.log(`${label}: initialize（快照）应答 ${Date.now() - T0}ms`);
        child.stdin.write(
          formatMessage({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "openwiki_list_wikis", arguments: {} },
          }),
        );
        return;
      }
      if (phase === "call" && buffer.includes('"id":2')) {
        clearTimeout(timer);
        const ms = Date.now() - T0;
        console.log(`${label}: tools/call 应答（后端就绪）${ms}ms`);
        if (onReady) {
          onReady().then(() => done({ ok: true, ms }));
        } else {
          done({ ok: true, ms });
        }
      }
    });
    child.stdin.write(
      formatMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "accept", version: "0" } },
      }),
    );
    child.stdin.write(formatMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  });
}

function waitForMeta(timeoutMs) {
  return (async () => {
    for (let i = 0; i < timeoutMs / 1000; i++) {
      if (existsSync(path.join(VER_DIR, "bundle.meta.json"))) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  })();
}

// 会话 1：冷态排队 + 后台补打（不在关键路径）
const s1 = await mcpSession({
  label: "会话 1（源码入口）",
  toolCallTimeoutMs: 600000,
  onReady: async () => {
    const ok = await waitForMeta(120000);
    check("后台补打完成（meta 就位）", ok);
  },
});
check("会话 1 在源码入口上完成（含冷启动）", s1.ok, `ms=${s1.ms}`);

// 会话 2：应使用重建的 bundle
const s2 = await mcpSession({ label: "会话 2（bundle）", toolCallTimeoutMs: 60000 });
check("会话 2 使用重建的 bundle（快照 + 热后端）", s2.ok && s2.ms < 5000, `ms=${s2.ms}`);

process.exit(failed ? 1 : 0);
