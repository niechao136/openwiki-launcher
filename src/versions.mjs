import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * openwiki 版本目录布局与「当前生效指针」的唯一权威。
 *
 * 各版本 side-by-side 装在 `<包根>/versions/<semver>/node_modules/openwiki`，
 * `versions/active.json` 记录当前生效版本。指针是纯文本 JSON 而不是 symlink：
 * Windows 上创建符号链接需要管理员权限或开发者模式，而指针只需要一次文件写入。
 *
 * 所有函数都接受 pkgRoot 参数：测试传临时目录，生产代码传真实包根。
 */

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * launcher 包根。版本目录、manifest 目录、出厂 node_modules 都挂在它下面；
 * 各模块默认值统一从这里取，不再各自推导一遍。
 *
 * @returns {string}
 */
export function launcherPackageRoot() {
  return PACKAGE_ROOT;
}

/** 指针文件名。版本目录与 manifest 目录之间只隔这一层语义。 */
const ACTIVE_FILE = "active.json";

/** 版本名只允许三段数字：目录名直接进路径，宽松一毫秒就是路径穿越。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * @param {string} value
 * @returns {boolean} 是否是 `x.y.z` 形式的三段数字版本名。
 */
export function isValidVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

/**
 * @param {string} pkgRoot launcher 包根。
 * @returns {string} `<pkgRoot>/versions`。
 */
export function versionsRoot(pkgRoot = PACKAGE_ROOT) {
  return path.join(pkgRoot, "versions");
}

/**
 * 某个版本的安装目录。非法版本名直接抛错——调用方不允许把未校验的值拼进路径。
 *
 * @param {string} pkgRoot launcher 包根。
 * @param {string} version 三段数字版本名。
 * @returns {string} `<pkgRoot>/versions/<version>`。
 */
export function versionDir(pkgRoot, version) {
  if (!isValidVersion(version)) {
    throw new Error(`非法的 openwiki 版本名: ${JSON.stringify(version)}（应为 x.y.z）`);
  }
  return path.join(versionsRoot(pkgRoot), version);
}

/**
 * 读取当前生效指针。
 *
 * 指针缺失、JSON 损坏、或内容不是一个合法版本名，都算「无指针」：
 * 调用方据此回退出厂依赖。损坏不抛错——broker 不能因为一个指针文件起不来。
 *
 * @param {string} pkgRoot launcher 包根。
 * @returns {{ version: string } | null}
 */
export function readActive(pkgRoot = PACKAGE_ROOT) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(versionsRoot(pkgRoot), ACTIVE_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && isValidVersion(parsed.version)) {
      return { version: parsed.version };
    }
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

/**
 * 原子写入指针：先写 `.tmp` 再 rename 覆盖。
 *
 * Windows 上 rename 覆盖已存在的目标文件会抛 EPERM/EACCES/EEXIST，
 * 删掉目标后重试一次。写坏的指针会让所有人回退出厂依赖，值得这一次重试。
 *
 * @param {string} pkgRoot launcher 包根。
 * @param {string} version 三段数字版本名。
 */
export function writeActiveAtomic(pkgRoot, version) {
  const dir = versionDir(pkgRoot, version);
  mkdirSync(versionsRoot(pkgRoot), { recursive: true });
  const target = path.join(versionsRoot(pkgRoot), ACTIVE_FILE);
  const tmp = `${target}.tmp`;
  const payload = `${JSON.stringify({ version }, null, 2)}\n`;
  writeFileSync(tmp, payload, "utf8");
  try {
    renameSync(tmp, target);
  } catch (error) {
    if (!["EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
    rmSync(target, { force: true });
    renameSync(tmp, target);
  }
}

/**
 * 已安装版本列表（semver 升序）。
 *
 * 版本目录里的 `README.md`、`.tmp` 之类的条目不是版本，按目录名过滤掉；
 * 磁盘占用读不出来按 0 计——清单的价值在版本与快照状态，不在精确字节数。
 *
 * @param {string} pkgRoot launcher 包根。
 * @returns {Array<{ version: string, hasManifest: boolean, sizeBytes: number }>}
 */
export function listInstalled(pkgRoot = PACKAGE_ROOT) {
  const root = versionsRoot(pkgRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && isValidVersion(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
  return versions.map((version) => ({
    version,
    hasManifest: existsSync(path.join(pkgRoot, "manifest", `openwiki-${version}.json`)),
    sizeBytes: dirSize(path.join(root, version)),
  }));
}

/**
 * 删除一个已安装版本。manifest 快照不删：它几十 KB，且随包发布的出厂
 * 快照重装即恢复，删了反而丢掉「这个版本曾经生成过快照」的记录。
 *
 * @param {string} pkgRoot launcher 包根。
 * @param {string} version 三段数字版本名。
 * @returns {{ removed: true } | { removed: false, reason: "active" | "not-installed" | "invalid" }}
 */
export function removeVersion(pkgRoot, version) {
  if (!isValidVersion(version)) return { removed: false, reason: "invalid" };
  const active = readActive(pkgRoot);
  if (active && active.version === version) return { removed: false, reason: "active" };
  const dir = path.join(versionsRoot(pkgRoot), version);
  if (!existsSync(dir)) return { removed: false, reason: "not-installed" };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

/** 三段数字逐段数值比较；等长对齐，预发布号不在词汇表里。 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 递归求目录字节数；任何一层读失败按已累计的部分返回。 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try {
        total += statSync(full).size;
      } catch {
        // 文件在读清单期间消失：跳过，不影响版本状态判断。
      }
    }
  }
  return total;
}
