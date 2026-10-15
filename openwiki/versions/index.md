# 文件

- [默认版本就绪：物化与自愈](default-readiness.md) - 出厂依赖为何要被物化进版本仓库、六态状态机、explicit 与 self-heal 双模式、删除标记与失败退避、后台自愈的时机与降优先级，以及各命令的接线。
- [版本命令：check / update / switch / versions](version-commands.md) - 版本管理子系统的命令层——四条命令各自回答什么问题、装依赖 → 录快照 → 写指针主链路的编排、默认版本就绪接线、交互确认的触发点，以及每个阶段的失败语义与降级策略。
- [openwiki 版本目录与生效指针](version-store.md) - 版本管理子系统的状态层——versions/<x.y.z>/ 的 side-by-side 布局与原子安装、active.json 指针的原子写入与损坏回退、三套锁与就绪标记的落点、已安装判定与删除规则，以及统一的运行时解析顺序。
