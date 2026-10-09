import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Absolute path of the snapshot recorded for one openwiki version.
 *
 * @param {string} version - openwiki package version.
 * @returns {string} Absolute path to the manifest snapshot file.
 */
export function manifestFilePath(version) {
  return path.join(PACKAGE_ROOT, "manifest", `openwiki-${version}.json`);
}

/**
 * Loads the response snapshot for one openwiki version.
 *
 * A missing snapshot is not an error: this openwiki version has no recorded
 * response yet, so the broker must fall back to the real backend instead of
 * answering from cache.
 *
 * @param {string} version - openwiki package version.
 * @returns {object | null} Snapshot, or null when none is recorded.
 */
export function loadManifest(version) {
  try {
    return JSON.parse(readFileSync(manifestFilePath(version), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
