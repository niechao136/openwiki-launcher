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

  it("points at the next release for warm and doctor until task 7 wires them", async () => {
    const { lines, logger } = createCapture();

    expect(await main(["warm"], { logger })).toBe(1);
    expect(await main(["doctor"], { logger })).toBe(1);
    expect(lines.join("\n")).toContain("0.2.0");
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
