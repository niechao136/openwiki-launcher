import { createRequire } from "node:module";

/**
 * 本包自身的版本信息。
 *
 * 只有一个理由：openwiki 版本与 launcher 版本此前各自散落在代码里被写死
 * （doctor 里写死 "0.6.0"、后端 initialize 里写死 "0.1.0"）。写死的常量在第一次
 * 升版后就开始说谎，而 doctor 恰好是规格指定的「升级后一条命令核对」流程 ——
 * 它一旦开始误报，用户就再也分不清哪条结论可信。
 */

const require = createRequire(import.meta.url);

/** @type {{ version: string, dependencies?: Record<string, string> } | null} */
let cached = null;

/**
 * 读取本包 package.json（只读一次）。
 *
 * @returns {{ version: string, dependencies?: Record<string, string> }}
 */
export function launcherPkg() {
  if (cached === null) cached = require("../package.json");
  return cached;
}

/**
 * 本包版本号。
 *
 * @returns {string}
 */
export function launcherVersion() {
  return launcherPkg().version;
}

/**
 * package.json 里对 openwiki 的依赖声明，原样返回（可能是范围）。
 *
 * @returns {string}
 */
export function declaredOpenwikiRange() {
  return launcherPkg().dependencies?.openwiki ?? "";
}

/** 精确版本：可选的 v / = 前缀 + 三段数字 + 可选的预发布后缀。 */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 从依赖声明里取出精确版本；声明不是精确锁版时返回 null。
 *
 * 只剥 `v` 与 `=` 前缀，**不剥 `^` / `~` / `>=`**：`^0.6.0` 允许 0.6.1、0.7.0，
 * 把它当成锁版会让 doctor 在一个根本没锁版的依赖上给出「一致」的结论 —— 比误报
 * 「不符」更危险，因为它让升级后的漂移悄悄溜过去。
 *
 * 刻意不引 semver：package.json 用的是精确锁版，字符串判断足够；而一旦有人把声明
 * 改成 `^0.6.0`，本函数返回 null，调用方跳过核对 —— 不确定时说不确定。
 *
 * @param {string} range 依赖声明，例如 "0.6.0" / "^0.6.0" / ">=0.6.0 <0.7.0"
 * @returns {string | null} 精确版本；无法确定时为 null
 */
export function exactPinnedVersion(range) {
  if (typeof range !== "string") return null;
  const trimmed = range.trim().replace(/^[v=]+/u, "");
  return EXACT_VERSION.test(trimmed) ? trimmed : null;
}
