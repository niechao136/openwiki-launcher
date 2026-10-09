import { describe, expect, it } from "vitest";
import { createLineParser, formatMessage } from "../src/jsonrpc.mjs";

describe("createLineParser", () => {
  it("parses one message delivered in two chunks", () => {
    const seen = [];
    const parser = createLineParser((message) => seen.push(message));

    parser.write('{"jsonrpc":"2.0","id":1');
    parser.write(',"result":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

    expect(seen).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
  });

  it("parses two complete messages from one chunk", () => {
    const seen = [];
    const parser = createLineParser((message) => seen.push(message));

    parser.write('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":[]}\n');

    expect(seen).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: [] },
    ]);
  });

  it("parses a 2MB single line without truncating it", () => {
    const seen = [];
    const parser = createLineParser((message) => seen.push(message));
    const blob = "x".repeat(2 * 1024 * 1024);

    parser.write(formatMessage({ jsonrpc: "2.0", id: 9, result: { blob } }));

    expect(seen).toHaveLength(1);
    expect(seen[0].result.blob).toHaveLength(blob.length);
  });

  it("reports an unparsable line and keeps parsing later messages", () => {
    const seen = [];
    const parser = createLineParser((message) => seen.push(message));

    parser.write('not json\n{"jsonrpc":"2.0","id":3,"result":{}}\n');

    expect(seen[0]).toEqual({ invalid: "not json" });
    expect(seen[1]).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("ignores blank lines", () => {
    const seen = [];
    const parser = createLineParser((message) => seen.push(message));

    parser.write('\n\n{"jsonrpc":"2.0","id":4,"result":{}}\n\n');

    expect(seen).toEqual([{ jsonrpc: "2.0", id: 4, result: {} }]);
  });
});

describe("formatMessage", () => {
  it("emits exactly one newline-terminated JSON line", () => {
    const line = formatMessage({ a: 1 });

    expect(line).toBe('{"a":1}\n');
    expect(JSON.parse(line)).toEqual({ a: 1 });
  });
});
