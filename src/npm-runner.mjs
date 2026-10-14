import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { compareVersions, isValidVersion } from "./versions.mjs";

/**
 * npm 子进程的启动方式，与 registry 版本表的挑选规则。
 *
 * Windows 上不起 `npm.cmd`：Node 18.20.2 / 20.12.2 / 21.7.0 起
 * （CVE-2024-27980 修复，本包要求的 22.22.0 包含它）不带 `shell:true` 启动
 * `.cmd` 会以 EINVAL 失败。首选 node 同目录下的 npm-cli.js——参数走数组，
 * 带空格的 `--prefix` 路径不需要引号转义。
 *
 * @param {{
 *   platform?: string, execPath?: string, exists?: (p: string) => boolean,
 * }} [options]
 * @returns {{ command: string, args: string[], shell?: boolean }}
 */
export function resolveNpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return { command: "npm", args: [] };
  const npmCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(npmCli)) return { command: execPath, args: [npmCli] };
  return { command: "npm.cmd", args: [], shell: true };
}

/**
 * 跑一次 npm，收拢 { code, stdout, stderr }。
 *
 * spawn 的同步抛错与 `error` 事件都归到 `{ code: -1 }`：调用方（installVersion /
 * check 的 registry 查询）都只认退出码，让异常穿透到 bin 只会给用户一截栈。
 *
 * `onSpawn(child)` 在子进程起来的那一刻被调用，给调用方一个改优先级的机会
 * （后台自愈的安装不该和用户正在用的磁盘 IO 抢资源）。
 *
 * @param {string[]} args npm 参数。
 * @param {{ onStderr?: (text: string) => void, onSpawn?: (child: object) => void }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runNpm(args, { onStderr, onSpawn } = {}) {
  const invocation = resolveNpmInvocation();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, [...invocation.args, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(invocation.shell ? { shell: true } : {}),
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error.message });
      return;
    }
    if (onSpawn) {
      try {
        onSpawn(child);
      } catch {
        // 改优先级失败不影响这次安装。
      }
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) onStderr(text);
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * 从 registry 版本表里挑最新稳定版。
 *
 * `npm view <pkg> versions` 按发布顺序返回且混有 prerelease：0.x 阶段
 * `0.7.0-beta.1` 可能排在 `0.6.3` 后面，直接取末位会把预发布当成升级目标，
 * 而版本名校验（只要 x.y.z）随后抛错。
 *
 * @param {unknown} versions npm view 解析后的值。
 * @returns {string | null} 最新稳定版；没有可用版本时为 null。
 */
export function pickLatestStable(versions) {
  if (!Array.isArray(versions)) return null;
  const stable = versions.filter((version) => isValidVersion(version));
  if (stable.length === 0) return null;
  return stable.sort(compareVersions)[stable.length - 1];
}
