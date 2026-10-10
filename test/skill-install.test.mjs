import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleDirFor, installSkill, readReceipt, verifySkill, removeSkill,
} from "../src/skill-install.mjs";

const BUNDLE = fileURLToPath(new URL("./fixtures/bundle/", import.meta.url));
// 单独一个「含白名单外目录」的夹具：白名单夹具必须保持干净，
// 否则所有安装用例都会被 scripts/ 的拦截提前打断。
const BUNDLE_WITH_SCRIPTS = fileURLToPath(new URL("./fixtures/bundle-with-scripts/", import.meta.url));

let root;
let logs;
const logger = {
  info: (m) => logs.push(m), warn: (m) => logs.push(m),
  error: (m) => logs.push(m), debug: () => {},
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ow-skill-")); logs = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const args = (targetDir, extra = {}) => ({
  bundleDir: BUNDLE,
  targetDir,
  hostId: "claude",
  scope: "user",
  mcpCommand: { command: "/node", args: ["/b.mjs", "mcp", "--host", "claude"] },
  launcherVersion: "0.2.0",
  logger,
  ...extra,
});

it("bundleDirFor 只做路径拼接，不猜测布局", () => {
  expect(bundleDirFor("/pkg/root")).toBe(join("/pkg/root", "integrations", "openwiki"));
});

it("复制 bundle 的三个文件并写出收据", () => {
  const r = installSkill(args(join(root, ".claude/skills/openwiki")));
  expect(Object.keys(r.files).sort()).toEqual(["SKILL.md", "agents/bob.yaml", "agents/openai.yaml"]);
  expect(existsSync(join(root, ".claude/skills/openwiki/agents/bob.yaml"))).toBe(true);
  const receipt = readReceipt(join(root, ".claude/skills/openwiki"));
  expect(receipt).toMatchObject({
    package: "openwiki-launcher", version: "0.2.0", target: "claude", scope: "user",
  });
  expect(Object.keys(receipt.files).every((k) => /^[a-f0-9]{64}$/u.test(receipt.files[k]))).toBe(true);
  expect(receipt.mcpServerCommand).toEqual({
    command: "/node", args: ["/b.mjs", "mcp", "--host", "claude"],
  });
});

it("拒绝白名单之外的 bundle 文件（scripts/），且不产生任何写入", () => {
  const targetDir = join(root, "t");
  expect(() => installSkill(args(targetDir, { bundleDir: BUNDLE_WITH_SCRIPTS })))
    .toThrow(/不允许的路径/u);
  expect(existsSync(targetDir)).toBe(false);
});

it("重复安装是幂等的，收据逐字节一致", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  const first = readFileSync(join(targetDir, ".openwiki-launcher.json"), "utf8");
  installSkill(args(targetDir));
  expect(readFileSync(join(targetDir, ".openwiki-launcher.json"), "utf8")).toBe(first);
});

it("已存在同名目录但无 launcher 收据时，先打印说明再覆盖（审查重点 3）", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "SKILL.md"), "手工放的文件", "utf8");
  installSkill(args(targetDir));
  expect(logs.join("\n")).toMatch(/已存在同名目录|没有安装收据/u);
  expect(readFileSync(join(targetDir, "SKILL.md"), "utf8")).not.toBe("手工放的文件");
});

it("takeover 时删除原生收据并改写为 launcher 收据", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, ".openwiki-install.json"),
    JSON.stringify({ package: "openwiki", version: "0.5.0" }), "utf8");
  const r = installSkill(args(targetDir, { takeover: true }));
  expect(existsSync(join(targetDir, ".openwiki-install.json"))).toBe(false);
  expect(existsSync(join(targetDir, ".openwiki-launcher.json"))).toBe(true);
  expect(r.tookOver).toBe(true);
});

it("verifySkill 在文件被改后报告不匹配", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  expect(verifySkill(targetDir).ok).toBe(true);
  writeFileSync(join(targetDir, "SKILL.md"), "用户改过了", "utf8");
  const v = verifySkill(targetDir);
  expect(v.ok).toBe(false);
  expect(v.mismatches).toContain("SKILL.md");
});

it("verifySkill 在收据缺失时报告 missing", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(verifySkill(targetDir)).toMatchObject({ ok: false, missing: true });
});

it("removeSkill 只在哈希全匹配时删除，否则报告 modified", () => {
  const targetDir = join(root, ".claude/skills/openwiki");
  installSkill(args(targetDir));
  writeFileSync(join(targetDir, "SKILL.md"), "用户改过了", "utf8");
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: false, reason: "modified" });
  expect(existsSync(targetDir)).toBe(true);
  writeFileSync(join(targetDir, "SKILL.md"), readFileSync(join(BUNDLE, "SKILL.md"), "utf8"), "utf8");
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: true });
  expect(existsSync(targetDir)).toBe(false);
});

it("removeSkill 在无收据时报告 missing", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(removeSkill(targetDir, logger)).toMatchObject({ removed: false, reason: "missing" });
});

it("readReceipt 在无收据或收据损坏时都返回 null", () => {
  const targetDir = join(root, "x");
  mkdirSync(targetDir, { recursive: true });
  expect(readReceipt(targetDir)).toBeNull();
  writeFileSync(join(targetDir, ".openwiki-launcher.json"), "{ 坏掉的 json", "utf8");
  expect(readReceipt(targetDir)).toBeNull();
});

describe("多家宿主共用同一个 skills 目录（I5）", () => {
  // codex / antigravity / bob 的 projectDir 与 globalDir 都是 .agents/skills，
  // 装出来是同一个目录。卸载任一家时不能把别家的 skill 一起删掉。
  const shared = () => join(root, ".agents/skills/openwiki");
  const installAs = (hostId) => installSkill(args(shared(), { hostId }));

  it("第二次安装把 host 追加进收据而不是覆盖", () => {
    installAs("codex");
    installAs("bob");
    const receipt = readReceipt(shared());
    expect(receipt.hosts.sort()).toEqual(["bob", "codex"]);
  });

  it("removeSkill 在还剩其他宿主时只删文件、不删目录", () => {
    installAs("codex");
    installAs("bob");
    const result = removeSkill(shared(), logger, { hostId: "codex" });
    expect(result).toMatchObject({ removed: false, reason: "shared" });
    expect(existsSync(join(shared(), "SKILL.md"))).toBe(true);
  });

  it("收据里只剩一个宿主时才真正删除目录", () => {
    installAs("bob");
    expect(removeSkill(shared(), logger, { hostId: "bob" })).toMatchObject({ removed: true });
    expect(existsSync(shared())).toBe(false);
  });

  it("installSkill 报告目录此前是否已存在（I3 回滚要靠它）", () => {
    expect(installSkill(args(shared(), { hostId: "codex" })).preexisting).toBe(false);
    expect(installSkill(args(shared(), { hostId: "bob" })).preexisting).toBe(true);
  });
});

describe("收据记下当时写入的 MCP 命令（I4）", () => {
  it("卸载可用它认领条目，而不必依赖当前的 node 路径", () => {
    const targetDir = join(root, ".claude/skills/openwiki");
    installSkill(args(targetDir, {
      mcpCommand: { command: "/old/node", args: ["/old/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"] },
    }));
    const receipt = readReceipt(targetDir);
    expect(receipt.mcpServerCommand).toEqual({
      command: "/old/node", args: ["/old/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"],
    });
  });
});