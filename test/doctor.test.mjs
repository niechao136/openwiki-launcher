import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/manifest.mjs";
import { runDoctorCommand } from "../src/commands/doctor.mjs";

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
