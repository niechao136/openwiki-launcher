import { existsSync } from "node:fs";
import { createBackendSupervisor } from "../backend.mjs";
import { loadManifest } from "../manifest.mjs";
import { MIN_NODE, nodeVersionSupported } from "../node-version.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { HOSTS } from "../registry.mjs";
import { readJsonEntry, readTomlBlock } from "../mcp-config.mjs";
import { collectMcpSnapshot } from "../targets.mjs";

const ENTRY_KEY = "openwiki";
const AUTO_KINDS = ["json", "codex-toml", "opencode-json"];

/**
 * 读回某个宿主已写入的 MCP 条目。
 *
 * @param {object} host 注册表条目
 * @param {{path: string, text: string, exists: boolean}} snapshot
 * @returns {object | null} 条目值；不存在或读不出来时返回 null
 */
function readEntry(host, snapshot) {
  if (!snapshot || !snapshot.exists) return null;
  try {
    if (host.mcp.kind === "codex-toml") {
      const block = readTomlBlock(snapshot.text, { tableName: `${host.mcp.containerKey}.${ENTRY_KEY}` });
      if (block === null) return null;
      return { command: /command = "([^"]*)"/u.exec(block)?.[1] ?? "", args: block };
    }
    return readJsonEntry(snapshot.text, {
      containerKey: host.mcp.containerKey,
      entryKey: ENTRY_KEY,
      allowComments: host.mcp.kind === "opencode-json",
    });
  } catch {
    return null;
  }
}

/**
 * 核对已写入的 MCP 条目是否仍指向当前 node 与本安装器。
 *
 * node 升级后 process.execPath 会变，而配置里存的是旧绝对路径 —— 那时宿主只会报
 * 连接错误，原因（配置里的路径过期了）不在任何日志里。这项检查就是把它讲出来。
 *
 * @param {object} options
 */
function checkInstalledMcpCommands({ logger, scope, baseDir, platform, nodeCommand, selfBin }) {
  const snapshot = collectMcpSnapshot(HOSTS, { scope, baseDir, platform, exists: existsSync });
  /** @type {string[]} */
  const problems = [];

  for (const host of HOSTS) {
    if (!AUTO_KINDS.includes(host.mcp?.kind)) continue;
    const entry = readEntry(host, snapshot[host.id]);
    if (!entry) continue;

    const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
    const args0 = Array.isArray(entry.command) ? entry.command[1] : entry.args?.[0];
    if (command !== nodeCommand.command || args0 !== selfBin) {
      problems.push(`  ! ${host.id}: command=${command ?? "(无)"} args0=${args0 ?? "(无)"}`
        + `（当前应为 command=${nodeCommand.command} args0=${selfBin}）`);
    }
  }

  if (problems.length === 0) {
    logger.info("✓ MCP 命令指向当前 node 与本安装器");
    return;
  }
  logger.warn("已写入的 MCP 命令与当前环境不一致，请重新运行 install 修正：");
  for (const line of problems) logger.warn(line);
}

/**
 * 核对实际解析到的 openwiki 版本是否与本包锁定的一致。
 *
 * @param {object} options
 */
function checkOpenwikiPin({ logger, runtimeVersion }) {
  const locked = "0.6.0";
  if (runtimeVersion === locked) {
    logger.info(`✓ openwiki 依赖与锁定版本一致（${locked}）`);
    return;
  }
  logger.warn(`! 依赖 openwiki@${runtimeVersion} 与锁定的 ${locked} 不符，请检查安装来源`);
}

/**
 * Lists tools present on only one side of the comparison.
 *
 * @param {object[]} expected - Tools recorded in the manifest.
 * @param {object[]} actual - Tools reported by the running backend.
 * @returns {string[]} `+ name` for additions and `- name` for removals.
 */
