---
type: subsystem
title: openwiki 版本目录与生效指针
description: 版本管理子系统的状态层——versions/<x.y.z>/ 的 side-by-side 布局与原子安装、active.json 指针的原子写入与损坏回退、三套锁与就绪标记的落点、已安装判定与删除规则，以及统一的运行时解析顺序。
tags: [version-management, versions-dir, active-pointer, atomic-install, runtime-resolution]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-10-15T15:06:21.524Z
sources:
  - id: openwiki-source-b4ad9d6666f93bb20232315a
    resource: repo://src/commands/doctor.mjs
  - id: openwiki-source-c89a7c0255f3d83bec964d44
    resource: repo://src/ensure-bundle.mjs
  - id: openwiki-source-c80596f8bd096a7db826530e
    resource: repo://src/holder-runtime.mjs
  - id: openwiki-source-086939609d4984ff8ba20658
    resource: repo://src/openwiki-install.mjs
  - id: openwiki-source-5cde29df2913f42519f02937
    resource: repo://src/paths.mjs
  - id: openwiki-source-96d987ff5f91a05f973f4bfd
    resource: repo://src/versions.mjs
  - id: openwiki-source-0c8da0fcedff086895cf9b5d
    resource: repo://test/versions.test.mjs
generated: { by: "codebuddy", at: "2026-10-15T15:06:21.524Z" }
---

# openwiki 版本目录与生效指针

`src/versions.mjs` 是 openwiki 版本目录布局与「当前生效指针」的**唯一权威**：版本目录、manifest 目录、出厂 node_modules 都挂在 launcher 包根下，各模块的默认值统一从 `launcherPackageRoot()` 取，不再各自推导一遍。所有函数都接受 `pkgRoot` 参数——测试传临时目录，生产代码传真实包根。

## 目录布局

```text
<launcher 包根>/
├── node_modules/openwiki/          # 出厂依赖（package.json 钉住的版本，兜底用）
├── manifest/openwiki-<版本>.json    # 各版本的工具清单快照
└── versions/
    ├── active.json                 # {"version": "x.y.z"}——当前生效指针
    ├── <x.y.z>/                    # side-by-side 安装的各版本
    │   ├── node_modules/openwiki/  #   openwiki 包本体
    │   ├── bundle-<hash8>.mjs      #   后端单文件 bundle（内容寻址）
    │   ├── bundle.meta.json        #   bundle 元数据（entryVersion 等）
    │   ├── bundle.bad              #   「这份产物把后端搞挂过」的标记（可选）
    │   └── install.meta.json       #   安装时的 Node 主版本（doctor 漂移检测用）
    ├── install-<版本>.lock         # 版本键控安装锁
    ├── bundle.lock                 # bundle 构建锁
    ├── holder-<宿主>.json          # holder 常驻后端的 lockfile
    ├── default-removed.json        # 「用户删过默认版本」标记（可选）
    └── prepare-failed.json         # 「上次就绪失败，退避中」标记（可选）
```

`versions/` 是**运行时状态，不随 npm 包发布**：`test/release.test.mjs` 同时断言产物与 package.json 的 `files` 配置都不含它（开发机的残留混进过发布包）。

## 指针为什么是纯文本 JSON 而不是 symlink

`versions/active.json` 记录当前生效版本。不用符号链接的原因很具体：**Windows 上创建符号链接需要管理员权限或开发者模式**，而指针只需要一次文件写入。代价是少了一层文件系统保证的原子性，所以写入自己做了补偿（见下）。

### 原子写入与 Windows 重试

`writeActiveAtomic` 先写 `.tmp` 再 `rename` 覆盖。Windows 上 `rename` 覆盖已存在的目标文件会抛 `EPERM`/`EACCES`/`EEXIST`，此时删掉目标后**重试一次**——写坏的指针会让所有人回退出厂依赖，值得这一次重试。

### 损坏不抛错

`readActive` 在指针缺失、JSON 损坏、或内容不是合法版本名时都返回 `null`（算「无指针」），调用方据此回退出厂依赖。**损坏不抛错**——broker 不能因为一个指针文件起不来。

## 版本名：路径穿越的第一道闸

版本名只允许三段数字（`VERSION_PATTERN = /^\d+\.\d+\.\d+$/`）。目录名会直接拼进路径，**宽松一毫秒就是路径穿越**：`versionDir` 对非法名直接抛错，调用方不允许把未校验的值拼进路径。`versions.test.mjs` 用 `../../etc`、`0.6.0\n`、`v0.6.0` 等输入钉住这条。

## 已安装判定：「装好」有明确门槛

`isInstalled` 判定的是**目录在且入口全**：`versions/<v>/node_modules/openwiki` 下同时存在 `package.json` 与 `dist/cli/cli.js`。switch 的「已安装」判定与 update 的「跳过下载」共用这一条——**目录在但入口不全不算装好，那是个装坏了的半成品，该清理而不是该切换**。

## 原子安装：临时目录 → 校验 → 一次 rename

往 `versions/` 写一个版本由 `src/openwiki-install.mjs` 统一负责（`installVersion`），它保证两条不变量：**原子性**与**互斥**。

