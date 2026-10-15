# openwiki-launcher 短命令别名与 openwiki 命令透传设计

日期：2026-10-15
状态：待审查
范围：新增 `bin/ow.mjs`、`src/openwiki-cli.mjs`；修改 `package.json`、`src/cli.mjs`、`README.md`；新增测试 `test/ow.test.mjs`、`test/bin-aliases.test.mjs`

## 1. 背景与问题

两个用户可见的摩擦：

- **名字太长**：`openwiki-launcher` 是 17 个字符，日常高频输入（doctor / check / warm）成本高；
- **用户不装全局 openwiki**：launcher 已经把 openwiki 物化进 `versions/<v>/`（默认版本物化设计），出厂依赖也随包发布——但 openwiki 自己的 CLI 命令（`visualize` 可视化、`link`、`workspace`、`auth`、`ingest`、`cron`、`ngrok`、`integrations`，以及裸跑进入的交互式 agent）**当前没有任何入口**。用户想用可视化就得另外 `npm install -g openwiki`，多装一份几百 MB 的副本，而且版本可能与 launcher 正在管理的那份不一致。

## 2. 目标与非目标

**目标**

- G1：提供短命令 `owl`，与 `openwiki-launcher` **完全等价**（同一实现、同一命令空间），保留全名向后兼容（已有用户的 MCP 配置、脚本不受影响）；
- G2：提供纯透传入口 `ow`：`ow <openwiki 参数…>` 等价于 `openwiki <参数…>`，让 launcher 自带的 openwiki（激活版本或出厂依赖）成为用户唯一需要的一份；
- G3：`owl ow <参数…>` 与 `ow <参数…>` 等价（launcher 内部也提供 `ow` 子命令，两条路径复用同一内核）；
- G4：透传对**所有** openwiki 命令生效——包括交互式 TUI（`ow` 裸跑）、长驻服务器（`ow visualize`）、需要 TTY 的 ink 渲染；退出码、信号、stdio 全部透明；
- G5：`ow` 使用的 openwiki 与 `mcp` 命令**同一个解析来源**（active 指针优先，失效回退出厂依赖），保证同一时刻两个命令跑的是同一份代码。

**非目标**

- 不做 `ow` 的版本覆盖开关（如 `OW_VERSION=0.7.2 ow …`）——YAGNI，需要换版本用 `owl switch`；
- 不拦截 `ow mcp`（纯透传原则）：它是 openwiki 的直连 mcp（冷启动 30-50 秒），要毫秒级 broker 用 `owl mcp`。文档明示，不做魔法；
- 不改宿主安装/卸载逻辑：MCP 配置始终指向 `bin/openwiki-launcher.mjs` 的绝对路径（`resolveSelfBin` 基于模块位置推导，与调用名无关——已确认 `src/self-path.mjs:21-24`），别名不影响已写出的配置；
- 不做 shell 补全、不做 `ow` 的 launcher 参数混入（`ow` 的一切参数都属于 openwiki）。

## 3. 方案选型

### 3.1 bin 形态：为什么 `ow` 必须是独立入口文件

| 方案 | 做法 | 权衡 |
| --- | --- | --- |
| A（选定） | `openwiki-launcher` 与 `owl` 指向 `bin/openwiki-launcher.mjs`；`ow` 指向独立的 `bin/ow.mjs` | 多一个 4 行文件；换来调用名可区分 |
| B | 三个名字指向同一入口文件 | **不可行**：Windows 的 npm shim（`.cmd`/`.ps1`）不向脚本传递"被哪个名字调用"，`ow` 的纯透传语义无法实现 |
| C | 只做 `owl ow` 前缀，不注册独立 `ow` bin | 用户已明确要 `ow` 直达；每命令多敲一个词 |

### 3.2 运行环境来源：与 `mcp` 同源，但禁用 bundle

`resolveOpenwikiRuntime` 的返回值里有两个入口字段：

- `cliJs`：**bundle 优先**的结果（bundle 就绪时是 `bundle-*.mjs`）——它是 MCP 后端的单文件入口，**不是** CLI；
- `sourceCliJs`：真实 openwiki 包的 `dist/cli/cli.js`（`src/paths.mjs:186-193`）。

`ow` 必须用 `sourceCliJs`——bundle 没有 CLI 命令分发能力，拿它当 CLI 跑会在参数解析处就崩。这一条是本设计最容易踩错的点，用测试钉死。

