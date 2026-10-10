import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger } from "./helpers.mjs";

let home, proj, logs;
beforeEach(() => {
  home = makeTempDir("ow-cli-home-");
  proj = makeTempDir("ow-cli-proj-");
  logs = collectLogger();
});
afterEach(() => { removeTempDir(home); removeTempDir(proj); });

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
