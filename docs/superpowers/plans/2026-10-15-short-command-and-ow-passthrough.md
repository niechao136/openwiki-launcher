# 短命令别名与 openwiki 命令透传 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增短命令 `owl`（与 `openwiki-launcher` 完全等价）与纯透传入口 `ow`（`ow visualize` → launcher 自带 openwiki 的 `visualize`），让用户不必另装全局 openwiki。

**架构：** 新模块 `src/openwiki-cli.mjs` 承载透传内核（运行时解析 → spawn 继承 stdio → 信号/退出码透明）；`bin/ow.mjs` 是它的 4 行入口；`owl` 与 `openwiki-launcher` 共用既有入口文件；`cli.mjs` 同步提供 `ow` 子命令（`owl ow` 与 `ow` 等价）。

**技术栈：** Node.js >= 22.22.0、ESM、`node:child_process`、vitest。

**规格：** `docs/superpowers/specs/2026-10-15-short-command-and-ow-passthrough-design.md`

## 全局约束

- Node >= 22.22.0（`package.json` `engines`，逐字）。
- `ow` 透传**必须**使用 `runtime.sourceCliJs`；禁止使用 `runtime.cliJs`（那是 bundle，仅供 MCP 后端）。
- 退出码语义：openwiki 子进程的退出码原样成为 `ow` 的退出码；`code === null`（信号终结）时返回 `1`；解析失败返回 `1`。
- 透传的 spawn 参数固定为：`process.execPath`、`[sourceCliJs, ...args]`、`{ stdio: "inherit", cwd: process.cwd() }`。
- 不拦截 `ow mcp`；不改 MCP 配置写入（`resolveSelfBin` 与调用名无关，不得改动）；不做版本覆盖开关。
- 中文文案与注释；commit 用中文 Conventional Commits。
- 测试命令：`npx vitest run <file>`（Windows 环境经 nvm 的 shim 运行，步骤命令写 `npx vitest run ...` 即可）。

## 审查重点（Review Focus）

1. **bundle 入口误用**：解析结果同时含 `cliJs`（bundle 路径）与 `sourceCliJs`（真实 CLI）时，若 spawn 用了 `cliJs`，`ow visualize` 会在参数解析处崩溃。→ 钉在任务 1 的来源测试。
2. **退出码被吞**：openwiki 失败（非 0）而 `ow` 返回 0，脚本链与 CI 会误判成功。→ 钉在任务 1 的退出码测试（含 `null` 分支）。
3. **参数被 launcher 吞掉**：以 `-` 开头的选项、`--` 分隔符、含空格路径必须原样落在 argv 数组里。→ 钉在任务 1 的参数透传测试。
4. **解析失败静默**：openwiki 不可读时若无输出、退出码含糊，用户无从诊断。→ 钉在任务 1 的错误提示测试。
5. **别名映射被未来重构破坏**：`bin` 条目被删/指错或 `bin/ow.mjs` 丢失接线。→ 钉在任务 2 的映射测试。

---

### 任务 1：透传内核 `src/openwiki-cli.mjs`

**文件：**
- 创建：`src/openwiki-cli.mjs`
- 测试：`test/ow.test.mjs`

**Interfaces（后续任务依赖此形状，不得更名）：**
- `runOpenwikiCli({ args, logger, pkgRoot?, resolveRuntime?, spawnFn? }) → Promise<number>`
  - `resolveRuntime` 默认 `resolveOpenwikiRuntime`（来自 `src/paths.mjs`）；`spawnFn` 默认 `child_process.spawn`。

- [ ] **步骤 1：编写失败的测试**

创建 `test/ow.test.mjs`：

