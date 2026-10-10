import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOSTS, ALIASES, CLI_PROBES, findHost, shortestAlias, isOnPath, validateRegistry,
} from "../src/registry.mjs";

const EXPECTED_IDS = [
  "bob", "claude", "cursor", "codex", "kiro", "opencode", "omp", "antigravity",
  "gemini-cli", "trae", "trae-cn", "vscode", "openclaw", "windsurf", "aider",
  "qwen-code", "hermes", "claw-code", "qoder", "codebuddy", "codearts", "reasonix",
  "dsh", "zcode", "crush", "cline", "kilo-code", "deerflow",
];

// 分档表（规格 3.4）：8 家可自动写 + 18 家 manual（磁盘路径待核实）+ 2 家 null（无 MCP 客户端能力）。
// 必须列全 28 条 —— 只列「已知的几家」会让新增的 manual 宿主悄悄逃过这张表。
const MCP_KIND_BY_ID = {
  // 8 家可自动写：格式取自 openwiki 自身注册表
  bob: "json",
  claude: "json",
  cursor: "json",
  kiro: "json",
  omp: "json",
  antigravity: "json",
  codex: "codex-toml",
  opencode: "opencode-json",
  // 18 家 manual：MCP 配置入口或磁盘路径未经核实，只打印片段不写盘
  "gemini-cli": "manual",
  codebuddy: "manual",
  windsurf: "manual",
  "qwen-code": "manual",
  cline: "manual",
  "kilo-code": "manual",
  crush: "manual",
  zcode: "manual",
  trae: "manual",
  "trae-cn": "manual",
  vscode: "manual",
  openclaw: "manual",
  hermes: "manual",
  "claw-code": "manual",
  qoder: "manual",
  codearts: "manual",
  reasonix: "manual",
  dsh: "manual",
  // 2 家无 MCP 客户端能力
  aider: null,
  deerflow: null,
};

it("覆盖且仅覆盖 28 家宿主", () => {
  expect(HOSTS.map((h) => h.id).sort()).toEqual([...EXPECTED_IDS].sort());
});

it("每条都通过 schema 自校验", () => {
  expect(validateRegistry()).toEqual([]);
});

it("id 全部匹配 broker 的 host 校验规则", () => {
  for (const h of HOSTS) expect(h.id).toMatch(/^[a-z0-9-]{1,64}$/u);
});

it("mcp.kind 分档与 3.4 一致：8 家可自动写、CodeBuddy manual、其余无 MCP 客户端能力", () => {
  const actual = Object.fromEntries(HOSTS.map((h) => [h.id, h.mcp?.kind ?? null]));
  expect(actual).toEqual(MCP_KIND_BY_ID);
});

it("8 家 native 宿主带原生定位信息，其余为 null", () => {
  expect(HOSTS.filter((h) => h.native).map((h) => h.id).sort()).toEqual(
    ["bob", "claude", "codex", "kiro", "opencode", "omp", "antigravity", "cursor"].sort());
  for (const h of HOSTS.filter((x) => !x.native)) expect(h.native).toBeNull();
});

it("8 家的 mcp 路径与 openwiki 注册表逐字一致（含用户级=项目级的那四家）", () => {
  const m = Object.fromEntries(HOSTS.map((h) => [h.id, h.mcp]));
  expect([m.bob.userPath, m.bob.projectPath]).toEqual([".bob/mcp.json", ".bob/mcp.json"]);
  expect([m.cursor.userPath, m.cursor.projectPath]).toEqual([".cursor/mcp.json", ".cursor/mcp.json"]);
  expect([m.kiro.userPath, m.kiro.projectPath]).toEqual([".kiro/settings/mcp.json", ".kiro/settings/mcp.json"]);
  expect([m.claude.userPath, m.claude.projectPath]).toEqual([".claude.json", ".mcp.json"]);
  expect([m.codex.userPath, m.codex.projectPath]).toEqual([".codex/config.toml", ".codex/config.toml"]);
  expect([m.opencode.userPath, m.opencode.projectPath])
    .toEqual([".config/opencode/opencode.jsonc", "opencode.jsonc"]);
  expect([m.omp.userPath, m.omp.projectPath]).toEqual([".omp/agent/mcp.json", ".omp/mcp.json"]);
  expect([m.antigravity.userPath, m.antigravity.projectPath])
    .toEqual([".gemini/config/mcp_config.json", ".agents/mcp_config.json"]);
});