- 安装发生在 `versions/.tmp-<版本>-<pid>/`：`npm install openwiki@<版本> --prefix <tmp> --prefer-offline --no-audit --no-fund`，失败先删临时目录，并经 `summarizeInstallFailure` 把几百行 stderr 提炼成可操作的原因；
- **完整性校验三项**（`verifyInstallTree`）：入口存在（`package.json` + `dist/cli/cli.js`）、入口包声明的版本与请求版本一致、依赖树含 `better-sqlite3` 时用一次短命进程验证「当前 Node 能否加载它」——预编译二进制与 ABI 绑死，装到一半的原生模块会让后端在启动时才炸，那时报错离现场已经很远；
- 通过校验才由 `promoteVersionDir` **一次 rename** 落成 `versions/<版本>/`：任何时刻该目录要么不存在、要么是完整条目，被打断的安装不会留下一个「看起来装好了」的半成品。目标已存在（历史遗留的 bundle-only 目录）时先把旧目录挪到 `.bak-<版本>-<pid>`，挪入失败则回滚旁路，成功后 `mergeBundleArtifacts` 把 bundle 产物搬回来——能省一次重建，也绝不弄丢用户已有的 bundle；
- 成功后写 `install.meta.json`（记录 Node 主版本，doctor 的「原生模块可能需要重装」提示靠它），失败则**留在可诊断的错误态**：清掉临时目录、不写 meta、不假装装好，下一次触发可以自愈。

残留清理只有一条规则：**持锁进程不在了就是残留**。`cleanupStaleTempDirs` 只删「名字匹配 `.tmp/.bak-<x.y.z>-<pid>` 且 pid 已消失」的目录——名字不匹配的（用户自己放的 README、真正的版本目录）一律不碰，pid 还活着的（另一个进程正在装）也一律不碰。

## 三套锁，同一套原语

`versions/` 下有三把锁，全部走 `src/lockfile.mjs` 的 `acquireLock`（`openSync(..., "wx")` 独占创建）+ pid 探活：

| 锁 | 保护对象 | 语义 |
| --- | --- | --- |
| `install-<版本>.lock` | 装同一个版本的三个调用方（update / switch / 后台物化） | 拿不到锁返回 `stage: "locked"`，调用方降级等下一次触发，**不排队** |
| `bundle.lock` | bundle 构建 | 锁着就降级源码入口，锁释放后的下一次触发自然补上 |
| `holder-<宿主>.json` | 谁该拉起 holder | 探活失败后 force 重取；内容含 `{ pid, pipeName, version, startedAt }` |

「残留锁必须可被强制重取」是三套锁共同踩过的坑：持有者被 kill 之后，不探活的锁会让这个版本 / 这个 bundle / 这个 holder 永远卡死。

## 版本清单与删除

- `listInstalled` 返回已装版本的 semver 升序列表，含每版的快照有无（`manifest/openwiki-<版本>.json` 是否存在）与磁盘占用。目录名不匹配版本模式的条目（`README.md`、`.tmp` 之类）过滤掉；磁盘占用读不出来按 0 计——清单的价值在版本与快照状态，不在精确字节数。
- `removeVersion` 拒绝删除当前激活版本、未安装的版本与非法版本名；删除时快照保留（理由见[版本命令](./version-commands.md)）。
- `compareVersions` 三段数字逐段数值比较；预发布号不在词汇表里。

## 运行时解析顺序（唯一入口）

`resolveOpenwikiRuntime`（`src/paths.mjs`）是 broker、warm、doctor 与全部版本命令共用的解析入口，顺序固定：

1. **显式版本**（`explicitVersion`，给还没激活的版本录快照用）：只看 `versions/<v>/node_modules/openwiki`，解析不到**直接抛 `OpenwikiNotFoundError`，绝不回退出厂依赖**——否则录出的快照会自称 requested 版本、内容是出厂版，一份对不上的工具清单正是规格要避免的；
2. **`versions/active.json` 指针**：指向的版本已安装且可解析则生效；指针损坏、或指向未安装/入口不全的版本时，**回退出厂依赖并写告警**；
3. **包内出厂 `node_modules/openwiki`**：package.json 钉住的依赖，最后一道兜底。

两条硬边界：

- **解析只认本包根下的 `versions/` 与 `node_modules`，绝不向上遍历目录树**。全局安装的 openwiki 恰好坐落在本包上一层，一次向上查找就会在出厂依赖缺失时被悄悄采纳，之后每个版本报告都在说谎。doctor 会显式检测并提示「全局 openwiki 不参与解析」。
- 入口判定统一是 `package.json` + `dist/cli/cli.js` 的存在性，且版本号从该包的 package.json 读出——目录在但读不出版本同样算解析失败。

## 相关页面

- [版本命令：check / update / switch / versions](./version-commands.md)
- [默认版本就绪：物化与自愈](./default-readiness.md)
- [工具清单快照（manifest）](../runtime/tool-manifest.md)
- [后端单文件打包（bundle）](../runtime/backend-bundle.md)
- [常驻后端（holder）与延迟回收](../runtime/holder.md)
- [openwiki 后端会话与监管](../runtime/backend-supervisor.md)
- [系统总览](../architecture/overview.md)