```js
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runOpenwikiCli } from "../src/openwiki-cli.mjs";
import { OpenwikiNotFoundError } from "../src/paths.mjs";
import { collectLogger } from "./helpers.mjs";

const RUNTIME = {
  packageRoot: "/pkg/versions/0.6.0/node_modules/openwiki",
  version: "0.6.0",
  cliJs: "/pkg/versions/0.6.0/bundle-abc123.mjs", // bundle：MCP 专用，绝不能被 spawn
  sourceCliJs: "/pkg/versions/0.6.0/node_modules/openwiki/dist/cli/cli.js",
  backend: "bundle",
  source: "versions",
};

function fakeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); return true; };
  const spawnFn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return child; };
  return { calls, child, spawnFn };
}

function deps(extra = {}) {
  const logs = collectLogger();
  const spawn = fakeSpawn();
  return {
    logs,
    ...spawn,
    base: {
      args: ["visualize", "--no-open"],
      logger: logs.logger,
      resolveRuntime: async () => RUNTIME,
      spawnFn: spawn.spawnFn,
      ...extra,
    },
  };
}

describe("runOpenwikiCli 透传内核", () => {
  it("用 sourceCliJs 启动（绝不使用 bundle 的 cliJs）", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].argv[0]).toBe(RUNTIME.sourceCliJs);
    expect(d.calls[0].argv.slice(1)).toEqual(["visualize", "--no-open"]);
  });

  it("spawn 参数：node 绝对路径、stdio inherit、cwd 为调用者 cwd、环境原样继承", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].cmd).toBe(process.execPath);
    expect(d.calls[0].opts.stdio).toBe("inherit");
    expect(d.calls[0].opts.cwd).toBe(process.cwd());
    // I3：环境不额外加工——不传 env 字段即继承调用者进程环境。
    expect(d.calls[0].opts.env).toBeUndefined();
  });

  it("参数原样透传：- 开头选项、-- 分隔符、含空格路径", async () => {
    const args = ["visualize", "--port", "3939", "--", "weird path/with space"];
    const d = deps({ args });
    const p = runOpenwikiCli(d.base);
    d.child.emit("close", 0, null);
    await p;
    expect(d.calls[0].argv.slice(1)).toEqual(args);
  });

  it("退出码透明转发", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    d.child.emit("close", 3, null);
    expect(await p).toBe(3);
  });

  it("被信号终结（code null）返回 1", async () => {
    const d = deps();
    const p = runOpenwikiCli(d.base);
    d.child.emit("close", null, "SIGTERM");
    expect(await p).toBe(1);
  });

  it("解析失败：返回 1 且打印可操作提示（含 owl install / owl warm）", async () => {
    const d = deps({
      resolveRuntime: async () => { throw new OpenwikiNotFoundError("boom"); },
    });
    expect(await runOpenwikiCli(d.base)).toBe(1);
    expect(d.calls.length).toBe(0);
    expect(d.logs.text()).toContain("owl install");
    expect(d.logs.text()).toContain("owl warm");
  });

  it("解析抛未知错误同样软着陆：返回 1 不抛出", async () => {
    const d = deps({ resolveRuntime: async () => { throw new Error("unexpected"); } });
    expect(await runOpenwikiCli(d.base)).toBe(1);
    expect(d.logs.text()).toContain("unexpected");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/ow.test.mjs`
预期：FAIL，报错 `Cannot find module '../src/openwiki-cli.mjs'`（或 `runOpenwikiCli is not a function`）。

- [ ] **步骤 3：实现 `src/openwiki-cli.mjs`**

导出仅一个函数（签名见 Interfaces）。实现要点（签名与测试未覆盖的行为，按此写）：

1. 解析：`const runtime = await resolveRuntime({ pkgRoot, logger })`；`OpenwikiNotFoundError` 与其它异常都 `logger.error` 后返回 `1`。解析失败文案固定为：
   `未找到可用的 openwiki：请重跑安装器（owl install）或用 owl warm 物化默认版本`（`OpenwikiNotFoundError` 分支额外附上 `error.message`）。
2. spawn：`spawnFn(process.execPath, [runtime.sourceCliJs, ...args], { stdio: "inherit", cwd: process.cwd() })`。
3. 信号转发：对 `SIGINT`、`SIGTERM` 各注册一个处理器 `() => { try { child.kill(signal); } catch { /* Windows 上可能不支持，忽略 */ } }`；子进程 `close` 后 `process.removeListener` 清理两者。
4. 等待 `close`：`new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)))`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/ow.test.mjs`
预期：PASS（7 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/openwiki-cli.mjs test/ow.test.mjs
git commit -m "feat: ow 透传内核——sourceCliJs 解析、stdio 继承、退出码与信号透明"
```

### 任务 2：bin 层（`bin/ow.mjs` + `package.json` bin 条目）

**文件：**
- 创建：`bin/ow.mjs`
- 创建：`test/bin-aliases.test.mjs`
- 修改：`package.json`（`bin` 字段）

- [ ] **步骤 1：编写失败的测试**

创建 `test/bin-aliases.test.mjs`：

