import { existsSync } from "node:fs";
import path from "node:path";
import { createBackendSupervisor } from "../backend.mjs";
import { loadManifest } from "../manifest.mjs";
import { MIN_NODE, nodeVersionSupported } from "../node-version.mjs";
import { normalizeForCompare } from "../guards.mjs";
import { resolveOpenwikiRuntime } from "../paths.mjs";
import { HOSTS } from "../registry.mjs";
import { readJsonEntry, readTomlBlock } from "../mcp-config.mjs";
import { collectMcpSnapshot } from "../targets.mjs";
import { declaredOpenwikiRange, exactPinnedVersion } from "../pkg.mjs";
import { isInstalled, launcherPackageRoot, listInstalled, readActive, versionsRoot } from "../versions.mjs";
import { bundleStatus } from "../ensure-bundle.mjs";
import { runNpm } from "../npm-runner.mjs";

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
 * 已写入的 MCP 条目是否仍指向当前的 node 与本安装器 bin。
 *
 * 路径比较走 normalizeForCompare，**不许逐字符比较**：win32 的路径不区分大小写、
 * 正反斜杠混写是同一条路径。用户换一种写法启动一次（小写盘符、npm shim 的路径形态），
 * 逐字符比较就会把自己刚写好的条目报成「与当前环境不一致，请重新运行 install」——
 * 用户照做，重跑又写入同一种写法的路径，误报循环。与 ownership.isOursEntry 同一套约定。
 *
 * @param {object | null} entry readEntry 的结果
 * @param {{ command: string }} nodeCommand
 * @param {string} selfBin
 * @param {string} [platform] 缺省取 process.platform
 * @returns {boolean}
 */
