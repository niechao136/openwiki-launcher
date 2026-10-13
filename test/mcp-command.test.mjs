import { describe, expect, it } from "vitest";
import { queueTimeoutFromEnv } from "../src/commands/mcp.mjs";

describe("queueTimeoutFromEnv", () => {
  it("defaults to 25000 when the variable is absent", () => {
    expect(queueTimeoutFromEnv({})).toBe(25000);
  });

  it("parses a valid override", () => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: "40000" })).toBe(40000);
  });

  it.each(["abc", "0", "-5", ""])("falls back to 25000 for %j", (value) => {
    expect(queueTimeoutFromEnv({ LAUNCHER_QUEUE_TIMEOUT_MS: value })).toBe(25000);
  });
});
