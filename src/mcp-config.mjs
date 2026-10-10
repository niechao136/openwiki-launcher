/**
 * MCP 配置的读与写。
 *
 * 三种格式（json / jsonc / toml）统一用**文本切片替换**：定位目标键值的字节区间，
 * 只替换那一段，其余字节原样输出。不用 JSON.parse + JSON.stringify 整体重写，
 * 理由有两个，都是真实用户会遇到的问题：
 *
 *   1. 用户的注释、缩进风格、键顺序、其他 server 的条目都会在重写中丢失
 *      （opencode.jsonc 的注释尤其致命）；
 *   2. 解析失败时不能「当成空对象写回去」—— 那等于清空用户的 MCP 配置。
 *      所以文本畸形一律抛错，原文件逐字节不动。
 *
 * 副作用是零新增运行时依赖：不需要 jsonc-parser，也不需要 toml 解析器。
 *
 * 实现的关键技巧是 `codeMask`：把注释与字符串**内容**用等长空格遮罩成一份同长度的
 * 副本，于是「括号配对」与「键定位」都能在 mask 上用最朴素的循环完成，
 * 而得到的偏移量在原文里依然有效。转义与嵌套字符串的复杂性一次解决。
 */

/** 本安装器在 codex 配置里用的块标记。不复用原生的 OPENWIKI:MCP:*，否则两个安装器会互相误切。 */
export const TOML_START = "# OPENWIKI-LAUNCHER:MCP:START";
export const TOML_END = "# OPENWIKI-LAUNCHER:MCP:END";

const BOM = "\uFEFF";
const INDENT_STEP = "  ";

/**
 * 生成与原文等长的「只看结构」副本：注释与字符串**内容**都被替换成空格，
 * 但引号本身保留（判断字符串边界要用），换行保留（缩进推断要用）。
 *
 * 因为长度不变，mask 上的任何偏移量都能直接用在原文上。
 *
 * @param {string} text
 * @param {boolean} allowComments true 表示这是 jsonc（opencode），注释合法
 * @returns {string}
 * @throws 字符串未闭合，或不允许注释却出现了注释
 */
function codeMask(text, allowComments) {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === '"') { out += '"'; inString = false; i += 1; continue; }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (ch === '"') { out += '"'; inString = true; i += 1; continue; }

    const isLineComment = ch === "/" && text[i + 1] === "/";
    const isBlockComment = ch === "/" && text[i + 1] === "*";

    if (isLineComment || isBlockComment) {
      if (!allowComments) {
        throw new Error(`无法解析: 第 ${i} 个字符处出现注释，这个文件不是纯 JSON`);
      }
      if (isLineComment) {
        while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
        continue;
      }
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  if (inString) throw new Error("无法解析: 字符串字面量没有闭合");
  if (out.length !== text.length) {
    throw new Error(`内部错误: mask 长度 ${out.length} 与原文 ${text.length} 不一致`);
  }
  return out;
}

/**
 * 在 mask 上做括号配对。
 *
 * @param {string} mask
 * @returns {Map<number, number>} 开括号下标 → 闭括号下标
 * @throws 括号不配对
 */
function matchBraces(mask) {
  /** @type {Map<number, number>} */
  const pairs = new Map();
  /** @type {number[]} */
  const stack = [];

  for (let i = 0; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === "{" || ch === "[") {
      stack.push(i);
    } else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open === undefined) throw new Error(`括号不配对: 多出一个 ${ch}（位置 ${i}）`);
      const want = ch === "}" ? "{" : "[";
      if (mask[open] !== want) {
        throw new Error(`括号不配对: ${mask[open]} 与 ${ch} 错配（位置 ${i}）`);
      }
      pairs.set(open, i);
    }
  }

  if (stack.length > 0) {
    throw new Error(`括号不配对: 有 ${stack.length} 个括号没有闭合（位置 ${stack[stack.length - 1]}）`);
  }
  assertNoTrailingComma(mask);
  return pairs;
}

/**
 * 拒绝尾随逗号（`{"a":1,}`）。
 *
 * 括号配对与键语法都合法，但 JSON 不允许尾随逗号。这种文件一旦被当成空对象重写，
 * 等于静默吞掉用户的一个条目，所以显式拒绝。
 *
 * @param {string} mask
 */
