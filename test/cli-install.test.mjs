import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { shouldPrepareAfterInstall } from "../src/commands/install.mjs";
import { BUNDLE, NODE, SELF_BIN, makeTempDir, removeTempDir, collectLogger } from "./helpers.mjs";

let home, proj, logs, warmCalls, bundleCalls, prepareCalls;
beforeEach(() => {
  home = makeTempDir("ow-cli-home-");
  proj = makeTempDir("ow-cli-proj-");
  logs = collectLogger();
  warmCalls = [];
  bundleCalls = [];
  prepareCalls = [];
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
  // 与 warmFn 同理：不注入桩的话 install 预热前会真去装 esbuild（数十秒）。
  // ensureBundle 是预热前的第一步，真实安装留给真实环境验证。
  ensureBundleFn: async () => {
    bundleCalls.push(true);
    return { ok: true, file: "bundle-x.mjs" };
  },
  // 就绪动作同理：不注入桩它会去 npm install 几百 MB。
  ensureDefaultVersionFn: async (options) => {
    prepareCalls.push(options);
    return { ok: true, version: "0.6.0" };
  },
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

  it("完全裸跑等价于 install（不回退成打印帮助）", async () => {
    // 回归：历史实现里 `!command` 早退会打印帮助，把下面的「裸用法走安装」
    // 分支变成死代码——README 与 HELP 都承诺裸跑即安装。
    const bare = await main([], deps());
    const bareText = logs.text();
    expect(bareText).not.toContain("用法:");
    expect(bareText).toContain("没有检测到已安装的宿主");
    logs.lines.length = 0;

    const explicit = await main(["install"], deps());
    expect(bare).toBe(explicit);
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

  it("预热之前先 ensureBundle（规格 §9：预热顺带验证 bundle 可启动）", async () => {
    const r = await main(["--tool", "claude"], deps());
    expect(r).toBe(0);
    expect(bundleCalls).toHaveLength(1);
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

describe("默认版本就绪的接线", () => {
  it("安装成功后执行就绪动作", async () => {
    const r = await main(["--tool", "claude"], deps());

    expect(r).toBe(0);
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toMatchObject({ mode: "explicit" });
  });

  it("配置已是最新（没有写入）时仍执行就绪动作，让重跑安装器能修复上一次失败的就绪", async () => {
    await main(["--tool", "claude"], deps());
    logs.lines.length = 0;

    // 第二次运行：配置 unchanged、report 全为 wrote:false，但用户正是靠重跑修复。
    const r = await main(["--tool", "claude"], deps());

    expect(r).toBe(0);
    expect(logs.text()).toContain("已是最新");
    expect(prepareCalls).toHaveLength(2);
  });

  it("检测不到宿主（退出码 1）时仍执行就绪动作", async () => {
    // 空 argv 走的是帮助分支；要走到"检测落空"必须给一个安装标志。
    const r = await main(["--global"], deps());

    expect(r).toBe(1);
    expect(logs.text()).toContain("没有检测到已安装的宿主");
    expect(prepareCalls).toHaveLength(1);
  });

  it("未知宿主时不执行就绪动作", async () => {
    const r = await main(["--tool", "nope"], deps());

    expect(r).toBe(1);
    expect(prepareCalls).toHaveLength(0);
  });

  it("--no-prepare 跳过就绪动作但不跳过预热", async () => {
    const r = await main(["--tool", "claude", "--no-prepare"], deps());

    expect(r).toBe(0);
    expect(prepareCalls).toHaveLength(0);
    expect(warmCalls).toHaveLength(1);
  });

  it("LAUNCHER_PREPARE=0 与 --no-prepare 等价", async () => {
    const r = await main(["--tool", "claude"], deps({ env: { PATH: "", LAUNCHER_PREPARE: "0" } }));

    expect(r).toBe(0);
    expect(prepareCalls).toHaveLength(0);
    expect(warmCalls).toHaveLength(1);
  });

  it("--no-prepare 连 bundle 也不打（bundle 属于版本仓库的一部分）", async () => {
    const r = await main(["--tool", "claude", "--no-prepare"], deps());

    expect(r).toBe(0);
    expect(prepareCalls).toHaveLength(0);
    expect(bundleCalls).toHaveLength(0);
    expect(warmCalls).toHaveLength(1);
  });

  it("--no-warm 只跳过预热，仍执行就绪动作", async () => {
    const r = await main(["--tool", "claude", "--no-warm"], deps());

    expect(r).toBe(0);
    expect(prepareCalls).toHaveLength(1);
    expect(warmCalls).toHaveLength(0);
  });

  it("卸载时不执行就绪动作", async () => {
    await main(["--tool", "claude"], deps());
    prepareCalls.length = 0;

    await main(["--uninstall", "--tool", "claude"], deps());

    expect(prepareCalls).toHaveLength(0);
  });
});

describe("shouldPrepareAfterInstall", () => {
  it("成功安装与检测落空都要就绪，其余都不要", () => {
    expect(shouldPrepareAfterInstall({ exitCode: 0, skippedNoHost: false })).toBe(true);
    expect(shouldPrepareAfterInstall({ exitCode: 1, skippedNoHost: true })).toBe(true);
    expect(shouldPrepareAfterInstall({ exitCode: 1, skippedNoHost: false })).toBe(false);
    expect(shouldPrepareAfterInstall({ exitCode: 2, skippedNoHost: false })).toBe(false);
  });

  it("被开关关掉时一律不就绪", () => {
    expect(shouldPrepareAfterInstall({ exitCode: 0, skippedNoHost: true, noPrepare: true })).toBe(false);
    expect(shouldPrepareAfterInstall({ exitCode: 0, skippedNoHost: true, env: { LAUNCHER_PREPARE: "0" } })).toBe(false);
  });
});
