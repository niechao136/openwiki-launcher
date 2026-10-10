import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSkill } from "../src/skill-install.mjs";
import { runInstall } from "../src/install.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => {
  home = makeTempDir("ow-u-home-");
  proj = makeTempDir("ow-u-proj-");
  logs = collectLogger();
});
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

const deps = (over = {}) => ({ ...baseDeps({ logger: logs.logger, cwd: proj, homeDir: home }), ...over });

/** 装一次 skill + 一次 MCP，模拟「已安装」的状态。 */
function installFixture(skillDir, hostId = "claude", mcpPath = null) {
  installSkill({
    bundleDir: BUNDLE, targetDir: skillDir, hostId, scope: "project",
    mcpCommand: { command: NODE, args: [SELF_BIN, "mcp", "--host", hostId] },
    launcherVersion: "0.2.0", logger: logs.logger,
  });
  if (mcpPath) {
    mkdirSync(join(mcpPath, ".."), { recursive: true });
    const entries = { other: { command: "x" } };
    entries.openwiki = hostId === "opencode"
      ? { type: "local", command: [NODE, SELF_BIN, "mcp", "--host", hostId], enabled: true }
      : { command: NODE, args: [SELF_BIN, "mcp", "--host", hostId] };
    const body = hostId === "opencode"
      ? { mcp: entries }
      : { mcpServers: entries };
    writeFileSync(mcpPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }
}

describe("runUninstall —— json 格式", () => {
  it("删除 MCP 条目并保留其他 server", () => {
    const cfg = join(proj, ".mcp.json");
    installFixture(join(proj, ".claude/skills/openwiki"), "claude", cfg);
    const r = runUninstall(deps({ tool: "claude" }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(cfg, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
  });

  it("用户改过 skill 文件时跳过删除，并在警告里给出目录路径", () => {
    const skillDir = join(proj, ".claude/skills/openwiki");
    installFixture(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "我改过了", "utf8");
    const r = runUninstall(deps({ tool: "claude" }));
    expect(existsSync(skillDir)).toBe(true);
    expect(r.report[0].skill.reason).toBe("modified");
    expect(logs.text()).toContain("未删除");
    // 注入的是 platform:"linux"，实现用 path.posix 拼路径（日志里是正斜杠），
    // 而 skillDir 是 Windows 原生路径（反斜杠）—— 指向同一位置但字符串不同。
    // 断言的意图是「警告里给出了目录路径」，所以比较时归一化分隔符。
    const norm = (p) => p.replace(/\\/gu, "/");
    expect(norm(logs.text())).toContain(norm(skillDir));
  });

  it("条目指向别处时不碰用户的配置", () => {
    const cfg = join(proj, ".mcp.json");
    const foreign = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp"]}}}\n';
    writeFileSync(cfg, foreign, "utf8");
    const r = runUninstall(deps({ tool: "claude" }));
    expect(readFileSync(cfg, "utf8")).toBe(foreign);
    expect(r.report[0].mcp.reason).toContain("不是本安装器写入");
  });

  it("未安装时是干净的 no-op，退出码 0", () => {
    const r = runUninstall(deps({ tool: "claude" }));
    expect(r.exitCode).toBe(0);
    expect(r.report[0].skill.action).toBe("skip");
    expect(r.report[0].mcp.action).toBe("skip");
  });

  it("自动检测卸载：不带 --tool 时对命中的宿主生效", () => {
    const skillDir = join(proj, ".codebuddy/skills/openwiki");
    installFixture(skillDir, "codebuddy");
    const r = runUninstall(deps({ detectSnapshotOverride: { codebuddy: true } }));
    expect(r.report.map((x) => x.hostId)).toEqual(["codebuddy"]);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("自动检测落空时 skippedNoHost 为 true 且退出码 1（与 install 一致）", () => {
    const r = runUninstall(deps({ detectSnapshotOverride: {} }));
    expect(r.exitCode).toBe(1);
    expect(r.skippedNoHost).toBe(true);
  });
});

describe("runUninstall —— codex toml", () => {
  it("删除 marker 块后逐字节还原", () => {
    const cfg = join(proj, ".codex/config.toml");
    const before = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
    mkdirSync(join(cfg, ".."), { recursive: true });
    writeFileSync(cfg, before, "utf8");
    runInstall(deps({ tool: "codex" }));
    expect(readFileSync(cfg, "utf8")).toContain("# OPENWIKI-LAUNCHER:MCP:START");
    const r = runUninstall(deps({ tool: "codex" }));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });
});

describe("runUninstall —— opencode jsonc", () => {
  it("删除条目后注释与其他 server 完好", () => {
    const cfg = join(proj, "opencode.jsonc");
    mkdirSync(join(cfg, ".."), { recursive: true });
    writeFileSync(cfg,
      '{\n  // 我的配置\n  "model": "x",\n  "mcp": {\n    "other": { "type": "local", "command": ["y"], "enabled": true }\n  }\n}\n', "utf8");
    runInstall(deps({ tool: "opencode" }));
    const r = runUninstall(deps({ tool: "opencode" }));
    expect(r.exitCode).toBe(0);
    const after = readFileSync(cfg, "utf8");
    expect(after).toContain("// 我的配置");
    expect(after).toContain('"other"');
    expect(after).not.toContain("openwiki");
  });
});
