---
type: subsystem
title: 版本命令：check / update / switch / versions
description: 版本管理子系统的命令层——四条命令各自回答什么问题、装依赖 → 录快照 → 写指针主链路的编排、默认版本就绪接线、交互确认的触发点，以及每个阶段的失败语义与降级策略。
tags: [version-management, update, switch, check, default-version, npm]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-b944b47c62340b02d28f8561
    resource: repo://src/commands/check.mjs
  - id: openwiki-source-d39330ef89d13e065ec31a89
    resource: repo://src/commands/switch.mjs
  - id: openwiki-source-ae3c8de10526e7697cd4507e
    resource: repo://src/commands/update.mjs
  - id: openwiki-source-81aa5cb3eb7581e3be3fecd8
    resource: repo://src/commands/versions.mjs
  - id: openwiki-source-9e51bcf0eb17106dc44a0c85
    resource: repo://src/npm-runner.mjs
  - id: openwiki-source-086939609d4984ff8ba20658
    resource: repo://src/openwiki-install.mjs
  - id: openwiki-source-96d987ff5f91a05f973f4bfd
    resource: repo://src/versions.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# 版本命令：check / update / switch / versions

版本管理是 0.3.0 新增的子系统。状态层（`versions/` 目录与 `active.json` 指针）见[版本目录与生效指针](./version-store.md)；本页讲命令层——四条命令各自回答什么问题，以及「装依赖 → 录快照 → 写指针」这条主链路的编排。

| 命令 | 回答的问题 | 退出码语义 |
| --- | --- | --- |
| `check` | 现在跑的是哪个版本、本机还装着哪些、registry 有没有更新 | 恒 0（registry 查询失败除外）；运行时解析失败为 1 |
| `update [--version <v>]` | 把 openwiki 升到新版本 | 0 成功；1 参数错误/安装失败/用户取消切换 |
| `switch <version>` | 让某个已装版本立即生效（可秒回滚） | 0 已切换或已是该版本；1 版本非法/未装/代装失败 |
| `versions remove <v>` | 删掉一个不再需要的版本 | 0 已删除；1 激活版本/未安装/版本名非法 |

四条命令的包根统一取自 `launcherPackageRoot()`，测试可注入 `pkgRoot` 指向临时目录。

## 主链路：installAndSnapshot

`update` 与 `switch` 的代装共用 `installAndSnapshot`（内核在 `src/openwiki-install.mjs`，命令层只是再导出），它按固定顺序做三件事，每步失败都带阶段名返回，由调用方决定下一步：

1. **装依赖。** 目标版本已装且可解析时**跳过下载，只补录快照**——几百 MB 白下载一次，网络一失败还会把原本可以 `switch` 回去的完好版本删掉。npm install 失败时**删掉半成品目录**：一个装了一半的版本目录会让 `isInstalled` 说 yes，然后在 broker 启动时才爆炸。
2. **录快照。** 用 `explicitVersion` 解析（解析不到即抛错，不回退出厂依赖），录得 `tools` 非空且 `protocolVersion` 非空才算可用快照；建好父目录后落盘 `manifest/openwiki-<version>.json`。
3. **写指针。** `writeActiveAtomic` 原子改写 `versions/active.json`，失败时指针未改动。

「装 + 录」整段运行在**同一把版本键控安装锁**内（`withVersionLock`）：`update` 装 0.7.0、`switch` 装 0.7.0、后台物化 0.7.0 三者互斥，而装 0.6.0 与装 0.7.0 互不影响。拿不到锁不是错误，返回 `stage: "locked"` 由调用方降级。安装本身走**临时目录 → 完整性校验 → 一次 rename** 的原子路径，校验包含入口存在、入口包声明版本与请求版本一致、以及（依赖树含 better-sqlite3 时）一次原生模块加载探活。

## update：交互确认式升级

- **前置就绪（0.5.0 起）**：当前生效版本还是出厂依赖时，先用 self-heal 模式把它物化进 `versions/`——否则指针一旦切走，`switch` 只认真实条目，就再也切不回去。自愈模式尊重删除标记与退避（用户删过、上次失败在退避期内就安静跳过），失败只 warn，不阻塞升级。
- **目标版本默认交互确认**（0.x 阶段每个版本都可能改工具清单，人工过目再装）；`--version <v>` 显式指定时跳过选择，`--version` 缺值**直接报错而不是静默滑进交互模式**——那会让脚本调用卡在一个看不见的提示上。
- 目标版本从 `npm view openwiki versions --json` 查询，经 `pickLatestStable` 过滤 prerelease 后取最新稳定版；已是最新时直接返回 0。
- **快照录不到不阻塞升级**：没有快照的版本会以直通模式运行，那是设计好的兜底；此时询问「仍要切换吗」，默认否——比回滚一个装好的版本更合理。
- `--no-switch` 只装不切：装好、录好快照就停，指针留给之后的 `switch`。
- 成功后 best-effort 给新版本打 bundle（失败只提示，退出码不变）；并提醒两件事：宿主持有的旧会话不受影响、新连接即用新版本（可跑 `warm` 预热）；若 openwiki 的 skill 内容有更新，重跑安装器可刷新宿主技能目录。

