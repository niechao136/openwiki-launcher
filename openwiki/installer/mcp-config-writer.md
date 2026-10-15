---
type: subsystem
title: MCP 配置文件读写（json / codex-toml / opencode-json）
description: mcp-config.mjs 如何在保留用户注释、缩进与其他条目的前提下精确切片替换 openwiki 条目：注释掩码、结构检查、幂等判定与三种格式的差异。
tags: [mcp-config, text-splice, jsonc, toml, idempotency]
sources:
  - id: openwiki-source-a30d02ce508a693ed6aed708
    resource: repo://src/mcp-config.mjs
  - id: openwiki-source-25b67ca644bd99d29a60497f
    resource: repo://src/plan.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
---

# MCP 配置文件读写（json / codex-toml / opencode-json）

## 为什么是文本切片而不是 parse-and-reprint

`src/mcp-config.mjs` 对三种配置格式统一用**文本切片替换**：定位目标键值的字节区间，只替换那一段，其余字节原样输出。不用 `JSON.parse` + `JSON.stringify` 整体重写，有两个真实用户会遇到的理由：

1. 用户的**注释、缩进风格、键顺序、其他 server 的条目**都会在重写中丢失——`opencode.jsonc` 的注释尤其致命；
2. 解析失败时不能「当成空对象写回去」，那等于清空用户的 MCP 配置。所以文本畸形一律抛错，原文件逐字节不动。

副作用是**零新增运行时依赖**：不需要 `jsonc-parser`，也不需要 TOML 解析器。

## 核心技术：codeMask

`codeMask(text, allowComments)` 生成一份与原文**等长**的「只看结构」副本：

- 注释与字符串的**内容**被替换成空格；
- **引号本身保留**（判断字符串边界要用）；
- **换行保留**（缩进推断要用）；
- 字符串内的转义序列被整体吞成两个空格，因此在 mask 上「下一个引号就是闭合引号」，不再需要处理转义与嵌套。

因为长度不变，**mask 上的任何偏移量都能直接用在原文上**——这就是让偏移量在原文与掩码间通用的原因。括号配对（`matchBraces`）与键定位（`findMember`）都可以在 mask 上用最朴素的循环完成，转义与嵌套字符串的复杂性一次解决。函数末尾还会断言 `out.length === text.length`，不等就抛内部错误。

`allowComments` 为 false（纯 JSON）时遇到注释直接抛错——这正是「`.json` 里混进注释」被拒绝的原因。`opencode-json` 传 true，`codex-toml` 不走这条路。

## 结构完整性检查

- **`matchBraces`** 用栈做括号配对，错配与未闭合都抛错，并顺带调用尾逗号检查。
- **`assertNoTrailingComma`** 显式拒绝尾随逗号。`{"a":1,}` 这种文件括号配对与键语法都合法，但 JSON 不允许尾随逗号；一旦被当成空对象重写，等于静默吞掉用户的一个条目。
- **`valueEndAt`** 返回**开区间**下标，可直接用于 `slice(valueStart, valueEnd)`。括号配对表给出的是闭合括号自身的下标，这里必须 +1，否则每个对象值都会被切掉最后一个字符。
- **`findMember` 返回的 `range`** 只在该键的值是对象/数组时存在。「成员」与「对象区间」是两种形状，混用会让 `.start` 变成 undefined 而静默失配——这是刻意区分的。

键名从**原文**读（mask 里字符串内容已被空格替换，读不出真名），偏移量全部来自 mask。

## spliceJsonEntry：容器 → 条目两级 upsert

入口签名：`spliceJsonEntry(text, { containerKey, entryKey, entryJson, allowComments })`。`entryJson` 为 `null` 表示删除。

几个关键分支：

**BOM 保留。** 文件开头的 BOM 单独摘出，写回时拼在最前。

**空/纯空白视为空配置。** 没有可损坏的内容，直接写出完整结构并返回 `created`。

**前导空白要跳过。** 编辑器模板与 `echo` 拼接很容易产出 `\n{ ... }`，根对象起点不是下标 0。

**删除时容器变空则连容器键一起删**——卸载后不留空壳。删完会重新 `codeMask` 一遍再判断。

