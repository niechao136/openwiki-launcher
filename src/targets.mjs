import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findHost } from "./registry.mjs";

/**
 * 作用域、目标与「现状快照」的解析。
 *
 * install 与 uninstall 共用这一套 —— 两者的作用域语义、别名解析、detect 判定
 * 必须完全一致，否则会出现「装到了 A 目录、卸载去 B 目录找」这种删不掉的残留。
 */

/**
 * 解析安装作用域。
 *
 * @param {{ global?: boolean, cwd: string, homeDir: string }} options
 * @returns {{ scope: "user" | "project", baseDir: string }}
 */
export function resolveScope({ global, cwd, homeDir }) {
  return global
    ? { scope: "user", baseDir: homeDir }
    : { scope: "project", baseDir: cwd };
}

/**
 * 解析目标宿主。
 *
 * @param {{ tool?: string | null, hosts: object[] }} options
 * @returns {object[] | null} 显式指定的宿主数组；tool 为 null 表示走自动检测；
 *   给了但没命中也返回 null —— 调用方负责区分这两种 null 并给出不同提示。
 */
export function resolveTargets({ tool, hosts }) {
  if (tool === null || tool === undefined) return null;
  const host = findHost(tool);
  return host ? [host] : null;
}

/**
 * 对全池一次性算完 detect 判定。
 *
 * **必须在任何写入之前调用完**（规格 4.2 的硬要求）：Codex 安装会创建 `.agents/skills`，
 * 而 Antigravity 的 detect 标记正是 `.agents` —— 先写后判会让它被邻居的产物
 * 误判成「已安装」而跳过。
 *
 * @param {object[]} hosts 注册表条目
 * @param {{ scope: string, baseDir: string, exists?: (p: string) => boolean }} options
 * @returns {Record<string, boolean>}
 */
export function collectDetectSnapshot(hosts, { scope, baseDir, exists = existsSync }) {
  /** @type {Record<string, boolean>} */
  const snapshot = {};
  for (const host of hosts) {
    const markers = scope === "user" ? host.skill.globalDetect : host.skill.detect;
    snapshot[host.id] = Array.isArray(markers) && markers.length > 0
      && markers.some((marker) => exists(path.resolve(baseDir, ...marker.split("/"))));
  }
  return snapshot;
}

/**
 * 探测各宿主的 skill 目录里是否存在 openwiki 原生安装器写的收据。
 *
 * @param {object[]} hosts 注册表条目
 * @param {{ scope: string, baseDir: string, platform?: string, exists?: (p: string) => boolean }} options
 * @returns {Record<string, { receipt: boolean, skillDir: string | null }>}
 */
export function collectNativeSnapshot(hosts, { scope, baseDir, platform, exists = existsSync }) {
  /** @type {Record<string, { receipt: boolean, skillDir: string | null }>} */
  const snapshot = {};
  const impl = platform === "win32" ? path.win32 : path.posix;

  for (const host of hosts) {
    if (!host.native) {
      snapshot[host.id] = { receipt: false, skillDir: null };
      continue;
    }
    const relDir = scope === "user" ? host.skill.globalDir : host.skill.projectDir;
    if (!relDir) {
      snapshot[host.id] = { receipt: false, skillDir: null };
      continue;
    }
    const skillDir = impl.join(baseDir, ...relDir.split("/"), "openwiki");
    const receipt = exists(path.join(skillDir, host.native.receipt));
    snapshot[host.id] = { receipt, skillDir };
  }
  return snapshot;
}

/**
 * 读取各宿主 MCP 配置文件的当前文本，供决策器判断「条目是否已存在、是否已经是我们的」。
 *
 * 读失败按「存在但内容为空」处理，交给切片层走空配置分支 —— 那样会写出新配置，
 * 而一个读不出来的文件大概率是权限问题，用户会从写入失败里看到真实原因。
 *
 * @param {object[]} hosts 注册表条目
 * @param {{ scope: string, baseDir: string, platform?: string,
 *           exists?: (p: string) => boolean, read?: (p: string) => string }} options
 * @returns {Record<string, { path: string, text: string, exists: boolean }>}
 */
export function collectMcpSnapshot(hosts, { scope, baseDir, platform, exists = existsSync, read = readFileSync }) {
  /** @type {Record<string, { path: string, text: string, exists: boolean }>} */
  const snapshot = {};
  const impl = platform === "win32" ? path.win32 : path.posix;

  for (const host of hosts) {
    const mcp = host.mcp;
    const writable = mcp && ["json", "codex-toml", "opencode-json"].includes(mcp.kind);
    const rel = writable ? (scope === "user" ? mcp.userPath : mcp.projectPath) : null;
    if (!rel) {
      snapshot[host.id] = { path: "", text: "", exists: false };
      continue;
    }
    const p = impl.join(baseDir, ...rel.split("/"));
    const present = exists(p);
    let text = "";
    if (present) {
      try {
        text = read(p, "utf8");
      } catch {
        text = "";
      }
    }
    snapshot[host.id] = { path: p, text, exists: present };
  }
  return snapshot;
}
