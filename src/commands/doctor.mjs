import { createBackendSupervisor } from "../backend.mjs";
import { loadManifest } from "../manifest.mjs";
import { MIN_NODE, nodeVersionSupported } from "../node-version.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";

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
 * }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runDoctorCommand({
  logger,
  nodeVersion = process.versions.node,
  resolveRuntime = resolveOpenwikiRuntime,
  createSupervisor = createBackendSupervisor,
  hostId = "doctor",
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