export function installedEntryMatches(entry, nodeCommand, selfBin, platform = process.platform) {
  if (!entry) return false;
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  const args0 = Array.isArray(entry.command) ? entry.command[1] : entry.args?.[0];
  const norm = (value) => normalizeForCompare(String(value ?? ""), platform);
  return norm(command) === norm(nodeCommand.command) && norm(args0) === norm(selfBin);
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

    if (!installedEntryMatches(entry, nodeCommand, selfBin, platform)) {
      const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
      const args0 = Array.isArray(entry.command) ? entry.command[1] : entry.args?.[0];
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
 * `declared` 是 package.json 里的依赖声明，取自本包而不是写死的常量：规格把 doctor
 * 定义成「openwiki 升级后的一条命令核对流程」，而写死的版本号在第一次升版后就会永远
 * 报「不符」—— 一个永远在报警的 doctor 等于没有 doctor。
 *
 * 声明不是精确锁版、或当前版本来自 versions/ 指针时跳过核对并说明原因：拿范围当版本号
 * 去比，报出来的结论是假的；而指针切换是版本管理命令的正常产物，拿出厂锁版去报「安装
 * 来源被污染」同样是在误报。
 *
 * @param {{ logger: object, runtimeVersion: string, declared: string, source?: string }} options
 */
function checkOpenwikiPin({ logger, runtimeVersion, declared, source }) {
  if (source === "versions") {
    logger.info(`✓ openwiki 版本由指针管理（${runtimeVersion}），跳过 package.json 锁版核对`);
    return;
  }
  const pinned = exactPinnedVersion(declared);
  if (pinned === null) {
    logger.info(`! 依赖声明 openwiki@${declared || "(缺失)"} 是范围而非精确锁版，已跳过版本核对`);
    return;
  }
  if (runtimeVersion === pinned) {
    logger.info(`✓ openwiki 依赖与锁定版本一致（${pinned}）`);
    return;
  }
  logger.warn(`! 依赖 openwiki@${runtimeVersion} 与锁定的 ${pinned} 不符，请检查安装来源`);
}

/**
 * 版本指针状态。
 *
 * 指针是 check/update/switch 唯一的生效途径，doctor 必须把它的状态讲清楚：
 * 生效中、损坏回退、未设置，三种状态对应三种用户动作（继续用 / 重跑 switch / 知道现在
 * 跑的是出厂版本）。
 *
 * @param {{ logger: object, pkgRoot: string, runtime: { version: string, source: string } }} options
 */
function checkVersionPointer({ logger, pkgRoot, runtime }) {
  const active = readActive(pkgRoot);
  const pointerFile = path.join(versionsRoot(pkgRoot), "active.json");
  if (active && runtime.source === "versions" && active.version === runtime.version) {
    logger.info(`✓ 版本指针：${active.version}（versions）`);
    return;
  }
  if (existsSync(pointerFile) && !active) {
    logger.warn("! 版本指针损坏，已回退出厂依赖；修复：重跑 switch 或删除 versions/active.json");
    return;
  }
  if (!active) {
    logger.info("✓ 版本指针：未设置，使用出厂依赖（bundled）");
    return;
  }
  logger.info(`! 版本指针：${active.version}，当前生效 ${runtime.version}（${runtime.source}）`);
}

/** win32 上裸 npm 名字起不来，shell 拼不出带空格的路径；npm 的 JS 入口见 npm-runner。 */

/**
 * 全局 openwiki 根目录。查不到（npm 不在 PATH、命令失败）时返回 null——
 * 这项提示是锦上添花，不该把 doctor 变成第二个故障源。
 *
 * @returns {Promise<string | null>}
 */
function defaultGlobalRoot() {
  return runNpm(["root", "-g"]).then((result) =>
    result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null,
  );
}

/**
 * 全局安装的 openwiki 不参与 launcher 解析（paths.mjs 只认包根与 versions/）。
 * 「全局装了新版却发现没生效」是最容易产生的一类困惑；检测到就说出来。
 *
 * @param {{ logger: object, resolveGlobalRoot: () => Promise<string | null> }} options
 */
async function checkGlobalOpenwiki({ logger, resolveGlobalRoot }) {
  let globalRoot;
  try {
    globalRoot = await resolveGlobalRoot();
  } catch {
    return;
  }
  if (!globalRoot) return;
  if (existsSync(path.join(globalRoot, "openwiki", "package.json"))) {
    logger.warn(
      `! 检测到全局 openwiki（${globalRoot}），launcher 不使用它；请用 check/update/switch 管理版本`,
    );
  }
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
 *   declaredOpenwiki?: string,
 *   pkgRoot?: string,
 *   resolveGlobalRoot?: () => Promise<string | null>,
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
  declaredOpenwiki = declaredOpenwikiRange(),
  pkgRoot = launcherPackageRoot(),
  resolveGlobalRoot = defaultGlobalRoot,
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

  checkVersionPointer({ logger, pkgRoot, runtime });
  await checkGlobalOpenwiki({ logger, resolveGlobalRoot });
  checkOpenwikiPin({ logger, runtimeVersion: runtime.version, declared: declaredOpenwiki, source: runtime.source });

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

  // Defender 排除是可选优化（规格 §6.3）：实时扫描对 node_modules 海量小文件的
  // 冷启动影响实测显著；只提示不代写，且仅 win32 相关。
  if (platform === "win32" && nodeCommand?.command) {
    const nodeDir = path.dirname(nodeCommand.command);
    logger.info("提示：Windows 实时扫描会显著拖慢冷启动——把以下目录加入 Defender 排除（需管理员，示例）：");
    logger.info(`  Add-MpPreference -ExclusionPath "${nodeDir}","${pkgRoot}"`);
  }

  // §9：各已装版本的 bundle 状态一目了然（ready/bad/missing）。
  const bundleStatusLabel = { ready: "✓ bundle 就绪", bad: "! bundle 被标记不可用（npm run bundle 重建后自动恢复）", missing: "! 无 bundle（冷启动较慢，npm run bundle 生成）" };
  try {
    const installed = listInstalled(pkgRoot).filter((entry) => isInstalled(pkgRoot, entry.version));
    if (installed.length > 0) {
      for (const entry of installed) {
        logger.info(`${bundleStatusLabel[bundleStatus(pkgRoot, entry.version)] ?? "! bundle 状态未知"}：openwiki ${entry.version}`);
      }
    }
  } catch (error) {
    logger.warn(`! bundle 状态枚举失败：${error.message}`);
  }

  // warmup 登录预热是可选优化（规格 §5.6）；只提示不代写。
  if (nodeCommand?.command && selfBin) {
    logger.info("提示：可将冷启动移到登录时——用 warmup 挂登录启动项（示例，需管理员执行 schtasks）：");
    logger.info(`  schtasks /create /tn "openwiki-warmup" /sc onlogon /tr "${nodeCommand.command} ${selfBin} warmup --host <宿主id>"`);
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
    // warmup 登录预热是可选优化（规格 §5.6）；只提示不代写。
    return 0;
  } catch (error) {
    logger.error(`✗ 后端握手失败：${error.message}`);
    if (error.stderrTail) logger.error(`  后端 stderr：${error.stderrTail}`);
    return 1;
  } finally {
    supervisor.stop();
  }
}