## switch：毫秒级回滚通道

switch 的语义是「**现在就让 X 生效**」，这是它相对 update 的存在理由：已安装版本之间是毫秒级指针改写，可反复横跳——回滚不应该再走一遍「装依赖 + 录快照」。

- 未装过的版本可以顺手代装（复用 `installAndSnapshot`），但**装不好就原样放弃**：switch 容不下没有快照的降级，update 那句「仍要切换吗」在这里不存在。
- 目录存在但入口不全（缺 `package.json` 或 `dist/cli/cli.js`）不是「没装」，是「装坏了」——在坏目录上重装只会合并出更难诊断的状态，因此**拒绝并指路 `versions remove <v>` 清理后重试**。默认版本例外：它的目录里可能只剩历史 bundle（物化之前的畸形状态），就绪动作会在这个目录里补齐实体条目。
- **切到未物化的默认版本时先就地物化**（explicit 模式）：出厂依赖不在版本仓库里，不物化的话「切回默认版本」会变成一次重下载。就绪被 `LAUNCHER_PREPARE=0` 关闭、或就绪后仍未安装，**直接拒绝切换**——指针只允许指向真实条目。
- 切换后按 bundle 状态三分支处置：`ready` 报「冷启动已优化」，`bad` 警告新会话走源码入口，`missing` 后台尽力补打（本进程先退出则下次触发再补）并提示下次会话生效。
- 切换成功后同样提醒：旧会话不受影响，新连接即用新版本。

## versions remove：保守清理

`versions remove <v>` 是 `versions` 命令目前唯一的子命令：

- **拒删当前激活版本**——先 `switch` 到别的版本再删，否则 broker 下一次启动就没有可解析的运行时；
- **manifest 快照不删**：它只有几十 KB，且随包发布的出厂快照重装即恢复，删了反而丢掉「这个版本曾经录过快照」的记录；
- 删的是默认版本时写 `versions/default-removed.json` 标记：**后台自愈不再把它长回来**，只有显式命令（`install` / `warm` / `switch`）会重建并清掉标记；
- 非法版本名、未安装都直接报错退出 1。

## check：状态一屏总览

`check` 回答三个问题：现在跑的是哪个版本（`versions 指针` 还是 `出厂依赖`）、本机还装着哪些版本（含快照有无与磁盘占用）、registry 上有没有更新的。三个刻意的设计：

- **默认版本状态行**（0.5.0 起）：出厂依赖在版本仓库里到底有没有实体条目，是「切回它要不要重新下载」的唯一依据，因此单独一行报六态（见[默认版本就绪](./default-readiness.md)）；
- **指针损坏如实告警**：`versions/active.json` 解析不了时提示已回退出厂依赖，并给出修复动作（重跑 `switch` 或删除该文件）；
- **registry 查询失败只降级提示**——这个命令的存在意义就是把状态讲清楚，不该因为查不到网上的信息就拒绝报告本地状态。

## npm 子进程与版本表挑选

**Windows 上不起 `npm.cmd`**：Node 18.20.2 / 20.12.2 / 21.7.0 起（CVE-2024-27980 修复，本包要求的 22.22.0 包含它）不带 `shell:true` 启动 `.cmd` 会以 EINVAL 失败。首选 node 同目录下的 `npm-cli.js`（参数走数组，带空格的 `--prefix` 路径不需要引号转义），找不到才退回 `npm.cmd` + `shell:true`。

**`pickLatestStable` 过滤 prerelease**：`npm view <pkg> versions` 按发布顺序返回且混有 prerelease，0.x 阶段 `0.7.0-beta.1` 可能排在 `0.6.3` 后面；直接取末位会把预发布当成升级目标，随后被版本名校验（只认 `x.y.z`）打掉。

**安装失败按根因给提示**：`summarizeInstallFailure` 从 npm 的几百行 stderr 里提炼根因行（`prebuild-install` / `ECONNRESET` / `EPERM` 优先于泛化的 "command failed"），过滤日志路径与 gyp 扫描噪声，并按根因给针对性提示——预编译二进制（better-sqlite3）下载被网络重置或回退源码编译时指向 npmmirror 镜像，`EPERM` 时提示文件被占用（常见为杀毒软件锁定）。让用户第一步就走对路（通常是配镜像，而不是装 Python 工具链）。

## 相关页面

- [openwiki 版本目录与生效指针](./version-store.md)
- [默认版本就绪：物化与自愈](./default-readiness.md)
- [工具清单快照（manifest）](../runtime/tool-manifest.md)
- [后端单文件打包（bundle）](../runtime/backend-bundle.md)
- [命令行接口与 doctor 自检](../commands/cli-and-doctor.md)
- [快速上手](../quickstart.md)
