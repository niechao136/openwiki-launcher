import path from "node:path";
import { isSystemDir as defaultIsSystemDir, isHomeDir as defaultIsHomeDir } from "./guards.mjs";
import { spliceJsonEntry, readJsonEntry, upsertTomlBlock, readTomlBlock } from "./mcp-config.mjs";
import { skillsDirFor, isOursEntry } from "./ownership.mjs";

/**
 * 安装决策器：一个**纯函数**，不碰文件系统。
 *
 * 所有检测结果由调用方（src/install.mjs）算好传进来，这里只做判断：
 * 装什么、跳过什么、报什么冲突、哪个动作被护栏拦。
 *
 * 这么切分是为了可测试性：整个安装决策面能用纯数据输入完整覆盖，不需要真实宿主、
 * 不需要临时目录。superpowers-zh 把决策与 IO 混在一个 83KB 单文件里，
 * 只能靠 verify-release.sh 的分段集成测试兜底。
 *
 * 附带一个关键性质：**护栏被拒时，执行器一个字节都不写** —— guarded 的条目在
 * 执行阶段被整体拦掉，而不是「跳过这一个文件、继续写别的」。
 */

/** MCP 条目在配置里的键名。与注册表的 containerKey 保持一致。 */
const ENTRY_KEY = "openwiki";

/** skill 在宿主 skills 目录下的目录名。 */
const SKILL_DIR_NAME = "openwiki";

/**
 * 按**给定的平台**拼接路径。
 *
 * 不能直接用 path.join：planInstall 是纯函数，platform 是它的入参，用宿主平台的
 * path.join 会让「注入 linux、跑在 Windows 上」这种组合产出反斜杠路径 ——
 * 纯函数必须只依赖它的输入。
 *
 * @param {string | undefined} platform
 * @param {string} base
 * @param {string} rel 相对路径，用 / 分隔（注册表里就是这么写的）
 * @returns {string}
 */
function joinFor(platform, base, rel) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  return impl.join(base, ...rel.split("/"));
}

/**
 * 生成某宿主该写入的 MCP 条目文本。
 *
 * 三种格式的形状与 openwiki 自身注册表一致（registry.ts:169-176 的默认命令，
 * 但 command/args 换成本包自己的入口）：
 *   json          → {command, args}
 *   opencode-json → {type:"local", command:[command, ...args], enabled:true}
 *   codex-toml    → [mcp_servers.openwiki] 表
 *
 * @param {object} host 注册表条目
 * @param {{ command: string, args: string[] }} nodeAndBin
 * @returns {{ entryJson: string | null, tomlBlock: string | null }}
 */
function buildEntryPayload(host, nodeAndBin) {
  const args = [...nodeAndBin.args];

  if (host.mcp.kind === "json") {
    return {
      entryJson: JSON.stringify({ command: nodeAndBin.command, args }, null, 2),
      tomlBlock: null,
    };
  }

  if (host.mcp.kind === "opencode-json") {
    return {
      entryJson: JSON.stringify({ type: "local", command: [nodeAndBin.command, ...args], enabled: true }, null, 2),
      tomlBlock: null,
    };
  }

  const quoted = args.map((a) => `"${a.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`).join(", ");
  return {
    entryJson: null,
    tomlBlock: `[${host.mcp.containerKey}.${ENTRY_KEY}]\ncommand = "${nodeAndBin.command}"\nargs = [${quoted}]`,
  };
}

/**
 * 读回已存在的 MCP 条目，用于判断它是不是本安装器写的。
 *
 * @param {object} host 注册表条目
 * @param {{ path: string, text: string, exists: boolean }} snapshot
 * @returns {object | null} 条目值；读不出来（文本畸形等）时返回 null
 */
