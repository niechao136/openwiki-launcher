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
 * 判断一个已存在的 MCP 条目是否由本安装器写入。
 *
 * 三种条目形态都要认：
 *   - json：`{command, args}`（command 是 node 路径，args[0] 是 launcher bin）
 *   - opencode-json：`{type, command:[node, ...args], enabled}`（command 与 args 合成一个数组）
 *   - codex-toml：marker 区间里的纯文本，用正则抽 command、对 bin 做包含判断
 *
 * @param {object | null} existing readJsonEntry / readTomlBlock 的结果
 * @param {{ command: string, args: string[] }} mine 本安装器应当写入的形态
 * @returns {boolean}
 */
export function isOursEntry(existing, mine) {
  if (!existing || typeof existing !== "object") return false;

  // opencode：command 数组的第 0 项是 node，第 1 项起是 args
  if (Array.isArray(existing.command)) {
    return existing.command[0] === mine.command
      && JSON.stringify(existing.command.slice(1)) === JSON.stringify(mine.args);
  }

  // toml：args 只能当纯文本比对，退化成包含判断
  if (typeof existing.args === "string") {
    return existing.command === mine.command && existing.args.includes(mine.args[0]);
  }

  // json
  return existing.command === mine.command
    && JSON.stringify(existing.args) === JSON.stringify(mine.args);
}