## 4. 命令空间与不变量

| 命令 | 职责 | 入口 |
| --- | --- | --- |
| `openwiki-launcher` | 全部 launcher 命令（现有） | `bin/openwiki-launcher.mjs` |
| `owl` | 同 `openwiki-launcher`，完全等价 | 同上（npm 建两个 shim） |
| `ow` | 纯透传 openwiki CLI | `bin/ow.mjs` |

不变量：

- **I1**：`owl <args>` 与 `openwiki-launcher <args>` 行为逐字节一致（同一入口文件，天然成立；测试锁住 bin 映射）；
- **I2**：`ow <args>` 与 `owl ow <args>` 走**同一个** `runOpenwikiCli` 内核，输出与退出码一致；
- **I3**：`ow` 透传时，openwiki 子进程的 cwd = 调用者 cwd，环境变量原样继承调用者进程环境（透传不额外加工）；
- **I4**：`ow` 对 launcher 状态**只读不写**：解析运行时只读 `versions/active.json` 与包内文件，不触发物化、不打 bundle、不写任何指针或标记；
- **I5**：退出码透明：openwiki 进程退出码原样成为 `ow` 的退出码；被信号终结时返回 `1`（POSIX 上转发信号后同样语义）。

## 5. 详细设计

### 5.1 `src/openwiki-cli.mjs`（新模块）

对外只暴露一个主要函数：

```
runOpenwikiCli({ args, logger, pkgRoot?, resolveRuntime?, spawnFn? })
  → Promise<number>   进程退出码
```

步骤：

1. `runtime = await resolveRuntime({ pkgRoot, logger })`；
   - `OpenwikiNotFoundError` → `logger.error` 打印可操作提示（"未找到 openwiki：重跑 `owl warm` 或失败时 `owl install`"），返回 `1`；
2. `spawnFn(process.execPath, [runtime.sourceCliJs, ...args], { stdio: "inherit", cwd: process.cwd() })`；
   - `spawnFn` 默认 `child_process.spawn`，测试注入假实现；
3. 等待 `close` 事件，返回 `code ?? 1`；
4. POSIX 信号转发：`SIGINT` / `SIGTERM` 到达父进程时 `child.kill(signal)`；子进程退出后移除监听器。Windows 上同一控制台进程组天然同时收到 Ctrl+C，`kill` 不可用时不报错（`try/catch` 忽略）。

`stdio: "inherit"` 是 TTY 透明性的唯一保证：openwiki 的 ink 交互界面、`visualize` 打印的本地地址、进度输出都直接落在调用者的终端上。

### 5.2 `bin/ow.mjs`（新文件）

```js
#!/usr/bin/env node
import { runOpenwikiCli } from "../src/openwiki-cli.mjs";
import { createLogger } from "../src/log.mjs";

const logger = createLogger({ debug: process.env.LAUNCHER_DEBUG === "1" });
process.exitCode = await runOpenwikiCli({ args: process.argv.slice(2), logger });
```

logger 走 `src/log.mjs` 的 `createLogger`（输出 stderr；`LAUNCHER_DEBUG=1` 时开 debug），与 `bin/openwiki-launcher.mjs` → `cli.mjs` 的默认 logger 形状一致。

### 5.3 `src/cli.mjs` 接线

- 新增分支（放在 `versions` 分支之后、裸用法兜底之前）：

```js
if (command === "ow") {
  return runOpenwikiCli({ args: rest, pkgRoot: deps.pkgRoot ?? launcherPackageRoot(), logger, resolveRuntime: deps.resolveRuntime, spawnFn: deps.spawnFn });
}
```

- `deps` 增加 `spawnFn` 注入点（测试用）；`cliDeps` 不透传它（`ow` 分支直接取 `deps`）。
- **HELP 更新**：用法块把示例从 `openwiki-launcher` 改为 `owl`（主推短名），并在块首加两行：
  - `（owl 与 openwiki-launcher 是同一个命令；ow 是 openwiki 的透传入口）`
  - `owl ow <参数…>  /  ow <参数…>     透传执行 openwiki CLI（visualize、link、workspace、auth、ingest…）`
- 现有测试常量 `HELP_LINE`（`test/cli.test.mjs:20`）与相关断言同步更新。