function assertNoTrailingComma(mask) {
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== ",") continue;
    const j = skipSpace(mask, i + 1, mask.length);
    if (mask[j] === "}" || mask[j] === "]") {
      throw new Error(`无法解析: 第 ${i} 个字符处出现尾随逗号`);
    }
  }
}

/**
 * 在 mask 上找字符串字面量的闭合引号下标。
 *
 * mask 里字符串内容已被空格替换，所以不存在转义序列，下一个引号就是闭合引号。
 *
 * @param {string} mask
 * @param {number} openIndex 开引号下标
 * @returns {number}
 */
function stringEnd(mask, openIndex) {
  for (let i = openIndex + 1; i < mask.length; i += 1) {
    if (mask[i] === '"') return i;
  }
  throw new Error(`无法解析: 第 ${openIndex} 个字符处的字符串没有闭合`);
}

/**
 * 跳过空白。
 *
 * @param {string} mask
 * @param {number} from
 * @param {number} limit
 * @returns {number}
 */
function skipSpace(mask, from, limit) {
  let i = from;
  while (i < limit && (mask[i] === " " || mask[i] === "\t" || mask[i] === "\n" || mask[i] === "\r")) {
    i += 1;
  }
  return i;
}

/**
 * 在给定起点读出一个值的结束下标。
 *
 * 返回的是**开区间**下标（可直接用于 slice(valueStart, valueEnd)）——
 * 括号配对表给出的是闭合括号自身的下标，这里必须 +1，否则每个对象值都会被
 * 切掉最后一个字符。
 *
 * @param {string} mask
 * @param {number} start
 * @param {number} limit
 * @param {Map<number, number>} pairs
 * @returns {number} 开区间下标
 */
function valueEndAt(mask, start, limit, pairs) {
  const ch = mask[start];
  if (ch === "{" || ch === "[") {
    const close = pairs.get(start);
    if (close === undefined) throw new Error(`无法解析: 第 ${start} 个字符处的值缺少闭合括号`);
    return close + 1;
  }
  if (ch === '"') return stringEnd(mask, start) + 1;
  let i = start;
  while (i < limit && !/[,\s}\]]/u.test(mask[i])) i += 1;
  return i;
}

/**
 * 在一个对象区间内找键。键名从**原文**读（mask 里字符串内容已被空格替换，读不出真名），
 * 偏移量全部来自 mask。
 *
 * 返回值里的 `range` 只在该键的值是对象/数组时存在，供调用方继续往里查找 ——
 * 「成员」与「对象区间」是两种形状，混用会让 `.start` 变成 undefined 而静默失配。
 *
 * @param {string} text 原文
 * @param {string} mask 等长 mask
 * @param {{start: number, end: number}} obj 对象括号区间（含括号）
 * @param {string} key
 * @param {Map<number, number>} pairs
 * @returns {{keyStart: number, valueStart: number, valueEnd: number,
 *            range: {start: number, end: number} | null} | null}
 */
function findMember(text, mask, obj, key, pairs) {
  let i = skipSpace(mask, obj.start + 1, obj.end);

  while (i < obj.end) {
    // 处理完最后一个成员后 i 会落在它自己值的闭合括号上（还没到 obj.end），
    // 那说明已经走完所有成员 —— 任何闭括号都是本层结束信号。
    if (mask[i] === "}" || mask[i] === "]") break;
    if (mask[i] === ",") { i = skipSpace(mask, i + 1, obj.end); continue; }
    if (mask[i] !== '"') {
      throw new Error(`无法解析: 第 ${i} 个字符处期望键名的引号，实际是 ${JSON.stringify(mask[i])}`);
    }
    const keyEnd = stringEnd(mask, i);
    const name = readKeyName(text, i, keyEnd);

    const j = skipSpace(mask, keyEnd + 1, obj.end);
    if (mask[j] !== ":") throw new Error(`无法解析: 键之后缺少冒号（位置 ${j}）`);
    const valueStart = skipSpace(mask, j + 1, obj.end);
    const valueEnd = valueEndAt(mask, valueStart, obj.end, pairs);

    if (name === key) {
      const isRange = mask[valueStart] === "{" || mask[valueStart] === "[";
      return {
        keyStart: i,
        valueStart,
        valueEnd,
        // range 用**闭合括号自身**的下标作 end：isObjectEmpty 与成员遍历都按
        // 「end 是闭合括号位置」来循环，混用开区间会让 isObjectEmpty 永远看到那个 }
        range: isRange ? { start: valueStart, end: valueEnd - 1 } : null,
      };
    }
    i = skipSpace(mask, valueEnd, obj.end);
  }

  return null;
}

