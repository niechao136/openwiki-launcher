#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestFilePath } from "../src/manifest.mjs";
import { writeManifest } from "../src/gen-manifest.mjs";

/**
 * `npm run manifest` 的入口：录制当前 openwiki 的快照。
 *
 * 生成逻辑在 src/gen-manifest.mjs（update 命令也要用它给未激活的版本录快照），
 * 这里只剩「被直接运行时才动手」的包装。
 */

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const manifest = await writeManifest();
  console.log(
    `wrote ${manifestFilePath(manifest.openwikiVersion)} (${manifest.tools.length} tools)`,
  );
}
