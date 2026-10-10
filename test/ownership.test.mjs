import { describe, expect, it } from "vitest";
import { isOursEntry } from "../src/ownership.mjs";

/**
 * 「这个 MCP 条目是不是本安装器写的」的三种条目形态与两种平台语义。
 *
 * 曾经的 bug：路径逐字符比较。Windows 的路径不区分大小写，用户用小写盘符启动一次
 * launcher（或 npm shim 换了种写法），写入配置的 bin 路径与归属判断算出来的就差在
 * 大小写上 —— 卸载会把自己的条目当成用户的，退出码 0 但残留永远删不掉。
 * 归属判断必须与 guards.mjs 的路径比较同一套约定：分隔符统一、win32 下不区分大小写。
 */

const MINE = {
  command: "D:\\Hub\\node\\node.exe",
  args: ["D:\\Hub\\launcher\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"],
};

describe("isOursEntry · json 形态", () => {
  const jsonEntry = (command, args) => ({ command, args });

  it("完全一致时认定为自家条目", () => {
    expect(isOursEntry(jsonEntry(MINE.command, [...MINE.args]), MINE, "win32")).toBe(true);
  });

  it("bin 路径大小写不同也认定（win32 路径不区分大小写）", () => {
    const args = ["d:\\hub\\launcher\\BIN\\openwiki-launcher.mjs", "mcp", "--host", "claude"];
    expect(isOursEntry(jsonEntry(MINE.command, args), MINE, "win32")).toBe(true);
  });

  it("node 路径大小写不同也认定", () => {
    expect(isOursEntry(jsonEntry("d:\\hub\\NODE\\node.exe", [...MINE.args]), MINE, "win32")).toBe(true);
  });

  it("正斜杠与反斜杠混写也认定", () => {
    const command = "D:/Hub/node/node.exe";
    const args = ["D:/Hub/launcher/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"];
    expect(isOursEntry(jsonEntry(command, args), MINE, "win32")).toBe(true);
  });

  it("linux 上大小写不同仍是两个路径，不认定", () => {
    const args = ["d:\\hub\\launcher\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"];
    expect(isOursEntry(jsonEntry(MINE.command, args), MINE, "linux")).toBe(false);
  });

  it("参数内容不同不认定", () => {
    const args = [MINE.args[0], "mcp", "--host", "cursor"];
    expect(isOursEntry(jsonEntry(MINE.command, args), MINE, "win32")).toBe(false);
  });

  it("平台缺省时用 process.platform，行为与显式传入一致", () => {
    const args = ["d:\\hub\\launcher\\bin\\openwiki-launcher.mjs", "mcp", "--host", "claude"];
    const expected = process.platform === "win32";
    expect(isOursEntry(jsonEntry(MINE.command, args), MINE)).toBe(expected);
  });
});

describe("isOursEntry · opencode-json 形态（command 是数组）", () => {
  const opencodeEntry = (command, extra = {}) => ({
    type: "local", command, enabled: true, ...extra,
  });
  const mineOpencode = { command: MINE.command, args: MINE.args };

  it("command 数组整体大小写不同也认定", () => {
    const command = ["d:\\hub\\NODE\\node.exe", "d:\\hub\\launcher\\BIN\\openwiki-launcher.mjs", "mcp", "--host", "claude"];
    expect(isOursEntry(opencodeEntry(command), mineOpencode, "win32")).toBe(true);
  });

  it("enabled 或 type 不参与归属判断", () => {
    const command = [MINE.command, ...MINE.args];
    expect(isOursEntry(opencodeEntry(command, { enabled: false, type: "other" }), mineOpencode, "win32")).toBe(true);
  });

  it("数组元素个数不同不认定", () => {
    expect(isOursEntry(opencodeEntry([MINE.command, ...MINE.args, "extra"]), mineOpencode, "win32")).toBe(false);
  });
});

describe("isOursEntry · codex-toml 形态（args 是块文本）", () => {
  // plan 写入时 toml 字符串里的反斜杠会被转义成 \\，块文本因此与 json 形态不同构
  const tomlBlock = (command, bin) =>
    `[mcp_servers.openwiki]\ncommand = "${command}"\nargs = ["${bin}", "mcp", "--host", "claude"]`;
  const tomlEntry = (command, bin) => ({
    command,
    args: tomlBlock(command, bin.replaceAll("\\", "\\\\")),
  });

  it("块内路径大小写不同也认定", () => {
    const entry = tomlEntry(MINE.command, "d:\\hub\\launcher\\BIN\\openwiki-launcher.mjs");
    expect(isOursEntry(entry, MINE, "win32")).toBe(true);
  });

  it("toml 的 args 是原始块文本，不是数组 —— 不能当数组比", () => {
    expect(isOursEntry(tomlEntry(MINE.command, MINE.args[0]), MINE, "win32")).toBe(true);
  });

  it("块指向别的宿主不认定", () => {
    const block = `[mcp_servers.openwiki]\ncommand = "${MINE.command}"\nargs = ["${MINE.args[0].replaceAll("\\", "\\\\")}", "mcp", "--host", "cursor"]`;
    expect(isOursEntry({ command: MINE.command, args: block }, MINE, "win32")).toBe(false);
  });
});

describe("isOursEntry · 防御", () => {
  it("条目缺失或畸形时返回 false，不抛错", () => {
    expect(isOursEntry(null, MINE, "win32")).toBe(false);
    expect(isOursEntry(undefined, MINE, "win32")).toBe(false);
    expect(isOursEntry("openwiki", MINE, "win32")).toBe(false);
    expect(isOursEntry({}, MINE, "win32")).toBe(false);
    expect(isOursEntry({ command: 42, args: MINE.args }, MINE, "win32")).toBe(false);
  });
});
