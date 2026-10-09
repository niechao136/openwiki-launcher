import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.mjs";

function collect(debug) {
  const lines = [];
  const logger = createLogger({
    debug,
    sink: { write: (text) => lines.push(text) },
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("prefixes info lines with [launcher]", () => {
    const { logger, lines } = collect(false);

    logger.info("x");

    expect(lines).toEqual(["[launcher] x\n"]);
  });

  it("suppresses debug lines unless debug is enabled", () => {
    const quiet = collect(false);
    quiet.logger.debug("y");
    expect(quiet.lines).toEqual([]);

    const loud = collect(true);
    loud.logger.debug("y");
    expect(loud.lines).toEqual(["[launcher] debug: y\n"]);
  });

  it("always writes error lines regardless of debug", () => {
    const { logger, lines } = collect(false);

    logger.error("z");

    expect(lines).toEqual(["[launcher] z\n"]);
  });

  it("marks warning lines so they stand out from errors", () => {
    const { logger, lines } = collect(false);

    logger.warn("drifted");

    expect(lines).toEqual(["[launcher] warn: drifted\n"]);
  });
});
