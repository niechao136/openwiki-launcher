---
type: subsystem
title: "安全护栏、备份与回滚"
description: guards.mjs 的系统目录与主目录拒绝规则，以及 backup.mjs 的同目录备份、符号链接解析与逐项回滚。
tags: [guards, backup, rollback, safety]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-10T08:12:25.306Z
sources:
  - id: openwiki-source-d0f4b9f3d483074f247655a4
    resource: repo://src/backup.mjs
  - id: openwiki-source-c346a3d078823ecde57ba108
    resource: repo://src/guards.mjs
  - id: openwiki-source-b995d49faa81ab47b4496f9b
    resource: repo://src/install.mjs
generated: { by: "codebuddy", at: "2026-10-10T08:12:25.306Z" }
---

# 安全护栏、备份与回滚

## 护栏：什么时候拒绝写入

安装器会往用户的宿主目录里写文件，护栏负责在写之前把明显不该写的地方挡掉。

### 系统目录：不可绕过

`isSystemDir(targetPath, opts)` 判断路径是否落在系统目录里，含该目录本身。系统根按平台取：unix 是 /usr、/etc、/bin、/sbin、/var、/opt、/System、/Library、/private/etc；win32 的四个根来自环境变量 SystemRoot、ProgramFiles、ProgramFiles(x86)、ProgramData，各带一个几乎不会变的默认值。

**这一条没有 --force 绕过。**

判定前有三条放行规则，每条都对应一个踩过的坑。第一，home 及其之下放行：主目录另有护栏，否则合法的全局目标（例如 home 下的某宿主技能目录）会被自家护栏拦下。第二，tmpdir 及其之下放行：macOS 的 TMPDIR 落在 /private/var 下会命中 /var 规则，而 CI、测试、先在临时目录试一下都是正当用途。第三，文件系统根与盘根一律拒绝。

### 主目录里的项目级安装：可以绕过

`isHomeDir` **只判「相等」不判「在其之下」**。理由写在注释里：判断安装目标是否落在 home 上时，语义是「用户其实想装全局，却在一个项目语境里跑」，而不是 home 的所有子目录都可疑。

这一条**可以**用 `--force` 绕过。用户在 home 根目录下 clone 了一个项目并想给它装 skill，是合理需求。

### 为什么所有隐式全局都改成入参

判定规则移植自 superpowers-zh，但 `process.platform`、`homedir()`、`tmpdir()`、`process.env` 全部改成参数注入。这样测试无需打桩全局就能覆盖 win32 与 unix 两套分支——**而这套逻辑恰恰是最容易「在非 Windows 上根本没法测」的部分**。`defaultSystemRoots` 因此可以被断言「`SystemRoot` 被改成 `D:\Win` 时第一个根就是 `D:\Win`」。

### 归一化与 realpath

`normalizeForCompare` 把分隔符统一成 `/`、去掉尾斜杠、win32 下再小写。不做这层归一化，同一条路径写成 `C:\Windows` 还是 `C:/Windows` 会得出不同结论。

`safeRealpath` 在解析失败时退化成绝对路径。**比较时两侧都做 realpath**：系统根也必须解析，否则 macOS 上 `/var/...` 与 `/private/var/...` 会被判成两个不同的地方（代码注释标注为实测踩到）。

## exit 2 与零字节写入的保证

护栏在 `planInstall` 里对每个 entry 的 skill 目录与 MCP 配置路径判定，结果汇总到 `guarded` 与 `guardReason`。`runInstall` 在**任何写入之前**检查：只要有一个 entry 被拒，就打印每家的拒绝理由并返回 `exitCode: 2`。

因此退出码 2 的含义非常具体：**本次安装没有写入任何文件**。不是「写了一部分后失败」，而是「一个字节都没写」。被拒的条目在执行阶段被整体拦掉，而不是「跳过这一个文件、继续写别的」。

## 备份：为什么写在真实文件同目录

安装器要改的是用户的 MCP 配置文件——里面可能有注释、其他 server、用户自己的参数。任何一步失败都必须能把这些文件恢复原状，而不是停在「装了一半」的状态。

备份文件名是 `<basename>.openwiki-launcher-backup-<ISO 时间戳>`（冒号与点换成连字符），放在**真实文件所在目录**。理由有两条：

- **跨卷 copy 会失败**——集中堆在一个备份目录里，遇到跨卷就复制不了；
- **和原文件放一起让用户找得到**。

原本不存在的文件（`existed` 为假）**不产生备份文件**，只记一条「原本不存在」，回滚时直接删掉。

## 符号链接解析

`resolveRealTarget(targetPath)` 解开软链得到真实路径。

理由：dotfiles 用户会把 `~/.claude.json` 软链进 git 仓库；**直接写链接路径会把链接替换成普通文件**，等于毁了用户的 dotfiles 管理。

文件还不存在时逐级上溯：找最近的已存在祖先的 realpath，拼上余下段。因此对尚未创建的文件也能定位到「它将来会在哪」。

## 回滚：尽力而为，最后汇总

`rollbackAll(backups)` 逐项处理：原本存在的从备份复制回来，原本不存在的删掉。

**单个失败不中断后续恢复**——恢复动作本身失败时也要把其余文件尽量还原，最后再抛出汇总异常。否则用户会同时失去「文件被改坏」和「文件没恢复」两件事。

回滚的调用点在安装与卸载两侧。

## 相关页面

- [安装决策器与安装编排](../installer/install-plan.md)
- [卸载与归属判定](../installer/uninstall.md)
- [快速上手](../quickstart.md)
