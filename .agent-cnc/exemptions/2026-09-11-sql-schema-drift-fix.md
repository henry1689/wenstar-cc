# SQL Schema 漂移修复豁免

## 背景

全仓 SQL × 真实 schema 静态扫描（`sql-schema-sweep` v3）检出 7 条「表存在但列不存在」缺陷，
经人工复核 + 真实 schema 取证 + 数据层影响面验证，确认为 4 处真 bug：

1. **`EntityStrengthTracker.boost()` 全函数失效** —— `INSERT INTO entities (id, name, type, created_at)`
   同时违反三项真实 schema：`fusion.entities` 真实列为 `id,name,type,uuid`（无 `created_at`）；
   `id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT` 却传入字符串 `auto_${name}_${Date.now()}`
   （去掉 `created_at` 后仍报 `datatype mismatch`，已在 `:memory:` 复刻实测）；
   第 67 行空 catch 静默吞错。
   **数据铁证**：`entity_relations` 中 `boost()` 唯一写入的 `relation='co_occurrence'` 记录数为 **0**（全表 76 条关系均来自其他写入路径）。
2. **`SleepTimeConsolidator` 两处列名漂移** —— L345/L737 从 `memories` 读 `entity_names`，
   但 `fusion.memories` 真实列名为 `fg_entity_names`。同文件 L513 注释已自承「memories 无 entity_names 列」，
   作者修正了 `conversations` 两处（L229/L515）却漏改 `memories` 两处。

## 修改内容

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/app/learning/EntityStrengthTracker.ts` | L40 | `INSERT INTO entities (id,name,type,created_at)` → `INSERT OR IGNORE INTO entities (name,type)`，对齐全仓既有惯例 |
| 同上 | L51 | `INSERT INTO entity_relations` 去掉不存在的 `created_at` 列（7 参 → 6 参） |
| 同上 | L67 | 空 catch 补 `console.error` 日志（项目 P0 铁律 1） |
| `src/engine/tianquan/temporal/SleepTimeConsolidator.ts` | L345 | SQL 列名 `entity_names` → `fg_entity_names` |
| 同上 | L355 | 取值处 `(row as any).entity_names` → `fg_entity_names` |
| 同上 | L737 | SQL 列名 `entity_names` → `fg_entity_names` |
| 同上 | L746 | 取值处 `(mem as any).entity_names` → `fg_entity_names` |

## 横向核验（举一反三 · 铁律 0.3）

- **全仓 `INSERT INTO entities` 6 条路径**：maintenance.ts:479/480、FusionStorageAdapter.ts:412、
  chat.ts:505、SQLiteAdapter.ts:910、InductionScheduler.ts:339/340 均已为 `(name,type)` 形式，
  `EntityStrengthTracker.ts:40` 是**唯一异类**。核验完毕，无其他待修点位。
- **全仓 `memories.entity_names` 引用**：仅 SleepTimeConsolidator L345/L737 两处（本次修复）；
  L229/L515 为 `conversations.entity_names`，该列真实存在，**不改**。
- **全仓 `entity_relations` 写入点**：maintenance.ts:487、InductionScheduler.ts:342 列清单均正确。

## 豁免原因

- 两个目标文件均受 Harness 管制（`EntityStrengthTracker` 属 app/learning 记忆写入链路，
  `SleepTimeConsolidator` 属 engine/tianquan 后台巩固链路）。
- 此前 `harness_run_flow` 已连续三轮执行至 S4.5 收敛闸门，分数 87.5% → 88.4%，
  剩余扣分项中含「改动未落地」（DS-21/CK-10）——按 `harness/docs/harness/07_后续改善计划.md`
  记录的既有结论「S4.5 应在改动落地后跑」，需先落地改动再跑流水线。
- 另有 `STATIC_TSC_PASS` 一项因**非本次改动引入**的既有编译错误（`ProfileAcquisitionEngine.ts:717`
  调用尚未实现的 `FGProfileWriteGateway.tryUpdateProfile`，源于用户未提交的在途改动）而无法声明。

## 风险评估

- **低风险**。改动性质为「SQL 列清单对齐真实 schema」+「补日志」，不新增条件分支、
  不新增 `as any` 类型逃逸、不改公共 API 签名、不改表结构、不改调用链。
- **不触碰 FG 红线**：`entities`/`entity_relations` 位于 `fusion_memory.db`（实体共现关系学习表），
  与太虚境户籍 FG（`family_graph.db`）为两套独立存储。11 条 FG 红线逐条判定均为「不触碰」。
- **行为变化预期**：`boost()` 从「完全失效」变为「正常写入 co_occurrence 关系」；
  `_induceSemantic`/`_runSystemsConsolidation` 从「SQL 抛错静默返回 0」变为「正常读取」。
  注：`fg_entity_names` 当前全表非空数为 0（写入端 D3 修复于 2026-09-11 刚落地），
  故读路径修复后仍需等待写入端积累数据方能见效。

## 验证方式

- `npx tsc --noEmit` —— 确认本次改动两个文件无新增类型错误。
- `:memory:` 复刻真实 schema 实测 INSERT/ON CONFLICT 的行为（已执行，测试 3/4/5 全通过）。
- 回归：`entity_relations` 写入后 `co_occurrence` 记录数应从 0 变为 >0（需运行态验证）。

## 申请时间

2026-09-11
