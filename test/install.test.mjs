import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTS } from "../src/registry.mjs";
import { resolveScope, resolveTargets, collectDetectSnapshot } from "../src/targets.mjs";
import { runInstall } from "../src/install.mjs";
import { NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => {
  home = makeTempDir("ow-home-");
  proj = makeTempDir("ow-proj-");
  logs = collectLogger();
});
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

const deps = (over = {}) => ({ ...baseDeps({ logger: logs.logger, cwd: proj, homeDir: home }), ...over });

describe("src/targets.mjs —— install 与 uninstall 共用的目标解析", () => {
  it("作用域解析：--global 用 home，否则用 cwd", () => {
    expect(resolveScope({ global: true, cwd: "/proj", homeDir: "/home/u" }))
      .toEqual({ scope: "user", baseDir: "/home/u" });
    expect(resolveScope({ global: false, cwd: "/proj", homeDir: "/home/u" }))
      .toEqual({ scope: "project", baseDir: "/proj" });
  });

  it("--tool 解析与自动检测走同一入口，未知 id 返回 null", () => {
    expect(resolveTargets({ tool: "cc", hosts: HOSTS }).map((h) => h.id)).toEqual(["claude"]);
    expect(resolveTargets({ tool: "nope", hosts: HOSTS })).toBeNull();
    expect(resolveTargets({ tool: null, hosts: HOSTS })).toBeNull();
  });

  it("detect 快照对全池一次性算完，数组标记取 some", () => {
    const base = mkdtempProbe();
    try {
      mkdirSync(join(base, ".codebuddy"), { recursive: true });
      const snap = collectDetectSnapshot(HOSTS, { scope: "project", baseDir: base, exists: existsSync });
      expect(snap.codebuddy).toBe(true);
      expect(snap.claude).toBe(false);
    } finally {
      removeTempDir(base);
    }
  });
});

function mkdtempProbe() {
  return makeTempDir("ow-detect-");
}

