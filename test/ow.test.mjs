import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runOpenwikiCli } from "../src/openwiki-cli.mjs";
import { main } from "../src/cli.mjs";
import { OpenwikiNotFoundError } from "../src/paths.mjs";
import { collectLogger } from "./helpers.mjs";

const RUNTIME = {
  packageRoot: "/pkg/versions/0.6.0/node_modules/openwiki",
  version: "0.6.0",
  cliJs: "/pkg/versions/0.6.0/bundle-abc123.mjs", // bundle：MCP 专用，绝不能被 spawn
  sourceCliJs: "/pkg/versions/0.6.0/node_modules/openwiki/dist/cli/cli.js",
  backend: "bundle",
  source: "versions",
};

function fakeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); return true; };
  const spawnFn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return child; };
  return { calls, child, spawnFn };
}

function deps(extra = {}) {
  const logs = collectLogger();
  const spawn = fakeSpawn();
  return {
    logs,
    ...spawn,
    base: {
      args: ["visualize", "--no-open"],
      logger: logs.logger,
      resolveRuntime: async () => RUNTIME,
      spawnFn: spawn.spawnFn,
      ...extra,
    },
  };
}

/**
 * 等 `runOpenwikiCli` 越过 `resolveRuntime` 的 await、完成 spawn 与 close 监听
 * 注册后，再把假子进程的事件发出去；直接在调用后同步 emit 会因为监听器还没
 * 注册而丢事件，让用例等成超时。
 */
function flushed() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("runOpenwikiCli 透传内核", () => {
  it("用 sourceCliJs 启动（绝不使用 bundle 的 cliJs）", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].argv[0]).toBe(RUNTIME.sourceCliJs);
    expect(d.calls[0].argv.slice(1)).toEqual(["visualize", "--no-open"]);
  });

  it("spawn 参数：node 绝对路径、stdio inherit、cwd 为调用者 cwd、环境原样继承", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].cmd).toBe(process.execPath);
    expect(d.calls[0].opts.stdio).toBe("inherit");
    expect(d.calls[0].opts.cwd).toBe(process.cwd());
    // I3：环境不额外加工——不传 env 字段即继承调用者进程环境。
    expect(d.calls[0].opts.env).toBeUndefined();
  });

  it("参数原样透传：- 开头选项、-- 分隔符、含空格路径", async () => {
    const args = ["visualize", "--port", "3939", "--", "weird path/with space"];
    const d = deps({ args });
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].argv.slice(1)).toEqual(args);
  });

  it("退出码透明转发", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("close", 3, null);
    expect(await p).toBe(3);
  });

  it("被信号终结（code null）返回 1", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("close", null, "SIGTERM");
    expect(await p).toBe(1);
  });

  it("解析失败：返回 1 且打印可操作提示（含 owl install / owl warm）", async () => {
    const d = deps({
      resolveRuntime: async () => { throw new OpenwikiNotFoundError("boom"); },
    });
    expect(await runOpenwikiCli(d.base)).toBe(1);
    expect(d.calls.length).toBe(0);
    expect(d.logs.text()).toContain("owl install");
    expect(d.logs.text()).toContain("owl warm");
  });

  it("解析抛未知错误同样软着陆：返回 1 不抛出", async () => {
    const d = deps({ resolveRuntime: async () => { throw new Error("unexpected"); } });
    expect(await runOpenwikiCli(d.base)).toBe(1);
    expect(d.logs.text()).toContain("unexpected");
  });

  it("spawn 失败（error 事件）：返回 1 且打印可操作提示，不是裸栈", async () => {
    // 入口文件在解析与 spawn 之间被删/被锁（并发 update、Defender 扫描）时
    // Node 会 emit 'error'；无监听器就是未捕获异常，用户拿到栈而不是提示。
    const d = deps();
    const p = runOpenwikiCli(d.base);
    await flushed();
    d.child.emit("error", Object.assign(new Error("spawn openwiki ENOENT"), { code: "ENOENT" }));
    expect(await p).toBe(1);
    expect(d.logs.text()).toContain("启动 openwiki 失败");
    expect(d.logs.text()).toContain("owl install");
  });
});

describe("owl ow 子命令分发", () => {
  it("main(['ow', ...]) 透传给 runOpenwikiCli，参数原样", async () => {
    const logs = collectLogger();
    const seen = [];
    const code = await main(["ow", "visualize", "--no-open"], {
      logger: logs.logger,
      runOpenwikiCliFn: async ({ args }) => { seen.push(...args); return 0; },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["visualize", "--no-open"]);
  });

  it("main(['ow']) 透传空参数（进入 openwiki 交互界面路径）", async () => {
    const logs = collectLogger();
    let called = false;
    const code = await main(["ow"], {
      logger: logs.logger,
      runOpenwikiCliFn: async ({ args }) => { called = true; expect(args).toEqual([]); return 0; },
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
  });
});
