# openwiki 版本管理 设计规格

- 日期：2026-10-12
- 状态：待审阅
- 前序规格：`docs/specs/2026-10-09-openwiki-launcher-design.md`（broker）、`docs/specs/2026-10-10-openwiki-launcher-installer-design.md`（安装器）
- 版本承诺：包版本 `0.2.0` → `0.3.0`

---

## 1. 背景与目标

openwiki 发新版后，launcher 侧的手工流程是四步：升 `package.json` 依赖 → `npm run manifest` 重新生成快照 → 测试 → 发版。其中前三步完全在本机完成，适合自动化；发版由 `release.yml`（tag 触发）负责，不在本规格内。

目标：新增 `check` / `update` / `switch` / `versions remove` 四个命令，让 openwiki 的版本状态在本机**可查、可控、可秒回滚**。

成功标准：

- `check` 一眼看清：当前生效版本、已装版本、registry 最新版、快照状态；
- `update` 交互确认式：列出可选版本 → 确认后自动完成「装版本 → 生成快照 → 激活」；
- `switch` 毫秒级切换，可反复回滚；
- 任一步失败，当前生效版本指针不动；
- 从未使用新命令的安装，行为与 `0.2.0` 完全一致（出厂依赖兜底）。

## 2. 已裁决的决策

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 形态 | 本地 CLI 四命令，不做 CI 自动化 | 用户要「本地可控制」；CI 自动 PR 需仓库写权限，且 0.x 阶段每个版本都应人工确认 skill/MCP 兼容性后再合并 |
| 存储 | side-by-side：各版本装到 `<包根>/versions/<semver>/`，`active.json` 指针选生效版本 | `switch` 毫秒级、天然保留旧版本可回滚——是「切换」而非「替换」 |
| 指针实现 | JSON 文本文件，不用 symlink | Windows 下 symlink 需要特权或开发者模式 |
| update 目标版本 | 交互确认：列出可选版本，选定才动手；`--version` 显式指定可跳过选择 | 0.x 阶段 minor 也可能有行为变化，人工确认更稳 |
| 指针损坏 | 警告 + 回退出厂依赖，不抛错 | broker 不能因指针损坏起不来，可用性优先 |
| 快照生成失败 | 保留已装版本、不激活、询问是否仍激活（默认否） | 直通模式是设计好的兜底；版本本身是好的 |
| 出厂依赖 | `package.json` 的 openwiki 钉版保留为兜底，新命令不改它 | 向后兼容：没跑过新命令的安装行为不变 |

## 3. 架构与数据模型

### 3.1 目录布局

```
<launcher 包根>/
  versions/                      ← 新目录，launcher 自管
    active.json                  ← { "version": "0.7.0" }，生效指针
    0.6.0/node_modules/openwiki/ ← npm install --prefix 装出的完整版本
    0.7.0/node_modules/openwiki/
  manifest/
    openwiki-0.6.0.json          ← 出厂随包发布
    openwiki-0.7.0.json          ← update 时生成
```

- 版本安装：`npm install openwiki@<v> --prefix versions/<v>`，保证 openwiki 落在 `versions/<v>/node_modules/openwiki`。
- `active.json` 原子写入：先写 `active.json.tmp` 再 rename 覆盖（Windows 覆盖失败时短重试）。
- 无 `active.json`、内容解析失败、或指向的版本不存在，一律视为无指针。

### 3.2 解析顺序（`src/paths.mjs`）

`resolveOpenwikiRuntime()` 新逻辑：

1. 读 `versions/active.json` 得到候选版本 `v`；
2. `v` 通过版本名校验（`/^\d+\.\d+\.\d+$/`），且 `versions/<v>/node_modules/openwiki` 能解析出 `package.json` 与 `dist/cli/cli.js` → 返回 `{ packageRoot, version, cliJs, source: "versions" }`；
3. 任一环节不满足 → 打警告，回退出厂依赖（现有 `require.resolve` 逻辑），`source: "bundled"`；
4. 指针损坏（JSON 解析失败、目录缺失、入口缺失）走第 3 条路径，**不抛异常**。

返回值新增 `source` 字段（`"versions" | "bundled"`），供 `doctor` / `check` 展示。

