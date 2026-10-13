# openwiki-launcher 冷启动治理设计

日期：2026-10-13
状态：待审查
范围：src/broker.mjs、src/backend.mjs、src/commands/mcp.mjs、新增 holder 与 lockfile 模块、构建脚本、docs

## 1. 背景与实测数据

launcher 已实现：连接即后台预热（`LAUNCHER_EAGER_START=0` 可关）、快照秒答握手与工具清单、
`tools/call` 排队透传（上限 120s）、后端单例常驻与崩溃重启。但实测确认问题形态为：

> **每个新宿主会话都要重付一次后端冷启动**（宿主断开即 `supervisor.stop()`），
> 且宿主在预热完成前就发出首个调用，调用必超时。

2026-10-13 实测（Windows，Defender 默认开启，node v24，openwiki 0.6.0）：

| 场景 | initialize 应答 | 后端就绪（预热完成） |
| --- | --- | --- |
| 经 launcher，文件缓存全冷 | ~2.3s | >120s（首次 tools/call 在 122.9s 得到应答，时间上与 120s 排队超时吻合，**返回体未捕获，此推断未经证实**） |
| 经 launcher，文件缓存半热 | ~1.5s | 33.5s |
| 直起 `node cli.js mcp`，缓存热 | 5.6~7.5s | 同左 |
| 经 launcher，缓存热 | ~1.4s（快照） | 5.5s |

关键结论：

1. **launcher 包装开销 ≈ 0**（热缓存下预热 5.5s vs 直起 5.6~7.5s）；
2. **时长方差由文件缓存温度主导**（6s → 33s → 120s+）；
3. **CPU profile（热态）显示 ~90% 自耗时在 `node:internal/modules/*` 与 v8 编译**；
   依赖自身的业务 CPU 均为 0；**无**索引加载、建库、联网等运行时初始化卡点
   → 冷启动瓶颈 = 模块图加载的文件 IO 与编译，bundle / compile cache / Defender 排除
   是对症的杠杆；
4. 首调到达 1.9s vs 预热完成 33.5s → 任何超时 < 30s 的宿主在每个新会话上必超时（判定为
   讨论中的 (b) 形态）。

测试局限（引用数字时按量级看，不当基线）：冷/热各仅采样一次；脚本固定 2s 后发首调，
与真实宿主行为（`tools/list` 后即调）量级一致；第一轮 122.9s 的应答内容未记录。

## 2. 目标与非目标

**目标**

- TTL 内的后续会话：首个 `tools/call` 在秒级得到真实应答；
- TTL 外的首个会话：调用在远短于宿主超时的时间内得到**明确的可重试错误**，而非静默超时；
- 压缩冷启动本身，使"当天第一个会话"的代价可承受；
- 宿主取消（`notifications/cancelled`）不再造成悬挂请求。

**非目标**

- 完整守护进程（开机自启、系统服务、跨用户）；
- 修改 openwiki 上游代码；
- 多机共享后端。

## 3. 已确认的架构事实（方案边界依据）

| 事实 | 来源 | 对方案的约束 |
| --- | --- | --- |
| openwiki MCP 层无内存会话状态，工具全落磁盘 | `src/integrations/mcp/server.ts:94-112` | 多会话共享一个后端进程不引入新的状态污染类问题 |
| capabilities 仅 tools，无 sampling/roots | 同上 | 不存在 server→client 请求在多客户端间的路由问题 |
| 上游主动通知现状即被丢弃 | `src/backend.mjs:90-92` | holder 无需实现通知广播 |
| `--host` 写入 openwiki run metadata | `src/backend.mjs:55` | holder 按 hostId 分 key，不混用 |

## 4. 第一步：排队策略（独立小改，先行合入，不依赖第二步）

改动集中在 `src/broker.mjs`：

1. **排队上限可配并下调**：新增 `LAUNCHER_QUEUE_TIMEOUT_MS`，默认 25000ms
   （现为常量 120000ms，远大于宿主超时，宿主永远等不到 wrapper 自己报错）。
   默认值的前提是目标宿主超时 ≥ 30s；若目标宿主存在更短超时，默认值随之下调；
2. **超时文案可执行**：排队超时返回 `isError: true`，文案改为
   `openwiki 后端仍在启动（冷启动可能需要 30~120 秒），请等待约 30 秒后重试`——
   明确的等待间隔避免 LLM 立即重试并在 120s 冷启动上重复消耗多轮排队
   （25s 上限时约需重试 3~4 次）；
