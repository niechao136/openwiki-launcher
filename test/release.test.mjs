import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lists the files npm would publish.
 *
 * @returns {string[]} Repo-relative paths in the tarball.
 */
function packedFiles() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(raw);
  return parsed[0].files.map((file) => file.path.replace(/\\/g, "/"));
}

describe("published package contents", () => {
  it("ships the runtime, the snapshot and the docs", () => {
    const files = packedFiles();

    for (const required of [
      "bin/openwiki-launcher.mjs",
      "src/broker.mjs",
      "src/backend.mjs",
      "manifest/openwiki-0.6.0.json",
      "scripts/gen-manifest.mjs",
      "package.json",
      "README.md",
      "LICENSE",
    ]) {
      expect(files).toContain(required);
    }
  }, 120000);

  it("keeps tests and dependencies out of the tarball", () => {
    const files = packedFiles();

    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
  }, 120000);

  it("ships every installer module the runtime needs", () => {
    const files = packedFiles();
    const required = [
      "bin/openwiki-launcher.mjs",
      "src/registry.mjs",
      "src/targets.mjs",
      "src/plan.mjs",
      "src/install.mjs",
      "src/uninstall.mjs",
      "src/mcp-config.mjs",
      "src/skill-install.mjs",
      "src/backup.mjs",
      "src/self-path.mjs",
      "src/guards.mjs",
      "src/commands/install.mjs",
      "manifest/openwiki-0.6.0.json",
    ];
    for (const file of required) {
      expect(files, `缺少 ${file}`).toContain(file);
    }
  }, 120000);
});
