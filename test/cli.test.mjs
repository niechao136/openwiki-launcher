import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.mjs";

function createCapture() {
  const lines = [];
  const logger = {
    info: (message) => lines.push(message),
    debug: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
  return { lines, logger };
}

const HELP_LINE = "openwiki-launcher mcp [--host <id>]";

describe("main", () => {
  it("rejects an invalid host identifier", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["mcp", "--host", "Bad_Host"], { logger });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("1-64 lowercase letters, digits, or hyphens");
  });

  it("points at the next release for install, which ships with the installer", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["install", "--tool", "codebuddy"], { logger });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("0.2.0");
  });

  it("runs warm against a fake backend and reports readiness", async () => {
    const { lines, logger } = createCapture();
    const fake = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "fake-openwiki.mjs",
    );

    const code = await main(["warm"], { logger, env: { LAUNCHER_BACKEND_CLI: fake } });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("后端就绪");
  }, 30000);

  it("returns 1 from doctor when openwiki cannot be resolved", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["doctor"], {
      logger,
      resolveRuntime: async () => {
        throw new Error("未找到 openwiki 依赖");
      },
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未找到");
  });

  it("prints usage for an unknown command", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["frobnicate"], { logger });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("用法");
  });

  it("prints usage on request", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["help"], { logger });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(HELP_LINE);
  });

  it("prints the package version", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["version"], { logger });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("0.1.0");
  });

  it("refuses to run on an unsupported Node version", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["mcp", "--host", "codebuddy"], {
      logger,
      nodeVersion: "20.0.0",
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("22.22.0");
  });
});
