import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger } from "./helpers.mjs";

let home, proj, logs, warmCalls;
beforeEach(() => {
  home = makeTempDir("ow-cli-home-");
  proj = makeTempDir("ow-cli-proj-");
  logs = collectLogger();
  warmCalls = [];
});
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

// install 成功后会自动预热。不注入桩的话，这些用例会去 spawn 真实 openwiki 后端，
// 每个多等 5-50s —— 测试变慢，而且失败时看不出是断言挂了还是后端没起来。
const stubWarm = (code = 0) => async (options) => {
  warmCalls.push(options);
  if (code !== 0) logs.logger.error("预热失败：boom");
  return code;
};

const deps = (over = {}) => ({
  logger: logs.logger,
  cwd: proj,
  homeDir: home,
  env: { PATH: "" },
  platform: "linux",
  exists: () => false,
  selfBin: SELF_BIN,
  nodeCommand: { command: NODE, warning: null },
  bundleDir: BUNDLE,
  warmFn: stubWarm(),
  ...over,
});

describe("install / uninstall 的 CLI 接线", () => {
  it("裸参数即安装：--tool claude", async () => {
    const r = await main(["--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
    expect(logs.text()).toContain(".claude");
  });

  it("install 子命令写法等价", async () => {
    const r = await main(["install", "--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
  });

  it("第二次运行报已是最新", async () => {
    await main(["--tool", "claude"], deps());
    logs.lines.length = 0;
    const r = await main(["--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(logs.text()).toContain("已是最新");
  });

  it("未知 --tool 报可读错误并列出可用 id", async () => {
    const r = await main(["--tool", "nope"], deps());
    expect(r).toBe(1);
    expect(logs.text()).toContain("未知宿主");
    expect(logs.text()).toContain("codebuddy");
  });

  it("--uninstall 卸载已安装的宿主", async () => {
    await main(["--tool", "claude"], deps());
    const r = await main(["--uninstall", "--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
  });

  it("uninstall 子命令写法等价", async () => {
    await main(["--tool", "claude"], deps());
    const r = await main(["uninstall", "--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
  });

  it("无法识别的参数返回 1", async () => {
    const r = await main(["--frobnicate"], deps());
    expect(r).toBe(1);
    expect(logs.text()).toContain("无法识别的参数");
  });

  it("--tool 缺值返回 1", async () => {
    const r = await main(["--tool"], deps());
    expect(r).toBe(1);
    expect(logs.text()).toContain("--tool 需要一个宿主 id");
  });

  it("对无全局目录的宿主用 --global 返回 1 并说明", async () => {
    const r = await main(["--tool", "antigravity", "--global"], deps());
    expect(r).toBe(1);
    expect(logs.text()).toContain("全局");
  });

  it("help 里包含安装相关用法", async () => {
    const r = await main(["--help"], deps());
    expect(r).toBe(0);
    expect(logs.text()).toContain("--no-takeover");
    expect(logs.text()).toContain("--uninstall");
  });

  it("node 版本不满足时在安装前就拒绝", async () => {
    const r = await main(["--tool", "claude"], deps({ nodeVersion: "20.0.0" }));
    expect(r).toBe(1);
    expect(logs.text()).toContain("22.22.0");
    expect(existsSync(join(proj, ".claude/skills/openwiki"))).toBe(false);
  });

  it("装出来的配置指向注入的 node 与 bin", async () => {
    await main(["--tool", "claude"], deps());
    const cfg = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers.openwiki).toEqual({
      command: NODE, args: [SELF_BIN, "mcp", "--host", "claude"],
    });
  });
});

describe("安装后的自动预热", () => {
  it("安装成功后预热一次", async () => {
    const r = await main(["--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(warmCalls).toHaveLength(1);
  });

  it("--no-warm 跳过预热，并提示可以手动跑", async () => {
    const r = await main(["--tool", "claude", "--no-warm"], deps());
    expect(r).toBe(0);
    expect(warmCalls).toHaveLength(0);
    expect(logs.text()).toContain("openwiki-launcher warm");
  });

  it("预热失败不影响安装结果：退出码仍是 0，并给出警告", async () => {
    const r = await main(["--tool", "claude"], deps({ warmFn: stubWarm(1) }));
    expect(r).toBe(0);
    expect(logs.text()).toContain("预热未成功");
    expect(existsSync(join(proj, ".claude/skills/openwiki/SKILL.md"))).toBe(true);
  });

  it("安装失败时不预热", async () => {
    const r = await main(["--tool", "nope"], deps());
    expect(r).toBe(1);
    expect(warmCalls).toHaveLength(0);
  });

  it("卸载时不预热", async () => {
    await main(["--tool", "claude"], deps());
    warmCalls.length = 0;
    const r = await main(["--uninstall", "--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(warmCalls).toHaveLength(0);
  });
});