function readExistingEntry(host, snapshot) {
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
 * 安装决策。
 *
 * @param {object} opts
 * @returns {{ entries: object[], skippedNoHost: boolean, nodeWarning: string | null }}
 */
export function planInstall(opts) {
  const {
    hosts, scope, baseDir, homeDir, targets, detectSnapshot, nativeSnapshot, mcpSnapshot,
    nodeCommand, selfBin, flags,
  } = opts;

  const checkSystem = opts.isSystemDir ?? defaultIsSystemDir;
  const checkHome = opts.isHomeDir ?? defaultIsHomeDir;
  const guardOpts = { platform: opts.platform, tmpdir: opts.tmpdir, systemRoots: opts.systemRoots, home: homeDir };

  const chosen = targets ?? hosts.filter((h) => detectSnapshot[h.id] === true);
  const entries = [];

  for (const host of chosen) {
    const hostId = host.id;
    const args = [selfBin, "mcp", "--host", hostId];
    const mine = { command: nodeCommand.command, args };

    // ---- skill 目录 ----
    // skillsDirFor 会按 platform 选 globalDirWin（Crush / Reasonix 的 Windows 全局路径与
    // unix 不同构），直接读 globalDir 会把 skill 装到宿主不扫描的目录（I1）
    const relDir = skillsDirFor(host, { scope, platform: opts.platform });
    /** @type {{action: string, dir: string, reason?: string}} */
    let skill;
    if (!relDir) {
      skill = {
        action: "skip",
        dir: "",
        skipKind: "scope",
        reason: scope === "user"
          ? "该宿主没有已核实的全局技能目录，请改用项目级安装"
          : (host.noProjectReason ?? "该宿主不支持项目级安装"),
      };
    } else {
      skill = { action: "install", dir: joinFor(opts.platform, baseDir, `${relDir}/${SKILL_DIR_NAME}`) };
    }

    // ---- mcp 动作 ----
    const relMcp = scope === "user" ? host.mcp?.userPath : host.mcp?.projectPath;
    /** @type {{action: string, path: string|null, kind: string|null, reason?: string, entryJson?: string, tomlBlock?: string}} */
    let mcp;

    if (!host.mcp) {
      mcp = { action: "none", path: null, kind: null };
    } else if (host.mcp.kind === "manual") {
      mcp = { action: "manual", path: null, kind: "manual" };
    } else {
      const mcpPath = joinFor(opts.platform, baseDir, relMcp);
      const snapshot = mcpSnapshot[hostId] ?? { path: mcpPath, text: "", exists: false };
      if (snapshot.unreadable) {
        // 读不出来的配置绝不能当成空配置：那样会用「只有 openwiki 一个 server」的
        // 新内容覆盖用户的整个配置文件，其他 server 全部消失（I7）。
        // 仍然往下走护栏检查，不因为这里提前返回。
        mcp = {
          action: "error", path: mcpPath, kind: host.mcp.kind,
          containerKey: host.mcp.containerKey,
          reason: `无法读取配置文件，已跳过以免覆盖：${snapshot.unreadable}`,
        };
      } else {
      const payload = buildEntryPayload(host, mine);
      try {
        const result = host.mcp.kind === "codex-toml"
          ? upsertTomlBlock(snapshot.text, { tableName: `${host.mcp.containerKey}.${ENTRY_KEY}`, block: payload.tomlBlock })
          : spliceJsonEntry(snapshot.text, {
            containerKey: host.mcp.containerKey,
            entryKey: ENTRY_KEY,
            entryJson: payload.entryJson,
            allowComments: host.mcp.kind === "opencode-json",
          });
        mcp = {
          action: result.action ?? (result.removed ? "unchanged" : "created"),
          path: mcpPath,
          kind: host.mcp.kind,
          containerKey: host.mcp.containerKey,
          entryJson: payload.entryJson,
          tomlBlock: payload.tomlBlock,
          newText: result.text,
          removed: result.removed,
        };
      } catch (error) {
        mcp = { action: "error", path: mcpPath, kind: host.mcp.kind, containerKey: host.mcp.containerKey, reason: error.message };
      }
      }
    }

    // ---- 护栏 ----
    const guardPaths = [skill.dir, mcp.path].filter(Boolean);
    let guarded = false;
    let guardReason;
    for (const p of guardPaths) {
      if (checkSystem(p, guardOpts)) {
        guarded = true;
        guardReason = `拒绝写入系统目录: ${p}`;
        break;
      }
      if (scope === "project" && checkHome(baseDir, { home: homeDir })) {
        if (!flags.force) {
          guarded = true;
          guardReason = `拒绝在用户主目录里做项目级安装（当前目录即 home）: ${p}`;
          break;
        }
      }
    }

    // ---- 接管判定 ----
    let takeover = false;
    let takeoverReason;
    if (nativeSnapshot[hostId]?.receipt === true) {
      takeover = true;
      takeoverReason = "native-receipt";
    } else if (mcp.action === "updated") {
      const existing = readExistingEntry(host, mcpSnapshot[hostId] ?? { path: "", text: "", exists: false });
      if (!isOursEntry(existing, mine)) {
        takeover = true;
        takeoverReason = "foreign-entry";
      }
    }

    if (takeover && flags.noTakeover) {
      skill = {
        action: "skip", dir: skill.dir, skipKind: "takeover",
        reason: "检测到 openwiki 原生安装，--no-takeover 已跳过",
      };
      mcp = { ...mcp, action: "skip", skipKind: "takeover", reason: "native install present (--no-takeover)" };
      takeover = false;
    }

    entries.push({
      hostId,
      displayName: host.displayName,
      skill,
      mcp,
      takeover,
      takeoverReason,
      guarded,
      guardReason,
    });
  }

  return {
    entries,
    skippedNoHost: chosen.length === 0,
    nodeWarning: nodeCommand.warning ?? null,
  };
}
