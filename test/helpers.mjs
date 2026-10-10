import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 测试公用件。
 *
 * 任务 7/8/9/10 都要「临时目录 + 收集日志的 logger + 固定的 node/bin 路径」这三样，
 * 各自重复一遍只会让同一个常量在五个文件里各写一次，改一处漏四处。
 */

/** skill bundle 夹具（白名单内的干净版本）。 */
export const BUNDLE = fileURLToPath(new URL("./fixtures/bundle/", import.meta.url));

/** 装出来的 MCP 配置里 args[0] 指向的 launcher bin。 */
export const SELF_BIN = "/abs/bin/openwiki-launcher.mjs";

/** 装出来的 MCP 配置里 command 指向的 node。 */
export const NODE = "/abs/node";

/**
 * 建一个临时目录。
 *
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 删掉临时目录。测试的 afterEach 用。
 *
 * @param {string} dir
 */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 收集日志的 logger。断言用 `text()` 拿全部内容。
 *
 * @returns {{ lines: string[], text(): string, logger: object }}
 */
export function collectLogger() {
  const lines = [];
  return {
    lines,
    text: () => lines.join("\n"),
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
      debug: () => {},
    },
  };
}

/**
 * install / uninstall 编排函数的默认依赖。
 *
 * 刻意把 systemRoots 设成与 platform 无关的固定值并让 tmpdir 指向 home ——
 * 这样任何「本机真实路径」都不会意外触发护栏，用例只测它自己声明的场景。
 *
 * @param {{ logger: object, cwd: string, homeDir: string, platform?: string,
 *           env?: object, selfBin?: string, nodeCommand?: object }} options
 * @returns {object}
 */
export function baseDeps(options) {
  const platform = options.platform ?? "linux";
  return {
    logger: options.logger,
    cwd: options.cwd,
    homeDir: options.homeDir,
    platform,
    env: options.env ?? {},
    tmpdir: options.homeDir,
    systemRoots: ["/__never_a_system_root__"],
    selfBin: options.selfBin ?? SELF_BIN,
    nodeCommand: options.nodeCommand ?? { command: NODE, warning: null },
    launcherVersion: "0.2.0",
    bundleDir: BUNDLE,
    now: () => new Date("2026-10-10T00:00:00Z"),
  };
}
