# 文件

- [宿主注册表：28 家 AI 编码宿主的统一描述](host-registry.md) - src/registry.mjs 的条目字段语义、8 家可直写 / 18 家仅打印片段 / 2 家只装 skill 的分组判据、别名解析、PATH 探测与自校验规则。
- [安装决策器与安装编排](install-plan.md) - planInstall 作为纯函数决策器如何为每个宿主算出 skill 与 MCP 动作，以及 runInstall 的编排顺序、护栏一票否决、写入、备份、回滚与安装收尾的默认版本就绪/预热判据。
- [MCP 配置文件读写（json / codex-toml / opencode-json）](mcp-config-writer.md) - mcp-config.mjs 如何在保留用户注释、缩进与其他条目的前提下精确切片替换 openwiki 条目：注释掩码、结构检查、幂等判定与三种格式的差异。
- [Skill 目录安装、收据与完整性校验](skill-install.md) - skill bundle 的白名单安全边界、.openwiki-launcher.json 收据的内容与用途、逐文件 sha256 校验，以及共享技能目录下多宿主共存的处理。
- [卸载与归属判定](uninstall.md) - 卸载如何做到只删自己写过的东西：归属判定优先用收据中当时写入的 command、sha256 不匹配即跳过、共享目录只移除本家记录，以及不做顺手清理的设计边界。
