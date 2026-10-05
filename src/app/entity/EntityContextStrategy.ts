/**
 * EntityContextStrategy —— 已废弃（2026-10-05 删除实现，保留墓碑）
 * ================================================================
 * 🔴 V35-B：本模块原有 `computeStrategy()` / `applyTokenBudget()` 两个导出，
 *    现**全部移除**，文件仅保留此说明。原因如下，勿在原处复活：
 *
 * 【一】它是「上下文窗口」这个概念的第 7 份实现。
 *   V35-B 之前，同一个窗口在仓里共有六套互不知情的口径（配置真源 80、keepFullTurns 100、
 *   chat.ts 写死 40 与 20、m5 的 slice(-20)、本模块的绝对值档位 5/10/20/40/60、压缩处塌成 8~10）。
 *   本模块是其中最隐蔽的一份 —— 它压在配置窗口**之上**，把 80 又切一刀。
 *
 * 【二】它的两个输入从来就是坏的，也就是说它从未按设计工作过。
 *   · `warmth`：唯一调用点（chat.ts 会晤增强块）传的是 **undefined**，
 *     代码注释自陈「edges warmth 需单独查，此处略过」⇒ intimate / soulmate 档**永远不可达**。
 *   · `lastInteraction`：调用点读的是 `entity.last_interaction`，
 *     而 FG 的 nodes 表**没有这个字段**（只有 properties.last_mentioned）⇒
 *     冷对话（>14 天）/ 久未互动（>7 天）两档可能被误触发，把窗口压到 1/16 或 1/8。
 *   实测（2026-10-05，徐诗雨 category='A'）：它把窗口压到 40 条，
 *   而业主选定的是 80 条；各档位字符总量的实测反推（4469 + 守卫伪轮 ≈ 生产 hist 5171）证实了这一点。
 *
 * 【三】窗口政策理应只有一处（不变量#7：禁止同一业务规则在多处实现）。
 *   2026-10-05 业主裁定：**会晤窗口 = MemoryConfig.compaction.contextWindowTurns（80）**，
 *   不接受任何"在其之上再切一刀"的第二套政策；相应地，放弃"冷实体收缩窗口"这一能力
 *   （该能力本就因输入缺失而未真正生效）。
 *
 * 【四】`applyTokenBudget()` 另有一份同族死代码，已于同批删除：
 *   · `EntityContextStrategy.applyTokenBudget` —— 用 `budgetTokens/200` 封顶 60，零调用点；
 *   · `EntityContextManager.applyTokenBudget`   —— 同样 `Math.min(60, budgetTokens/200)`，零调用点。
 *
 * 若将来确需恢复"按关系亲疏 / 互动频次差异化窗口"，请先确保：
 *   ① 输入真实可得（warmth 需从 FG edges 查、时间维度需用 nodes 表真实存在的字段）；
 *   ② 表达方式是"相对配置窗口的比例"，而非另一套绝对值；
 *   ③ 有回归测试锁住"不得超过配置窗口"。
 *   在此之前，不要重新引入本模块。
 */

export {};
