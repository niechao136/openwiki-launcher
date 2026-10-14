import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateManifest } from "./gen-manifest.mjs";
import { acquireLock, pidAlive, releaseLock } from "./lockfile.mjs";
import { manifestFilePath } from "./manifest.mjs";
import { runNpm } from "./npm-runner.mjs";
import { isValidVersion, isInstalled, versionDir, versionsRoot } from "./versions.mjs";

/**
 * 「往 versions/<版本>/ 写一个 openwiki 版本」的唯一入口。
 *
 * 本模块存在的理由是两条不变量（规格 I5）：
 *
 * 1. **原子性**——安装过程发生在 `versions/.tmp-<版本>-<pid>/`，通过完整性校验
 *    之后才以一次 rename 出现在 `versions/<版本>/`。任何时刻该目录要么不存在、
 *    要么是完整条目；被打断的安装（宿主退出、进程被杀）不会留下一个「看起来装
 *    好了」的版本目录。
 * 2. **互斥**——锁按版本键控。`update` 装 0.7.0、`switch` 装 0.7.0、后台物化
 *    0.7.0 三者互斥，而装 0.6.0 与装 0.7.0 互不影响。
 *
 * 残留判定只有一条规则：持锁进程不在了就是残留（`pidAlive`）。同一个过程里顺带
 * 清掉上一个被杀进程留下的临时目录与原子替换中转目录。
 */

/** 临时目录与替换中转目录的命名：`.tmp-<x.y.z>-<pid>` / `.bak-<x.y.z>-<pid>`。 */
const TEMP_DIR_PATTERN = /^\.(tmp|bak)-(\d+\.\d+\.\d+)-(\d+)$/;

/**
 * 删除上一个进程留下的安装临时目录与替换中转目录。
 *
 * 只认名字匹配且 pid 已消失的目录：名字不匹配的（用户自己放进来的 README、
 * 真正的版本目录）一律不碰，pid 还在的（另一个进程正在装）也一律不碰。
 *
 * @param {string} pkgRoot launcher 包根。
 * @param {{ isPidAlive?: (pid: number) => boolean }} [options] 探活实现（测试注入）。
 * @returns {{ removed: string[] }} 被删除目录的绝对路径。
 */
export function cleanupStaleTempDirs(pkgRoot, { isPidAlive = pidAlive } = {}) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(versionsRoot(pkgRoot));
  } catch (error) {
    if (error.code === "ENOENT") return { removed };
    throw error;
  }

  for (const name of entries) {
    const match = TEMP_DIR_PATTERN.exec(name);
    if (!match) continue;
    const full = path.join(versionsRoot(pkgRoot), name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (isPidAlive(Number(match[3]))) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // 清理失败不影响调用方：它挡不住真正的安装，只是多占一点磁盘。
    }
  }
  return { removed };
}

/**
 * 某个版本的安装锁路径。
 *
 * @param {string} pkgRoot
 * @param {string} version
 * @returns {string}
 */
export function versionLockPath(pkgRoot, version) {
  if (!isValidVersion(version)) {
    throw new Error(`非法的 openwiki 版本名: ${JSON.stringify(version)}（应为 x.y.z）`);
  }
  return path.join(versionsRoot(pkgRoot), `install-${version}.lock`);
}

/**
 * 以版本键控的独占锁运行一段安装逻辑。
 *
 * 拿不到锁不是错误，是「另一个进程正在装同一个版本」——调用方据此降级（等待
 * 下一次触发），而不是排队或重试。锁一定释放：无论 `fn` 正常返回还是抛出。
 *
 * @param {{ pkgRoot: string, version: string, logger?: object,
 *           deps?: { isPidAlive?: (pid: number) => boolean } }} options
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ ok: true, value: any } | { ok: false, reason: "locked" }>}
 */
