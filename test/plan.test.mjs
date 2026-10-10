import { describe, it, expect } from "vitest";
import { planInstall } from "../src/plan.mjs";
import { HOSTS, findHost } from "../src/registry.mjs";
import { spliceJsonEntry } from "../src/mcp-config.mjs";

const NIX = { platform: "linux", home: "/home/u", tmpdir: "/tmp", systemRoots: ["/usr", "/etc", "/bin"] };
const base = {
  hosts: HOSTS,
  scope: "project",
  baseDir: "/home/u/proj",
  homeDir: "/home/u",
  targets: null,
  detectSnapshot: {},
  nativeSnapshot: {},
  mcpSnapshot: {},
  nodeCommand: { command: "/abs/node", warning: null },
  selfBin: "/abs/bin/openwiki-launcher.mjs",
  launcherVersion: "0.2.0",
  flags: { force: false, noTakeover: false },
  ...NIX,
};

const detectAllFalse = () => Object.fromEntries(HOSTS.map((h) => [h.id, false]));
const entry = (plan, id) => plan.entries.find((e) => e.hostId === id);

it("自动检测：只对命中的宿主产出条目", () => {
  const plan = planInstall({ ...base, detectSnapshot: { ...detectAllFalse(), codebuddy: true } });
  expect(plan.entries.map((e) => e.hostId)).toEqual(["codebuddy"]);
  expect(plan.skippedNoHost).toBe(false);
});

it("检测全落空时 skippedNoHost 为 true 且条目为空", () => {
  const plan = planInstall({ ...base, detectSnapshot: detectAllFalse() });
  expect(plan.entries).toEqual([]);
  expect(plan.skippedNoHost).toBe(true);
});

it("--tool 指定时忽略 detect 快照", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")], detectSnapshot: detectAllFalse() });
  expect(plan.entries.map((e) => e.hostId)).toEqual(["claude"]);
});

it("项目级装到只支持全局的宿主时跳过并给出替代命令", () => {
  const e = entry(planInstall({ ...base, targets: [findHost("zcode")] }), "zcode");
  expect(e.skill.action).toBe("skip");
  expect(e.skill.reason).toContain("--global");
});

it("--global 装到无全局目录的宿主时跳过并指向项目级（Antigravity 裁决）", () => {
  const e = entry(planInstall({ ...base, scope: "user", baseDir: "/home/u",
    targets: [findHost("antigravity")] }), "antigravity");
  expect(e.skill.action).toBe("skip");
  expect(e.skill.reason).toContain("项目级");
});

it("全局作用域把 skill 目录解析到 home 下", () => {
  const e = entry(planInstall({ ...base, scope: "user", baseDir: "/home/u",
    targets: [findHost("codebuddy")] }), "codebuddy");
  expect(e.skill.action).toBe("install");
  expect(e.skill.dir).toBe("/home/u/.codebuddy/skills/openwiki");
});

it("系统目录被护栏标记 guarded，且 --force 也不放行", () => {
  const inSystem = { ...base, baseDir: "/usr/local/proj", targets: [findHost("claude")] };
  expect(entry(planInstall(inSystem), "claude").guarded).toBe(true);
  const forced = entry(planInstall({ ...inSystem, flags: { ...base.flags, force: true } }), "claude");
  expect(forced.guarded).toBe(true);
  expect(forced.guardReason).toContain("系统目录");
});

it("主目录护栏：项目级安装的 base 目录等于 home 时拒绝，--force 可放行", () => {
  // 起飞前裁决：规格写的「目标目录等于 ~」在本包装布局（恒在末尾追加 openwiki）下不可达，
  // 改判 base 目录 —— 「用户在主目录里跑项目级安装」，且对他来说 --global 目标路径相同。
  const fromHome = { ...base, baseDir: "/home/u", targets: [findHost("claude")] };
  const e = entry(planInstall(fromHome), "claude");
  expect(e.guarded).toBe(true);
  expect(e.guardReason).toContain("主目录");
  expect(entry(planInstall({ ...fromHome, flags: { ...base.flags, force: true } }), "claude").guarded).toBe(false);
});

it("普通项目目录不被主目录护栏拦", () => {
  expect(entry(planInstall({ ...base, targets: [findHost("claude")] }), "claude").guarded).toBe(false);
});

