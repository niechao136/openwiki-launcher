import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs the real-backend smoke test on any platform.
 *
 * The gate lives in a script instead of an inline env assignment because
 * `LAUNCHER_REAL_SMOKE=1 vitest` is not valid on Windows shells.
 */
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    // The snapshot guard compares the committed manifest against a live
    // openwiki handshake; without it in this list, upstream drift would only
    // be caught by hand.
    "test/real-openwiki.test.mjs",
    "test/manifest.test.mjs",
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, LAUNCHER_REAL_SMOKE: "1" },
  },
);

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
