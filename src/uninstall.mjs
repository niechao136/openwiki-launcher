import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOSTS } from "./registry.mjs";
import { removeSkill, readReceipt } from "./skill-install.mjs";
import { readJsonEntry, spliceJsonEntry, removeTomlBlock, readTomlBlock } from "./mcp-config.mjs";
import { createBackup, rollbackAll } from "./backup.mjs";
import { skillsDirFor, isOursEntry } from "./ownership.mjs";
import {
  resolveScope, resolveTargets, collectDetectSnapshot, collectMcpSnapshot,
} from "./targets.mjs";

/**
 * 卸载：与 install 共用作用域与目标解析，动作表相反。
 *
 * 两条硬规则：
 *   1. **只删自己写过的东西。** skill 目录要收据 + 逐文件 sha256 全匹配才删；
 *      MCP 条目要 command 指向本安装器的 bin 才删。用户手改过的、或者指向别处的，
 *      一律跳过并说清楚为什么跳过。
 *   2. **不做「顺手清理」。** 不删备份文件、不删用户目录、不动其他 server 的条目。
 */

const ENTRY_KEY = "openwiki";

/**
 * 执行一次卸载。
 *
 * @param {object} deps
 * @returns {{ exitCode: 0 | 1 | 2, report: object[], guardedCount: number, skippedNoHost: boolean }}
 */
