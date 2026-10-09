/**
 * Node version gate shared by the CLI and the doctor command.
 */
export const MIN_NODE = [22, 22, 0];

/**
 * Compares a Node version against the minimum this package supports.
 *
 * @param {string} version - Version to check, e.g. "24.21.0".
 * @returns {boolean} Whether the version is at least the minimum.
 */
export function nodeVersionSupported(version) {
  const parts = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const actual = parts[index] === undefined ? 0 : parts[index];
    if (actual > MIN_NODE[index]) return true;
    if (actual < MIN_NODE[index]) return false;
  }
  return true;
}