**幂等判定。** 现有条目的值与期望值 `JSON.stringify` 后相等时，返回 `unchanged` 且**文本逐字节不变**（连 BOM 都不重排）。这是重复安装不产生任何文件改动的基础。

**逗号处理是这个模块最容易出错的地方**，代码里为此写了两条注释：

- 更新已有成员时，只有**后面还有成员**才补尾随逗号；只有它一个时补了就是尾随逗号，JSON 直接崩。
- 插入新成员时，「需不需要尾随逗号」的正确判据是**插入点之后、容器闭合之前是否还有内容**，而不是「容器原来非空」。多行格式里新成员插到最前面（后面有成员 → 要逗号），单行格式里插到最后一个（后面没成员 → 不要逗号），两种情况「容器原来都非空」。
- 单行压缩 JSON 里插入点紧跟在上一个值后面（没有换行可借），必须由 `needsCommaBefore` 自己补逗号，否则会产出 `{"a":1"mcpServers":{...}}` 这种非法 JSON，**而且被当成 created 成功写盘**。

**缩进靠推断。** `inferIndent` 有兄弟成员就沿用兄弟的缩进，没有就用父级缩进加两格。这样新条目与用户既有风格一致。

**删除区间要精确。** `deleteMemberSpan` 分两种情况：后面还有成员就吃掉**尾随**逗号与本行换行；自己是最后一个就改吃**前导**逗号。关键是用 `skipInlineSpace`（只跳空格制表符）而不是 `skipSpace`（跨行）——后者会把下一个成员的缩进一起吃掉，用户文件里那个成员就贴到行首了。

## readJsonEntry 为什么对畸形文本抛错

`readJsonEntry` 在容器或条目不存在时返回 `null`，但**文本畸形时抛错**。原因在它的注释里：卸载与 doctor 依赖它判断「这条目是不是我们写的」，静默返回 `null` 会让卸载误判成「用户自己写的」而把条目留在那里——一个删不掉的残留，比一次明确的报错更难排查。

`plan.mjs` 的 `readExistingEntry` 与 `doctor.mjs` 的 `readEntry` 都在外面包了 try/catch，把抛错降级为「读不出来」，由上层按「读不出来不等于空配置」处理。

## TOML：哨兵块约定

Codex 的 `config.toml` 用哨兵注释包裹本安装器写入的表：

```toml
# OPENWIKI-LAUNCHER:MCP:START
[mcp_servers.openwiki]
command = "..."
args = ["...", "mcp", "--host", "codex"]
# OPENWIKI-LAUNCHER:MCP:END
```

**标记刻意不复用 openwiki 原生的 `OPENWIKI:MCP:*`**——两个安装器写同一个文件，共用标记会互相误切对方写的块。

`upsertTomlBlock` 已存在哨兵时，比较**必须走 `readTomlBlock`**：marker 区间里存的是 `<block>\n`，直接切原始文本会多带一个换行，导致「已经是你要的」被误判成需要更新。

`removeTomlBlock` 连同 marker 前面的分隔空行一起吃掉，让文件逐字节回到安装前。**没有 marker 的裸表返回 `removed: false`**——那是 openwiki 原生或用户手写的，本安装器无权删除。

## 三种载荷形状

| kind | 载荷 |
| --- | --- |
| `json` | `{ "command": <绝对路径>, "args": [<bin>, "mcp", "--host", <id>] }` |
| `opencode-json` | `{ "type": "local", "command": [<command>, ...args], "enabled": true }` |
| `codex-toml` | `[mcp_servers.openwiki]` 表，含 `command` 与 `args` |

写进去的 `command` 是 node 的**绝对路径**，不是 `"node"`。本包存在的意义就是消灭全局路径探测、空格路径与 nvm shim 这三类故障，配置里不该再留一个要靠 PATH 解析的东西。

## 相关页面

- [宿主注册表](./host-registry.md)
- [安装决策器与安装编排](./install-plan.md)
- [卸载与归属判定](./uninstall.md)
- [安全护栏、备份与回滚](../safety/guards-and-backups.md)
