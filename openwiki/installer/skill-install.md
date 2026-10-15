---
type: subsystem
title: Skill 目录安装、收据与完整性校验
description: skill bundle 的白名单安全边界、.openwiki-launcher.json 收据的内容与用途、逐文件 sha256 校验，以及共享技能目录下多宿主共存的处理。
tags: [skill-install, receipt, sha256, allowlist, ownership]
sources:
  - id: openwiki-source-fe0e8939c28a8252895f4e54
    resource: repo://src/ownership.mjs
  - id: openwiki-source-a4f5a4545f8074c813e8e76f
    resource: repo://src/skill-install.mjs
  - id: openwiki-source-82ad0bac05d48ab1a24b4e91
    resource: repo://src/targets.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
---

# Skill 目录安装、收据与完整性校验

bundle 只有一个 skill（`SKILL.md` 加 `agents/*.yaml`），复制动作本身很轻。真正的设计重量在两件事上：**白名单**与**收据 + 逐文件 sha256**。

## 白名单：依赖内容不能直接进入用户仓库

bundle 里的文件树来自 npm 依赖（`openwiki` 包），复制到宿主的 skills 目录等于**让依赖的内容进入用户的仓库**。因此：

```js
ALLOWED_BUNDLE_FILES = ["SKILL.md"];
ALLOWED_BUNDLE_DIRS  = ["agents", "references"];
```

文件与目录分开声明——语义不同，混在一个数组里「顶层段是否在白名单内」说不清。

`listBundleFiles` 递归遍历时：

- 路径中**出现 `..` 直接抛错**，错误信息含「不允许的路径」；
- 顶层目录不在 `ALLOWED_BUNDLE_DIRS` 里就抛错——这正是 `scripts/` 被拒的原因；
- 顶层文件不在 `ALLOWED_BUNDLE_FILES` 里就抛错。

**必须整棵树校验完再开始写任何文件。** 半途才发现一个 `scripts/` 就已经写了三个文件，用户目录会停在「装了一半」的状态——那是最难收拾的一种结果。`installSkill` 的第一件事就是 `listBundleFiles(bundleDir)`，此时一个字都还没写。

`bundleDirFor(openwikiPackageRoot)` 只做拼接（`<openwiki>/integrations/openwiki`），不做存在性判断、不做任何路径探测。唯一允许的入参来源是 `resolveOpenwikiRuntime()` 返回的 `packageRoot`。

## 收据：`.openwiki-launcher.json`

安装完成后在目标目录写一份收据：

```json
{
  "package": "openwiki-launcher",
  "version": "<launcher 版本>",
  "target": "<宿主 id>",
  "hosts": ["<并集>"],
  "scope": "project | user",
  "skillDir": "<绝对路径>",
  "mcpServerCommand": { "command": "<node 绝对路径>", "args": ["<bin>", "mcp", "--host", "<id>"] },
  "files": { "SKILL.md": "<sha256>", "agents/bob.yaml": "<sha256>" }
}
```

### 两个收据文件严格区分

| 文件名 | 写入者 | 谁读 | 何时动 |
| --- | --- | --- | --- |
| `.openwiki-launcher.json` | 本安装器 | `readReceipt` / `verifySkill` / `receiptHosts` | 卸载时读写 |
| `.openwiki-install.json` | openwiki 原生安装器 | `targets.mjs` 的 `collectNativeSnapshot` | **只在接管时被删除** |

两者绝不混用。看到同名目录但没有本安装器的收据时，安装器会明确提示「将覆盖，里面的文件会被本安装器的 bundle 替换」。

### 收据读不出来时返回 null

`readReceipt` 在文件不存在或 JSON 解析失败时都返回 `null`。用户不该因为安装器的收据文件损坏而**无法卸载**——宁可保守处理。

## sha256 完整性校验

`verifySkill(targetDir)` 遍历收据里的 `files`，逐个重算 sha256：

- 收据缺失或 `files` 不是对象 → `{ ok: false, missing: true }`；
- 有文件不存在或哈希不符 → 收集到 `mismatches`。

用户可能手改过 `SKILL.md`。哈希不符就不删——**宁可留垃圾也不丢用户数据**。

## 共享技能目录：hosts 并集

codex、antigravity、bob 三家的技能目录都是 `.agents/skills`，即多个宿主共用同一个目录。

如果收据只记单个 `target`，后装的会覆盖先装的记录，**卸载任一家就会把整目录删掉、连带删掉别家的 skill**。因此收据记 `hosts` 并集：写入时把旧收据的 `hosts`（以及旧格式的 `target`）与本次的 `hostId` 合并去重排序。

`removeSkill` 在传入 `hostId` 时按「移除本宿主」语义处理：若收据里还有别的宿主，只把本家从 `hosts` 里去掉、`target` 改为剩余的第一个，**目录保留**并报告「还被 X 共用」。

这里的语义是：**目录里其实只有一份 openwiki skill，宿主之间是「谁来读它」的关系，不是「谁拥有它」的关系。**

## 与 MCP 条目归属的口径统一

`ownership.mjs` 的 `isOursEntry(existing, mine)` 认三种条目形态：

| 形态 | 判定 |
| --- | --- |
| `opencode-json`（command 是数组） | `command[0] === node 路径` 且 `command.slice(1)` 与 args 逐元素归一化后全等 |
| `codex-toml`（args 是块文本） | 抽出 args 字面量后与 json 同一套**逐元素比较**——不能退化成包含判断，否则 `--host cursor` 的块会被当成 claude 的 |
| `json`（command + args） | command 与 args 都逐元素归一化后全等 |

三种形态的路径比较统一走 `normalizeForCompare`，**不许逐字符比较**：Windows 路径不分大小写、正反斜杠混写是同一条路径，逐字符比较会让条目被当成用户的——uninstall 退出码 0 却留下永远删不掉的残留，plan 则会对同一条目反复报「接管」。

它被 install、uninstall、plan、doctor **四处共用**，口径必须一致。模块头部的注释写明了后果：如果 plan 与 uninstall 各写一份，opencode 的条目（command 是数组形态）会在 plan 里被判成「用户手写的」而误报接管，在 uninstall 里却能正确认出。用户会看到「已接管」这种错误结论，**而且加 `--no-takeover` 后再也无法更新自己的条目**。

`skillsDirFor` 同样住在这里：全局作用域下按平台选目录，win32 优先 `globalDirWin`。不做这个选择就会把 skill 装到宿主根本不扫的目录。

## 相关页面

- [宿主注册表](./host-registry.md)
- [安装决策器与安装编排](./install-plan.md)
- [卸载与归属判定](./uninstall.md)