3. **progress 通知**：`tools/call` 排队期间，若 `params._meta.progressToken` 存在，
   每 2 秒发一条 `notifications/progress`（progress 递增，message 注明"等待 openwiki 后端启动"）。
   不指望它兜底（`resetTimeoutOnProgress` 非普遍支持），但对支持的宿主直接消除硬超时；
4. **处理 `notifications/cancelled`**：建立 id → 取消映射；收到取消只终结该请求的应答，
   **不得**中断预热或重启后端；已透传到上游的调用按 MCP 语义仅丢弃结果。

测试：四项行为各一单测（可配上限、超时文案、progress 节奏与 token 透传、取消不波及预热）。

## 5. 第二步：延迟回收（holder + lockfile + TTL）

### 5.1 进程模型

- 新增 holder 进程：`openwiki-launcher holder --host <id>`；
  wrapper（`mcp` 命令）以 `detached: true` 拉起，脱离宿主会话生命周期，
  spawn 参数带 `windowsHide: true` 与 `stdio: 'ignore'`（避免弹出控制台窗口）；
- holder 内 spawn openwiki 子进程（沿用 `createBackendSession` 的启动参数与崩溃检测），
  并监听 `\\.\pipe\openwiki-launcher-<hostId>-<version>` 命名管道
  （`node:net`，跨宿主多客户端接入）；
- 每个宿主一份 holder。同宿主多会话共享同一 holder。

**detached 存活性（已做机制实测 + 保留逐宿主验证门槛）**

2026-10-13 本机机制实测（Win32 Job Object API 模拟宿主行为）：

- 对照：wrapper 被放入 kill-on-close Job 后 `TerminateJobObject` 能杀死它
  → assignment 与 kill 传播机制本身有效；
- 关键场景：wrapper 在 Job 内 detached 拉起子进程 → **wrapper 退出后子进程存活，
  job 句柄关闭（模拟宿主正常退出）后子进程依然存活**
  → Node `detached: true`（libuv）的子进程会脱离 kill-on-close Job。

剩余风险与处理：

- 宿主若用 `CreateProcess` 把 wrapper **直接创建**进禁止 breakaway 的 Job，
  detached spawn 会**直接失败**（不会留孤儿）→ wrapper 捕获 spawn 失败，
  该宿主回退到进程内 supervisor；
- **逐宿主验收门槛**：对首批支持的宿主（CodeBuddy、Claude Code 等）逐一实测
  "宿主退出后 holder 存活"（见 §8）；某宿主不成立 → 该宿主在 registry 中标注降级，
  永久走进程内 supervisor 路径。

### 5.2 lockfile

- 位置：launcher 数据目录下 `holder-<hostId>.json`，内容
  `{ pid, pipeName, version, startedAt }`；
- 创建用 `open(..., 'wx')` 独占语义防并发拉起：输方不覆盖，改为探活对方并接入；
- 探活 = 管道 connect 成功（不依赖 pid，规避 pid 复用）+ 版本匹配；
  **探活只代表 holder 存活，不代表 openwiki 后端就绪**——后者由连接内的排队机制处理；
- holder 优雅退出时删除 lockfile；探活失败视为残留，删除后重拉。

### 5.3 wrapper 侧逻辑变化

`runMcpCommand` 启动顺序：读 lockfile → 探活且版本匹配 → 直接接入；
否则独占创建 lockfile 并 detached 拉起 holder。

**回退触发条件（收窄，防止双重冷启动）**：

- holder **先监听管道、再启动 openwiki**，wrapper 一连上管道即进入排队等待，
  不需要等后端就绪 → "holder 还在启动、管道暂时连不上"属于正常状态，
  wrapper 以短间隔重试连接，**不触发回退**；
- 仅以下两种情况回退到现有进程内 supervisor，并打日志：
  1. detached 拉起 holder 本身失败（含上文禁止 breakaway 的 Job 场景）；
  2. 连接重试超过上限（建议 3 次 / 5 秒）仍连不上；
- 回退时不再触碰 lockfile 之外的后端资源，避免 holder 与进程内后端同时
  冷启动互相拖慢文件 IO、或同时写同一份 wiki 文件。

**宿主断开不再停止后端**，只断开与 holder 的连接。进程内 supervisor 保留为回退路径。

### 5.4 holder 内多路复用（已收窄）

wrapper 本来就用快照秒答 `initialize` 与 `tools/list`（不触碰后端），
因此这两类请求**不进 holder**。holder 只处理两类消息：

