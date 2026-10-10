import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOSTS, CLI_PROBES, isOnPath, shortestAlias } from "./registry.mjs";
import { installSkill } from "./skill-install.mjs";
import { planInstall } from "./plan.mjs";
import { spliceJsonEntry, upsertTomlBlock } from "./mcp-config.mjs";
import { createBackup, rollbackAll } from "./backup.mjs";
import {
  resolveScope, resolveTargets, collectDetectSnapshot, collectNativeSnapshot, collectMcpSnapshot,
} from "./targets.mjs";

/**
 * 安装编排：检测 → 计划 → 执行 → 回滚 → 报告。
 *
 * 决策全在 planInstall（纯函数）里，这里只负责按表执行与善后。
 * 顺序上有一条硬要求：**所有检测必须在本模块写任何文件之前算完** ——
 * 否则 Codex 安装产生的 `.agents/` 目录会让 Antigravity 被误判成已安装。
 */

const ENTRY_KEY = "openwiki";

/**
 * 列出全部可用的宿主 id，供「未知宿主」错误信息使用。
 *
 * @param {object[]} hosts
 * @returns {string[]}
 */
function availableIds(hosts) {
  return hosts.map((h) => h.id).sort();
}

/**
 * 检测落空时扫 PATH，给出可直接复制的 --tool 命令。
 *
 * 只提示不执行：IDE 装在应用目录里 PATH 上探不到，自动安装等于猜。
 *
 * @param {{ logger: object, env: object, platform: string, exists?: (p: string) => boolean }} deps
 */
function suggestFromPath({ logger, env, platform, exists }) {
  let any = false;
  for (const [id, bins] of Object.entries(CLI_PROBES)) {
    if (isOnPath(bins[0], { platform, env, exists })) {
      any = true;
      logger.info(`  检测到 PATH 上有 ${bins[0]}，可以试：openwiki-launcher --tool ${shortestAlias(id)}`);
    }
  }
  if (!any) {
    logger.info("  没有在 PATH 上发现已知的宿主 CLI。可用 --tool <id> 显式指定，id 列表：");
    logger.info(`  ${availableIds(HOSTS).join(", ")}`);
  }
}

/**
 * 执行一次安装。
 *
 * @param {object} deps
 * @returns {{ exitCode: 0 | 1 | 2, report: object[], guardedCount: number, skippedNoHost: boolean }}
 */
