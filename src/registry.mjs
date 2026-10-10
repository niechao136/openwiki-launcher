/**
 * 宿主注册表：本包支持的全部 MCP 宿主及其安装路径知识。
 *
 * 路径知识的来源有两个，都是已核实的官方文档，不猜：
 *
 *   1. superpowers-zh 的 TARGETS 表（d:/hub/superpowers-zh/bin/superpowers-zh.js:56-205）。
 *      每条都附官方文档出处或 issue 编号，是 26 家宿主 skills 目录的权威记录。
 *   2. openwiki 自身的宿主注册表（d:/hub/openwiki/src/integrations/install/registry.ts:10-142）。
 *      8 家已注册宿主的 MCP 配置路径与格式以它为准。
 *
 * 两表重叠 6 家（claude/cursor/codex/kiro/opencode/antigravity），并集 28 家。
 * 每条下面的注释保留出处标注 —— 这是「不确认不写、不猜路径」口径的可审计资产。
 */
import { existsSync } from "node:fs";

/** 仅这 8 家在 openwiki 自身注册表里已注册，MCP 配置格式有 ground truth，可自动写入。 */
const NATIVE_IDS = ["bob", "claude", "codex", "kiro", "opencode", "omp", "antigravity", "cursor"];

/** 原生收据文件名（openwiki 写的），与本包的 .openwiki-launcher.json 严格区分。 */
const NATIVE_RECEIPT = ".openwiki-install.json";