export async function withVersionLock({ pkgRoot, version, logger, deps = {} }, fn) {
  const isPidAlive = deps.isPidAlive ?? pidAlive;
  cleanupStaleTempDirs(pkgRoot, { isPidAlive });

  const lockPath = versionLockPath(pkgRoot, version);
  const payload = { pid: process.pid, version, startedAt: Date.now() };
  let lock = acquireLock(lockPath, payload);

  if (!lock.acquired) {
    // 残留锁（持锁进程已死，或文件内容损坏读不出 pid）会让这个版本永远装不上，
    // 必须能强制重取。持有者还活着才是真的「别人在装」。
    const holder = lock.existing?.pid;
    if (typeof holder !== "number" || !isPidAlive(holder)) {
      releaseLock(lockPath);
      lock = acquireLock(lockPath, payload);
    }
  }

  if (!lock.acquired) {
    logger?.debug?.(`另一个进程正在安装 openwiki@${version}，本次跳过`);
    return { ok: false, reason: "locked" };
  }

  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * 命令行场景的默认 npm 执行器：把进度条（写 stderr）原样透传给用户。
 *
 * 几百 MB 的依赖树要装几分钟，静默会让人以为卡死。它必须住在模块层而不是某个
 * 命令里——就绪动作的三个触发点（`warm` / `warmup` / `mcp` 后台自愈）没有执行器
 * 可传，只能靠这里兜底。
 */
export function defaultRunNpm(args, options = {}) {
  return runNpm(args, { ...options, onStderr: (text) => process.stderr.write(text) });
}

/** 原生模块预编译二进制下载失败时的可操作指引（update / 就绪动作共用）。 */
const NPM_MIRROR_HINT =
  "预编译二进制下载失败或被网络重置：用 npmmirror 镜像重试——"
  + "npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3";

/**
 * 从 npm install 的 stderr 里提炼人能看懂的原因。
 *
 * 原生模块（better-sqlite3 等）编译失败时，stderr 是几百行 gyp 噪声加 npm
 * notice 收尾；取「最后几行」只会捞到 notice，真正的失败原因（预编译下载被
 * 网络重置 → 回退源码编译 → 缺工具链）整段被淹没。这里按根因给针对性提示，
 * 让用户第一步就走对路（通常是配镜像，而不是装 Python 工具链）。
 *
 * @param {string} stderr
 * @returns {string[]} 逐行日志内容（不带 logger 前缀），总量封顶。
 */
export function summarizeInstallFailure(stderr) {
  const all = String(stderr || "").split("\n").map((line) => line.trim());
  const joined = all.join("\n");

  const root = [];
  // 根因行（预编译下载失败、文件占用）优先于泛化的 "command failed"。
  const rootCause = /prebuild-install|ECONNRESET|ETIMEDOUT|EPERM/i;
  for (const pass of [rootCause, /./]) {
    for (const line of all) {
      if (!line.startsWith("npm error")) continue;
      // 日志文件路径与 gyp 的 find Python 扫描是纯噪声：前者不可操作，后者
      // 一刷几百行且结论只有一个（没有工具链）——由下面的针对性提示代替。
      if (/A complete log of this run/.test(line)) continue;
      if (/gyp ERR! find Python|gyp info/.test(line)) continue;
      if (root.includes(line)) continue;
      if (!pass.test(line)) continue;
      if (root.length < 4) root.push(line);
    }
  }

  const hints = [];
  const prebuildReset = /prebuild-install/i.test(joined)
    && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(joined);
  const gypFallback = /find Python|gyp ERR! configure/i.test(joined);
  if (prebuildReset || gypFallback) {
    hints.push(NPM_MIRROR_HINT);
  }
  if (gypFallback) {
    hints.push(
      "node-gyp 回退到了源码编译但缺 Python/构建工具链；配好上面的镜像让预编译直接下载成功后，无需编译",
    );
  }
  if (/EPERM/.test(joined)) {
    hints.push("部分文件被占用（常见为杀毒软件锁定），关闭占用程序后重试");
  }

  const lines = [...root, ...hints];
  if (lines.length > 0) return lines.slice(0, 8);
  const tail = all.filter(Boolean).slice(-1)[0];
  return [tail || "npm install 失败，无详细错误输出"];
}

/** 后台自愈的安装不该和用户正在用的磁盘 IO 抢资源；失败静默（跨平台差异不致命）。 */
function setBelowNormalPriority(child) {
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // 平台不支持或权限不足，忽略。
  }
}

/**
 * 默认的原生模块探活：当前 Node 能否加载这份安装产物里的 better-sqlite3。
 *
 * 预编译二进制与 Node ABI 绑死，装到一半的原生模块会让后端在启动时才炸——那时
 * 报错离现场已经很远。这里在入库前先问一次，代价是一次短命进程。
 *
 * @param {string} dir 安装产物所在目录。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {boolean}
 */