export function runInstall(deps) {
  const {
    logger, tool, global: isGlobal = false, force = false, noTakeover = false, bootstrap = false,
    nodeCommand, selfBin, launcherVersion, bundleDir,
  } = deps;

  const hosts = deps.hosts ?? HOSTS;
  const cwd = deps.cwdOverride ?? deps.cwd;
  const platform = deps.platform ?? process.platform;

  // ---- 未知宿主：在任何写入之前拒绝 ----
  const explicitTargets = resolveTargets({ tool, hosts });
  if (tool && !explicitTargets) {
    logger.error(`未知宿主: ${tool}`);
    logger.error(`可用的 id: ${availableIds(hosts).join(", ")}`);
    return { exitCode: 1, report: [], guardedCount: 0, skippedNoHost: false };
  }

  const { scope, baseDir } = resolveScope({ global: isGlobal, cwd, homeDir: deps.homeDir });

  // ---- 一次性算完三张快照，之后才允许写 ----
  const detectSnapshot = deps.detectSnapshotOverride
    ?? collectDetectSnapshot(hosts, { scope, baseDir, exists: deps.exists });
  const nativeSnapshot = collectNativeSnapshot(hosts, { scope, baseDir, platform, exists: deps.exists });
  const mcpSnapshot = collectMcpSnapshot(hosts, { scope, baseDir, platform, exists: deps.exists });

  const plan = planInstall({
    hosts, scope, baseDir, homeDir: deps.homeDir,
    targets: explicitTargets, detectSnapshot, nativeSnapshot, mcpSnapshot,
    nodeCommand, selfBin, launcherVersion,
    flags: { force, noTakeover },
    platform, tmpdir: deps.tmpdir, systemRoots: deps.systemRoots,
  });

  // ---- 护栏：任一被拒则整体中止，零写入 ----
  const guarded = plan.entries.filter((e) => e.guarded);
  if (guarded.length > 0) {
    logger.error("安装被护栏拒绝，本次没有写入任何文件：");
    for (const e of guarded) logger.error(`  ${e.displayName}: ${e.guardReason}`);
    return {
      exitCode: 2,
      report: plan.entries.map((e) => ({ hostId: e.hostId, wrote: false, skill: e.skill, mcp: e.mcp })),
      guardedCount: guarded.length,
      skippedNoHost: false,
    };
  }

  if (plan.skippedNoHost) {
    logger.info("没有检测到已安装的宿主。");
    suggestFromPath({ logger, env: deps.env ?? {}, platform, exists: deps.exists });
    return { exitCode: 1, report: [], guardedCount: 0, skippedNoHost: true };
  }

  // ---- 执行 ----
  /** @type {Array<{realPath: string, backupPath: string, existed: boolean}>} */
  const backups = [];
  /** @type {string[]} */
  const createdSkillDirs = [];
  const report = [];
  let failed = false;

  for (const e of plan.entries) {
    const row = {
      hostId: e.hostId, displayName: e.displayName, wrote: false,
      takeoverReason: e.takeoverReason,
      skill: { action: e.skill.action, dir: e.skill.dir, reason: e.skill.reason },
      mcp: { action: e.mcp.action, path: e.mcp.path, reason: e.mcp.reason },
    };

    // plan 已判定为 error 的条目（配置文件畸形等）必须让整次安装算失败：
    // 不写它不等于这次安装成功，用户需要看到非零退出码与可读原因。
    if (e.mcp.action === "error") {
      row.mcp.action = "error";
      row.mcp.reason = e.mcp.reason;
      logger.error(`${e.displayName}: MCP 配置无法处理，已保留原文件未改动 —— ${e.mcp.reason}`);
      failed = true;
      report.push(row);
      continue;
    }

    if (e.skill.action === "install") {
      try {
        installSkill({
          bundleDir, targetDir: e.skill.dir, hostId: e.hostId, scope,
          mcpCommand: { command: nodeCommand.command, args: [selfBin, "mcp", "--host", e.hostId] },
          launcherVersion, logger, takeover: e.takeover && e.takeoverReason === "native-receipt",
        });
        createdSkillDirs.push(e.skill.dir);
        row.skill.action = "installed";
      } catch (error) {
        row.skill.action = "error";
        row.skill.reason = error.message;
        failed = true;
      }
    } else {
      logger.info(`${e.displayName}: 跳过 skill（${e.skill.reason}）`);
    }

    if (["created", "updated"].includes(e.mcp.action)) {
      try {
        const backup = createBackup(e.mcp.path, path.dirname(e.mcp.path), deps.now);
        backups.push(backup);
        const next = e.mcp.kind === "codex-toml"
          ? upsertTomlBlock(mcpSnapshot[e.hostId].text, {
            tableName: `${e.mcp.containerKey}.${ENTRY_KEY}`, block: e.mcp.tomlBlock,
          }).text
          : spliceJsonEntry(mcpSnapshot[e.hostId].text, {
            containerKey: e.mcp.containerKey,
            entryKey: ENTRY_KEY,
            entryJson: e.mcp.entryJson,
            allowComments: e.mcp.kind === "opencode-json",
          }).text;
        mkdirSync(path.dirname(e.mcp.path), { recursive: true });
        writeFileSync(e.mcp.path, next, "utf8");
      } catch (error) {
        row.mcp.action = "error";
        row.mcp.reason = error.message;
        failed = true;
      }
    }

    row.wrote = row.skill.action === "installed" || ["created", "updated"].includes(row.mcp.action);
    report.push(row);
  }

  // ---- 失败：回滚，且失败目标的错误与其他宿主的结果同时可见 ----
  if (failed) {
    try {
      rollbackAll(backups);
      for (const dir of createdSkillDirs) rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      logger.error(`回滚过程中出错: ${error.message}`);
    }
    logger.error("安装失败，已回滚本次写入的内容。逐家结果：");
    for (const row of report) {
      logger.info(`  ${row.hostId}: skill=${row.skill.action} mcp=${row.mcp.action}`
        + `${row.skill.reason ? ` (${row.skill.reason})` : ""}`
        + `${row.mcp.reason ? ` (${row.mcp.reason})` : ""}`);
    }
    return { exitCode: 1, report, guardedCount: 0, skippedNoHost: false };
  }

  // ---- 报告 ----
  for (const row of report) {
    logger.info(`${row.displayName}:`);
    if (row.skill.action === "installed") logger.info(`  skill -> ${row.skill.dir}`);
    if (row.takeoverReason) {
      logger.info(row.takeoverReason === "native-receipt"
        ? `  已接管 openwiki 原生安装（删除原生收据并改写为 launcher 收据）`
        : `  已接管该宿主里已存在的 openwiki MCP 条目（原条目不是本安装器写入的）`);
    }
    if (row.mcp.action === "created" || row.mcp.action === "updated") {
      logger.info(`  MCP -> ${row.mcp.path}`);
    }
    if (row.mcp.action === "manual") {
      logger.info("  该宿主的 MCP 配置需要在宿主界面里手动添加，请把下面这段放进它的 MCP 设置：");
      logger.info(JSON.stringify({
        mcpServers: { [ENTRY_KEY]: { type: "stdio", command: nodeCommand.command, args: [selfBin, "mcp", "--host", row.hostId] } },
      }, null, 2));
    }
    if (row.mcp.action === "none") {
      logger.info("  该宿主没有 MCP 客户端能力，只安装 skill；openwiki 的 SKILL.md 自带降级路径。");
    }
  }

  if (plan.nodeWarning) logger.warn(plan.nodeWarning);
  if (bootstrap) logger.info("引导文件（--bootstrap）在 0.2.0 未启用，本次只安装 skill 与 MCP 配置。");
  logger.info("下一步可运行 `openwiki-launcher warm` 预热后端，让第一次工具调用更快。");
  if (platform === "win32") {
    logger.info("Windows 上建议把 Node 与 openwiki 依赖目录加入 Microsoft Defender 排除项，冷启动会快很多。");
  }

  return { exitCode: 0, report, guardedCount: 0, skippedNoHost: false };
}
