import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("命令别名映射", () => {
  it("bin 三条目：openwiki-launcher 与 owl 同一入口，ow 独立入口", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin["openwiki-launcher"]).toBe("./bin/openwiki-launcher.mjs");
    expect(pkg.bin.owl).toBe("./bin/openwiki-launcher.mjs");
    expect(pkg.bin.ow).toBe("./bin/ow.mjs");
    for (const rel of ["./bin/openwiki-launcher.mjs", "./bin/ow.mjs"]) {
      expect(existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  it("bin/ow.mjs 以 runOpenwikiCli 收尾并转发退出码", () => {
    const src = readFileSync(path.join(ROOT, "bin/ow.mjs"), "utf8");
    expect(src).toContain("runOpenwikiCli");
    expect(src).toContain("process.exitCode");
    expect(src).toContain("process.argv.slice(2)");
  });
});
