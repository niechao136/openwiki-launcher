/**
 * stderr diagnostics for the launcher.
 *
 * stdout belongs to the MCP wire: a single stray byte there corrupts the
 * session. Every diagnostic therefore goes to stderr behind one prefix.
 */

/**
 * Creates a logger writing prefixed lines to a sink.
 *
 * @param {{ debug?: boolean, sink?: { write(text: string): unknown } }} options
 * @returns {{ info(message: string): void, debug(message: string): void, error(message: string): void }}
 */
export function createLogger({ debug = false, sink = process.stderr } = {}) {
  const write = (text) => {
    sink.write(text);
  };

  return {
    info(message) {
      write(`[launcher] ${message}\n`);
    },
    debug(message) {
      if (debug) write(`[launcher] debug: ${message}\n`);
    },
    warn(message) {
      write(`[launcher] warn: ${message}\n`);
    },
    error(message) {
      write(`[launcher] ${message}\n`);
    },
  };
}