export function defaultVerifyNative(dir, { timeoutMs = 30000 } = {}) {
  try {
    const result = spawnSync(process.execPath, ["-e", "import('better-sqlite3')"], {
      cwd: dir,
      timeout: timeoutMs,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 安装产物的完整性校验：三项全过才允许进入 `versions/`。
 *
 * @param {string} tmpDir 临时安装目录。
 * @param {string} version 请求的版本。
 * @param {{ verifyNativeFn?: (dir: string) => boolean }} [options]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyInstallTree(tmpDir, version, { verifyNativeFn = defaultVerifyNative } = {}) {
  const pkgDir = path.join(tmpDir, "node_modules", "openwiki");
  const packageJson = path.join(pkgDir, "package.json");
  const cliJs = path.join(pkgDir, "dist", "cli", "cli.js");
  if (!existsSync(packageJson) || !existsSync(cliJs)) {
    return { ok: false, reason: "安装产物缺少 node_modules/openwiki/package.json 或 dist/cli/cli.js" };
  }

  let declared = null;
  try {
    declared = JSON.parse(readFileSync(packageJson, "utf8")).version;
  } catch {
    declared = null;
  }
  if (declared !== version) {
    return {
      ok: false,
      reason: `安装产物的入口包版本是 ${declared ?? "未知"}，与请求的 ${version} 不一致`,
    };
  }

  // 依赖树里没有原生模块的版本跳过这一项：不是所有版本都带 better-sqlite3。
  if (existsSync(path.join(tmpDir, "node_modules", "better-sqlite3")) && !verifyNativeFn(tmpDir)) {
    return { ok: false, reason: "better-sqlite3 无法在当前 Node 下加载（预编译二进制与 ABI 不匹配，或缺构建工具链）" };
  }
  return { ok: true };
}

/** 把旧目录里的 bundle 产物搬到新目录：node_modules 用新的，bundle 能省一次重建。 */
function mergeBundleArtifacts(bakDir, targetDir) {
  let merged = 0;
  let names;
  try {
    names = readdirSync(bakDir);
  } catch {
    return merged;
  }
  for (const name of names) {
    if (!(name === "bundle.meta.json" || name === "bundle.bad" || /^bundle-.*\.mjs$/.test(name))) continue;
    try {
      renameSync(path.join(bakDir, name), path.join(targetDir, name));
      merged += 1;
    } catch {
      // 搬不动只是少了 bundle，ensureBundle 下次会重建。
    }
  }
  return merged;
}

/**
 * 原子落盘：临时目录 → `versions/<版本>/`。
 *
 * 目标已存在（历史遗留的 bundle-only 目录）时先把旧目录挪到旁路，再挪入新的，
 * 最后把旁路的 bundle 产物合并回来。挪入失败要回滚旁路，绝不能把用户已有的
 * bundle 弄丢。
 *
 * @param {{ pkgRoot: string, version: string, tmpDir: string }} options
 * @returns {{ merged: number }}
 */
export function promoteVersionDir({ pkgRoot, version, tmpDir }) {
  const target = versionDir(pkgRoot, version);
  mkdirSync(versionsRoot(pkgRoot), { recursive: true });

  if (!existsSync(target)) {
    renameSync(tmpDir, target);
    return { merged: 0 };
  }

  const bak = path.join(versionsRoot(pkgRoot), `.bak-${version}-${process.pid}`);
  rmSync(bak, { recursive: true, force: true });
  renameSync(target, bak);
  try {
    renameSync(tmpDir, target);
  } catch (error) {
    renameSync(bak, target);
    throw error;
  }
  const merged = mergeBundleArtifacts(bak, target);
  rmSync(bak, { recursive: true, force: true });
  return { merged };
}

/** 记录这次安装是在哪个 Node 主版本下完成的（doctor 的漂移提示靠它）。 */
function writeInstallMeta(pkgRoot, version, now) {
  const meta = {
    version,
    nodeMajor: process.versions.node.split(".")[0],
    installedAt: (now ? now() : new Date()).toISOString(),
  };
  try {
    writeFileSync(path.join(versionDir(pkgRoot, version), "install.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch {
    // 元数据写失败不影响安装结果，只是丢一条诊断信息。
  }
}

/** 已在锁内的安装主体：临时目录安装 → 校验 → 原子落盘。 */
async function installVersionLocked({ pkgRoot, version, runNpm, logger, priority, deps }) {
  const tmpDir = path.join(versionsRoot(pkgRoot), `.tmp-${version}-${process.pid}`);
  rmSync(tmpDir, { recursive: true, force: true });
  logger?.info?.(`安装 openwiki@${version}（npm install --prefix ${tmpDir}）…`);

  const args = [
    "install",
    `openwiki@${version}`,
    "--prefix",
    tmpDir,
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
  ];
  const result = await runNpm(args, {
    onSpawn: priority === "below-normal" ? setBelowNormalPriority : undefined,
  });

  if (!result || result.code !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    const stderr = result?.stderr ?? "";
    logger?.error?.(`npm install 失败（退出码 ${result?.code ?? "?"}）`);
    const lines = summarizeInstallFailure(stderr);
    for (const line of lines) logger?.error?.(`  ${line}`);
    return { ok: false, stage: "install", reason: lines[0] ?? "npm install 失败" };
  }

  const verified = verifyInstallTree(tmpDir, version, { verifyNativeFn: deps.verifyNativeFn });
  if (!verified.ok) {
    rmSync(tmpDir, { recursive: true, force: true });
    logger?.error?.(`安装产物校验失败：${verified.reason}`);
    return { ok: false, stage: "verify", reason: verified.reason };
  }

  const promote = deps.promoteVersionDirFn ?? promoteVersionDir;
  try {
    promote({ pkgRoot, version, tmpDir });
  } catch (error) {
    // Windows 上目标目录被 Defender / 运行中的后端占用就是这个形状。留在可诊断的
    // 错误态：清掉临时目录、不写 meta、不假装装好了，下一次触发可以自愈。
    rmSync(tmpDir, { recursive: true, force: true });
    logger?.error?.(`安装产物落盘失败：${error.message}`);
    return { ok: false, stage: "install", reason: `安装产物落盘失败：${error.message}` };
  }

  writeInstallMeta(pkgRoot, version, deps.now);
  return { ok: true, entryVersion: version };
}

/**
 * 把一个 openwiki 版本装进 `versions/<版本>/`。
 *
 * 全流程由版本键控锁保护；拿不到锁返回 `stage: "locked"`，由调用方降级
 * （等待下一次触发），而不是排队。
 *
 * @param {{
 *   pkgRoot: string, version: string, runNpm: Function, logger: object,
 *   priority?: "normal" | "below-normal",
 *   deps?: { verifyNativeFn?: Function, isPidAlive?: Function, now?: () => Date },
 * }} options
 * @returns {Promise<{ ok: true, entryVersion: string } | { ok: false, stage: "locked" | "install" | "verify", reason: string }>}
 */
export async function installVersion({ pkgRoot, version, runNpm, logger, priority = "normal", deps = {} }) {
  if (!isValidVersion(version)) {
    return { ok: false, stage: "install", reason: `非法的 openwiki 版本名: ${JSON.stringify(version)}（应为 x.y.z）` };
  }
  const locked = await withVersionLock(
    { pkgRoot, version, logger, deps: { isPidAlive: deps.isPidAlive } },
    () => installVersionLocked({ pkgRoot, version, runNpm, logger, priority, deps }),
  );
  if (!locked.ok) return { ok: false, stage: "locked", reason: "另一个进程正在安装同一个版本" };
  return locked.value;
}

/**
 * 安装一个版本并为它录制快照，落盘 `manifest/openwiki-<版本>.json`。
 *
 * 已安装且可解析的版本不重下：几百 MB 白下载一次，网络一失败还会把原本可以
 * switch 回去的完好版本删掉——缺的只是快照。整段（装 + 录）在同一把版本锁内。
 *
 * @param {{
 *   pkgRoot: string, version: string, runNpm: Function, logger: object,
 *   writeSnapshot?: Function, hostId?: string,
 *   priority?: "normal" | "below-normal", deps?: object,
 * }} options
 * @returns {Promise<
 *   { ok: true, snapshot: object }
 *   | { ok: false, stage: "locked" | "install" | "verify", reason: string }
 *   | { ok: false, stage: "snapshot", error: Error }
 * >}
 */
export async function installAndSnapshot({
  pkgRoot,
  version,
  runNpm,
  logger,
  writeSnapshot = generateManifest,
  hostId = "update",
  priority = "normal",
  deps = {},
}) {
  const locked = await withVersionLock(
    { pkgRoot, version, logger, deps: { isPidAlive: deps.isPidAlive } },
    async () => {
      if (isInstalled(pkgRoot, version)) {
        logger?.info?.(`openwiki@${version} 已安装，跳过下载，仅补录快照`);
      } else {
        const installed = await installVersionLocked({ pkgRoot, version, runNpm, logger, priority, deps });
        if (!installed.ok) return { ok: false, stage: installed.stage, reason: installed.reason };
      }

      let snapshot;
      try {
        snapshot = await writeSnapshot({ explicitVersion: version, hostId, pkgRoot });
        const usable = snapshot
          && Array.isArray(snapshot.tools) && snapshot.tools.length > 0
          && typeof snapshot.protocolVersion === "string" && snapshot.protocolVersion.length > 0;
        if (!usable) throw new Error("快照缺少工具清单或 protocolVersion");
      } catch (error) {
        return { ok: false, stage: "snapshot", error };
      }

      const snapshotPath = manifestFilePath(version, pkgRoot);
      // manifest/ 随包发布，生产环境里一定在；但被清理过的安装没有它，
      // 而 writeFileSync 不建父目录——没有这一行，最后一步会炸掉。
      mkdirSync(path.dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      logger?.info?.(`✓ 快照已生成：openwiki-${version}.json（${snapshot.tools.length} 个工具）`);
      return { ok: true, snapshot };
    },
  );
  if (!locked.ok) return { ok: false, stage: "locked", reason: "另一个进程正在安装同一个版本" };
  return locked.value;
}
