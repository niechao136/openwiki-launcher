import {
  copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * 写前快照与失败回滚。
 *
 * 安装器要改的是用户的 MCP 配置文件 —— 里面可能有注释、其他 server、用户自己的参数。
 * 任何一步失败都必须能把这些文件恢复原状，而不是停在「装了一半」的状态。
 *
 * 备份文件与真实文件同目录（不是集中堆在一个备份目录里）：跨卷 copy 会失败，
 * 而「和原文件放一起」也让用户找得到。
 */

const BACKUP_MARKER = ".openwiki-launcher-backup-";

/**
 * 解开符号链接得到真实路径。
 *
 * dotfiles 用户会把 ~/.claude.json 软链进 git 仓库；直接写链接路径会把链接
 * 替换成普通文件，等于毁了用户的 dotfiles 管理。找不到时（文件还不存在）
 * 用「最近的已存在祖先 + 余下段」拼出目标位置，保证对尚未创建的文件也能定位。
 *
 * @param {string} targetPath
 * @returns {string}
 */
export function resolveRealTarget(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    const dir = path.dirname(targetPath);
    try {
      return path.join(realpathSync(dir), path.basename(targetPath));
    } catch {
      // 目录也不存在：向上找最近的存在祖先
      let current = path.resolve(dir);
      for (;;) {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(targetPath);
        try {
          return path.join(realpathSync(parent), path.relative(parent, path.resolve(targetPath)));
        } catch {
          current = parent;
        }
      }
    }
  }
}

/**
 * 在改一个文件之前给它拍个快照。
 *
 * @param {string} targetPath 即将被修改的文件（可以是符号链接）
 * @param {string} backupDir 备份文件所在目录，通常就是目标所在目录
 * @param {() => Date} [now] 时间戳来源，测试可注入
 * @returns {{ path: string, realPath: string, backupPath: string, existed: boolean }}
 */
export function createBackup(targetPath, backupDir, now = () => new Date()) {
  const realPath = resolveRealTarget(targetPath);
  const dir = path.dirname(realPath);
  const stamp = now().toISOString().replace(/[:.]/gu, "-");
  const backupPath = path.join(dir, `${path.basename(realPath)}${BACKUP_MARKER}${stamp}`);

  const existed = existsSync(realPath);
  if (existed) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(backupPath, readFileSync(realPath));
  }
  return { path: targetPath, realPath, backupPath, existed };
}

/**
 * 按快照批量回滚：原本存在的恢复原状，原本不存在的删掉。
 *
 * 单个失败不中断后续恢复 —— 恢复动作本身失败时也要把其余文件尽量还原，
 * 最后再抛出汇总异常，否则用户会同时失去「文件被改坏」和「文件没恢复」两件事。
 *
 * @param {Array<{ realPath: string, backupPath: string, existed: boolean }>} backups
 */
export function rollbackAll(backups) {
  /** @type {string[]} */
  const failures = [];

  for (const b of backups) {
    try {
      if (b.existed) {
        mkdirSync(path.dirname(b.realPath), { recursive: true });
        copyFileSync(b.backupPath, b.realPath);
      } else {
        rmSync(b.realPath, { force: true });
      }
    } catch (error) {
      failures.push(`${b.realPath}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`回滚失败，${failures.length} 个文件未能恢复:\n${failures.join("\n")}`);
  }
}