- **`tools/call`**：id 重映射（每连接自增 id → holder 全局唯一 id），响应按映射回送；
  `params._meta.progressToken` **直接剥掉**——已核实 openwiki 不发
  `notifications/progress`（`server.ts` 仅注册工具，无 progress 相关调用），
  无需双向路由；wrapper 在排队期间自己用宿主原 token 发 progress（§4），两者不冲突；
- **`notifications/cancelled`**：`requestId` 按连接映射为全局 id。

holder 自身对上游执行一次 initialize 握手（沿用 `initializeParams()`）。
上游主动通知保持现状丢弃（§3）。

### 5.5 TTL 与生命周期

- **空闲定义**：无活跃连接时开始计时；期间有新连接则取消计时器，
  断开后重新计时。空闲超过 TTL 则 holder 优雅退出并删 lockfile；
  默认 30 分钟，`LAUNCHER_HOLDER_TTL_MINUTES` 可配；
- 版本切换：lockfile 带 openwiki 版本，不匹配 → wrapper 请求旧 holder 退出（带兜底 kill）
  后拉新 holder；
- **局限（明示）**：TTL 过期或重启机器后的第一个会话仍付全款冷启动（30~120s+）。
  缓解手段：`warmup` 命令（见 5.6）与第三步。

### 5.6 warmup 命令

`openwiki-launcher warmup`：确保指定 hostId 的 holder 已就绪（复用现有 `warm` 的
就绪探测，目标从"拉起一次后端后退出"改为"接入或拉起 holder"）。文档给出挂登录启动项的
示例，`doctor` 顺带打印可直接复制的 `schtasks` 命令；**不自动写入**启动项。

### 5.7 测试

- holder 单测：id 重映射、initialize 缓存、progressToken 重写与还原、cancelled 映射、
  假上游 + 假双客户端；
- lockfile：并发创建竞争、残留探活失败重建、版本不匹配换血；
- TTL：空闲退出、活跃不退出；
- 真实后端冒烟（`LAUNCHER_REAL_SMOKE=1`）：连续两个会话，第二个首调 < 2s。

## 6. 第三步：压缩冷启动（剖析结论已就位）

剖析确认瓶颈是模块图加载（文件 IO + 编译），不是运行时初始化，因此：

1. **esbuild bundle**：将 openwiki `dist/` 与依赖打成单文件；`better-sqlite3` 及一切
   原生 `.node` 标记 external，产物与 bundle 同目录。产物进 `versions/<v>/`，
   与 `switch` / `versions remove` 集成；`files` 白名单加产物路径；
2. **Defender 排除**：`doctor` 增加检测与提示，打印可直接执行的
   `Add-MpPreference` 命令（需管理员）；**不做自动添加**（与现有护栏原则一致）；
3. **验收**：全冷（清文件缓存 + Defender 扫描态）启动对比基线，目标中位数 < 10s；
   bundle 后重跑一次 CPU profile，若瓶颈仍在再回查上游。

> compile cache：双路径实测未见收益（见 §9），已整体移除，无悬空项。

## 7. 风险与开放问题

- **命名管道安全**：本机任意进程可连接 holder 使用 openwiki 工具。openwiki 工具仅
  读写仓库内 wiki 文件，风险评估为可接受；写入文档说明；
- **多宿主内存代价**：每 hostId 一个 holder（≈ 一个 node + 一个 openwiki 进程），
  多宿主重度用户内存翻倍；
- **安装体积**：bundle 产物显著增大包体，GitHub 安装路径需验证；
- **compile cache 收益不确定**：按第 6.2 条实测决定去留。

## 8. 验收标准

| 步骤 | 标准 |
| --- | --- |
| 第一步 | 排队 25s 超时返回明确可重试文案；带 progressToken 的宿主无硬超时；取消不波及预热；单测全绿 |
| 第二步 | 同 hostId 连续两会话，第二会话首调 < 2s；**宿主退出后 holder 存活（逐宿主实测：CodeBuddy、Claude Code 等首批支持宿主各一次；不成立的宿主标注降级）**；两个会话并发调用时 id 与结果不串；TTL 后 holder 退出且 lockfile 清理；`switch` 后旧 holder 换新；宿主断开后端存活至 TTL |
| 第三步 | 全冷启动中位数 < 10s；Defender 排除前后有可对比数据；bundle 产物经 `doctor` 自检通过 |

## 9. 修订（2026-10-13，第三步交付后）：ensureBundle 统一打包入口