另导出 `resolveOpenwikiRuntime({ explicitVersion })`：跳过指针、直接解析 `versions/<v>/`，供 `update` 在指针切换**之前**为该版本生成快照。缺省行为不变。

### 3.3 自动生效面

broker 后端启动（`src/commands/mcp.mjs`）、`gen-manifest`、`doctor`、`skill-install`（`bundleDirFor(packageRoot)`）全部经过 `resolveOpenwikiRuntime`，切指针即全链路生效，无需逐个改动。快照经 `loadManifest(runtime.version)` 按版本命名，天然共存。

### 3.4 并发语义

切换不打断运行中的会话：broker 进程在启动时解析一次运行时，旧会话用旧进程跑完，新会话读新指针。天然会话隔离，无需杀进程。

## 4. 命令规格

### 4.1 `check`（只读）

输出：

- 当前生效版本与来源（`source`）；
- `versions/` 已装版本列表：各版本有无快照、目录磁盘占用合计；
- registry 最新版（`npm view openwiki version`，走本机 registry 配置，如 npmmirror）；网络失败时本地信息照常输出，仅 registry 行降级为提示；
- 指针异常时明确报告异常与修复方式。

退出码：0（含网络降级）；1 仅用于本机环境错误。

### 4.2 `update`

参数：`--version <semver>`（显式指定，跳过选择）、`--no-switch`（装好 + 生成快照但不激活）。

流程：

1. 查 registry 最新版，或取 `--version` 指定版本；
2. 与当前生效版本相同 → 提示「已是最新」，退出 0；
3. 列出最近 10 个版本（`npm view openwiki versions` 按 semver 降序），默认选中最新版，等待 y/n 确认；选 n 退出 0，无任何副作用；
4. `npm install openwiki@<v> --prefix versions/<v>`：
   - 失败（含信号退出）→ 删除半成品 `versions/<v>/`，退出码 1；
5. 用 `resolveOpenwikiRuntime({ explicitVersion: v })` 生成快照，写入 `manifest/openwiki-<v>.json`：
   - 失败或校验不过（`tools` 为空、缺 `protocolVersion`）→ **保留版本目录**，提示「该版本将以直通模式运行」，询问是否仍激活（默认否）；
6. 原子写 `active.json`（`--no-switch` 时跳过）：
   - 失败 → 版本保留、指针不动，退出码 1；
7. 成功 → 打印摘要（版本、快照工具数、耗时）与提醒：skill 内容可能变化可重跑安装器刷新；宿主下次连接生效；可跑 `warm` 预热。

### 4.3 `switch <version>`

- 版本必须已安装（`versions/<v>/` 可解析出 openwiki 入口）；未安装 → 询问是否代装（复用 4.2 的安装 + 快照流程，不切指针）；
- 校验通过 → 打印「当前 → 目标」→ 原子写指针 → 提示「运行中会话不受影响，宿主下次连接生效；可跑 `warm` 预热」；
- 校验失败 → 拒绝、指针不动、退出码 1。

### 4.4 `versions remove <version>`

- 拒绝删除当前激活版本（提示先 `switch` 到别的版本）；
- 删除 `versions/<v>/` 整个目录；出厂依赖（`package.json` 钉版）不在管辖内，不出现在可删列表；
- **不删** `manifest/openwiki-<v>.json`（几十 KB，留作记录；随包发布的出厂文件重装即恢复）。

### 4.5 CLI 注册与文档

`src/cli.mjs` 命令分发表新增四个分支；`HELP` 文本、README 命令表、「工作方式」一节、故障排查表（新增「指针损坏」一行）同步更新。

## 5. 失败处理与回滚

### 5.1 update 失败矩阵

| 失败步骤 | 处理 | 指针 | 退出码 |
| --- | --- | --- | --- |
| 查 registry | 无副作用，提示网络/registry 问题 | 不动 | 1 |
| npm install | 删半成品 `versions/<v>/` | 不动 | 1 |
| 生成快照 | 保留版本目录，询问是否仍激活；用户选择不激活 → 退出码 1（升级目标未达成，但版本已装好，可 `switch` 或重跑 `update` 兜底） | 不动 | 1 |
| 快照校验不过 | 视同生成快照失败 | 不动 | 1 |
| 指针写入 | 版本保留，提示磁盘/权限问题 | 不动 | 1 |

