---
type: subsystem
title: 卸载与归属判定
description: 卸载如何做到只删自己写过的东西：归属判定优先用收据中当时写入的 command、sha256 不匹配即跳过、共享目录只移除本家记录，以及不做顺手清理的设计边界。
tags: [uninstall, ownership, receipt, safe-removal]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-a4f5a4545f8074c813e8e76f
    resource: repo://src/skill-install.mjs
  - id: openwiki-source-82ad0bac05d48ab1a24b4e91
    resource: repo://src/targets.mjs
  - id: openwiki-source-94ff95c1f11b8b7df6ddb6c1
    resource: repo://src/uninstall.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 卸载与归属判定

## 两条硬规则

`src/uninstall.mjs` 的模块头把它们写得很直接：

1. **只删自己写过的东西。** skill 目录要收据 + 逐文件 sha256 全匹配才删；MCP 条目要确认指向本安装器才删。用户手改过的、或者指向别处的一律跳过，并说清楚为什么跳过。
2. **不做「顺手清理」。** 不删备份文件、不删用户目录、不动其他 server 的条目。

第二条与第一条同等重要。卸载器最容易犯的错是「既然来了就顺便收拾干净」——而它无法知道那些东西是不是用户想要的。

## 与安装共用同一套解析

卸载复用 `targets.mjs` 的 `resolveScope`、`resolveTargets`、`collectDetectSnapshot`、`collectMcpSnapshot`。必须复用：两者的作用域语义、别名解析、detect 判定一旦分叉，就会出现「装到了 A 目录、卸载去 B 目录找」这种删不掉的残留。

与安装相同的还有「未知宿主在任何写入之前拒绝」与「快照一律用真实的 `existsSync`」。

## skill：两道校验

`removeSkill(skillDir, logger, { hostId })`：

1. **收据 + sha256。** 哈希全匹配才删；不匹配则跳过并列出改动过的文件（原因 `modified`）；收据不存在则是 `missing`。
2. **共享目录。** 传入 `hostId` 后，若收据里还有其他宿主，只把本家从 `hosts` 移除、`target` 改为剩余第一个，**目录保留**（原因 `shared`）。

共享目录不是边缘情况：codex、antigravity、bob 三家都用 `.agents/skills`，目录里只有一份 openwiki skill，宿主之间是「谁来读它」的关系。

## MCP：归属判定优先用收据里当时写入的 command

这是卸载里最容易做错的一处，也是代码注释花笔墨最多的地方：

```js
const receipt = skillDir ? readReceipt(skillDir) : null;
const mine = receipt?.mcpServerCommand
  ?? { command: nodeCommand.command, args: [selfBin, "mcp", "--host", host.id] };
```

**为什么不直接用当前的 node 路径和 bin 路径比对？** 因为用户升级 node 或换了全局 npm 前缀之后，**当前路径已经变了**。拿它比对会把「自己写的条目」判成「不是本安装器写入的」，于是条目被留在配置里——**而退出码是 0**。用户会看到「该条目不是本安装器写入的，未触碰」，然后永远删不掉它。

收据里记着安装当时写入的 `mcpServerCommand`，那是唯一可靠的归属凭据。读不到收据时才退化为按当前路径推断。

判定用 `isOursEntry`（与安装、plan、doctor 共用同一口径，认三种条目形态）。判定为「不是我们的」时给出两种可读原因：

- `配置里没有 openwiki 条目`
- `该条目不是本安装器写入的，未触碰`

## 写入前同样先备份

删除条目前 `createBackup`，全部处理完后若任一宿主出错，`rollbackAll(backups)` 恢复配置并返回 1。回滚只针对**本次卸载写入**的内容，与安装侧对称。

## 结束时明确交代备份

卸载成功后的最后一句固定输出：

> 备份文件（形如 `*.openwiki-launcher-backup-*`）不会自动删除，确认无误后可自行清理。

这是第二条硬规则的用户可见形式。备份是唯一的回退手段，自动删掉等于把安全网一起扔了；至于什么时候清理，交给用户判断——本工具无法替他决定那个文件是不是还有用。

## 报告粒度

报告按宿主逐家输出，每家两行：`skill` 是「已删除」还是「未删除 + 原因」，`mcp` 是「已删除」还是「未改动 + 原因」。跳过的每一步都有可读理由，用户不需要去猜是哪里没清干净。

## 相关页面

- [安装决策器与安装编排](./install-plan.md)
- [Skill 目录安装、收据与完整性校验](./skill-install.md)
- [安全护栏、备份与回滚](../safety/guards-and-backups.md)
- [宿主注册表](./host-registry.md)