export function diffTools(expected, actual) {
  const expectedNames = new Set((expected ?? []).map((tool) => tool.name));
  const actualNames = new Set((actual ?? []).map((tool) => tool.name));
  const lines = [];

  for (const tool of actual ?? []) {
    if (!expectedNames.has(tool.name)) lines.push(`+ ${tool.name}`);
  }
  for (const tool of expected ?? []) {
    if (!actualNames.has(tool.name)) lines.push(`- ${tool.name}`);
  }
  return lines;
}

/**
 * Reports whether this machine can run the launcher, and whether its recorded
 * snapshot still matches the openwiki it depends on.
 *
 * A missing or drifted snapshot is reported but still exits 0: the launcher
 * degrades to talking to the real backend, so the install is usable while the
 * user decides when to regenerate.
 *
 * @param {{
 *   logger: object,
 *   nodeVersion?: string,
 *   resolveRuntime?: Function,
 *   createSupervisor?: Function,
 *   hostId?: string,
 *   scope?: "user" | "project",
 *   baseDir?: string,
 *   homeDir?: string,
 *   platform?: string,
 *   nodeCommand?: { command: string, warning: string | null },
 *   selfBin?: string,
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runDoctorCommand({
  logger,
  nodeVersion = process.versions.node,
  resolveRuntime = resolveOpenwikiRuntime,
  createSupervisor = createBackendSupervisor,
  hostId = "doctor",
  scope = "project",
  baseDir = process.cwd(),
  homeDir = "",
  platform = process.platform,
  nodeCommand,
  selfBin = "",
}) {
  if (!nodeVersionSupported(nodeVersion)) {
    logger.error(
      `✗ Node.js ${nodeVersion} 不满足要求，需要 >= ${MIN_NODE.join(".")}`,
    );
    return 1;
  }
  logger.info(`✓ Node.js ${nodeVersion}`);

  let runtime;
  try {
    runtime = await resolveRuntime();
  } catch (error) {
    logger.error(`✗ 未找到 openwiki 依赖：${error.message}`);
    logger.error("  openwiki-launcher 自带 openwiki 依赖，请重新安装本包。");
    return 1;
  }
  logger.info(`✓ openwiki ${runtime.version}：${runtime.cliJs}`);

  checkOpenwikiPin({ logger, runtimeVersion: runtime.version });

  // 没有给 baseDir / nodeCommand 时静默跳过这两项：doctor 可能被只想检查后端的用户调用，
  // 那时它对「装到哪儿了」一无所知，报告一堆「不一致」反而是噪声。
  if (baseDir && nodeCommand && selfBin) {
    checkInstalledMcpCommands({ logger, scope, baseDir, platform, nodeCommand, selfBin });
  }

  const manifest = loadManifest(runtime.version);
  if (manifest) {
    logger.info(`✓ manifest: openwiki-${runtime.version}.json（${manifest.tools.length} 个工具）`);
  } else {
    logger.info(`! manifest: 未找到 openwiki-${runtime.version}.json`);
    logger.info("  建议：npm run manifest 生成快照（不影响使用，首次调用会走直通模式）");
  }

  const supervisor = createSupervisor({ cliJs: runtime.cliJs, hostId, logger });
  try {
    const session = await supervisor.ensureReady();
    const result = await session.request("tools/list", {});
    const live = result.tools ?? [];

    if (!manifest) {
      logger.info(`! 后端握手成功（${live.length} 个工具），但没有快照可比对`);
    } else {
      const drift = diffTools(manifest.tools, live);
      if (drift.length === 0) {
        logger.info(`✓ 工具清单一致（${live.length} 个）`);
      } else {
        logger.warn(`工具清单与 manifest 有差异，需要更新 manifest（npm run manifest）：`);
        for (const line of drift) logger.warn(`  ${line}`);
      }
    }
    return 0;
  } catch (error) {
    logger.error(`✗ 后端握手失败：${error.message}`);
    if (error.stderrTail) logger.error(`  后端 stderr：${error.stderrTail}`);
    return 1;
  } finally {
    supervisor.stop();
  }
}