/**
 * 读出一个键名。mask 的内容已被空格替换，所以回原文取切片再 JSON.parse。
 *
 * @param {string} text 原文
 * @param {number} open 开引号下标
 * @param {number} close 闭引号下标
 * @returns {string}
 */
function readKeyName(text, open, close) {
  try {
    return JSON.parse(text.slice(open, close + 1));
  } catch {
    return text.slice(open + 1, close);
  }
}

/**
 * 对象区间里除空白与逗号之外是否什么都没有。
 *
 * @param {string} mask
 * @param {{start: number, end: number}} obj
 * @returns {boolean}
 */
function isObjectEmpty(mask, obj) {
  for (let i = obj.start + 1; i < obj.end; i += 1) {
    const ch = mask[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") continue;
    return false;
  }
  return true;
}

/**
 * 成员的「整行起点 + 值开区间下标」。
 *
 * 刻意**不**吞掉尾随逗号与换行：调用方需要据此判断「这个成员后面还有没有别的成员」，
 * 而那决定了替换时该不该补逗号、删除时该吃前导还是尾随逗号。
 *
 * @param {string} mask
 * @param {{keyStart: number, valueEnd: number}} member
 * @param {number} lowerBound 不越过这个下标
 * @returns {{start: number, valueEnd: number}}
 */
function memberLineSpan(mask, member, lowerBound) {
  let start = member.keyStart;
  while (start > lowerBound + 1 && (mask[start - 1] === " " || mask[start - 1] === "\t")) start -= 1;
  return { start, valueEnd: member.valueEnd };
}

/**
 * 向前跳过空白（含换行）。
 *
 * 必须连换行一起跳：多行格式里成员的前导逗号在**上一行末尾**，
 * 只跳空格会停在换行上、找不到那个逗号，于是删除最后一个成员后留下 `},` 悬空逗号。
 *
 * @param {string} mask
 * @param {number} from
 * @param {number} limit
 * @returns {number} 停在第一个非空白字符上；到 limit 返回 limit
 */
function skipSpaceBack(mask, from, limit) {
  let i = from;
  while (i >= limit
    && (mask[i] === " " || mask[i] === "\t" || mask[i] === "\n" || mask[i] === "\r")) {
    i -= 1;
  }
  return i;
}

/**
 * 算出删除一个成员应当切掉的区间。
 *
 * @param {string} mask
 * @param {{keyStart: number, valueEnd: number}} member
 * @param {number} objStart 所属容器的 `{` 下标
 * @param {number} objEnd 所属容器的 `}` 下标
 * @returns {{start: number, end: number}}
 */
function deleteMemberSpan(mask, member, objStart, objEnd) {
  const line = memberLineSpan(mask, member, objStart);
  const afterIdx = skipSpace(mask, line.valueEnd, mask.length);

  // 后面还有成员：吃掉尾随逗号与这一行的换行。
  // 注意只能用 skipInlineSpace —— skipSpace 会跨过换行继续吃下一行的缩进，
  // 那样「删掉 openwiki」会把紧随其后的 other 的缩进一起吃掉。
  if (mask[afterIdx] === ",") {
    let end = skipInlineSpace(mask, afterIdx + 1);
    if (mask[end] === "\n") end += 1;
    return { start: line.start, end };
  }

  // 自己是最后一个成员：改吃前导逗号（若有），否则吃掉本行换行
  let start = line.start;
  const beforeIdx = skipSpaceBack(mask, start - 1, objStart);
  if (beforeIdx >= objStart && mask[beforeIdx] === ",") start = beforeIdx;

  let end = skipInlineSpace(mask, line.valueEnd);
  if (mask[end] === "\n") end += 1;
  void objEnd;
  return { start, end };
}

/**
 * 只跳空格与制表符，**不跨换行**。
 *
 * 与 skipSpace 的区别就是「不跨行」这一个语义：删除成员时要精确地吃掉「本行的
 * 逗号与换行」，若顺手把下一行的缩进也吃掉，用户文件里下一个成员就贴到行首了。
 *
 * @param {string} mask
 * @param {number} from
 * @returns {number}
 */
function skipInlineSpace(mask, from) {
  let i = from;
  while (i < mask.length && (mask[i] === " " || mask[i] === "\t")) i += 1;
  return i;
}

/**
 * 推断一个成员的缩进：有兄弟成员就沿用它，没有就用父级缩进 + 2 空格。
 *
 * @param {string} text 原文
 * @param {{keyStart: number} | null} sibling
 * @param {number} openIndex 父级括号起点
 * @returns {string}
 */
function inferIndent(text, sibling, openIndex) {
  if (sibling) {
    const lineStart = text.lastIndexOf("\n", sibling.keyStart) + 1;
    return /^[ \t]*/u.exec(text.slice(lineStart, sibling.keyStart))[0];
  }
  const lineStart = text.lastIndexOf("\n", openIndex) + 1;
  return `${/^[ \t]*/u.exec(text.slice(lineStart, openIndex))[0]}${INDENT_STEP}`;
}

/**
 * 按给定缩进渲染一个 `"key": <value>` 成员（不含尾随逗号与换行）。
 *
 * @param {string} key
 * @param {string} valueJson 已格式化好的值（2 空格缩进）
 * @param {string} indent
 * @returns {string}
 */
function renderMember(key, valueJson, indent) {
  const body = valueJson
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join("\n");
  return `${indent}"${key}": ${body}`;
}

/**
 * 从 `from` 找到下一个换行之后的位置（容错：找不到就用 to）。
 *
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function skipToNextLine(text, from, to) {
  const idx = text.indexOf("\n", from);
  return idx === -1 || idx >= to ? to : idx + 1;
}

/**
 * 对象里的第一个成员（用来对齐新成员的缩进）。
 *
 * @param {string} mask
 * @param {{start: number, end: number}} obj
 * @param {Map<number, number>} pairs
 * @returns {{keyStart: number, valueEnd: number} | null}
 */
function findAnyMember(mask, obj, pairs) {
  const i = skipSpace(mask, obj.start + 1, obj.end);
  if (i >= obj.end || mask[i] !== '"') return null;
  const keyEnd = stringEnd(mask, i);
  const j = skipSpace(mask, keyEnd + 1, obj.end);
  if (mask[j] !== ":") return null;
  const valueStart = skipSpace(mask, j + 1, obj.end);
  return { keyStart: i, valueEnd: valueEndAt(mask, valueStart, obj.end, pairs) };
}

/**
 * 在 JSON 文本里 upsert / 删除一个「容器 → 条目」两级的键。
 *
 * @param {string} text 原文，可为 ""（空配置）
 * @param {{ containerKey: string, entryKey: string, entryJson: string | null,
 *           allowComments?: boolean }} opts
 *   entryJson 为 null 表示删除该条目
 * @returns {{ text: string, action?: "created" | "updated" | "unchanged", removed?: boolean }}
 * @throws 文本畸形时抛错，且不返回任何修改过的文本
 */
export function spliceJsonEntry(text, opts) {
  const { containerKey, entryKey, entryJson, allowComments = false } = opts;

  const bom = text.startsWith(BOM) ? BOM : "";
  const body = bom ? text.slice(BOM.length) : text;

  // 空 / 纯空白视为空配置：没有可损坏的内容，直接写出完整结构
  if (body.trim() === "") {
    if (entryJson === null) return { text, removed: false };
    const containerValue = `{\n${renderMember(entryKey, entryJson, INDENT_STEP)}\n}`;
    return { text: bom + `{\n${renderMember(containerKey, containerValue, "")}\n}\n`, action: "created" };
  }

  const mask = codeMask(body, allowComments);
  if (mask[0] !== "{") {
    throw new Error(`无法解析: 配置必须以 { 开头（实际是 ${JSON.stringify(body[0])}）`);
  }
  const pairs = matchBraces(mask);
  const rootEnd = pairs.get(0);
  if (rootEnd === undefined) throw new Error("无法解析: 根对象没有闭合");
  const root = { start: 0, end: rootEnd };

  const container = findMember(body, mask, root, containerKey, pairs);

  // ---------------- 删除 ----------------
  if (entryJson === null) {
    if (!container?.range) return { text, removed: false };
    const containerRange = container.range;
    const inner = findMember(body, mask, containerRange, entryKey, pairs);
    if (!inner) return { text, removed: false };

    const span = deleteMemberSpan(mask, inner, containerRange.start, containerRange.end);
    let next = body.slice(0, span.start) + body.slice(span.end);

    // 容器变空则连容器键一起删（卸载后不留空壳）
    const mask2 = codeMask(next, allowComments);
    const pairs2 = matchBraces(mask2);
    const root2 = { start: 0, end: pairs2.get(0) };
    const container2 = findMember(next, mask2, root2, containerKey, pairs2);
    if (container2?.range && isObjectEmpty(mask2, container2.range)) {
      const span2 = deleteMemberSpan(mask2, container2, root2.start, root2.end);
      next = next.slice(0, span2.start) + next.slice(span2.end);
    }
    return { text: bom + next, removed: true };
  }

  const expected = JSON.stringify(JSON.parse(entryJson));

  // ---------------- 容器与条目都已存在 ----------------
  if (container?.range) {
    const containerRange = container.range;
    const inner = findMember(body, mask, containerRange, entryKey, pairs);

    if (inner) {
      let current = null;
      try {
        current = JSON.stringify(JSON.parse(body.slice(inner.valueStart, inner.valueEnd)));
      } catch {
        current = null;
      }
      if (current === expected) return { text, action: "unchanged" };

      // 后面还有成员才补逗号；只有它一个时补了就是尾随逗号，JSON 会直接崩
      const afterIdx = skipSpace(mask, inner.valueEnd, mask.length);
      const hasComma = mask[afterIdx] === ",";
      const lineEnd = skipSpace(mask, hasComma ? afterIdx + 1 : inner.valueEnd, mask.length);
      const newline = mask[lineEnd] === "\n" ? "\n" : "";
      const tailStart = newline ? lineEnd + 1 : (hasComma ? afterIdx + 1 : inner.valueEnd);

      const indent = inferIndent(body, inner, containerRange.start);
      const line = memberLineSpan(mask, inner, containerRange.start);
      return {
        text: bom + body.slice(0, line.start)
          + renderMember(entryKey, entryJson, indent)
          + (hasComma ? "," : "")
          + newline
          + body.slice(tailStart),
        action: "updated",
      };
    }

    // ---------------- 容器存在，条目不存在 ----------------
    const sibling = findAnyMember(mask, containerRange, pairs);
    const indent = sibling ? inferIndent(body, sibling, containerRange.start) : INDENT_STEP;
    const insertAt = skipToNextLine(body, containerRange.start + 1, containerRange.end);
    const needsComma = !isObjectEmpty(mask, containerRange);
    const piece = `${renderMember(entryKey, entryJson, indent)}${needsComma ? "," : ""}\n`;
    return { text: bom + body.slice(0, insertAt) + piece + body.slice(insertAt), action: "created" };
  }

  // ---------------- 容器不存在，新建 ----------------
  const rootIndent = inferIndent(body, findAnyMember(mask, root, pairs), root.start);
  const memberIndent = `${rootIndent}${INDENT_STEP}`;
  const containerValue = `{\n${renderMember(entryKey, entryJson, memberIndent)}\n${rootIndent}}`;
  const rendered = `${rootIndent}"${containerKey}": ${containerValue}`;

  if (isObjectEmpty(mask, root)) {
    return { text: bom + `{\n${rendered}\n}\n`, action: "created" };
  }

  const insertAt = skipToNextLine(body, 0, root.end);
  const tail = body.slice(insertAt);
  const needsComma = !/^\s*[}\]]/u.test(tail);
  return {
    text: bom + body.slice(0, insertAt) + rendered + (needsComma ? "," : "") + `\n${tail}`,
    action: "created",
  };
}