describe("runInstall", () => {
  it("为指定宿主安装 skill 并把 MCP 命令指向自身 bin", () => {
    const r = runInstall(deps({ tool: "claude" }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".claude/skills/openwiki/.openwiki-launcher.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers.openwiki)
      .toEqual({ command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"] });
  });

  it("CodeBuddy 打印 manual 配置片段且不写 MCP 文件", () => {
    const r = runInstall(deps({ tool: "codebuddy" }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(proj, ".codebuddy/skills/openwiki/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".codebuddy/mcp.json"))).toBe(false);
    expect(r.report[0].mcp).toMatchObject({ action: "manual" });
    expect(logs.text()).toContain('"command"');
  });

  it("系统目录被拒绝时退出码 2 且文件系统零改动", () => {
    const systemRoot = makeTempDir("ow-sys-");
    try {
      const before = readdirSync(systemRoot);
      const r = runInstall(deps({
        tool: "claude", cwdOverride: join(systemRoot, "proj"), systemRoots: [systemRoot],
      }));
      expect(r.exitCode).toBe(2);
      expect(r.guardedCount).toBeGreaterThan(0);
      expect(r.report.every((x) => !x.wrote)).toBe(true);
      expect(readdirSync(systemRoot)).toEqual(before);
    } finally { removeTempDir(systemRoot); }
  });

  it("主目录里做项目级安装被拒，退出码 2 且零写入", () => {
    const r = runInstall(deps({ tool: "claude", cwdOverride: home, homeDir: home }));
    expect(r.exitCode).toBe(2);
    expect(logs.text()).toContain("主目录");
  });

  it("检测落空时给 PATH 建议而不是静默退出 0", () => {
    const r = runInstall(deps({ env: { PATH: "" }, exists: () => false, detectSnapshotOverride: {} }));
    expect(r.exitCode).toBe(1);
    expect(r.skippedNoHost).toBe(true);
  });

  it("接管原生安装：替换 MCP 条目、更替收据、留下备份", () => {
    const skillDir = join(home, ".claude/skills/openwiki");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, ".openwiki-install.json"),
      '{"package":"openwiki","version":"0.5.0"}', "utf8");
    writeFileSync(join(home, ".claude.json"),
      '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}', "utf8");

    const r = runInstall(deps({ tool: "claude", global: true }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(skillDir, ".openwiki-install.json"))).toBe(false);
    expect(existsSync(join(skillDir, ".openwiki-launcher.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.openwiki.command).toBe(NODE);
    expect(logs.text()).toContain("接管");
    expect(readdirSync(home).filter((f) => f.includes(".openwiki-launcher-backup-"))).toHaveLength(1);
  });

  it("接管用户手工写的同名条目时也打印说明", () => {
    writeFileSync(join(proj, ".mcp.json"),
      '{"mcpServers":{"openwiki":{"command":"/other/node","args":["x"]}}}', "utf8");
    const r = runInstall(deps({ tool: "claude" }));
    expect(r.report[0].takeoverReason).toBe("foreign-entry");
    expect(logs.text()).toContain("接管");
  });

  it("--no-takeover 下零改动", () => {
    const before = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}';
    writeFileSync(join(home, ".claude.json"), before, "utf8");
    const r = runInstall(deps({ tool: "claude", global: true, noTakeover: true }));
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
    expect(r.report[0].mcp.reason).toContain("native install present");
  });

  it("配置畸形时报可读错误并回滚，不清空用户文件（审查重点 1）", () => {
    const bad = '{ "mcpServers": { }';
    writeFileSync(join(proj, ".mcp.json"), bad, "utf8");
    const r = runInstall(deps({ tool: "claude" }));
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(bad);
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
    expect(logs.text()).toMatch(/无法解析|括号不配对/u);
  });

  it("重复安装幂等，第二次报 unchanged 且不重写", () => {
    runInstall(deps({ tool: "claude" }));
    const first = readFileSync(join(proj, ".mcp.json"), "utf8");
    const r = runInstall(deps({ tool: "claude" }));
    expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(first);
    expect(r.report[0].mcp.action).toBe("unchanged");
  });

  it("--bootstrap 首版不写任何引导文件但打印说明", () => {
    const r = runInstall(deps({ tool: "claude", bootstrap: true }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(proj, ".claude/CLAUDE.md"))).toBe(false);
    expect(logs.text()).toContain("引导文件");
  });

  it("node 绝对路径不可用时回退 node 并在报告里警告", () => {
    const r = runInstall(deps({
      tool: "claude", nodeCommand: { command: "node", warning: "未能确定 node 绝对路径" },
    }));
    expect(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers.openwiki.command).toBe("node");
    expect(logs.text()).toContain("未能确定");
  });

  it("自动检测命中多个宿主时按注册表顺序全部安装", () => {
    const r = runInstall(deps({ detectSnapshotOverride: { claude: true, codebuddy: true } }));
    expect(r.report.map((x) => x.hostId)).toEqual(["claude", "codebuddy"]);
    expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".codebuddy/skills/openwiki/SKILL.md"))).toBe(true);
  });

  it("配置文件读不出来时跳过写盘而不是当成空配置覆盖（I7）", () => {
    const cfg = join(proj, ".mcp.json");
    writeFileSync(cfg, '{"mcpServers":{"other":{"command":"x"}}}', "utf8");
    const r = runInstall(deps({
      tool: "claude",
      // 存在但读不出来（权限不足 / 被独占 / 间歇性 IO 错误）
      read: () => { throw new Error("EACCES: permission denied"); },
    }));
    expect(r.exitCode).toBe(1);
    expect(readFileSync(cfg, "utf8")).toBe('{"mcpServers":{"other":{"command":"x"}}}');
    expect(logs.text()).toContain("无法读取");
  });

  it("--no-takeover 跳过是成功路径，不该报「不支持该作用域」（I2）", () => {
    const skillDir = join(home, ".claude/skills/openwiki");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, ".openwiki-install.json"), '{"package":"openwiki"}', "utf8");
    writeFileSync(join(home, ".claude.json"),
      '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}', "utf8");

    const r = runInstall(deps({ tool: "claude", global: true, noTakeover: true }));
    expect(r.exitCode).toBe(0);
    expect(logs.text()).not.toContain("不支持你选择的安装作用域");
    expect(logs.text()).toContain("跳过");
  });

  it("写入中途失败时回滚，且不删运行之前就存在的 skill 目录（I3）", () => {
    // 一个「用户手放的」skill 目录：没有收据，安装会覆盖它，但回滚不该删掉它
    const manualDir = join(proj, ".codebuddy/skills/openwiki");
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, "用户手放.txt"), "keep me", "utf8");
    // 预置 claude 的配置文件，让「读不出来」这条路径真的被走到
    writeFileSync(join(proj, ".mcp.json"), '{"mcpServers":{"other":{"command":"x"}}}', "utf8");

    const r = runInstall(deps({
      detectSnapshotOverride: { claude: true, codebuddy: true },
      read: (p) => {
        if (String(p).endsWith(".mcp.json")) throw new Error("EACCES: permission denied");
        return readFileSync(p, "utf8");
      },
    }));

    expect(r.exitCode).toBe(1);
    expect(existsSync(join(manualDir, "用户手放.txt"))).toBe(true);
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
    // 失败目标的错误与成功目标的报告同时可见
    expect(logs.text()).toContain("claude");
    expect(logs.text()).toContain("codebuddy");
  });

  it("win32 上 --global 用 globalDirWin（I1）", () => {
    const home2 = makeTempDir("ow-win-");
    try {
      const logs2 = collectLogger();
      const r = runInstall({
        ...baseDeps({
          logger: logs2.logger, cwd: join(home2, "proj"), homeDir: home2, platform: "win32",
        }),
        tool: "crush",
        global: true,
      });
      expect(r.exitCode).toBe(0);
      // Crush 的 Windows 全局目录是 AppData/Local/crush/skills，不是 .config/crush/skills
      const crushDir = join(home2, "AppData", "Local", "crush", "skills", "openwiki", "SKILL.md");
      const unixDir = join(home2, ".config", "crush", "skills", "openwiki", "SKILL.md");
      expect(existsSync(crushDir)).toBe(true);
      expect(existsSync(unixDir)).toBe(false);
    } finally { removeTempDir(home2); }
  });
});
