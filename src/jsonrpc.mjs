/**
 * Line-delimited JSON-RPC framing shared by every stdio MCP surface.
 *
 * The transport is newline-delimited JSON: one complete JSON-RPC message per
 * line. A parser must therefore tolerate arbitrary chunk boundaries, because a
 * host or backend may split a message anywhere.
 */

/**
 * Feeds one raw line to the message consumer, tolerating CRLF endings.
 *
 * @param {string} rawLine - Line without its trailing newline.
 * @param {(message: object) => void} onMessage - Message consumer.
 */
function handleLine(rawLine, onMessage) {
  const line = rawLine.replace(/\r$/, "").trim();
  if (!line) return;

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A line that is not JSON cannot be a protocol message. Report it in a
    // shape the caller can log and keep parsing: dropping later messages
    // because of one bad line would silently break the session.
    onMessage({ invalid: line });
    return;
  }

  // Deliver outside the parse guard: a throwing consumer must not turn a
  // perfectly valid message into an "invalid line" report, which would make the
  // broker drop a real request and leave the host waiting.
  onMessage(parsed);
}

/**
 * Creates an incremental parser for newline-delimited JSON-RPC.
 *
 * @param {(message: object) => void} onMessage - Receives parsed messages, or
 * `{ invalid }` for lines that are not parseable JSON.
 * @returns {{ write(chunk: string): void, end(): void }} Parser handle.
 */
export function createLineParser(onMessage) {
  let buffer = "";

  return {
    write(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line, onMessage);
      }
    },
    end() {
      const rest = buffer;
      buffer = "";
      handleLine(rest, onMessage);
    },
  };
}

/**
 * Formats one message as a single newline-terminated JSON line.
 *
 * @param {object} message - JSON-RPC message.
 * @returns {string} Wire representation including the trailing newline.
 */
export function formatMessage(message) {
  return `${JSON.stringify(message)}\n`;
}
