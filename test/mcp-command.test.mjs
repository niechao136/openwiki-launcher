import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { queueTimeoutFromEnv } from "../src/commands/mcp.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SOURCE = readFileSync(path.join(REPO_ROOT, "src", "commands", "mcp.mjs"), "utf8");

describe("queueTimeoutFromEnv", () => {
  it("defaults to 25000 when the variable is absent", () => {
    expect(queueTimeoutFromEnv({})).toBe(25000);
  });

  it("parses a valid override", () => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: "40000" })).toBe(40000);
  });

  it.each(["abc", "0", "-5", ""])("falls back to 25000 for %j", (value) => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: value })).toBe(25000);
  });
});

// runMcpCommand 的主循环要等 stdin 结束，直接驱动它得造一整套 MCP 假宿主；而这里的
// 契约只有一句"后台补打必须用 launcher 包根"。用源文件不变量钉住（与 bundle-backend
// 的 esbuild 静态导入护栏同一手法），调度逻辑本身由 ensure-default 的单测覆盖。
describe("mcp 后台补打的落点", () => {
  it("把 launcher 包根传下去，而不是 openwiki 包目录", () => {
    expect(MCP_SOURCE).not.toContain("pkgRoot: runtime.packageRoot");
    expect(MCP_SOURCE).toContain("pkgRoot: launcherPackageRoot()");
  });

  it("按来源分流，统一走 scheduleBackgroundPrepare", () => {
    expect(MCP_SOURCE).not.toContain("scheduleBackgroundBundle(");
    expect(MCP_SOURCE).toContain("scheduleBackgroundPrepare(");
  });
});
