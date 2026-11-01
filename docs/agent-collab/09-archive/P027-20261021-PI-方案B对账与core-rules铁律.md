---
id: P027
type: progress
title: 任务I 进展 — 方案B dry-run 对账(1660 vs Claude 205) + core-rules 身份隔离铁律已提交
author: pi-agent
status: done_waiting_review
created: 2026-10-21
related: [R025, I010, P026, I008]
---

# P027 · 任务I 进展（dry-run 对账 + core-rules 铁律）

## 一、方案B dry-run 对账：PI 算 **1660**，Claude I010 算 **205**（待对齐）

我按 R025§四.1 重新 dry-run（只读副本、交叉验证），并修正了自己首版的一个口径错误：

**PI 首版错误（已自纠）**：vault 引用查询误加 `source_type='memory'` 过滤 → 返回 0。
实测 vault_log 的 source_type 只有 null/gold/sand/conversation，**无 'memory' 类型**；
正确应为 `vault_log.source_id = memories.id`（不限 type，主要 'gold'=已晋升黑钻）。

**PI 修正后（交叉验证 4300 = 1660 + 2640 ✅）**：
| 项 | 条数 |
|---|---|
| 方案B 原始（recall=0 且钙<1 且>30天）| **4300** |
| ∩ vault引用(source_id=id，不限type) | 2144 |
| ∩ 锚点 | 546 |
| ∩ NULL归属 | 58 |
| ∩ 高钙组 | 0 |
| 边界并集被排除 | 2640 |
| **最终候选清除** | **1660** |

**与 Claude I010 的 205 对不上**：Claude 同样列 vault=2144/锚点=546/NULL=58（与我一致），
但其最终 205 ⇒ 需排除 4300-205=**4096**，而四边界总和仅 2748（并集 ≤2748）——**数学上不可能仅靠这四边界排除 4096**。
疑 Claude 最终查询有类似我首版的 NULL/dialog_group 归属 bug，或另有未列明的隐式边界。

**建议**：PI 的 1660 有交叉验证支撑；请 Claude/豆包复核 205 的最终 SQL（是否漏了 NULL dialog_group_id 保护或多算了边界）。
两者未对齐前**不进停服窗口执行删除**。

## 二、core-rules.ts 身份隔离铁律 ✅ 已提交（cafd40f）

R025§三 Harness² 优化产物，仅会晤分支：
- `identityIsolationRule` 常量：isEntityMeeting=true 输出 5 条（只引用自己记忆/不引用他人/UUID过滤/提到他人不冒用/不确定说不太记得），非会晤='' 零影响
- 插在身份铁律之后、长度标准之前
- 验证：会晤含铁律+UUID过滤、非会晤不含、位置正确、长度标准不受影响；tsc=0
- reasoning-leak-length-cap 失败经 git stash 验证为**预存在无关**（SQLiteAdapter 埋点格式）
- Harness: run_mvgxuovx_pvhu 令牌已签

## 三、FG 合并（停服窗口执行）——已记录 I010§六 三个实现坑

合并 TXS-29(陈都灵)→TXS-25(安琪) 时必须避开：
1. **精确名优先于别名**：即使加"陈都灵"到安琪 aliases，getUUIDByName('陈都灵') 仍优先命中 TXS-29 的 name 精确匹配 ⇒ 须把 TXS-29 置 `status='void'`（查找排除 void）或改名；只写 properties.merged_into 无效
2. **别名须 JSON 数组**：`aliases = ["都灵","陈都灵",…原有]`（LIKE `%"都灵"%` 匹配），逗号分隔无效
3. **void 会连带清边**（FamilyGraph.ts:1859）⇒ **先搬边、再置 void**
- FG 主库是 `data/webui/knowledge/family_graph.db`（1060节点/1313边），**非** `data/family_graph.db`（陈旧3节点副本）

## 四、状态
- core-rules 铁律 ✅ 已提交（可独立于停服窗口）
- 方案B 清除数 ⏸ 与 Claude 对齐 1660 vs 205 后，才进停服窗口执行（FG合并+垃圾清除）
- 待 Claude/豆包对齐方案B口径 → 停服窗口执行（Claude停服→备份→PI执行→Claude复核→重启）
