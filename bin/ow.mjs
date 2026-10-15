#!/usr/bin/env node
import { runOpenwikiCli } from "../src/openwiki-cli.mjs";
import { createLogger } from "../src/log.mjs";

const logger = createLogger({ debug: process.env.LAUNCHER_DEBUG === "1" });
process.exitCode = await runOpenwikiCli({ args: process.argv.slice(2), logger });
