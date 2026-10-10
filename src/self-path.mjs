import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 本包自身的可执行路径与 node 路径。
 *
 * 单独成模块是因为它们回答的是同一个问题的两面 —— 「装出来的 MCP 配置该指向哪里」。
 * 写进宿主配置的是这两个绝对路径，宿主启动时会直接 exec 它们。
 */

/**
 * 由本模块的位置推导包根下的 bin 入口。
 *
 * 不依赖 process.argv[1]：全局安装时 argv[1] 是 npm 生成的 shim 路径，
 * 而 Windows 的 .exe / .cmd shim 不转发 stdio —— 那正是本包要消灭的故障面之一。
 *
 * @param {string} moduleUrl 传 import.meta.url。必须传参，无参调用是错误用法：
 *   那样拿到的是本函数自己所在文件的 URL，在被打包或链接后会指向错误的包根。
 * @returns {string} bin/openwiki-launcher.mjs 的绝对路径
 */
export function resolveSelfBin(moduleUrl) {
  const here = path.dirname(fileURLToPath(moduleUrl));   // <pkg>/src
  return path.join(here, "..", "bin", "openwiki-launcher.mjs");
}

const NODE_FALLBACK_WARNING = "未能确定 node 的绝对路径，MCP 配置里的 command 将写为 node，"
  + "它依赖宿主环境的 PATH —— 若宿主启动时找不到 node，请手动改成绝对路径。";

/**
 * node 的调用方式。写进 MCP 配置的是绝对路径 —— 配置里不该留一个需要靠 PATH
 * 解析的东西，本包存在的意义就是消灭 PATH / shim / 空格路径这三类故障。
 *
 * @param {() => string} [execPath] 取绝对路径的函数，默认 process.execPath
 * @param {() => string | null} [warning] 生成警告文案的函数，默认给一句固定说明
 * @returns {{ command: string, warning: string | null }}
 */
export function resolveNodeCommand(execPath, warning) {
  const readExec = execPath ?? (() => process.execPath);
  const makeWarning = warning ?? (() => NODE_FALLBACK_WARNING);

  let command = "";
  try {
    command = readExec() ?? "";
  } catch {
    command = "";
  }
  if (command) return { command, warning: null };
  return { command: "node", warning: makeWarning() };
}