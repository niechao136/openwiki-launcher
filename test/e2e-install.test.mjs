import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTS } from "../src/registry.mjs";
import { runInstall } from "../src/install.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger, baseDeps } from "./helpers.mjs";

const AUTO_MCP = ["json", "codex-toml", "opencode-json"];
const PLATFORM = "linux";

/**
 * 按 kind 造一份「用户已有内容」，安装后必须原样保留，卸载后必须逐字节还原。
 *
 * @param {string} cfgPath
 * @param {string} kind
 * @returns {string} 写入前的原文
 */
function seedConfig(cfgPath, kind) {
  mkdirSync(join(cfgPath, ".."), { recursive: true });
  const text = kind === "codex-toml"
    ? 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n'
    : kind === "opencode-json"
      ? '{\n  // 我的配置\n  "model": "x",\n  "mcp": {\n    "other": { "type": "local", "command": ["y"], "enabled": true }\n  }\n}\n'
      : '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';
  writeFileSync(cfgPath, text, "utf8");
  return text;
}

describe.each(HOSTS)("宿主 $id", (host) => {
  const autoMcp = AUTO_MCP.includes(host.mcp?.kind);

  if (host.skill.projectDir) {
    it("项目级安装与卸载闭环", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
        expect(runInstall({ ...d, tool: host.id }).exitCode).toBe(0);
        const skillDir = join(proj, host.skill.projectDir, "openwiki");
        expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
        expect(existsSync(join(skillDir, ".openwiki-launcher.json"))).toBe(true);
        expect(runUninstall({ ...d, tool: host.id }).exitCode).toBe(0);
        expect(existsSync(skillDir)).toBe(false);
      } finally { removeTempDir(proj); }
    });
  }

  if (host.skill.globalDir) {
    it("用户级安装与卸载闭环（globalDirWin 按注入的 platform 选取）", () => {
      const home = makeTempDir("ow-e-");
      // 路径选择必须跟注入的 platform 走，不能读真实 process.platform ——
      // 否则在 Windows 上跑 platform:"linux" 的用例会断言到错误的目录。
      const rel = PLATFORM === "win32" && host.skill.globalDirWin ? host.skill.globalDirWin : host.skill.globalDir;
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: join(home, "proj"), homeDir: home, platform: PLATFORM });
        expect(runInstall({ ...d, tool: host.id, global: true }).exitCode).toBe(0);
        expect(existsSync(join(home, rel, "openwiki", "SKILL.md"))).toBe(true);
        expect(runUninstall({ ...d, tool: host.id, global: true }).exitCode).toBe(0);
        expect(existsSync(join(home, rel, "openwiki"))).toBe(false);
      } finally { removeTempDir(home); }
    });
  }

  if (autoMcp) {
    it("MCP 条目写入正确且卸载后配置文件逐字节还原", () => {
      const proj = makeTempDir("ow-e-");
      const cfg = join(proj, host.mcp.projectPath);
      const before = seedConfig(cfg, host.mcp.kind);
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
        expect(runInstall({ ...d, tool: host.id }).exitCode).toBe(0);
        const after = readFileSync(cfg, "utf8");
        if (host.mcp.kind === "codex-toml") {
          expect(after).toContain("# OPENWIKI-LAUNCHER:MCP:START");
          expect(after).toContain("[mcp_servers.other]");
          expect(after).toContain('model = "x"');
          expect(after).toContain(SELF_BIN);
        } else {
          const parsed = JSON.parse(after.replace(/^\s*\/\/.*$/gmu, ""));
          expect(parsed[host.mcp.containerKey].openwiki).toBeTruthy();
          expect(JSON.stringify(parsed[host.mcp.containerKey].openwiki)).toContain(NODE);
          expect(parsed[host.mcp.containerKey].other).toBeTruthy();
        }
        expect(runUninstall({ ...d, tool: host.id }).exitCode).toBe(0);
        expect(readFileSync(cfg, "utf8")).toBe(before);
      } finally { removeTempDir(proj); }
    });
  }

  if (host.mcp?.kind === "manual" && host.skill.projectDir) {
    it("只装 skill 并报告 manual", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
        const r = runInstall({ ...d, tool: host.id });
        expect(r.exitCode).toBe(0);
        expect(r.report[0].mcp).toMatchObject({ action: "manual" });
        expect(logs.text()).toContain('"command"');
      } finally { removeTempDir(proj); }
    });
  }

  if (host.skill.projectDir === null) {
    it("拒绝项目级并给出替代命令", () => {
      const proj = makeTempDir("ow-e-");
      try {
        const logs = collectLogger();
        const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
        const r = runInstall({ ...d, tool: host.id });
        expect(r.exitCode).toBe(1);
        expect(r.report[0].skill.action).toBe("skip");
        // 替代命令未必字面含 --global（TRAE CN 指向 Trae 的项目级），断言「给出了替代命令」
        expect(r.report[0].skill.reason).toContain("openwiki-launcher");
      } finally { removeTempDir(proj); }
    });
  }
});