### 5.4 `package.json`

```json
"bin": {
  "openwiki-launcher": "./bin/openwiki-launcher.mjs",
  "owl": "./bin/openwiki-launcher.mjs",
  "ow": "./bin/ow.mjs"
}
```

`files` 已含 `bin` 目录，无需改动；`bin/ow.mjs` 自动入包。

## 6. 测试与验收

**单测（新增 `test/ow.test.mjs`）**

- `runOpenwikiCli` 用假 `spawnFn` 断言：命令数组为 `[runtime.sourceCliJs, ...args]`、`stdio: "inherit"`、`cwd` 为调用者 cwd；
- **来源断言**：runtime 对象同时含 `cliJs`（bundle 路径）与 `sourceCliJs` 时，spawn 用的必须是 `sourceCliJs`（I/§3.2 的钉死测试）；
- 退出码转发：假子进程 exit(3) → 返回 3；code 为 null → 返回 1；
- 解析失败（`resolveRuntime` 抛 `OpenwikiNotFoundError`）→ 返回 1 且 stderr 有可操作提示；
- `main(["ow", "visualize"])` 分发到 `runOpenwikiCli`（注入 stub 断言 args 透传）且不再走裸用法安装分支。

**bin 映射测试（新增 `test/bin-aliases.test.mjs`）**

- 断言 `package.json` 的 `bin` 三条目指向正确文件且文件存在（防止未来重构悄悄丢掉别名）；
- `bin/ow.mjs` 与 `bin/openwiki-launcher.mjs` 都以 `process.exitCode = await …` 收尾（模式一致性断言可简化为文件存在 + 包含关键 import）。

**本机实测验收（重装全局包后）**

| 项 | 标准 |
| --- | --- |
| 别名等价 | `owl version` 输出与 `openwiki-launcher version` 一致；`owl doctor` 全绿 |
| 透传帮助 | `ow --help` 显示 openwiki 自己的帮助（含 visualize 段），`owl ow --help` 输出一致 |
| 可视化实测 | `ow visualize --no-open --port 3939` 能起服务（进程存活 + 端口可连），Ctrl+C / 杀进程后正常退出 |
| 退出码透明 | `ow 不存在命令` 的退出码 = openwiki 自己的错误码 |
| 不拦截 mcp | `ow mcp --help`（或等价安全子命令）走 openwiki 直连语义，不触发 broker |
| 交互 TTY | `ow` 裸跑进入 openwiki agent 界面（人工确认渲染正常，可 `/exit` 退出） |
| 回归 | vitest 全绿（除已知 Windows symlink 环境项） |

**环境注意事项（实测时执行）**

新 bin 装上后 nvm v2 需要 `nvm firewall trust` + `nvm reshim` 才可执行（与上次重装全局包同一机制，见 NVM4306）。

## 7. 风险与降级

- **`ow mcp` 误用**：用户可能把宿主 MCP 配置指向 `ow mcp`（直连、慢）。文档与 `owl --help` 明确"broker 用 `owl mcp`"；不做运行时拦截（破坏纯透传语义）。
- **信号转发在 Windows 的边界**：`child.kill('SIGINT')` 在 Windows 上语义受限；依赖控制台进程组天然转发。长驻命令（visualize）在 Windows 上 Ctrl+C 双发到父子进程是既定行为，无额外处理。
- **openwiki CLI 自身崩溃**：`ow` 只需透明传递退出码与输出，不做包装（错误诊断属于 openwiki 的 UX）。
- **别名与 nvm shim**：三个 shim 由 npm 生成、nvm reshim 接管；卸载 launcher 时随 npm 一起清理，无残留逻辑。

## 8. 交付拆分（供 writing-plans 展开）

1. **内核**：新增 `src/openwiki-cli.mjs`（解析 + spawn + 信号 + 退出码）+ 单测 `test/ow.test.mjs`；
2. **bin 层**：新增 `bin/ow.mjs`，`package.json` bin 三条目 + 映射测试 `test/bin-aliases.test.mjs`；
3. **接线**：`src/cli.mjs` 的 `ow` 子命令与 HELP 更新（含既有测试常量同步）；
4. **文档**：README 快速开始主推 `owl`、新增"短命令与 ow 透传"一节、别名说明；
5. **验收**：重装全局包（含 nvm trust/reshim）→ 实测表中的六项。
