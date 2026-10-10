import { realpathSync, resolve as resolvePath } from "node:fs";
import os from "node:os";

/**
 * 路径护栏：拒绝把 skill 装进系统目录，拒绝在主目录里做项目级安装。
 *
 * 判定规则逐字移植 superpowers-zh.js:1297-1353，但把所有隐式全局（process.platform、
 * homedir()、tmpdir()、process.env）改成参数注入 —— 这样测试无需打桩全局就能覆盖
 * win32 与 unix 两套分支，而这套逻辑恰恰是最容易「在非 Windows 上根本没法测」的部分。
 */

const UNIX_SYSTEM_ROOTS = [
  "/usr", "/etc", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private/etc",
];

/** win32 的四个系统根来自环境变量，各带一个几乎不会变的默认值。 */
const WINDOWS_ROOT_DEFAULTS = [
  ["SystemRoot", "C:\\Windows"],
  ["ProgramFiles", "C:\\Program Files"],
  ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
  ["ProgramData", "C:\\ProgramData"],
];

/**
 * 平台对应的系统根目录列表。
 *
 * superpowers-zh 的原始实现直接读 process.env；这里做成可注入的纯函数，
 * 测试才能断言「SystemRoot 被改成 D:\Win 时第一个根就是 D:\Win」。
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {string[]}
 */
export function defaultSystemRoots(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return [...UNIX_SYSTEM_ROOTS];
  const env = opts.env ?? process.env;
  return WINDOWS_ROOT_DEFAULTS.map(([key, fallback]) => env[key] || fallback);
}

/**
 * realpath 的容错包装：解析不了就退化成绝对路径。
 *
 * @param {string} p
 * @param {(p: string) => string} fn
 * @returns {string}
 */
function safeRealpath(p, fn) {
  try {
    return fn(p);
  } catch {
    return resolvePath(p);
  }
}

/**
 * 归一化路径用于比较：分隔符统一成 /，去掉尾斜杠，win32 下再小写。
 *
 * 不做这层归一化，同一条路径写成 C:\Windows 还是 C:/Windows 会得出不同结论 ——
 * 这正是原实现注释里记下的「在非 Windows 上根本没法测这段逻辑」的成因。
 *
 * @param {string} value
 * @param {string} platform
 * @returns {string}
 */
function normalizeForCompare(value, platform) {
  let v = String(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return platform === "win32" ? v.toLowerCase() : v;
}

/**
 * 判断路径是否落在系统目录里（含该目录本身）。
 *
 * 三条放行规则，每条都对应一个踩过的坑：
 *   1. home 及其之下放行 —— 主目录另有护栏；否则 ~/.codeartsdoer/skills 这类
 *      合法全局目标会被自家护栏拦下（macOS 上 /Users/x 在某些配置下会落进 unix 根判断）。
 *   2. tmpdir 及其之下放行 —— macOS 的 TMPDIR 落在 /private/var/folders/…，会命中
 *      /var 规则；CI、测试、「先在临时目录试一下」都是正当用途，不能拦。
 *   3. 根目录与盘根拒绝 —— 归一化后为空串或 C: 这种。
 *
 * @param {string} targetPath
 * @param {{ platform?: string, home?: string, tmpdir?: string, systemRoots?: string[],
 *           realpath?: (p: string) => string }} [opts]
 * @returns {boolean} true 表示应当拒绝写入
 */
export function isSystemDir(targetPath, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home === undefined ? safeHomedir() : opts.home;
  const tmp = opts.tmpdir === undefined ? safeTmpdir() : opts.tmpdir;
  const roots = opts.systemRoots ?? defaultSystemRoots({ platform, env: process.env });
  const realpath = opts.realpath ?? ((p) => safeRealpath(p, realpathSync));

  const real = realpath(targetPath);

  // 1. 主目录另有护栏，这里必须放行
  const realHome = home ? realpath(home) : null;
  if (realHome && isSameOrUnder(real, realHome)) return false;

  // 2. 临时目录豁免（macOS TMPDIR 落在 /var 下）
  if (tmp) {
    const realTmp = realpath(tmp);
    if (isSameOrUnder(real, realTmp)) return false;
  }

  const norm = (value) => normalizeForCompare(value, platform);
  const r = norm(real);

  // 3. 文件系统根（归一化后为空串）与 win32 盘根
  if (r === "") return true;
  if (platform === "win32" && /^[a-z]:$/u.test(r)) return true;

  // 两边都要 realpath：根目录也必须解析，否则 macOS 上 /var/... 与 /private/var/...
  // 会被判成两个不同的地方（实测踩到）。
  return roots.some((root) => {
    const rr = norm(realpath(root));
    return rr !== "" && isSameOrUnder(r, rr);
  });
}

/**
 * 路径是否等于主目录。
 *
 * 只判「相等」不判「在其之下」：判断安装目标是否落在 home 上时，语义是
 * 「用户其实想装全局，却在一个项目语境里跑」，而不是 home 的所有子目录都可疑。
 *
 * @param {string} targetPath
 * @param {{ home?: string, realpath?: (p: string) => string }} [opts]
 * @returns {boolean}
 */
export function isHomeDir(targetPath, opts = {}) {
  const home = opts.home === undefined ? safeHomedir() : opts.home;
  if (!home) return false;
  const realpath = opts.realpath ?? ((p) => safeRealpath(p, realpathSync));
  return realpath(targetPath) === realpath(home);
}

/**
 * candidate 是否等于 ancestor 或落在其之下。两端都已归一化。
 *
 * @param {string} candidate
 * @param {string} ancestor
 * @returns {boolean}
 */
function isSameOrUnder(candidate, ancestor) {
  if (candidate === ancestor) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return candidate.startsWith(prefix);
}

function safeHomedir() {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

function safeTmpdir() {
  try {
    return os.tmpdir();
  } catch {
    return "";
  }
}