it("6 家 json 的键名是 mcpServers，opencode 用 mcp", () => {
  expect(Object.fromEntries(HOSTS.filter((h) => h.mcp?.kind === "json").map((h) => [h.id, h.mcp.containerKey])))
    .toEqual({ bob: "mcpServers", claude: "mcpServers", cursor: "mcpServers",
      kiro: "mcpServers", omp: "mcpServers", antigravity: "mcpServers" });
  expect(findHost("opencode").mcp.containerKey).toBe("mcp");
  expect(findHost("codex").mcp.containerKey).toBe("mcp_servers");
});

it("Antigravity 无全局目录（2.3 裁决）", () => {
  expect(findHost("antigravity").skill.globalDir).toBeNull();
});

it("globalDirWin 只有 Crush 与 Reasonix 非空（Windows 差异目录）", () => {
  const withWin = HOSTS.filter((h) => h.skill.globalDirWin).map((h) => h.id).sort();
  expect(withWin).toEqual(["crush", "reasonix"]);
});

it("拒绝项目级的条目带 noProjectReason", () => {
  for (const id of ["zcode", "trae-cn"]) {
    expect(findHost(id).skill.projectDir).toBeNull();
    expect(typeof findHost(id).noProjectReason).toBe("string");
  }
});

it("别名解析命中规范 id，未知别名返回 null", () => {
  expect(findHost("cc").id).toBe("claude");
  expect(findHost("claude-code").id).toBe("claude");
  expect(findHost("codebuddy").id).toBe("codebuddy");
  expect(findHost("nope")).toBeNull();
});

it("shortestAlias 返回可复制的最短别名", () => {
  expect(shortestAlias("claude")).toBe("cc");
  expect(shortestAlias("bob")).toBe("bob");
});

it("isOnPath 按 platform 处理分隔符与 PATHEXT", () => {
  const exists = (p) => p === "/usr/bin/codex";
  expect(isOnPath("codex", { platform: "linux", env: { PATH: "/usr/bin" }, exists })).toBe(true);
  expect(isOnPath("codex", { platform: "linux", env: { PATH: "/nowhere" }, exists })).toBe(false);
  expect(isOnPath("codex", { platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
    exists: (p) => p === "C:\\bin\\codex.EXE" })).toBe(true);
});

it("CLI_PROBES 只列 CLI 宿主", () => {
  expect(Object.keys(CLI_PROBES).sort()).toEqual(
    ["claude", "codex", "gemini-cli", "opencode", "aider", "qwen-code",
      "openclaw", "claw-code", "crush", "hermes"].sort());
});

it("全部别名指向存在的宿主", () => {
  for (const [alias, id] of Object.entries(ALIASES)) {
    expect(HOSTS.some((h) => h.id === id), `别名 ${alias} → ${id}`).toBe(true);
  }
});

it("openwiki 包内的 skill bundle 位于 integrations/openwiki 且含 SKILL.md", async () => {
  // 直接拼路径而不是调本包的 bundleDirFor：这条测试要钉住的是「bundle 就在 openwiki
  // 包的这个位置」这个外部事实，不该耦合到我们自己的包装函数（那是 task3 的测试）。
  // 路径来源只允许是 resolveOpenwikiRuntime() 的返回值 —— 不做全局路径探测。
  const { resolveOpenwikiRuntime } = await import("../src/paths.mjs");
  const bundle = join((await resolveOpenwikiRuntime()).packageRoot, "integrations", "openwiki");
  expect(existsSync(join(bundle, "SKILL.md"))).toBe(true);
});