describe("跨宿主的不变量", () => {
  it("护栏：系统目录被拒绝时文件系统零改动", () => {
    const systemRoot = makeTempDir("ow-e-sys-");
    try {
      const before = readdirSync(systemRoot);
      const logs = collectLogger();
      const r = runInstall({
        ...baseDeps({
          logger: logs.logger, cwd: join(systemRoot, "proj"), homeDir: join(systemRoot, "home"),
          platform: PLATFORM, systemRoots: [systemRoot],
        }),
        // 必须显式指定宿主：空目录里自动检测找不到任何宿主，会先走「检测落空」分支（退出码 1），
        // 根本到不了护栏那一步。
        tool: "claude",
      });
      expect(r.exitCode).toBe(2);
      expect(r.report.every((x) => !x.wrote)).toBe(true);
      expect(readdirSync(systemRoot)).toEqual(before);
    } finally { removeTempDir(systemRoot); }
  });

  it("接管：预置原生收据与原生条目，安装后完成接管", () => {
    const home = makeTempDir("ow-e-home-");
    try {
      const skillDir = join(home, ".claude/skills/openwiki");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, ".openwiki-install.json"),
        '{"package":"openwiki","version":"0.5.0"}', "utf8");
      writeFileSync(join(home, ".claude.json"),
        '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}', "utf8");
      const logs = collectLogger();
      const d = baseDeps({ logger: logs.logger, cwd: join(home, "proj"), homeDir: home, platform: PLATFORM });
      expect(runInstall({ ...d, tool: "claude", global: true }).exitCode).toBe(0);
      expect(existsSync(join(skillDir, ".openwiki-install.json"))).toBe(false);
      expect(existsSync(join(skillDir, ".openwiki-launcher.json"))).toBe(true);
      expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(SELF_BIN);
    } finally { removeTempDir(home); }
  });

  it("格式保真：opencode.jsonc 的注释与 config.toml 的其他表都不丢", () => {
    const proj = makeTempDir("ow-e-fmt-");
    try {
      const logs = collectLogger();
      const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
      const oc = join(proj, "opencode.jsonc");
      seedConfig(oc, "opencode-json");
      const cx = join(proj, ".codex/config.toml");
      seedConfig(cx, "codex-toml");
      runInstall({ ...d, tool: "opencode" });
      runInstall({ ...d, tool: "codex" });
      expect(readFileSync(oc, "utf8")).toContain("// 我的配置");
      expect(readFileSync(cx, "utf8")).toContain("[mcp_servers.other]");
      expect(readFileSync(cx, "utf8")).toContain('model = "x"');
    } finally { removeTempDir(proj); }
  });

  it("28 家全部能装上并卸掉（每家至少验证 skill 落位）", () => {
    const proj = makeTempDir("ow-e-all-");
    try {
      const logs = collectLogger();
      const d = baseDeps({ logger: logs.logger, cwd: proj, homeDir: join(proj, "home"), platform: PLATFORM });
      const withProject = HOSTS.filter((h) => h.skill.projectDir);
      for (const host of withProject) {
        const r = runInstall({ ...d, tool: host.id });
        expect(r.exitCode, `安装 ${host.id}`).toBe(0);
        expect(existsSync(join(proj, host.skill.projectDir, "openwiki", "SKILL.md")), host.id).toBe(true);
      }
      for (const host of withProject) {
        expect(runUninstall({ ...d, tool: host.id }).exitCode, `卸载 ${host.id}`).toBe(0);
        expect(existsSync(join(proj, host.skill.projectDir, "openwiki")), host.id).toBe(false);
      }
    } finally { removeTempDir(proj); }
  });
});
