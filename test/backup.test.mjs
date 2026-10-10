import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, rollbackAll } from "../src/backup.mjs";
import { resolveSelfBin, resolveNodeCommand } from "../src/self-path.mjs";

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ow-bak-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("写前快照把原内容存到备份文件", () => {
  const f = join(root, "mcp.json");
  writeFileSync(f, "原内容", "utf8");
  const b = createBackup(f, root);
  expect(b.existed).toBe(true);
  expect(readFileSync(b.backupPath, "utf8")).toBe("原内容");
  expect(b.backupPath).toMatch(/mcp\.json\.openwiki-launcher-backup-/u);
});

it("原文件不存在时快照记录 existed=false 且不产生备份文件", () => {
  const b = createBackup(join(root, "none.json"), root);
  expect(b.existed).toBe(false);
  expect(existsSync(b.backupPath)).toBe(false);
});

it("目标所在目录不存在时也能定位（备份目录取最近的已存在祖先）", () => {
  const target = join(root, "deep", "nested", "mcp.json");
  const b = createBackup(target, root);
  expect(b.existed).toBe(false);
  expect(existsSync(b.backupPath)).toBe(false);
  expect(b.realPath).toContain(join("deep", "nested"));
});

it("rollbackAll 恢复存在过的文件并删除新建的文件", () => {
  const a = join(root, "a.json");
  writeFileSync(a, "A", "utf8");
  const c = join(root, "c.json");
  const backups = [createBackup(a, root), createBackup(c, root)];
  writeFileSync(a, "被改坏", "utf8");
  writeFileSync(c, "新建的", "utf8");
  rollbackAll(backups);
  expect(readFileSync(a, "utf8")).toBe("A");
  expect(existsSync(c)).toBe(false);
});

it("符号链接跟随到真实路径，快照写在真实路径旁（审查重点 2）", () => {
  mkdirSync(join(root, "real"), { recursive: true });
  const real = join(root, "real", "claude.json");
  writeFileSync(real, "真实内容", "utf8");
  symlinkSync(real, join(root, "claude.json"));
  const b = createBackup(join(root, "claude.json"), root);
  expect(b.realPath).toBe(real);
  expect(lstatSync(b.backupPath).isSymbolicLink()).toBe(false);
  expect(b.backupPath.startsWith(join(root, "real"))).toBe(true);
  expect(readFileSync(b.backupPath, "utf8")).toBe("真实内容");
});

it("resolveSelfBin 由模块位置推导包根下的 bin", () => {
  const selfUrl = new URL("../src/self-path.mjs", import.meta.url);
  expect(resolveSelfBin(selfUrl.href)).toBe(
    join(fileURLToPath(new URL("..", import.meta.url)), "bin", "openwiki-launcher.mjs"),
  );
});

it("resolveNodeCommand 绝对路径不可用时回退 node 并带警告", () => {
  expect(resolveNodeCommand(() => "/abs/node", () => null))
    .toEqual({ command: "/abs/node", warning: null });
  expect(resolveNodeCommand(() => "", () => "警告文本"))
    .toEqual({ command: "node", warning: "警告文本" });
});