/**
 * 读出一个「容器 → 条目」的值。
 *
 * 畸形文本一律抛错而不是返回 null：卸载与 doctor 依赖它判断「这条目是不是我们写的」，
 * 静默返回 null 会让卸载误判成「用户自己写的」而把条目留在那里。
 *
 * @param {string} text
 * @param {{ containerKey: string, entryKey: string, allowComments?: boolean }} opts
 * @returns {unknown | null} 容器或条目不存在时返回 null
 */
export function readJsonEntry(text, opts) {
  const { containerKey, entryKey, allowComments = false } = opts;
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (body.trim() === "") return null;

  const mask = codeMask(body, allowComments);
  if (mask[0] !== "{") throw new Error("无法解析: 配置必须以 { 开头");
  const pairs = matchBraces(mask);
  const rootEnd = pairs.get(0);
  if (rootEnd === undefined) throw new Error("无法解析: 根对象没有闭合");

  const container = findMember(body, mask, { start: 0, end: rootEnd }, containerKey, pairs);
  if (!container?.range) return null;
  const inner = findMember(body, mask, container.range, entryKey, pairs);
  if (!inner) return null;

  const raw = body.slice(inner.valueStart, inner.valueEnd);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `无法解析: 条目的值不是合法 JSON（区间 ${inner.valueStart}..${inner.valueEnd}，内容 ${JSON.stringify(raw.slice(0, 120))}）`,
    );
  }
}