快照失败不整体回滚的理由：直通模式是设计好的安全兜底（`src/commands/mcp.mjs:42-46`，宁可慢也不给错的清单），版本本身是好的，留给用户日后 `switch` 决定。

### 5.2 三级回滚路径

1. `switch <旧版本>` —— 秒级回到此前版本；
2. 删除 `active.json` —— 回到出厂依赖；
3. `versions remove <v>` —— 清理磁盘。

从轻到重，覆盖「新版有问题」「指针乱了」「不要这个版本了」三类场景。

### 5.3 指针损坏的运行时行为

- broker 启动读到坏指针：警告 + 回退出厂依赖，继续服务；
- `doctor` / `check` 报告指针异常与修复方式（重跑 `switch` 或删 `active.json`）；
- 用户修复后无需重启 launcher，下次连接即按新指针解析。

## 6. 安全护栏

- 版本名校验 `/^\d+\.\d+\.\d+$/`：用于 `active.json` 内容校验与 `switch` / `versions remove` 的参数，不匹配直接拒绝，防 `switch ../../etc` 类路径穿越；
- 所有写操作只允许落在包根内的 `versions/` 与 `manifest/`；沿用 `src/guards.mjs` 的退出码约定（0 成功 / 1 用户或环境错误 / 2 护栏拒绝）；
- npm install 的子进程输出透传 stderr，成败以退出码判定；
- 版本安装目标目录先用校验后的版本名拼接，拼接前不得含路径分隔符（校验规则已保证，实现时仍显式断言）。

## 7. 对现有模块的影响

| 模块 | 改动 |
| --- | --- |
| `src/paths.mjs` | `resolveOpenwikiRuntime` 加指针解析、`source` 字段、可选 `explicitVersion` 参数；`OpenwikiNotFoundError` 语义不变 |
| `src/commands/mcp.mjs` | 无逻辑改动（自动跟随解析）；直通模式提示不变 |
| `src/commands/doctor.mjs` | 新增一行指针状态展示（生效版本、来源、指针异常） |
| `src/cli.mjs` | 注册四个新命令；更新 HELP |
| `scripts/gen-manifest.mjs` | `generateManifest` 透传 `explicitVersion` 给解析函数，其余不变 |
| `src/manifest.mjs` | 无改动 |
| `src/skill-install.mjs` | 无改动（`bundleDirFor(packageRoot)` 自动跟随） |
| `README.md` | 命令表、「工作方式」、故障排查同步更新 |

## 8. 测试策略（TDD）

**单元测试**（vitest，fake npm 子进程与 registry 应答，不打真实网络）：

- 指针读写、原子替换、损坏回退、缺省回退；
- `resolveOpenwikiRuntime` 的 `source` 两种取值与 `explicitVersion` 路径；
- 版本名校验拒绝路径穿越与非法 semver；
- `versions remove` 护栏（拒删激活版本、删不存在版本）；
- `update` 失败矩阵逐项验证「指针不变 + 目录清理」；
- `check` 网络失败降级。

**e2e**（`LAUNCHER_REAL_SMOKE` 门控，真实后端）：装一个版本 → 生成快照 → `switch` → 起 broker → `initialize` / `tools/list` 应答来自新版本快照。

**现有测试适配**：`paths.test.mjs`（`source` 字段）、`doctor.test.mjs`（指针状态行）、`cli.test.mjs`（命令注册与 help）。

## 9. 范围外（YAGNI）

- 不做 CI 自动化（已裁决为本地 CLI 形态）；
- 不做版本间依赖共享（每版本独立依赖树，磁盘换简单）；
- 不自动清理旧版本（手动 `versions remove`）；
- `versions remove` 不删快照文件；
- 不做 `--dry-run`（`check` 承担预览职责）；
- 不改宿主安装逻辑本体；
- 不动 `.github/workflows/openwiki-update.yml`（那是 openwiki wiki 文档刷新流程，与依赖升级无关）。