const RAW_HOSTS = [
  {
    id: "claude",
    displayName: "Claude Code",
    skill: {
      // 官方文档 codebuddy 无关：Claude Code 官方文档确认 .claude/skills 自动发现。
      projectDir: ".claude/skills",
      detect: [".claude"],
      globalDir: ".claude/skills",
      globalDetect: ".claude",
      bootFile: "CLAUDE.md",
    },
    mcp: { kind: "json", containerKey: "mcpServers", userPath: ".claude.json", projectPath: ".mcp.json" },
    // openwiki 注册表：用户级配置在 ~/.claude.json，项目级在 <repo>/.mcp.json。
    native: { skillDir: ".claude/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "cursor",
    displayName: "Cursor",
    skill: {
      // cursor.com/docs/skills：.cursor/skills/<name>/SKILL.md，启动自动发现，无需配置。
      projectDir: ".cursor/skills",
      detect: [".cursor", ".cursorrules"],
      globalDir: null,
      globalDirWin: null,
      globalDetect: null,
      bootFile: null,
    },
    mcp: { kind: "json", containerKey: "mcpServers", userPath: ".cursor/mcp.json", projectPath: ".cursor/mcp.json" },
    native: { skillDir: ".cursor/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    skill: {
      // Codex 各层级扫的都是 .agents/skills，从不扫 .codex/skills（superpowers-zh v1.7.11 的修正）。
      // 与 Antigravity 共用 .agents/skills 是预期的：两者共用这个开放约定。
      projectDir: ".agents/skills",
      detect: ".codex",
      globalDir: ".agents/skills",
      globalDetect: ".codex",
      bootFile: null,
    },
    mcp: { kind: "codex-toml", containerKey: "mcp_servers", userPath: ".codex/config.toml", projectPath: ".codex/config.toml" },
    native: { skillDir: ".agents/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "kiro",
    displayName: "Kiro",
    skill: {
      // kiro.dev/docs/steering：skills 放 .kiro/skills/（不被自动加载），
      // steering 每轮常驻，只放小索引。
      projectDir: ".kiro/skills",
      detect: ".kiro",
      globalDir: null,
      globalDirWin: null,
      globalDetect: null,
      bootFile: ".kiro/steering/openwiki-launcher.md",
    },
    mcp: { kind: "json", containerKey: "mcpServers", userPath: ".kiro/settings/mcp.json", projectPath: ".kiro/settings/mcp.json" },
    native: { skillDir: ".kiro/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    skill: {
      // opencode.ai/docs/skills：项目 .opencode/skills/，全局 ~/.config/opencode/skills/。
      // 它同时扫 .claude/skills 与 .agents/skills，已装过那两家的项目它能读到。
      projectDir: ".opencode/skills",
      detect: ".opencode",
      globalDir: ".config/opencode/skills",
      globalDetect: ".config/opencode",
      bootFile: null,
    },
    mcp: {
      kind: "opencode-json", containerKey: "mcp",
      userPath: ".config/opencode/opencode.jsonc", projectPath: "opencode.jsonc",
    },
    native: { skillDir: ".opencode/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    skill: {
      projectDir: ".agents/skills",
      detect: ".agents",
      // 裁决（规格 2.3）：不给全局目录。superpowers-zh 明确「未在 docs 证实」
      // （superpowers-zh.js:104-105），而 openwiki 注册表声称的全局路径
      // .gemini/antigravity-cli/skills/openwiki 引用的文档 URL 是 MCP 文档，
      // 并未证实 skills 加载路径。保守方向的代价是拒绝了少数情况可用，
      // 冒进方向的代价是装到不扫描的目录（装了不生效）—— 后者正是本项目要消灭的失败模式。
      globalDir: null,
      globalDirWin: null,
      globalDetect: null,
      bootFile: ".agents/rules.md",
    },
    mcp: {
      kind: "json", containerKey: "mcpServers",
      userPath: ".gemini/config/mcp_config.json", projectPath: ".agents/mcp_config.json",
    },
    native: { skillDir: ".agents/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "bob",
    displayName: "IBM Bob",
    skill: {
      // superpowers-zh 无此宿主，目录知识从 openwiki 注册表的 skillDirectory 反推：
      // .agents/skills/openwiki → 父目录 .agents/skills。
      projectDir: ".agents/skills",
      detect: [".bob"],
      globalDir: ".agents/skills",
      globalDetect: ".bob",
      bootFile: null,
    },
    mcp: { kind: "json", containerKey: "mcpServers", userPath: ".bob/mcp.json", projectPath: ".bob/mcp.json" },
    native: { skillDir: ".agents/skills/openwiki", receipt: NATIVE_RECEIPT },
  },
  {
    id: "omp",
    displayName: "Oh My Pi",
    skill: {
      // 同上，从 openwiki 注册表反推：用户级 .omp/agent/skills/openwiki，项目级 .omp/skills/openwiki。
      // 用户级默认指向 omp 的 agent 目录；命名 profile 与 PI_CODING_AGENT_DIR
      // 覆盖的设置请用项目级。
      projectDir: ".omp/skills",
      detect: [".omp"],
      globalDir: ".omp/agent/skills",
      globalDetect: ".omp",
      bootFile: null,
    },
    mcp: { kind: "json", containerKey: "mcpServers", userPath: ".omp/agent/mcp.json", projectPath: ".omp/mcp.json" },
    native: { skillDir: ".omp/skills/openwiki", receipt: NATIVE_RECEIPT },
  },

  // ---- 以下 20 家只有 skills 目录知识，MCP 配置一律 manual 或 null ----

  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    skill: {
      projectDir: ".gemini/skills",
      detect: "GEMINI.md",          // 某些检出只在项目根留 GEMINI.md，不建目录
      globalDir: null,              // 全局加载走扩展目录 ~/.gemini/extensions/*/skills/ + gemini-extension.json，不是简单复制
      globalDetect: null,
      bootFile: "GEMINI.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 ~/.gemini/settings.json 的 mcpServers 键
  },
  {
    id: "trae",
    displayName: "Trae",
    skill: {
      // docs.trae.cn/ide/skills：项目级 .trae/skills/，国际版与国内版相同。
      projectDir: ".trae/skills",
      detect: ".trae",
      globalDir: null,              // docs.trae.ai 没给国际版的全局路径，不猜
      globalDetect: null,
      bootFile: ".trae/rules/openwiki-launcher.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 MCP 配置是 UI 还是磁盘文件
  },
  {
    id: "trae-cn",
    displayName: "TRAE CN",
    skill: {
      // 只承担全局：docs.trae.cn/ide/skills 给出 macOS/Linux 与 Windows 都是
      // home 下的 .trae-cn/skills（%userprofile% 就是 home），不需要 dirWin。
      // 项目级由上面的 Trae 条目覆盖（两版同构），故单独成条而非挂在 Trae 上。
      projectDir: null,
      detect: [],
      globalDir: ".trae-cn/skills",
      globalDetect: ".trae-cn",
      bootFile: null,
    },
    noProjectReason:
      "TRAE CN 的项目级技能目录与国际版 TRAE 相同（.trae/skills/），已经由 Trae 这一条覆盖，请直接用：\n"
      + "  openwiki-launcher --tool trae\n"
      + "本条目只用于 TRAE CN 独有的全局目录（~/.trae-cn/skills）。",
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 同 Trae
  },
  {
    id: "vscode",
    displayName: "VS Code",
    skill: {
      // code.visualstudio.com/docs/copilot/customization/custom-instructions：
      // 只自动读 .github/copilot-instructions.md、AGENTS.md、CLAUDE.md（always-on）
      // 与 .github/instructions/*.instructions.md（按 applyTo 匹配）。
      projectDir: ".github/superpowers",
      detect: [".github/copilot-instructions.md", ".github/instructions"],
      globalDir: null,
      globalDetect: null,
      bootFile: ".github/instructions/openwiki-launcher.instructions.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 .vscode/mcp.json 与用户级 mcp.json 的键名
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    skill: {
      projectDir: "skills",
      detect: ".openclaw",
      globalDir: ".openclaw/skills",
      globalDetect: ".openclaw",
      bootFile: null,
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 MCP 配置是否落在 ~/.openclaw/ 下
  },
  {
    id: "windsurf",
    displayName: "Windsurf",
    skill: {
      // docs.windsurf.com/windsurf/cascade/skills：项目级 .windsurf/skills/，
      // **用户级是 ~/.codeium/windsurf/skills/，不是 ~/.windsurf/skills**（反直觉，已核实）。
      projectDir: ".windsurf/skills",
      detect: ".windsurf",
      globalDir: ".codeium/windsurf/skills",
      globalDetect: ".codeium",
      bootFile: null,
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 ~/.codeium/windsurf/mcp_config.json（与 skills 目录的差异同源）
  },
  {
    id: "aider",
    displayName: "Aider",
    skill: {
      // Aider 不创建 .aider/ 目录，它在项目根留下的是 .aider.* 前缀的产物。
      // CONVENTIONS.md 不会被自动加载，需要 `aider --read CONVENTIONS.md`。
      projectDir: ".aider/skills",
      detect: [".aider.conf.yml", ".aider.chat.history.md", ".aider.tags.cache.v3", ".aider"],
      globalDir: null,
      globalDetect: null,
      bootFile: "CONVENTIONS.md",
    },
    mcp: null,                      // 无 MCP 客户端能力，靠 SKILL.md 自带的降级路径
  },
  {
    id: "qwen-code",
    displayName: "Qwen Code",
    skill: {
      // QwenLM/qwen-code 这个 CLI（Gemini CLI 的 fork），**不是**通义灵码。
      projectDir: ".qwen/skills",
      detect: ".qwen",
      globalDir: ".qwen/skills",
      globalDetect: ".qwen",
      bootFile: "QWEN.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // Gemini CLI 的 fork，需核实是否沿用 ~/.gemini/ 约定
  },
  {
    id: "hermes",
    displayName: "Hermes Agent",
    skill: {
      // 官方文档：只自动加载 ~/.hermes/skills/，项目级不被自动发现，
      // 外部目录必须写进 ~/.hermes/config.yaml 的 skills.external_dirs。
      projectDir: ".hermes/skills",
      detect: [".hermes", "HERMES.md", ".hermes.md"],
      globalDir: ".hermes/skills",
      globalDetect: ".hermes",
      bootFile: "AGENTS.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 config.yaml 的 MCP 段结构（yaml，需新增第四种 kind）
  },
  {
    id: "claw-code",
    displayName: "Claw Code",
    skill: {
      // 源码级证据（ultraworkers/claw-code）：skills 从 .claw/skills、.omc/skills、
      // .agents/skills 等本地根发现；指令文件优先级 CLAUDE.md > CLAW.md > AGENTS.md。
      projectDir: ".claw/skills",
      detect: [".claw", "CLAW.md"],
      globalDir: null,
      globalDetect: null,
      bootFile: "CLAW.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 MCP 配置来源（可能仅读 CLAUDE.md）
  },
  {
    id: "qoder",
    displayName: "Qoder",
    skill: {
      projectDir: ".qoder/skills",
      detect: ".qoder",
      globalDir: ".qoder/skills",
      globalDetect: ".qoder",
      bootFile: ".qoder/rules/openwiki-launcher.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 ~/.qoder/ 下的 MCP 配置格式
  },
  {
    id: "codebuddy",
    displayName: "CodeBuddy",
    skill: {
      // codebuddy.cn/docs/cli/codebuddy-dir：全局与项目级同构，
      // 记忆文件 ~/.codebuddy/CODEBUDDY.md 与项目根 CODEBUDDY.md 两处等价，项目级优先。
      projectDir: ".codebuddy/skills",
      detect: [".codebuddy", "CODEBUDDY.md"],
      globalDir: ".codebuddy/skills",
      globalDetect: ".codebuddy",
      bootFile: "CODEBUDDY.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 规格 3.4 已定：MCP 配置入口在 IDE UI，磁盘路径未确认
  },
  {
    id: "codearts",
    displayName: "CodeArts",
    skill: {
      // 华为云码道。support.huaweicloud.com/usermanual-codeartssnap/codeartsdoer_ug_0024.html：
      // 项目级 ./.codeartsdoer/skills/，个人级 %USERPROFILE%/.codeartsdoer/skills。
      projectDir: ".codeartsdoer/skills",
      detect: ".codeartsdoer",
      globalDir: ".codeartsdoer/skills",
      globalDetect: ".codeartsdoer",
      bootFile: null,               // skills-only：其 bootstrap/指令文件约定未证实，不猜
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 MCP 配置入口
  },
  {
    id: "reasonix",
    displayName: "Reasonix",
    skill: {
      // esengine/DeepSeek-Reasonix。docs/CONFIG_PATHS.zh-CN.md：Reasonix home =
      // macOS/Linux ~/.reasonix，**Windows %APPDATA%\\reasonix**；全局 skills = <home>/skills/。
      // Windows 与 Unix 不同构，用 dirWin。
      projectDir: ".reasonix/skills",
      detect: [".reasonix", "reasonix.toml"],
      globalDir: ".reasonix/skills",
      globalDirWin: "AppData/Roaming/reasonix/skills",
      globalDetect: ".reasonix",
      bootFile: "REASONIX.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 reasonix.toml 的 MCP 表名（toml 需新增第四种 kind）
  },
  {
    id: "dsh",
    displayName: "DeepSeek Harness",
    skill: {
      projectDir: ".dsh/skills",
      detect: [".dsh", "dsh.json"],
      globalDir: ".dsh/skills",
      globalDetect: ".dsh",
      bootFile: "AGENTS.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 dsh.json 的 MCP 键结构
  },
  {
    id: "zcode",
    displayName: "ZCode",
    skill: {
      // zcode.z.ai/docs/skill 只写了一个路径：用户级 ~/.zcode/skills/<skill-name>/SKILL.md。
      // 项目级在文档里是「设置 → 技能」里的 UI 导入动作，**从不暴露项目级磁盘路径**，
      // 因此 projectDir 为 null —— 这是证据决定的，不是偷懒。
      projectDir: null,
      detect: [],
      globalDir: ".zcode/skills",
      globalDetect: ".zcode",
      bootFile: null,
    },
    noProjectReason:
      "ZCode 的项目级技能在「设置 → 技能」里通过 UI 导入，官方文档没有暴露项目级磁盘路径。\n"
      + "请改用全局安装：\n  openwiki-launcher --global --tool zcode",
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 MCP 配置入口
  },
  {
    id: "crush",
    displayName: "Crush",
    skill: {
      // 遵循 Agent Skills 开放标准，自动发现 .crush/skills、.agents/skills、
      // .claude/skills、.cursor/skills 四个目录。README 的「Agent Skills」一节
      // 给 Windows 用户的上手命令就是 mkdir "$env:LOCALAPPDATA\crush\skills"，
      // 所以 Windows 下不是 ~/.config/crush/skills —— 用 dirWin。
      projectDir: ".crush/skills",
      detect: [".crush", "crush.json", ".crush.json"],
      globalDir: ".config/crush/skills",
      globalDirWin: "AppData/Local/crush/skills",
      globalDetect: ".config/crush",
      bootFile: null,
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实 ~/.config/crush/mcp.json（Windows 下 dirWin 差异同样适用）
  },
  {
    id: "cline",
    displayName: "Cline",
    skill: {
      // VS Code 扩展，加载的是 rules 而非 skills，且 rules 每轮常驻 system prompt。
      // skills 放各自的 skills/ 目录（不被自动加载）。
      projectDir: ".cline/skills",
      detect: ".clinerules",
      globalDir: null,              // 全局 rules 在 ~/Documents/Cline/Rules（随 OS 变，Linux/WSL 还有 ~/Cline/Rules 回退），不是通用全局路径
      globalDetect: null,
      bootFile: ".clinerules/openwiki-launcher.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实是否支持 MCP 客户端
  },
  {
    id: "kilo-code",
    displayName: "Kilo Code",
    skill: {
      projectDir: ".kilocode/skills",
      detect: [".kilocode", ".kilo", "kilo.jsonc"],
      globalDir: null,              // 全局需改 kilo.jsonc，不是通用全局路径
      globalDetect: null,
      bootFile: ".kilocode/rules/openwiki-launcher.md",
    },
    mcp: { kind: "manual", containerKey: null, userPath: null, projectPath: null }, // 需核实是否支持 MCP 客户端
  },
  {
    id: "deerflow",
    displayName: "DeerFlow",
    skill: {
      // bytedance-deer-flow.mintlify.app/concepts/skills：自动扫描 skills/public 与
      // skills/custom 两个固定目录，custom 默认被 gitignore。
      // detect 用 skills/public：它是 skills 机制本身、随仓库版本控制，任何检出都有。
      projectDir: "skills/custom",
      detect: ["skills/public", "deer_flow"],
      globalDir: null,
      globalDetect: null,
      bootFile: null,
    },
    mcp: null,                      // 无 MCP 客户端能力
  },
];

/**
 * 把数据表归一化成消费端可以无差别处理的形状：
 *
 * - `detect` / `globalDetect` 一律是数组（superpowers-zh 的数据表允许写单字符串，
 *   这里统一成数组，消费端就不必每处都写 `Array.isArray(x) ? x : [x]`）；
 * - `globalDirWin` / `globalDetect` / `bootFile` / `noProjectReason` / `mcp` / `native`
 *   缺省时显式补 `null`，让「不支持」在数据上是一个值而不是「键不存在」——
 *   消费端 `h.native` 与 `h.native === null` 的判断不会因为漏写键而分叉。
 *
 * @param {object} h
 * @returns {object}
 */
function normalizeHost(h) {
  const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  return {
    ...h,
    aliases: toArray(h.aliases),
    skill: {
      ...h.skill,
      detect: toArray(h.skill.detect),
      globalDir: h.skill.globalDir ?? null,
      globalDirWin: h.skill.globalDirWin ?? null,
      globalDetect: h.skill.globalDetect ?? null,
      bootFile: h.skill.bootFile ?? null,
    },
    noProjectReason: h.noProjectReason ?? null,
    mcp: h.mcp ?? null,
    native: h.native ?? null,
  };
}

/** 28 家宿主，字段形状已归一化。 */
export const HOSTS = RAW_HOSTS.map(normalizeHost);

/**
 * 用户输入 → 规范 id。移植 superpowers-zh.js:1109-1159 的 TOOL_ALIASES，
 * 值从 displayName 换成本表的 id；另补 sp-zh 没有的 bob / omp。
 */
export const ALIASES = {
  cc: "claude", claudecode: "claude", claude: "claude", "claude-code": "claude",
  copilot: "claude", "copilot-cli": "claude",
  cursor: "cursor",
  codex: "codex",
  kiro: "kiro",
  opencode: "opencode",
  antigravity: "antigravity",
  bob: "bob",
  omp: "omp",
  gemini: "gemini-cli", "gemini-cli": "gemini-cli",
  trae: "trae",
  "trae-cn": "trae-cn", traecn: "trae-cn", "trae-china": "trae-cn",
  vscode: "vscode", "vs-code": "vscode",
  openclaw: "openclaw",
  windsurf: "windsurf",
  aider: "aider",
  qwen: "qwen-code", "qwen-code": "qwen-code",
  hermes: "hermes", "hermes-agent": "hermes",
  claw: "claw-code", "claw-code": "claw-code", clawcode: "claw-code",
  qoder: "qoder",
  codebuddy: "codebuddy", codebuddycode: "codebuddy", "codebuddy-code": "codebuddy",
  "codebuddy-cn": "codebuddy",
  codearts: "codearts", codeartsdoer: "codearts", "codearts-doer": "codearts", huawei: "codearts",
  cline: "cline",
  kilocode: "kilo-code", kilo: "kilo-code", "kilo-code": "kilo-code",
  crush: "crush",
  reasonix: "reasonix",
  dsh: "dsh", deepseek: "dsh", "deepseek-harness": "dsh",
  zcode: "zcode", "z-code": "zcode",
  deerflow: "deerflow",
};

/**
 * CLI 可执行文件名 —— 检测落空时扫 PATH 给出针对性建议。
 * 只列 CLI：IDE（Cursor/Trae/Qoder 等）装在应用目录里，PATH 上探不到。
 */
export const CLI_PROBES = {
  claude: ["claude", "copilot"],
  codex: ["codex"],
  "gemini-cli": ["gemini"],
  opencode: ["opencode"],
  aider: ["aider"],
  "qwen-code": ["qwen"],
  openclaw: ["openclaw"],
  "claw-code": ["claw"],
  crush: ["crush"],
  hermes: ["hermes"],
};

/** MCP kind 枚举：三种可自动写 + manual（只打印片段）+ null（无 MCP 客户端能力）。 */
const AUTO_KINDS = ["json", "codex-toml", "opencode-json"];
const ALL_KINDS = [...AUTO_KINDS, "manual"];

/**
 * 解析用户输入的宿主名或别名。
 *
 * @param {string} nameOrAlias
 * @returns {object | null} 匹配的宿主条目，未命中返回 null
 */
export function findHost(nameOrAlias) {
  if (typeof nameOrAlias !== "string" || nameOrAlias === "") return null;
  const key = nameOrAlias.trim().toLowerCase();
  const byId = HOSTS.find((h) => h.id === key);
  if (byId) return byId;
  const id = ALIASES[key];
  return id ? HOSTS.find((h) => h.id === id) ?? null : null;
}

/**
 * 反查某宿主的最短别名，用于拼出可直接复制的 --tool 命令。
 *
 * @param {string} id
 * @returns {string} 最短别名；没有别名时回退为 id 本身
 */
export function shortestAlias(id) {
  const aliases = Object.keys(ALIASES).filter((a) => ALIASES[a] === id).sort((a, b) => a.length - b.length);
  return aliases[0] ?? id;
}

/**
 * 在 PATH 里找可执行文件。只查文件是否存在，不 spawn 进程 ——
 * 绝不在用户机器上执行探测命令（既慢又有副作用风险）。
 *
 * @param {string} bin 可执行文件名，不含扩展名
 * @param {{ platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [opts]
 * @returns {boolean}
 */
export function isOnPath(bin, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const sep = platform === "win32" ? ";" : ":";
  const dirs = String(env.PATH ?? "").split(sep).filter(Boolean);
  const exts = platform === "win32"
    ? ["", ...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (exists(`${dir}${platform === "win32" ? "\\" : "/"}${bin}${ext}`)) return true;
      } catch {
        // 单个路径不可访问（如权限不足）不该中断整次探测
      }
    }
  }
  return false;
}

/**
 * 逐条校验注册表，返回问题列表（空数组表示全部合法）。
 *
 * 这是「不猜路径」口径的自动化闸门：新增宿主时若漏填字段、id 不合法、
 * 声称可自动写 MCP 却没有路径，立刻在这里暴露，而不是等到某台机器上装错。
 *
 * @returns {string[]}
 */
export function validateRegistry() {
  const problems = [];
  const seen = new Set();

  for (const h of HOSTS) {
    const at = `宿主 ${h.id}`;
    if (seen.has(h.id)) problems.push(`${at}: id 重复`);
    seen.add(h.id);

    if (!/^[a-z0-9-]{1,64}$/u.test(h.id)) problems.push(`${at}: id 不匹配 /^[a-z0-9-]{1,64}$/`);

    if (!h.skill) { problems.push(`${at}: 缺 skill 字段`); continue; }
    if (h.skill.projectDir === null && typeof h.noProjectReason !== "string") {
      problems.push(`${at}: projectDir 为 null 时必须给 noProjectReason`);
    }
    if (h.skill.projectDir === undefined) problems.push(`${at}: skill.projectDir 未声明（用 null 表示不支持）`);
    if (h.skill.globalDir !== null && !h.skill.globalDir) problems.push(`${at}: skill.globalDir 未声明`);
    if (h.skill.globalDir && !h.skill.globalDetect) problems.push(`${at}: 有 globalDir 但缺 globalDetect`);
    if (h.skill.globalDirWin && !h.skill.globalDir) problems.push(`${at}: 有 globalDirWin 但缺 globalDir`);

    const detectMarkers = h.skill.detect ?? [];
    if (!Array.isArray(detectMarkers)) problems.push(`${at}: skill.detect 必须是数组`);

    if (h.mcp === null) {
      // 无 MCP 客户端能力，合法
    } else if (h.mcp === undefined) {
      problems.push(`${at}: mcp 未声明（用 null 表示无 MCP 客户端能力）`);
    } else {
      if (!ALL_KINDS.includes(h.mcp.kind)) problems.push(`${at}: mcp.kind 非法 -> ${h.mcp.kind}`);
      if (AUTO_KINDS.includes(h.mcp.kind)) {
        for (const key of ["containerKey", "userPath", "projectPath"]) {
          if (!h.mcp[key]) problems.push(`${at}: mcp.kind=${h.mcp.kind} 缺 ${key}`);
        }
      }
    }

    const expectNative = NATIVE_IDS.includes(h.id);
    if (expectNative && !h.native) problems.push(`${at}: 属 openwiki 已注册宿主，必须带 native 定位信息`);
    if (!expectNative && h.native) problems.push(`${at}: 非 openwiki 已注册宿主，不应有 native 字段`);
    if (h.native && !h.native.skillDir) problems.push(`${at}: native 缺 skillDir`);
    if (h.native && h.native.receipt !== NATIVE_RECEIPT) {
      problems.push(`${at}: native.receipt 必须是 ${NATIVE_RECEIPT}`);
    }
  }

  for (const [alias, id] of Object.entries(ALIASES)) {
    if (!seen.has(id)) problems.push(`别名 ${alias}: 指向不存在的宿主 ${id}`);
  }
  for (const id of Object.keys(CLI_PROBES)) {
    if (!seen.has(id)) problems.push(`CLI_PROBES.${id}: 不是已注册宿主`);
  }

  return problems;
}