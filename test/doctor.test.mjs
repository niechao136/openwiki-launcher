import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runDoctorCommand } from "../src/commands/doctor.mjs";
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