export function runUninstall(deps) {
  const { logger, tool, global: isGlobal = false } = deps;
  const hosts = deps.hosts ?? HOSTS;
  const cwd = deps.cwdOverride ?? deps.cwd;
  const platform = deps.platform ?? process.platform;
  const nodeCommand = deps.nodeCommand ?? { command: "", warning: null };

  const explicitTargets = resolveTargets({ tool, hosts });
  if (tool && !explicitTargets) {
    logger.error(`未知宿主: ${tool}`);
    logger.error(`可用的 id: ${hosts.map((h) => h.id).sort().join(", ")}`);
    return { exitCode: 1, report: [], guardedCount: 0, skippedNoHost: false };
  }

  const { scope, baseDir } = resolveScope({ global: isGlobal, cwd, homeDir: deps.homeDir });

  // deps.exists 是 PATH 探测的 seam，不是文件系统抽象；快照一律用真实的 existsSync。
  const detectSnapshot = deps.detectSnapshotOverride
    ?? collectDetectSnapshot(hosts, { scope, baseDir });
  const chosen = explicitTargets ?? hosts.filter((h) => detectSnapshot[h.id] === true);

  if (chosen.length === 0) {
    logger.info("没有检测到已安装的宿主，没有可卸载的内容。");
    return { exitCode: 1, report: [], guardedCount: 0, skippedNoHost: true };
  }

  const mcpSnapshot = collectMcpSnapshot(hosts, { scope, baseDir, platform, read: deps.read });
  const impl = platform === "win32" ? path.win32 : path.posix;

  /** @type {Array<{realPath: string, backupPath: string, existed: boolean}>} */
  const backups = [];
  const report = [];
  let failed = false;

  for (const host of chosen) {
    const row = {
      hostId: host.id, displayName: host.displayName,
      skill: { action: "skip", reason: "missing" },
      mcp: { action: "skip", reason: "没有可自动写入的 MCP 配置" },
    };

    // ---- skill ----
    const relDir = skillsDirFor(host, { scope, platform });
    let skillDir = null;
    if (relDir) {
      skillDir = impl.join(baseDir, ...relDir.split("/"), "openwiki");
      // 传 hostId：多家宿主共用同一个 skills 目录时只移除本家的记录（I5）
      const result = removeSkill(skillDir, logger, { hostId: host.id });
      row.skill = result.removed
        ? { action: "removed", dir: skillDir }
        : { action: "skip", dir: skillDir, reason: result.reason };
    } else {
      row.skill = {
        action: "skip",
        reason: scope === "user" ? "该宿主没有全局技能目录" : (host.noProjectReason ?? "该宿主不支持项目级"),
      };
    }

    // 归属判断优先用收据里**当时写入**的命令，而不是当前的 node 路径 / bin 路径。
    // 用户升级 node 或换了全局 npm 前缀之后，当前路径已经变了，拿它比对会把
    // 「自己写的条目」判成「不是本安装器写入的」，于是 MCP 条目被留在配置里
    // 而退出码是 0 —— 用户永远删不掉它（I4）。
    const receipt = skillDir ? readReceipt(skillDir) : null;
    const mine = receipt?.mcpServerCommand
      ?? { command: nodeCommand.command, args: [deps.selfBin, "mcp", "--host", host.id] };

    // ---- MCP ----
    const mcp = host.mcp;
    const writable = mcp && ["json", "codex-toml", "opencode-json"].includes(mcp.kind);
    if (!writable) {
      report.push(row);
      continue;
    }

    const rel = scope === "user" ? mcp.userPath : mcp.projectPath;
    const cfgPath = impl.join(baseDir, ...rel.split("/"));
    const snapshot = mcpSnapshot[host.id] ?? { path: cfgPath, text: "", exists: false };

    try {
      const existing = mcp.kind === "codex-toml"
        ? (() => {
          const block = readTomlBlock(snapshot.text, { tableName: `${mcp.containerKey}.${ENTRY_KEY}` });
          if (block === null) return null;
          return { command: /command = "([^"]*)"/u.exec(block)?.[1] ?? "", args: block };
        })()
        : readJsonEntry(snapshot.text, {
          containerKey: mcp.containerKey,
          entryKey: ENTRY_KEY,
          allowComments: mcp.kind === "opencode-json",
        });

      const ours = isOursEntry(existing, mine, platform);

      if (!ours) {
        row.mcp = {
          action: "skip",
          reason: existing === null ? "配置里没有 openwiki 条目" : "该条目不是本安装器写入的，未触碰",
        };
      } else {
        const backup = createBackup(cfgPath, path.dirname(cfgPath), deps.now);
        backups.push(backup);
        const next = mcp.kind === "codex-toml"
          ? removeTomlBlock(snapshot.text, { tableName: `${mcp.containerKey}.${ENTRY_KEY}` }).text
          : spliceJsonEntry(snapshot.text, {
            containerKey: mcp.containerKey, entryKey: ENTRY_KEY, entryJson: null,
            allowComments: mcp.kind === "opencode-json",
          }).text;
        mkdirSync(path.dirname(cfgPath), { recursive: true });
        writeFileSync(cfgPath, next, "utf8");
        row.mcp = { action: "removed", path: cfgPath };
      }
    } catch (error) {
      row.mcp = { action: "error", path: cfgPath, reason: error.message };
      failed = true;
    }

    report.push(row);
  }

  if (failed) {
    try {
      rollbackAll(backups);
    } catch (error) {
      logger.error(`回滚过程中出错: ${error.message}`);
    }
    logger.error("卸载失败，已回滚本次写入的内容。逐家结果：");
    for (const row of report) {
      logger.info(`  ${row.hostId}: skill=${row.skill.action} mcp=${row.mcp.action}`
        + `${row.mcp.reason ? ` (${row.mcp.reason})` : ""}`);
    }
    return { exitCode: 1, report, guardedCount: 0, skippedNoHost: false };
  }

  for (const row of report) {
    logger.info(`${row.displayName}:`);
    if (row.skill.action === "removed") logger.info(`  已删除 skill -> ${row.skill.dir}`);
    else if (row.skill.reason) logger.info(`  skill 未删除: ${row.skill.reason}`);
    if (row.mcp.action === "removed") logger.info(`  已删除 MCP 条目 -> ${row.mcp.path}`);
    else if (row.mcp.reason) logger.info(`  MCP 未改动: ${row.mcp.reason}`);
  }
  logger.info("备份文件（形如 *.openwiki-launcher-backup-*）不会自动删除，确认无误后可自行清理。");

  return { exitCode: 0, report, guardedCount: 0, skippedNoHost: false };
}
