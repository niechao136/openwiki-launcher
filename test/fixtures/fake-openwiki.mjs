#!/usr/bin/env node
// Controllable stand-in for the openwiki MCP server.
//
// It exists so broker behaviour (queueing, restart, passthrough) can be tested
// without paying openwiki real 10-60s import cost on every run.
const delay = Number(process.env.FAKE_STARTUP_DELAY_MS ?? 0);
const serverName = process.env.FAKE_SERVER_NAME ?? "fake-openwiki";
const exitAfterMs = Number(process.env.FAKE_EXIT_AFTER_MS ?? 0);
const exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
const noise = process.env.FAKE_STDOUT_NOISE ?? "";

function send(message) {
  if (noise) process.stdout.write(noise + "\n");
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(message) {
  if (!message || typeof message !== "object") return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "9.9.9" },
        instructions: "fake instructions",
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "echo_a", description: "fake tool a", inputSchema: { type: "object" } },
          { name: "echo_b", description: "fake tool b", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ echoed: message.params && message.params.arguments }) },
        ],
        isError: false,
      },
    });
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore garbage, like a real server would
    }
  }
});

if (exitAfterMs > 0) {
  setTimeout(() => process.exit(exitCode), exitAfterMs).unref();
}

// Simulate a slow import phase: burn wall-clock time before serving.
if (delay > 0) {
  const until = Date.now() + delay;
  while (Date.now() < until) {
    // busy wait on purpose
  }
}