第三步交付后暴露缺口：bundle 只在构建时生成一份，全新机器安装、`update` 新版本、
`switch` 到旧版本都拿不到 bundle 且无任何提示。`prepare` 方案被否决（只覆盖安装时
版本；产物路径与 files 白名单错位即静默失效）。修订如下：

**机制**：`ensureBundle(version)` 成为唯一的 bundle 生产入口——"launcher 对某个
openwiki 版本目录执行的运行时操作"，而非仓库构建产物。

- **esbuild 懒安装**：不进 dependencies。首次需要时安装到 launcher 自己的
  `<pkgRoot>/tools/esbuild/`（独立 `npm install esbuild`，失败即降级并提示）。
  运行时依赖保持为零。
- **触发点**：`install`（预热前先 ensureBundle(active)，预热顺带验证 bundle 可启动）、
  `update <v>`（装完新版本后 best-effort，失败只提示不影响退出码）、
  `switch <v>`（毫秒级不构建：缺 bundle 打印状态并在后台起低优先级补打任务）、
  `mcp` 运行中缺 bundle（后端就绪后后台补，不占冷启动关键路径）、
  `doctor`（列出各版本 bundle 状态）。
- **原子写入**：构建到临时文件再 rename，杜绝读到半成品。
- **失效判断**：`bundle.meta.json` 记录 openwiki 版本、打包脚本哈希、Node 主版本、
  平台；任一变化视为过期，降级并重建。
- **运行时兜底**：bundle 启动的后端在就绪前崩溃 → 自动改用源码入口重试一次，并写
  `bundle.bad` 标记阻止后续会话重复踩坑（解析层见 `bundle.bad` 直接跳过 bundle）。
- **不静默**：`switch` 与 `doctor` 显示 bundle 状态。

**compile cache 双路径实测未见收益（数据）**：bundle 态 2.5s vs +cache 2.5~3.1s；
源码态（缓存已填充的多轮计时）6.3s vs +cache 9.3~10s。**原因待证**——
"缓存反序列化与校验的 IO 超过重编译"是推测。§6.2 的 compile cache 条目就此删除，
不留"实测决定去留"的悬空项：两条路径都不引入 compile cache。

**冷态收益未证**：现有对比均为热缓存数据。验收新增：ensureBundle 合入后，
**重启机器后的首次启动**实测一次（不清 standby list），作为两项决策的依据——
① bundle 的冷态收益量化；② `LAUNCHER_HOLDER` 是否改默认开启（若 bundle+排队已让
首调落在宿主超时内，holder 维持可选；holder 本体已交付，无需返工）。

**esbuild 懒安装的落点与约束**：esbuild 不进 dependencies，按需装到**用户级数据目录**
`%LOCALAPPDATA%\openwiki-launcher\tools\esbuild\`（非 %TEMP%、非 pkgRoot——pkgRoot
随 Node 版本与重装漂移，跨用户机器不可靠；`versions/` 同病，holder lockfile 的迁移
记为后续项）。约束：esbuild 钉死确切版本（不用范围）；npm 安装走用户既有 npm 配置
（复用 npm-runner，不硬编码源）；离线/失败静默降级但 `doctor` 可见原因。

**bundle.bad 的触发条件（防误判）**：只有"**bundle 启动失败且源码入口随后成功**"才写
标记；标记内容含当时 meta 的哈希，`ensureBundle` 重新构建成功后自动失效；
`doctor` 提供清除标记的说明。磁盘满、路径问题、杀毒拦截等与 bundle 无关的失败
不会污染标记。

**并发与 Windows 文件占用**：多会话同时发现缺 bundle 时，用规格 §5.2 同款 `wx` 独占
lockfile 做构建锁；重建时若产物内容哈希与现役一致则跳过，不一致则写到带哈希后缀的
新文件（`bundle-<hash8>.mjs`），由 meta 指向实际文件名——避免 rename 覆盖被运行中
后端（尤其 `.node`）占用的文件。

**后台构建的时机**：`switch`/`mcp` 的补打延后到**后端就绪之后**——冷启动瓶颈是 IO，
构建的 CPU/磁盘占用不得与它同时抢。

**已交付部分与本修订的衔接**：`scripts/bundle-backend.mjs` 的构建配置、
`resolveOpenwikiRuntime` 的 `preferBundle` 降级语义、doctor Defender 提示均保留，
作为 `ensureBundle` 的构建内核与降级底座；本修订新增的是懒安装、触发点接线、
元数据失效、原子写入与运行时兜底。