/**
 * 把一段 toml 内容包进本安装器的 marker 区间。
 *
 * @param {string} block
 * @returns {string}
 */
function wrapTomlBlock(block) {
  return `${TOML_START}\n${block.replace(/\n+$/u, "")}\n${TOML_END}`;
}

/**
 * 定位 marker 区间。
 *
 * @param {string} text
 * @returns {{start: number, contentStart: number, contentEnd: number, endMarker: number} | null}
 */
function locateTomlBlock(text) {
  const start = text.indexOf(TOML_START);
  if (start === -1) return null;
  const endMarker = text.indexOf(TOML_END, start);
  if (endMarker === -1) return null;
  return {
    start,
    contentStart: start + TOML_START.length + 1,
    contentEnd: endMarker,
    endMarker,
  };
}

/**
 * upsert 一段带 marker 的 toml 表。
 *
 * @param {string} text
 * @param {{ tableName: string, block: string }} opts
 * @returns {{ text: string, action: "created" | "updated" | "unchanged" }}
 */
export function upsertTomlBlock(text, opts) {
  const wrapped = wrapTomlBlock(opts.block);
  const span = locateTomlBlock(text);

  if (span) {
    // 比较必须走 readTomlBlock：marker 区间里存的是 `<block>\n`，
    // 直接切原始文本会多带一个换行，导致「已经是你要的」被误判成需要更新。
    if (readTomlBlock(text, opts) === opts.block) {
      return { text, action: "unchanged" };
    }
    const end = span.endMarker + TOML_END.length;
    const trailing = text[end] === "\n" ? "\n" : "";
    return { text: text.slice(0, span.start) + wrapped + trailing + text.slice(end), action: "updated" };
  }

  const head = text === "" ? "" : `${text.replace(/\n+$/u, "")}\n\n`;
  return { text: `${head}${wrapped}\n`, action: "created" };
}

