import { markDefaultRemoved } from "../ensure-default.mjs";
import { bundledOpenwikiVersion } from "../paths.mjs";
import { removeVersion } from "../versions.mjs";

/**
 * `versions` 命令：本地版本目录的管理入口。
 *
 * 目前只有一个子命令 remove。快照文件不随版本删除——几十 KB，且随包发布的出厂
 * 快照重装即恢复；删了反而丢掉「这个版本曾经录过快照」的记录。
 */

const USAGE = "用法: openwiki-launcher versions remove <version>";

/**
 * @param {{ logger: object, pkgRoot: string, args: string[] }} options
 * @returns {Promise<number>} Exit code.
 */
export async function runVersionsCommand({ logger, pkgRoot, args }) {
  const [subcommand, version, ...rest] = args;
  if (subcommand !== "remove" || !version || rest.length > 0) {
    logger.info(USAGE);
    logger.error(subcommand === undefined ? "缺少子命令" : `无法识别的参数: ${args.join(" ")}`);
    return 1;
  }

  const outcome = removeVersion(pkgRoot, version);
  switch (outcome.reason) {
    case "active":
      logger.error(`openwiki@${version} 是当前激活版本，不能删除；先 switch 到别的版本再删`);
      return 1;
    case "invalid":
      logger.error(`版本名必须是 x.y.z 形式的三段数字，收到: ${JSON.stringify(version)}`);
      return 1;
    case "not-installed":
      logger.error(`openwiki@${version} 未安装`);
      return 1;
    default:
      logger.info(`已删除 openwiki@${version}（manifest/openwiki-${version}.json 快照保留）`);
      // 删的是默认版本：记一笔，让后台自愈别再把它长回来（否则"删了又回来"）。
      // 只有显式命令（install / warm / switch）会重建并清掉这个标记。
      if (version === bundledOpenwikiVersion(pkgRoot)) {
        markDefaultRemoved(pkgRoot, version);
        logger.info(`已记录：openwiki@${version} 是默认版本，不再自动重建；需要时用 install / warm / switch 重建`);
      }
      return 0;
  }
}
