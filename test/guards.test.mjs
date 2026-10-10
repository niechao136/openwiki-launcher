import { describe, it, expect } from "vitest";
import { isSystemDir, isHomeDir, defaultSystemRoots } from "../src/guards.mjs";

const win = { platform: "win32", home: "C:\\Users\\x", tmpdir: "C:\\Users\\x\\AppData\\Local\\Temp",
  systemRoots: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"] };
// /tmp 必须不在 systemRoots 里，否则「放行 tmpdir」这条断言会恒真
const nix = { platform: "linux", home: "/home/x", tmpdir: "/tmp",
  systemRoots: ["/usr", "/etc", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private/etc"] };

const noRealpath = (p) => p;   // 测试里不碰磁盘

describe("isSystemDir", () => {
  it("拒绝系统目录本身与其之下（win32）", () => {
    expect(isSystemDir("C:\\Windows", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("C:\\Windows\\System32\\.trae\\skills", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("C:\\Program Files\\nodejs", { ...win, realpath: noRealpath })).toBe(true);
  });

  it("拒绝系统目录本身与其之下（unix）", () => {
    expect(isSystemDir("/usr", { ...nix, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("/etc/foo", { ...nix, realpath: noRealpath })).toBe(true);
  });

  it("拒绝盘根与文件系统根", () => {
    expect(isSystemDir("C:", { ...win, realpath: noRealpath })).toBe(true);
    expect(isSystemDir("/", { ...nix, realpath: noRealpath })).toBe(true);
  });

  it("放行 home 及其之下（否则合法全局目标被自家护栏拦下）", () => {
    expect(isSystemDir("C:\\Users\\x", { ...win, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("C:\\Users\\x\\.codeartsdoer\\skills", { ...win, realpath: noRealpath })).toBe(false);
  });

  it("放行 tmpdir 及其之下，即使 tmpdir 落在 /var 下（macOS 的坑）", () => {
    const macLike = { ...nix, tmpdir: "/var/folders/ab/T" };
    expect(isSystemDir("/var/folders/ab/T/proj/.claude/skills", { ...macLike, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("/var/log/other", { ...macLike, realpath: noRealpath })).toBe(true);
  });

  it("归一化分隔符并忽略 win32 大小写", () => {
    expect(isSystemDir("C:/WINDOWS/System32", { ...win, realpath: noRealpath })).toBe(true);
  });

  it("放行普通用户目录", () => {
    expect(isSystemDir("C:\\Users\\x\\proj\\.claude\\skills", { ...win, realpath: noRealpath })).toBe(false);
    expect(isSystemDir("/home/x/proj/.claude/skills", { ...nix, realpath: noRealpath })).toBe(false);
  });
});

describe("isHomeDir", () => {
  it("仅当相等时为 true", () => {
    expect(isHomeDir("/home/x", { home: "/home/x", realpath: noRealpath })).toBe(true);
    expect(isHomeDir("/home/x/proj", { home: "/home/x", realpath: noRealpath })).toBe(false);
  });

  it("home 不可用时返回 false", () => {
    expect(isHomeDir("/home/x", { home: "", realpath: noRealpath })).toBe(false);
  });
});

describe("defaultSystemRoots", () => {
  it("win32 下从 env 取四个根并带默认值", () => {
    expect(defaultSystemRoots({ platform: "win32", env: {} }))
      .toEqual(["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]);
    expect(defaultSystemRoots({ platform: "win32", env: { SystemRoot: "D:\\Win", ProgramFiles: "E:\\PF" } })[0])
      .toBe("D:\\Win");
  });

  it("unix 下返回固定九个根", () => {
    expect(defaultSystemRoots({ platform: "linux", env: {} }))
      .toEqual(["/usr", "/etc", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private/etc"]);
  });
});