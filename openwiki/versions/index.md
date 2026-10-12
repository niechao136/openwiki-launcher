# 文件

- [版本命令：check / update / switch / versions](version-commands.md) - 版本管理子系统的命令层——四条命令各自回答什么问题、装依赖 → 录快照 → 写指针主链路的编排、交互确认的触发点，以及每个阶段的失败语义与降级策略。
- [openwiki 版本目录与生效指针](version-store.md) - 版本管理子系统的状态层——versions/<x.y.z>/ 的 side-by-side 布局、active.json 指针的原子写入与损坏回退、已安装判定与删除规则，以及统一的运行时解析顺序。