it("mcp.kind 为 manual 时 action=manual，为 null 时 action=none", () => {
  const plan = planInstall({ ...base, targets: [findHost("codebuddy"), findHost("aider")] });
  expect(entry(plan, "codebuddy").mcp).toMatchObject({ action: "manual", path: null });
  expect(entry(plan, "aider").mcp).toMatchObject({ action: "none", path: null });
});

it("MCP 路径按作用域解析到用户级或项目级", () => {
  const user = planInstall({ ...base, scope: "user", baseDir: "/home/u", targets: [findHost("claude")] });
  expect(entry(user, "claude").mcp.path).toBe("/home/u/.claude.json");
  const project = planInstall({ ...base, targets: [findHost("claude")] });
  expect(entry(project, "claude").mcp.path).toBe("/home/u/proj/.mcp.json");
});

it("条目缺失时 created、等值时 unchanged、不同时 updated", () => {
  const entryJson = JSON.stringify({ command: "/abs/node",
    args: ["/abs/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"] }, null, 2);
  const equalText = spliceJsonEntry("", { containerKey: "mcpServers", entryKey: "openwiki", entryJson }).text;
  const nativeText = '{"mcpServers":{"openwiki":{"command":"openwiki","args":["mcp","--host","claude"]}}}';
  const snap = (text, exists) => ({ mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text, exists } } });
  const run = (s) => entry(planInstall({ ...base, targets: [findHost("claude")], ...s }), "claude").mcp.action;

  expect(run(snap("", false))).toBe("created");
  expect(run(snap(equalText, true))).toBe("unchanged");
  expect(run(snap(nativeText, true))).toBe("updated");
});

it("MCP 条目存在但不属于本安装器时标记 takeover（规格 4.4 第二种情形）", () => {
  const foreign = '{"mcpServers":{"openwiki":{"command":"/other/bin/node","args":["x"]}}}';
  const e = entry(planInstall({ ...base, targets: [findHost("claude")],
    mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text: foreign, exists: true } } }), "claude");
  expect(e.mcp.action).toBe("updated");
  expect(e.takeover).toBe(true);
  expect(e.takeoverReason).toBe("foreign-entry");
});

it("配置文件畸形时 action=error 而不是抛异常", () => {
  const e = entry(planInstall({ ...base, targets: [findHost("claude")],
    mcpSnapshot: { claude: { path: "/home/u/proj/.mcp.json", text: '{ "mcpServers": {', exists: true } } }), "claude");
  expect(e.mcp.action).toBe("error");
  expect(e.mcp.reason).toBeTruthy();
  expect(e.guarded).toBe(false);
});

it("原生收据存在时标记 takeover；--no-takeover 下整家跳过", () => {
  const withNative = { nativeSnapshot: { claude: { receipt: true, skillDir: "/home/u/.claude/skills/openwiki" } } };
  const normal = entry(planInstall({ ...base, targets: [findHost("claude")], ...withNative }), "claude");
  expect(normal.takeover).toBe(true);
  expect(normal.takeoverReason).toBe("native-receipt");

  const opted = entry(planInstall({ ...base, targets: [findHost("claude")], ...withNative,
    flags: { ...base.flags, noTakeover: true } }), "claude");
  expect(opted.takeover).toBe(false);
  expect(opted.mcp.action).toBe("skip");
  expect(opted.mcp.reason).toContain("native install present");
  expect(opted.skill.action).toBe("skip");
});

it("node 回退警告透出到 plan 顶层", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")],
    nodeCommand: { command: "node", warning: "未能确定 node 绝对路径" } });
  expect(plan.nodeWarning).toContain("未能确定");
});

it("注入的 isSystemDir 可替换", () => {
  const plan = planInstall({ ...base, targets: [findHost("claude")], isSystemDir: () => true });
  expect(plan.entries[0].guarded).toBe(true);
  expect(plan.entries[0].guardReason).toContain("系统目录");
});

it("codex 宿主用 toml marker 而非原生 marker", () => {
  const plan = planInstall({ ...base, targets: [findHost("codex")] });
  expect(entry(plan, "codex").mcp.action).toBe("created");
  expect(entry(plan, "codex").mcp.containerKey).toBe("mcp_servers");
});