/**
 * 删除带 marker 的 toml 表，连同它前面的分隔空行，让文件逐字节回到安装前。
 *
 * 没有 marker 的裸表返回 removed: false —— 那是 openwiki 原生或用户手写的，
 * 本安装器无权删除。
 *
 * @param {string} text
 * @param {{ tableName: string }} opts
 * @returns {{ text: string, removed: boolean }}
 */
export function removeTomlBlock(text, opts) {
  void opts;
  const span = locateTomlBlock(text);
  if (!span) return { text, removed: false };

  // marker 前面若正好是一个空行（两个连续换行），把这个空行一起吃掉
  let start = span.start;
  if (text.slice(0, start).endsWith("\n\n")) start -= 1;

  let end = span.endMarker + TOML_END.length;
  if (text[end] === "\n") end += 1;

  return { text: text.slice(0, start) + text.slice(end), removed: true };
}

/**
 * 读出 marker 区间内的表内容；没有 marker 时返回 null。
 *
 * @param {string} text
 * @param {{ tableName: string }} opts
 * @returns {string | null}
 */
export function readTomlBlock(text, opts) {
  void opts;
  const span = locateTomlBlock(text);
  if (!span) return null;
  // marker 区间里存的是 `<block>\n`，切掉那个分隔换行才能与传入的 block 逐字比较
  return text.slice(span.contentStart, span.contentEnd).replace(/\n$/u, "");
}