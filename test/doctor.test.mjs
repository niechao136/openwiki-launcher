import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runDoctorCommand, installedEntryMatches } from "../src/commands/doctor.mjs";
import { NODE, SELF_BIN, collectLogger } from "./helpers.mjs";

const RUNTIME = { packageRoot: "root", version: "0.6.0", cliJs: "/abs/cli.js" };

function capture() {
  const lines = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      debug: () => {},
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  };
}

function supervisorWith(tools) {
  return () => ({
    ensureReady: async () => ({
      request: async (method) => {
        if (method === "tools/list") return { tools };
        return {};
      },
    }),
    stop: () => {},
  });
}

describe("runDoctorCommand", () => {
  it("passes every check when runtime, manifest and backend agree", async () => {
    const { lines, logger } = capture();
    const manifest = loadManifest("0.6.0");

    const code = await runDoctorCommand({
      logger,
      nodeVersion: "24.21.0",
      resolveRuntime: async () => RUNTIME,
      createSupervisor: supervisorWith(manifest.tools),
    });

    const output = lines.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("✓ Node.js 24.21.0");
    expect(output).toContain("✓ openwiki 0.6.0");
    expect(output).toContain("✓ manifest");
    expect(output).toContain("✓ 工具清单一致");
  });

  it("keeps exit code 0 but tells the user how to record a missing snapshot", async () => {
    const { lines, logger } = capture();

    const code = await runDoctorCommand({
      logger,
      nodeVersion: "24.21.0",
      resolveRuntime: async () => ({ ...RUNTIME, version: "9.9.9" }),
      createSupervisor: supervisorWith([{ name: "echo_a" }]),
    });

    const output = lines.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("manifest: 未找到 openwiki-9.9.9.json");
    expect(output).toContain("npm run manifest");
  });

  it("lists added and removed tools when the snapshot drifted", async () => {
    const { lines, logger } = capture();

    const code = await runDoctorCommand({
      logger,
      nodeVersion: "24.21.0",
      resolveRuntime: async () => RUNTIME,
      createSupervisor: supervisorWith([{ name: "echo_a" }, { name: "echo_b" }]),
    });

    const output = lines.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("+ echo_b");
    expect(output).toContain("- openwiki_read");
    expect(output).toContain("需要更新 manifest");
  });

  it("returns 1 when openwiki cannot be resolved", async () => {
    const { lines, logger } = capture();

    const code = await runDoctorCommand({
      logger,
      nodeVersion: "24.21.0",
      resolveRuntime: async () => {
        throw new Error("未找到 openwiki 依赖");
      },
      createSupervisor: () => {
        throw new Error("must not be called");
      },
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未找到");
  });

  it("flags an unsupported Node version", async () => {
    const { lines, logger } = capture();

    const code = await runDoctorCommand({
      logger,
      nodeVersion: "20.0.0",
      resolveRuntime: async () => RUNTIME,
      createSupervisor: supervisorWith([]),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("22.22.0");
  });
});

describe("doctor 的 openwiki 版本核对读声明，而不是读一个写死的常量", () => {
  // 曾经的 bug：checkOpenwikiPin 里写死了 "0.6.0"。规格 6 把「doctor 是 openwiki
  // 升级后的一条命令核对流程」写成产品承诺，而写死的常量在第一次升版就让这个承诺失效
  // —— 它会永远报「与锁定的 0.6.0 不符」，用户从此不再相信 doctor 的任何结论。
  const check = async (declaredOpenwiki) => {
    const { lines, logger } = collectLogger();
    const code = await runDoctorCommand({
      logger, nodeVersion: "24.21.0",
      resolveRuntime: async () => RUNTIME,
      createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
      declaredOpenwiki,
    });
    return { code, out: lines.join("\n") };
  };

  it("声明被注入时逐字报出声明的版本，说明结论来自声明而非常量", async () => {
    const { out } = await check("1.2.3");
    expect(out).toContain("1.2.3");
    expect(out).toContain("不符");
  });

  it("不注入时取本包 package.json 的声明，一致则报通过", async () => {
    const { code, out } = await check(undefined);
    expect(code).toBe(0);
    expect(out).toMatch(/✓ openwiki 依赖与锁定版本一致（\d+\.\d+\.\d+[^）]*）/);
  });

  it("声明是范围时跳过核对，而不是拿范围当版本去比", async () => {
    const { code, out } = await check("^0.6.0");
    expect(code).toBe(0);
    expect(out).toContain("范围");
    expect(out).toContain("跳过");
    expect(out).not.toContain("不符");
  });
});

describe("doctor 的安装配置核对（新增两项）", () => {
  /** 造一个装好 claude 的临时项目目录。 */
  function installedProject({ command = NODE, args = [SELF_BIN, "mcp", "--host", "claude"] } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ow-doc-"));
    mkdirSync(join(root, ".claude/skills/openwiki"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/openwiki/.openwiki-launcher.json"),
      JSON.stringify({ package: "openwiki-launcher", version: "0.2.0", target: "claude",
        scope: "project", files: {} }), "utf8");
    writeFileSync(join(root, ".mcp.json"),
      `{"mcpServers":{"other":{"command":"x"},"openwiki":${JSON.stringify({ command, args })}}}\n`, "utf8");
    return root;
  }

  it("MCP 命令指向当前 node 与本安装器时报通过", async () => {
    const root = installedProject();
    try {
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0", resolveRuntime: async () => RUNTIME,
        createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
        scope: "project", baseDir: root, homeDir: root,
        nodeCommand: { command: NODE, warning: null }, selfBin: SELF_BIN,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("✓ MCP 命令指向当前 node 与本安装器");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("MCP 命令指向别处时逐条指出并提示重跑 install", async () => {
    const root = installedProject({ command: "/old/node", args: ["/old/bin.mjs", "mcp", "--host", "claude"] });
    try {
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0", resolveRuntime: async () => RUNTIME,
        createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
        scope: "project", baseDir: root, homeDir: root,
        nodeCommand: { command: NODE, warning: null }, selfBin: SELF_BIN,
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("claude");
      expect(out).toContain("/old/node");
      expect(out).toContain("重新运行 install");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("依赖的 openwiki 版本与 package.json 锁定的不符时告警", async () => {
    const { lines, logger } = collectLogger();
    const code = await runDoctorCommand({
      logger, nodeVersion: "24.21.0",
      resolveRuntime: async () => ({ ...RUNTIME, version: "0.6.1" }),
      createSupervisor: supervisorWith([]),
      scope: "project", baseDir: mkdtempSync(join(tmpdir(), "ow-doc-b-")), homeDir: "/home/u",
      nodeCommand: { command: NODE, warning: null }, selfBin: SELF_BIN,
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("0.6.1");
    expect(out).toContain("不符");
  });

  it("未安装任何宿主时这两项静默跳过，不报错", async () => {
    const { lines, logger } = collectLogger();
    const code = await runDoctorCommand({
      logger, nodeVersion: "24.21.0", resolveRuntime: async () => RUNTIME,
      createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
      scope: "project", baseDir: mkdtempSync(join(tmpdir(), "ow-doc-c-")), homeDir: "/home/u",
      nodeCommand: { command: NODE, warning: null }, selfBin: SELF_BIN,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("重新运行 install");
  });
});

describe("doctor 的版本指针与全局安装提示", () => {
  function tempPkgRoot() {
    return mkdtempSync(join(tmpdir(), "ow-doc-p-"));
  }

  it("指针生效时展示指针与来源，并跳过 package.json 锁版核对", async () => {
    // 指针把运行时切到 0.7.0 而 package.json 仍锁 0.6.0——这是合法的指针切换，
    // 不是「安装来源被污染」。拿锁版去报「不符」的 doctor 会在第一次 switch 后
    // 开始永远误报，用户从此不再相信它的任何结论。
    const root = tempPkgRoot();
    try {
      mkdirSync(join(root, "versions"), { recursive: true });
      writeFileSync(join(root, "versions", "active.json"), JSON.stringify({ version: "0.7.0" }));
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0",
        resolveRuntime: async () => ({ ...RUNTIME, version: "0.7.0", source: "versions" }),
        createSupervisor: supervisorWith([]),
        pkgRoot: root,
        resolveGlobalRoot: async () => null,
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("✓ 版本指针：0.7.0（versions）");
      expect(out).not.toContain("不符，请检查安装来源");
      expect(out).toContain("跳过");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("指针损坏时报出损坏与修复方式，并说明已回退出厂依赖", async () => {
    const root = tempPkgRoot();
    try {
      mkdirSync(join(root, "versions"), { recursive: true });
      writeFileSync(join(root, "versions", "active.json"), "not json");
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0",
        resolveRuntime: async () => ({ ...RUNTIME, source: "bundled" }),
        createSupervisor: supervisorWith([]),
        pkgRoot: root,
        resolveGlobalRoot: async () => null,
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("版本指针损坏");
      expect(out).toContain("switch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("无指针时说明使用出厂依赖", async () => {
    const root = tempPkgRoot();
    try {
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0",
        resolveRuntime: async () => ({ ...RUNTIME, source: "bundled" }),
        createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
        pkgRoot: root,
        resolveGlobalRoot: async () => null,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("✓ 版本指针：未设置，使用出厂依赖（bundled）");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("检测到全局 openwiki 时明确告知 launcher 不使用它", async () => {
    const root = tempPkgRoot();
    const globalRoot = tempPkgRoot();
    try {
      mkdirSync(join(globalRoot, "openwiki"), { recursive: true });
      writeFileSync(join(globalRoot, "openwiki", "package.json"), "{}");
      const { lines, logger } = collectLogger();
      const code = await runDoctorCommand({
        logger, nodeVersion: "24.21.0",
        resolveRuntime: async () => ({ ...RUNTIME, source: "bundled" }),
        createSupervisor: supervisorWith(loadManifest("0.6.0").tools),
        pkgRoot: root,
        resolveGlobalRoot: async () => globalRoot,
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("检测到全局 openwiki");
      expect(out).toContain("launcher 不使用它");
      expect(out).toContain("check/update/switch");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});

describe("installedEntryMatches", () => {
  const nodeCommand = { command: "D:\\Hub\\node\\node.exe", warning: null };
  const selfBin = "D:\\Hub\\launcher\\bin\\openwiki-launcher.mjs";

  it("win32 下路径大小写与斜杠写法不同也算指向当前环境", () => {
    // 与 ownership.isOursEntry 同一个坑：逐字符比较会让 doctor 把自己刚写好的条目
    // 报成「请重新运行 install」，用户照做也消不掉，误报循环。
    const entry = { command: "d:/hub/node/node.exe", args: ["d:\\HUB\\LAUNCHER\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"] };
    expect(installedEntryMatches(entry, nodeCommand, selfBin, "win32")).toBe(true);
  });

  it("opencode 的数组形态（command 合并 node 与 args）也认", () => {
    const entry = { command: ["d:\\hub\\node\\node.exe", "d:\\hub\\launcher\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"] };
    expect(installedEntryMatches(entry, nodeCommand, selfBin, "win32")).toBe(true);
  });

  it("linux 上大小写不同就是不同路径", () => {
    const entry = { command: nodeCommand.command, args: ["d:\\hub\\launcher\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"] };
    expect(installedEntryMatches(entry, nodeCommand, selfBin, "linux")).toBe(false);
  });

  it("指向别处或缺字段时不算匹配", () => {
    expect(installedEntryMatches(
      { command: "/old/node", args: [selfBin, "mcp", "--host", "claude"] },
      nodeCommand, selfBin, "win32",
    )).toBe(false);
    expect(installedEntryMatches({ command: nodeCommand.command }, nodeCommand, selfBin, "win32")).toBe(false);
    expect(installedEntryMatches(null, nodeCommand, selfBin, "win32")).toBe(false);
  });
});
