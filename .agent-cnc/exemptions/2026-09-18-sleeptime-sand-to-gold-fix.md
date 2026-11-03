# 豁免记录：SleepTimeConsolidator 砂金→金库晋升缺陷修复（S4.5 复杂度收敛豁免）

- **日期**: 2026-09-18
- **任务**: 修复 `SleepTimeConsolidator._promoteSandToGold()` 三处缺陷（P0 静默丢数据 / P1 缺 role 过滤 / P1 缺长度过滤）
- **方式**: 分支2 + token 流程（`exemptions-core.cjs.addExemption`，`relaxed_checks: ["S4.5_complexity"]`，180 分钟）
- **豁免编号**: `ex-469e1b1f`（源文件） / `ex-8fa4ba13`（测试文件）

## 修改文件

| # | 文件 | 改动 |
|:-:|------|------|
| 1 | `src/engine/tianquan/temporal/SleepTimeConsolidator.ts` | SELECT 增补 `role`（**未**增补 `belong_entity_uuid`，见下）；循环开头加 `role!=='user'` 与 `minContentLength` 两道硬约束；手写 `INSERT OR IGNORE` + 无条件 `UPDATE is_promoted=1` 收口为 `sqlite.writeMemory(...)` + `if (!written) continue` |
| 2 | `src/__tests__/memory-insert-notnull-columns.test.ts`（新增） | 回归守卫：`src/**` 每个 `INSERT ... INTO memories` 的列清单必须覆盖目标库全部 NOT NULL 无默认列 |

### 落地修正（与初稿的差异，均已在 S3 核验）

- **归属 UUID**：初稿拟在 SELECT 增补 `belong_entity_uuid` 喂给 `deriveBelongUuid(row)`。落地核验 `conversations` 的 DDL（`SQLiteAdapter.ts` 485-522 行）**并无 `belong_entity_uuid` / `entity_uuid` 列**；权威路径 `MemoryAssessor.runSandToGold()` 的 SELECT（196-197 行）同样未取该列 → 其 `deriveBelongUuid(conv)` 恒为 `undefined`。若强行引入该列，SQLite 会抛 `no such column` → 整个晋升循环被 `catch` 吞成 0（**更严重的回归**）。故只加 `role`，`deriveBelongUuid(row)` 与权威路径**逐字一致**（无归属 → undefined → 落 NULL）。
- **回归守卫**：生产函数 `extractInsertColumns` 的 OR 子句**只识别 `OR REPLACE`**、不识别 `OR IGNORE`（`OR IGNORE` 恰是本次缺陷所在语句类型）。该函数所在文件不在本次改动范围，故守卫侧以 `columnsOf()` 把 `OR IGNORE` 归一为 `OR REPLACE` 后再解析（对「列清单」目标零影响）。

## 豁免范围与理由（为什么只放宽 S4.5 复杂度收敛）

`relaxed_checks: ["S4.5_complexity"]` **仅**放宽 CK-06.5（举一反三同名碰撞）与 CK-08（补丁嗅探），不放宽任何正确性检查。

| CK | 命中原因 | 判定 |
|:--|:--|:--|
| CK-06.5 | 本文件 `import type { FusionStorageAdapter }`，全仓 57 个文件同名 → 启发式恒报「同名候选 77 处」 | **误报**。该检查自述「名称碰撞≠共性缺陷，降 warn 不自动阻断」。真实共性判定在 S1 已完成：全仓 10 处 `INSERT INTO memories` 逐点扫描，仅本处缺列 |
| CK-08 | 对齐 `MemoryAssessor` 权威路径新增 3 个 if（`role!=='user'` / 长度门槛 / `if (!written) continue`） | **非场景化补丁分支**。前二者是「与主路径一致的硬约束」，第三者是「写入成功才标记」的核心不变量收口，均属消除两路径行为漂移与静默失败，而非按场景打补丁。补丁嗅探对「约束对齐 / 失败可见化」类改动无判别力 |

**正确性未被放宽**：CK-01~CK-07、CK-11 仍全量执行；S5 的 `npx tsc --noEmit` 与 `npx vitest run`、S6 的 CK-09/CK-10 意图验证仍为硬闸门。

## 回归守卫说明

现有 `memory-write-columns.test.ts`（D8）**捕获不到本次缺陷**：它只扫 `SQLiteAdapter.ts` 单文件、只查 6 个「身份/归属」列、且只匹配 `INSERT OR REPLACE`。本次缺陷位于 `INSERT OR IGNORE`（`OR IGNORE` 把 NOT NULL 违约静默吞掉），且缺的是 NOT NULL 列。新增守卫从真实库 schema 取 NOT NULL-无默认列集，按「多库容忍」对全仓 `INSERT INTO memories` 逐点核验。

## 红判定

FG 11 条红线全部不触碰：不改 `FamilyGraph.ts` / `nodes` / `edges` / `entity_relations` / UUID 分配 / `_inferCategory` / PAE；不涉及角色扮演、会晤实体传播链、dossier 结构。
