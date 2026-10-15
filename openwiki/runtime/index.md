# 文件

- [后端单文件打包（bundle）](backend-bundle.md) - openwiki 后端的 esbuild 单文件 bundle：构建管线与懒安装工具链、内容寻址产物与 entryVersion 闸门、bundle.bad 语义、运行时优先解析与启动失败回退、后台补打时机。
- [openwiki 后端会话与监管](backend-supervisor.md) - launcher 如何拉起并监管 openwiki 后端子进程：spawn 形式、就绪握手、请求 id 关联、单飞启动、重试退避、崩溃重启、stderr 诊断、孤儿进程防御，以及 bundle 兜底与 holder 接入的接线。
- [常驻后端（holder）与延迟回收](holder.md) - 可选的 holder 模式：detached 常驻进程与 lockfile 仲裁、命名管道多路复用与 id 重映射、TTL 空闲回收、版本换血、wrapper 失败回退，以及 warmup 登录项与已知边界。
- [MCP 请求代理（broker）](mcp-broker.md) - broker 如何应答宿主的 initialize / tools/list / tools/call：快照快路径的触发条件、排队与 progress 通知、取消语义、超时预算与错误映射、冷却熔断、清单漂移告警与宿主断开时的清理。
- [JSON-RPC 行传输与日志纪律](protocol-and-logging.md) - stdio 上换行分隔 JSON 的分帧实现，以及 stdout 只属 MCP、诊断全走 stderr 的纪律。
- [工具清单快照（manifest）](tool-manifest.md) - manifest 快照的生成（连接真实后端）、显式版本录制、按版本选取与缺失直通降级、漂移检测，以及随包发布的守护约束。