```js
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("命令别名映射", () => {
  it("bin 三条目：openwiki-launcher 与 owl 同一入口，ow 独立入口", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin["openwiki-launcher"]).toBe("./bin/openwiki-launcher.mjs");
    expect(pkg.bin.owl).toBe("./bin/openwiki-launcher.mjs");
    expect(pkg.bin.ow).toBe("./bin/ow.mjs");
    for (const rel of ["./bin/openwiki-launcher.mjs", "./bin/ow.mjs"]) {
      expect(existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  it("bin/ow.mjs 以 runOpenwikiCli 收尾并转发退出码", () => {
    const src = readFileSync(path.join(ROOT, "bin/ow.mjs"), "utf8");
    expect(src).toContain("runOpenwikiCli");
    expect(src).toContain("process.exitCode");
    expect(src).toContain("process.argv.slice(2)");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/bin-aliases.test.mjs`
预期：FAIL（`pkg.bin.owl` 为 undefined；`bin/ow.mjs` 不存在）。

- [ ] **步骤 3：实现**

`bin/ow.mjs`（照此写，仅此内容）：

```js
#!/usr/bin/env node
import { runOpenwikiCli } from "../src/openwiki-cli.mjs";
import { createLogger } from "../src/log.mjs";

const logger = createLogger({ debug: process.env.LAUNCHER_DEBUG === "1" });
process.exitCode = await runOpenwikiCli({ args: process.argv.slice(2), logger });
```

`package.json` 的 `bin` 改为：

```json
"bin": {
  "openwiki-launcher": "./bin/openwiki-launcher.mjs",
  "owl": "./bin/openwiki-launcher.mjs",
  "ow": "./bin/ow.mjs"
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/bin-aliases.test.mjs`
预期：PASS（2 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add bin/ow.mjs package.json test/bin-aliases.test.mjs
git commit -m "feat: 注册 owl 与 ow 命令，ow 为 openwiki 纯透传入口"
```

### 任务 3：CLI 接线（`ow` 子命令 + HELP 主推 `owl`）

**文件：**
- 修改：`src/cli.mjs`（HELP 常量；`main` 分发）
- 修改：`test/cli.test.mjs`（HELP_LINE 及受影响的断言）
- 修改：`test/ow.test.mjs`（追加分发测试）

- [ ] **步骤 1：编写失败的测试**

追加到 `test/ow.test.mjs`：

```js
import { main } from "../src/cli.mjs"; // 放到文件顶部 import 区

