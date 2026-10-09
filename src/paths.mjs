import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Raised when the openwiki dependency cannot be located.
 *
 * The launcher never guesses a global installation path: a wrong guess starts
 * the wrong backend, or none at all, and the host sees a timeout instead of a
 * diagnosis.
 */
export class OpenwikiNotFoundError extends Error {}

/**
 * Resolves the pinned openwiki dependency and the CLI entry the broker spawns.
 *
 * Resolution goes through Node module resolution from this package, so the
 * absolute path may contain spaces and never depends on PATH, on an nvm shim,
 * or on a globally installed openwiki.
 *
 * @returns {Promise<{ packageRoot: string, version: string, cliJs: string }>}
 * Absolute package root, declared version, and absolute CLI entry path.
 */

export async function resolveOpenwikiRuntime() {
  const require = createRequire(import.meta.url);
  let packageJsonPath;
  let cliJs;
  try {
    packageJsonPath = require.resolve("openwiki/package.json");
    cliJs = require.resolve("openwiki/dist/cli/cli.js");
  } catch (error) {
    throw new OpenwikiNotFoundError(`cannot resolve openwiki dependency: ${error.message}`);
  }
  const packageRoot = path.dirname(packageJsonPath);
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return { packageRoot, version, cliJs };
}
