import { describe, it, expect } from "vitest";
import {
  spliceJsonEntry, readJsonEntry,
  upsertTomlBlock, removeTomlBlock, readTomlBlock,
  TOML_START, TOML_END,
} from "../src/mcp-config.mjs";

const cmd = { command: "/abs/node", args: ["/abs/bin/openwiki-launcher.mjs", "mcp", "--host", "claude"] };
const entryJson = JSON.stringify(cmd, null, 2);
const call = (text, extra = {}) =>
  spliceJsonEntry(text, { containerKey: "mcpServers", entryKey: "openwiki", entryJson, ...extra });

describe("json（mcpServers.openwiki）", () => {
  it("空文本与纯空白都按空配置处理", () => {
    for (const input of ["", "   \n\n"]) {
      const r = call(input);
      expect(JSON.parse(r.text).mcpServers.openwiki).toEqual(cmd);
      expect(r.action).toBe("created");
    }
  });

  it("空配置产出合法的 JSON 文本", () => {
    expect(call("").text.endsWith("\n")).toBe(true);
    expect(JSON.parse(call("").text)).toEqual({ mcpServers: { openwiki: cmd } });
  });

  it("保留 BOM", () => {
    expect(call("\uFEFF{}").text.startsWith("\uFEFF")).toBe(true);
  });

  it("保留其他 server 条目与缩进逐字节不变", () => {
    const input = [
      "{", '  "mcpServers": {', '    "other": {', '      "command": "x"', "    }", "  },",
      '  "otherTop": 1', "}", "",
    ].join("\n");
    const r = call(input);
    expect(r.action).toBe("created");
    expect(JSON.parse(r.text)).toMatchObject({
      otherTop: 1,
      mcpServers: { other: { command: "x" }, openwiki: cmd },
    });
    expect(r.text).toContain('    "other": {');
    expect(r.text.endsWith("}\n")).toBe(true);
  });

  it("已存在等值条目时逐字节不变", () => {
    const first = call("");
    const second = call(first.text);
    expect(second.action).toBe("unchanged");
    expect(second.text).toBe(first.text);
  });

  it("已存在不同值条目时替换并标记 updated", () => {
    const base = call("", {
      entryJson: JSON.stringify({ command: "openwiki", args: ["mcp", "--host", "claude"] }),
    });
    expect(call(base.text).action).toBe("updated");
    expect(JSON.parse(call(base.text).text).mcpServers.openwiki).toEqual(cmd);
  });

  it("删除条目只影响该键，其他条目保留", () => {
    const base = call('{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    const r = spliceJsonEntry(base.text, {
      containerKey: "mcpServers", entryKey: "openwiki", entryJson: null,
    });
    expect(r.removed).toBe(true);
    expect(JSON.parse(r.text).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("删除后容器变空则连容器键一起删（卸载后的形态）", () => {
    const base = call("");
    const r = spliceJsonEntry(base.text, {
      containerKey: "mcpServers", entryKey: "openwiki", entryJson: null,
    });
    expect(r.removed).toBe(true);
    expect(JSON.parse(r.text).mcpServers).toBeUndefined();
  });

  it("容器不存在时创建它", () => {
    const r = call('{\n  "otherTop": 1\n}\n');
    expect(JSON.parse(r.text)).toMatchObject({ otherTop: 1, mcpServers: { openwiki: cmd } });
  });

  it("畸形内容拒绝写入且原文本逐字节不变（审查重点 1）", () => {
    for (const bad of [
      '{\n  "mcpServers": {\n    "a": 1,\n  }\n}\n',      // 尾逗号
      '{\n  // 我的注释\n  "mcpServers": {}\n}\n',  // 注释混入 .json
      '{\n  "mcpServers": {\n',                      // 括号不配对
    ]) {
      expect(() => call(bad)).toThrow(/无法解析|括号不配对/u);
    }
  });
});

describe("opencode jsonc（mcp.openwiki）", () => {
  it("保留注释与兄弟条目", () => {
    const input = [
      "{", "  // 我的 opencode 配置", '  "model": "x",', '  "mcp": {',
      "    // 已有 server",
      '    "other": { "type": "local", "command": ["x"], "enabled": true }', "  }", "}", "",
    ].join("\n");
    const r = spliceJsonEntry(input, {
      containerKey: "mcp",
      entryKey: "openwiki",
      allowComments: true,          // opencode 用的是 jsonc，注释合法
      entryJson: JSON.stringify({
        type: "local", command: ["/n", "mcp", "--host", "opencode"], enabled: true,
      }, null, 2),
    });
    expect(r.text).toContain("// 我的 opencode 配置");
    expect(r.text).toContain("// 已有 server");
    expect(JSON.parse(r.text.replace(/^\s*\/\/.*$/gmu, "")).mcp.openwiki)
      .toMatchObject({ type: "local", enabled: true });
  });
});

describe("reader", () => {
  it("readJsonEntry 读出当前值", () => {
    expect(readJsonEntry(call("").text, { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toEqual(cmd);
    expect(readJsonEntry('{"mcpServers":{}}', { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toBeNull();
  });

  it("readJsonEntry 在畸形文本上抛错而不是静默返回 null", () => {
    expect(() => readJsonEntry('{"mcpServers":{', { containerKey: "mcpServers", entryKey: "openwiki" }))
      .toThrow(/无法解析|括号不配对/u);
  });

  it("readTomlBlock 读出块内容，无 marker 时返回 null", () => {
    const block = [
      "[mcp_servers.openwiki]", 'command = "/abs/node"',
      'args = ["/abs/b.mjs", "mcp", "--host", "codex"]',
    ].join("\n");
    const text = upsertTomlBlock('model = "x"\n', { tableName: "mcp_servers.openwiki", block }).text;
    expect(readTomlBlock(text, { tableName: "mcp_servers.openwiki" })).toBe(block);
    expect(readTomlBlock('[mcp_servers.openwiki]\ncommand = "openwiki"\n',
      { tableName: "mcp_servers.openwiki" })).toBeNull();
  });
});

describe("codex toml", () => {
  const block = [
    "[mcp_servers.openwiki]", 'command = "/abs/node"',
    'args = ["/abs/b.mjs", "mcp", "--host", "codex"]',
  ].join("\n");

  it("marker 常量不是原生的 OPENWIKI:MCP", () => {
    expect(TOML_START).toBe("# OPENWIKI-LAUNCHER:MCP:START");
    expect(TOML_END).toBe("# OPENWIKI-LAUNCHER:MCP:END");
  });

  it("保留其他表", () => {
    const r = upsertTomlBlock('model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n',
      { tableName: "mcp_servers.openwiki", block });
    expect(r.text).toContain("[mcp_servers.other]");
    expect(r.text).toContain('model = "x"');
    expect(r.text).toContain(TOML_START);
    expect(r.text).toContain("[mcp_servers.openwiki]");
  });

  it("连续两次 upsert 不产生两个块且逐字节一致", () => {
    const first = upsertTomlBlock("", { tableName: "mcp_servers.openwiki", block });
    const second = upsertTomlBlock(first.text, { tableName: "mcp_servers.openwiki", block });
    expect(second.action).toBe("unchanged");
    expect(second.text).toBe(first.text);
  });

  it("删除块连同前导空行一起吃掉，使文件逐字节回到原样", () => {
    const before = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
    const text = upsertTomlBlock(before, { tableName: "mcp_servers.openwiki", block }).text;
    expect(removeTomlBlock(text, { tableName: "mcp_servers.openwiki" }).text).toBe(before);
  });

  it("无 marker 的裸表不视为 launcher 的块，不删除", () => {
    const native = '[mcp_servers.openwiki]\ncommand = "openwiki"\n';
    expect(removeTomlBlock(native, { tableName: "mcp_servers.openwiki" }).removed).toBe(false);
  });
});