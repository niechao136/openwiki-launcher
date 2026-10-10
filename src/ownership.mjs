import { normalizeForCompare } from "./guards.mjs";

/**
 * 「这个 MCP 条目是不是本安装器写的」以及「这个宿主的 skills 目录在哪」。
 *
 * 这两件事被 install、uninstall、plan、doctor 四处用到，而它们的判断口径必须一致 ——
 * plan 与 uninstall 各自写一份的后果是：opencode 的条目（command 是数组形态）
 * 在 plan 里被判成「用户手写的」而误报接管，在 uninstall 里却能正确认出。
 * 用户会看到「已接管」这种错误结论，且加 --no-takeover 后再也无法更新自己的条目。
 */

/**
 * 取某宿主在给定作用域下的 skills 目录（相对 baseDir，用 / 分隔）。
 *
 * 全局作用域下要按平台选目录：Crush 与 Reasonix 的 Windows 全局路径与 unix 不同构
 * （Crush 官方给 Windows 用户的上手命令就是 mkdir "$env:LOCALAPPDATA\crush\skills"）。
 * 不做这个选择就会把 skill 装到宿主根本不扫的目录 —— 规格 2.3 明说要消灭的失败模式。
 *
 * @param {object} host 注册表条目
 * @param {{ scope: string, platform?: string }} options
 * @returns {string | null} 相对目录；该作用域不支持时返回 null
 */
export function skillsDirFor(host, { scope, platform }) {
  if (scope === "user") {
    if (!host.skill.globalDir) return null;
    if (platform === "win32" && host.skill.globalDirWin) return host.skill.globalDirWin;
    return host.skill.globalDir;
  }
  return host.skill.projectDir;
}

/**
 * 从 toml 块文本里抽出 args 数组的各个字符串字面量，并还原 toml 的 `\\` 转义。
 *
 * 块的形状由 plan 写入时确定（`args = ["a", "b", …]`），openwiki 原生安装器写的块
 * 也是同一形状。字面量按 `", "` 切分：路径里不含这个序列，够用且不必引 toml 解析器。
 *
 * @param {string} block
 * @returns {string[]}
 */
function tomlArgsTokens(block) {
  const literal = /args\s*=\s*\[([^\]]*)\]/u.exec(block);
  if (!literal) return [];
  return literal[1]
    .split(/",\s*"/u)
    .map((token) => token.replace(/^"/u, "").replace(/"$/u, "").replaceAll("\\\\", "\\"));
}

/**
 * 判断一个已存在的 MCP 条目是否由本安装器写入。
 *
 * 三种条目形态都要认：
 *   - json：`{command, args}`（command 是 node 路径，args[0] 是 launcher bin）
 *   - opencode-json：`{type, command:[node, ...args], enabled}`（command 与 args 合成一个数组）
 *   - codex-toml：marker 区间里的纯文本，用正则抽 command、对 bin 做包含判断
 *
 * 路径比较走 normalizeForCompare，**不许逐字符比较**：Windows 的路径不区分大小写，
 * 用户用小写盘符启动一次（或 npm shim 换了种写法），写进配置的路径与这里算出来的
 * 就差在大小写上 —— 条目会被当成用户的，uninstall 退出码 0 却留下永远删不掉的残留，
 * plan 则会对同一条目反复报「接管」。归一化只作用于路径参数；其余参数（"mcp"、
 * "--host"、宿主 id）本来就限定为小写，一并归一化不会改变结论。
 *
 * @param {object | null} existing readJsonEntry / readTomlBlock 的结果
 * @param {{ command: string, args: string[] }} mine 本安装器应当写入的形态
 * @param {string} [platform] 缺省取 process.platform；plan 等纯函数必须显式传入
 * @returns {boolean}
 */
export function isOursEntry(existing, mine, platform = process.platform) {
  if (!existing || typeof existing !== "object") return false;
  if (typeof existing.command !== "string" && !Array.isArray(existing.command)) return false;

  const norm = (value) => normalizeForCompare(value, platform);

  // opencode：command 数组的第 0 项是 node，第 1 项起是 args
  if (Array.isArray(existing.command)) {
    if (existing.command.length !== mine.args.length + 1) return false;
    return norm(existing.command[0]) === norm(mine.command)
      && existing.command.slice(1).every((arg, index) => norm(arg) === norm(mine.args[index]));
  }

  // toml：args 是块文本（反斜杠已被转义成 \\），抽出字面量后与 json 同一套逐元素比较。
  // 不能退化成「块里含 bin 路径」的包含判断 —— 那会让 --host cursor 的块被当成 claude 的。
  if (typeof existing.args === "string") {
    const tokens = tomlArgsTokens(existing.args);
    return norm(existing.command) === norm(mine.command)
      && tokens.length === mine.args.length
      && tokens.every((token, index) => norm(token) === norm(mine.args[index]));
  }

  // json
  if (!Array.isArray(existing.args) || existing.args.length !== mine.args.length) return false;
  return norm(existing.command) === norm(mine.command)
    && existing.args.every((arg, index) => norm(arg) === norm(mine.args[index]));
}