describe("owl ow 子命令分发", () => {
  it("main(['ow', ...]) 透传给 runOpenwikiCli，参数原样", async () => {
    const logs = collectLogger();
    const seen = [];
    const code = await main(["ow", "visualize", "--no-open"], {
      logger: logs.logger,
      runOpenwikiCliFn: async ({ args }) => { seen.push(...args); return 0; },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["visualize", "--no-open"]);
  });

  it("main(['ow']) 透传空参数（进入 openwiki 交互界面路径）", async () => {
    const logs = collectLogger();
    let called = false;
    const code = await main(["ow"], {
      logger: logs.logger,
      runOpenwikiCliFn: async ({ args }) => { called = true; expect(args).toEqual([]); return 0; },
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
  });
});
```

修改 `test/cli.test.mjs`：
- `HELP_LINE` 常量改为 `"owl mcp [--host <id>]"`。
- 追加断言：`--help` 输出包含别名说明（`expect(out).toContain("ow")` 与 `expect(out).toContain("透传")`，可并入既有 "help lists the four new commands" 用例或新增一个）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/ow.test.mjs test/cli.test.mjs`
预期：FAIL——`ow` 分发用例失败（当前 `ow` 未识别，落到裸用法/未知命令），HELP 相关断言失败。

- [ ] **步骤 3：实现 `src/cli.mjs`**

1. `main` 的 deps 增加 `runOpenwikiCliFn`（默认 `runOpenwikiCli`，从 `../src/openwiki-cli.mjs` import）。
2. 在 `versions` 分支之后、裸用法兜底之前插入：

```js
if (command === "ow") {
  return runOpenwikiCliFn({
    args: rest,
    logger,
    pkgRoot: deps.pkgRoot ?? launcherPackageRoot(),
    resolveRuntime: deps.resolveRuntime,
  });
}
```

（只透传有测试注入点的参数：`spawnFn` 不经 `main` 转发，透明性由任务 1 单测直接覆盖内核保证。）

3. HELP 常量更新（文案定稿）：
   - 用法块首行加：`（owl 与 openwiki-launcher 是同一个命令；ow 是 openwiki 的透传入口）`
   - 用法块示例前缀统一由 `openwiki-launcher` 改为 `owl`
   - 在命令列表中加入：`  owl ow <参数…>  /  ow <参数…>      透传执行 openwiki CLI（visualize、link、workspace、auth、ingest…）`
   - 按规格 §2：`ow mcp` 不在帮助中拦截；但 HELP 里 `mcp` 行保留原样（broker 说明在行尾已有）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run test/ow.test.mjs test/cli.test.mjs`
预期：PASS。随后运行 `npx vitest run` 全量，修复任何因 HELP 文案前缀变化而失败的其它断言（只改断言中的名字，不改行为）。

- [ ] **步骤 5：Commit**

```bash
git add src/cli.mjs test/cli.test.mjs test/ow.test.mjs
git commit -m "feat: owl ow 子命令与 HELP 主推短名，owl 与 openwiki-launcher 等价"
```

### 任务 4：README 文档

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：更新 README**

1. 快速开始：示例命令由 `openwiki-launcher` 改为 `owl`；紧随其后加一行：`> openwiki-launcher 是 owl 的全名，两者完全等价；ow 是 openwiki 命令的透传入口。`
2. 命令表新增一行：`| \`owl ow <参数…>\` / \`ow <参数…>\` | 透传执行 openwiki CLI（visualize、link、workspace、auth、ingest、cron…；裸跑进入交互式 agent） |`
3. 新增小节「短命令与 `ow` 透传」（置于「命令」之后）：
   - 三个命令名与职责表（owl / openwiki-launcher / ow）；
   - 示例：`ow visualize --no-open --port 3939`、`ow link ../repo`、`ow auth configure openai`；
   - 明确警示：**`ow mcp` 是 openwiki 的直连 mcp（冷启动 30-50 秒）；宿主 MCP 配置请用 `owl mcp`（broker）**；
   - 说明 `ow` 使用当前激活版本（与 `mcp` 同源），用户无需另外安装全局 openwiki。
4. 故障排查表追加一行：`ow 报「未找到可用的 openwiki」` → 重跑安装器（`owl install`）或 `owl warm` 物化默认版本。

- [ ] **步骤 2：确认无测试影响**

运行：`npx vitest run test/release.test.mjs`
预期：PASS（README 在 files 里，打包内容断言不受影响）。

- [ ] **步骤 3：Commit**

```bash
git add README.md
git commit -m "docs: README 主推短命令 owl，新增 ow 透传章节"
```

### 任务 5：本机全局验收

**文件：** 不改代码；若实测发现缺陷，回到对应任务的测试补红-绿后单独提交修复。

- [ ] **步骤 1：重装全局包**

```bash
npm pack --pack-destination %TEMP%
npm install -g %TEMP%\openwiki-launcher-0.5.0.tgz --no-audit --no-fund
nvm firewall trust module openwiki-launcher        # 重装后签名变化，按需
nvm reshim
```

（若 `owl` / `ow` 的 shim 报 NVM4306，对相应的 module 执行同样的 trust。）

- [ ] **步骤 2：逐项验收（记录实测输出）**

| 项 | 命令 | 通过标准 |
| --- | --- | --- |
| 别名等价 | `owl version` 与 `openwiki-launcher version` | 输出一致 |
| 别名可用 | `owl doctor` | 全绿、无异常 |
| 透传帮助 | `ow --help` 与 `owl ow --help` | 显示 openwiki 自己的帮助（含 visualize 段），两者一致 |
| 可视化实测 | `ow visualize --no-open --port 3939` | 进程存活且 3939 端口可连；终止后退出码符合预期 |
| 退出码透明 | `ow definitely-not-a-command` | 退出码 = openwiki 自己的错误码（非 0），stderr 是 openwiki 的报错 |
| 不拦截 mcp | `ow --help` 输出中存在 mcp 相关说明即为透传语义（不做特殊拦截） | 命令未被 launcher 特殊处理 |
| 交互 TTY（人工项） | `ow` 裸跑 | openwiki 交互界面正常渲染；输入 `/exit` 可退出（AI 环境无法自动化，留给人确认） |
| 回归 | `npx vitest run` | 除已知 Windows symlink 环境项外全绿 |

- [ ] **步骤 3：清理与收尾**

删除测试用临时文件；把实测数据记录到 PR/会话总结；确认 `git status` 干净。
