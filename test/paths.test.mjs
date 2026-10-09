import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenwikiRuntime } from "../src/paths.mjs";

describe("resolveOpenwikiRuntime", () => {
  it("resolves the pinned openwiki package and its CLI entry", async () => {
    const runtime = await resolveOpenwikiRuntime();

    expect(runtime.version).toBe("0.6.0");
    expect(existsSync(runtime.cliJs)).toBe(true);
    expect(runtime.cliJs.endsWith(path.join("openwiki", "dist", "cli", "cli.js"))).toBe(true);
  });

  it("reports the package root that contains package.json", async () => {
    const runtime = await resolveOpenwikiRuntime();

    expect(existsSync(path.join(runtime.packageRoot, "package.json"))).toBe(true);
  });
});
