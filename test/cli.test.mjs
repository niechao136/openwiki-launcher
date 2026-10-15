import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.mjs";
import { readActive, versionDir, writeActiveAtomic } from "../src/versions.mjs";

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

const HELP_LINE = "owl mcp [--host <id>]";

describe("main", () => {
  it("rejects an invalid host identifier", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["mcp", "--host", "Bad_Host"], { logger });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("1-64 lowercase letters, digits, or hyphens");
  });

  it("no longer defers install to a later release", async () => {
    // 0.2.0 起 install 已实现（见 docs/specs/2026-10-10-openwiki-launcher-installer-design.md）。
    // 接线与参数解析的完整覆盖在 test/cli-install.test.mjs，这里只守住「不再打占位文案」。
    const { lines, logger } = createCapture();

    const code = await main(["install", "--frobnicate"], { logger });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("无法识别的参数");
    expect(lines.join("\n")).not.toContain("将在 openwiki-launcher 0.2.0 提供");
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

  it("help 说明别名与 ow 透传入口", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["--help"], { logger });

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("owl");
    expect(out).toContain("ow");
    expect(out).toContain("透传");
  });

  it("routes check to the check command", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["check"], {
      logger,
      resolveRuntime: async () => ({ version: "0.6.0", source: "bundled", cliJs: "/fake/cli.js" }),
      runNpm: async () => ({ code: 0, stdout: '["0.6.0"]', stderr: "" }),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("当前生效版本");
  });

  it("routes update and forwards --version", async () => {
    const { lines, logger } = createCapture();
    const root = mkdtempSync(path.join(tmpdir(), "ow-cli-update-"));
    const calls = [];
    try {
      const code = await main(["update", "--version", "0.6.3"], {
        logger,
        pkgRoot: root,
        runNpm: async (args) => {
          calls.push(args);
          // 成功时必须种出可解析的入口树：安装内核会在入库前校验入口与版本号。
          if (args[0] === "install") {
            const pkg = path.join(args[args.indexOf("--prefix") + 1], "node_modules", "openwiki");
            mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
            writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: args[1].replace(/^openwiki@/, "") }));
            writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        confirm: async () => true,
        resolveRuntime: async () => ({ version: "0.6.0", source: "bundled", cliJs: "/fake/cli.js" }),
        writeSnapshot: async () => ({
          openwikiVersion: "0.6.3",
          protocolVersion: "2024-11-05",
          tools: [{ name: "openwiki_a" }],
        }),
      });

      expect(code).toBe(0);
      expect(calls.find((args) => args[0] === "install")).toContain("openwiki@0.6.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes switch with its version argument", async () => {
    const { lines, logger } = createCapture();
    const root = mkdtempSync(path.join(tmpdir(), "ow-cli-switch-"));
    try {
      const pkg = path.join(versionDir(root, "0.6.0"), "node_modules", "openwiki");
      mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.6.0" }));
      writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
      writeActiveAtomic(root, "0.7.0");

      const code = await main(["switch", "0.6.0"], {
        logger,
        pkgRoot: root,
        resolveRuntime: async () => ({ version: "0.7.0", source: "versions", cliJs: "/fake/cli.js" }),
      });

      expect(code).toBe(0);
      expect(readActive(root).version).toBe("0.6.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects switch without a version", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["switch"], { logger, pkgRoot: mkdtempSync(path.join(tmpdir(), "ow-cli-switch-b-")) });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("x.y.z");
  });

  it("routes versions remove", async () => {
    const { lines, logger } = createCapture();
    const root = mkdtempSync(path.join(tmpdir(), "ow-cli-versions-"));
    try {
      for (const version of ["0.6.0", "0.7.0"]) {
        const pkg = path.join(versionDir(root, version), "node_modules", "openwiki");
        mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
        writeFileSync(path.join(pkg, "dist", "cli", "cli.js"), "// entry");
      }
      writeActiveAtomic(root, "0.7.0");

      const code = await main(["versions", "remove", "0.6.0"], { logger, pkgRoot: root });

      expect(code).toBe(0);
      expect(existsSync(versionDir(root, "0.6.0"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the version command for the launcher itself", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["--version"], { logger });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("openwiki-launcher ");
  });

  it("help lists the four new commands", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["help"], { logger });

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("check");
    expect(out).toContain("update");
    expect(out).toContain("switch");
    expect(out).toContain("versions remove");
  });

  it("prints the package version", async () => {
    const { lines, logger } = createCapture();

    const code = await main(["version"], { logger });

    expect(code).toBe(0);
    // 不写死版本号：0.2.0 起实现了安装器，改版本时这条测试不该红。
    // 断言的是「输出的版本与 package.json 一致」这个不变量。
    expect(lines.join("\n")).toContain(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    );
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
