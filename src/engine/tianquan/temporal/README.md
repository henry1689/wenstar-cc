# Temporal 域（engine/tianquan/temporal/）— 海马体记忆

**含义：** 记忆时序、快照、巩固、新颖度检测、前瞻模拟。

> ⚠️ 此 temporal = "hippocampal memory timeline"，不是 "calendar time"。
> 日历时间的 temporal 在 `engine/temporal/`。

核心模块：SceneSnapshotBuilder、SleepTimeConsolidator(9阶段)、HippocampalIndex、ProspectiveSimulator、NoveltyDetector

SceneSnapshot 是 temporal→prefrontal 的唯一数据合约。
