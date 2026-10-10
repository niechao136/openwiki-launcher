# 文件

- [openwiki 后端会话与监管](backend-supervisor.md) - launcher 如何拉起并监管 openwiki 后端子进程：spawn 形式、就绪握手、请求 id 关联、单飞启动、重试退避、崩溃重启、stderr 诊断与孤儿进程防御。
- [MCP 请求代理（broker）](mcp-broker.md) - broker 如何应答宿主的 initialize / tools/list / tools/call：快照快路径的触发条件、排队与超时预算、错误映射为工具结果、冷却熔断与恢复、清单漂移告警与宿主断开时的清理。
- [JSON-RPC 行传输与日志纪律](protocol-and-logging.md) - stdio 上换行分隔 JSON 的分帧实现，以及 stdout 只属 MCP、诊断全走 stderr 的纪律。
- [工具清单快照（manifest）](tool-manifest.md) - manifest 快照的生成、按版本选取、缺失降级直通与漂移检测。
