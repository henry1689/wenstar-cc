# 变更台账 · 2026-11-02 40D 字典层级归位与锚点隔离列

- **批次**: V51（业主批准「案B 三件套」）
- **性质**: 共性底层通用修复（40D 数据契约是存储层落库 schema 与逻辑层输入契约的共用底层定义）
- **问题性质声明**: `arch_structural_defect` —— 走架构通道（R4）+ 三轮复审（R5）
- **流水线**: `wenstaros_core_repair_flow` S1→S7-B 十阶段通过
- **完整说明**: [V51-40D字典层级归位与锚点隔离列-变更说明.md](../V51-40D字典层级归位与锚点隔离列-变更说明.md)

## 一、改动清单（9 文件）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/m2/types/perception-40d.ts` | 8 行转发桩 → **176 行唯一真源**（含三层历史口径与归位依据） |
| 2 | `src/m3/types/perception-40d.ts` | 176 行定义 → **转发桩** `export * from '../../m2/...'` |
| 3 | `src/m2/SQLiteAdapter.ts` | ① `:141` import 改同层；② `:2898` 新增 `anchorNamespace` 继承查询；③ `:2923` 列清单补 `namespace`；④ `:2924` VALUES 补占位；⑤ `:2932` 参数补 `anchorNamespace` |
| 4 | `src/m2/YaoguangNormalizer.ts` | `:19-20` import 改同层 |
| 5 | `src/m2/PerceptionVector40DCodec.ts` | `:27` import 改同层 |
| 6 | `src/m2/__tests__/memory-write-columns.test.ts` | 新增隔离列守卫 3 例 |
| 7 | `docs/adr/ADR-007-m1-m9-module-boundaries.md` | 违规表补登记 M2→M3 反向依赖（P0）+ 修复 |
| 8 | `docs/V51-40D字典层级归位与锚点隔离列-变更说明.md` | 新建（白皮书/蓝皮书/持久化/回滚四部分） |
| 9 | 本文件 | 新建 |

## 二、缺陷根因（#13 收口）

**现象**：`test_mode` 流量写入的记忆，`namespace` 从 `'test'` 变回 `'default'`。

**穷举审计结论**（全仓扫写路径）：

| 通道 | 是否触及 namespace | 结论 |
|---|---|---|
| `write()`（SQLiteAdapter:1036） | ✅ 列清单含，且 `ON CONFLICT ... SET namespace = excluded.namespace` | 正确 |
| `writeMemory()`（SQLiteAdapter:1246） | ✅ 同上 | 正确 |
| `persistence-stage.ts` 4 处 | ✅ `namespace: input.ctx.testMode ? 'test' : 'default'` | 正确 |
| 全仓 `UPDATE memories`（约 30 处） | ❌ **零处**触及 | 不会改 |
| 14 个 `scripts/` backfill 脚本 | ❌ **零处**触及 | 不会改 |
| `_rebuildMemoryAnchors`（:2902） | ❌ **列清单缺 `namespace`** | **唯一缺口** |

**为什么缺列此前未暴露**：`_restoreSnap` 会按「表实际列 − 派生列」动态回填，`namespace` 不在 `ANCHOR_REBUILD_DERIVED_COLUMNS` 集合内 ⇒ 正常路径由快照补回。

**真实风险面**：快照构建是 `try { ... } catch { 降级为无回填 }`（日志原文「锚点快照失败（降级为无回填）」）。**降级发生时**，`INSERT OR REPLACE` 的 `DEFAULT 'default'` 生效 ⇒ 整批重建锚点丢失隔离标记，穿透检索侧 `namespace <> 'test'` 硬门。

⇒ 结论：**不是「重启必丢」，是对快照的单点依赖、降级即丢**。修复方向是写入时显式继承，消除单点。

## 三、S4 评审

| CK | 结果 |
|---|---|
| CK-01 管线依赖 | ✅ **本批修复目标** —— 6 个代码文件改后 m2→m3 值引用清零，m3→m2 为 ADR-007 正向 |
| CK-02 PFC 薄调度 | ✅ pass（不涉及） |
| CK-03~07, CK-11 | ✅ pass |
| DS-01 九层管线 | 改动前 60 分（CK-01 −40）→ **本批即为其修复**；S7-B 走 `arch_structural_defect` 架构通道放行 |

**诚实标注**：S4.5 收敛时 DS-01 尚为 60 分，因 CK-01 只有**改完代码**才消失，而拿令牌需先过 S4.5 —— 结构性死锁。经业主人工裁决（任务单 `ck_ddeef335ae6a7c93` 三项确认）+ 架构通道放行。

## 四、关联但不修改

| 文件 | 原因 |
|---|---|
| `src/m2/migration.ts:14` | `M3LogicOrchestrator` 值导入 —— **业务编排**（`new M3LogicOrchestrator()`），性质与数据契约归属不同，改它会动迁移执行时序 ⇒ **单独立项** |
| `SQLiteAdapter:121/140`、`Perception40DStore:15`、`math.ts:7/247`、`types/index.ts:6/71/146` | `import type` —— CK-01 口径编译期擦除、不计入依赖边，不影响 DS-01；彻底清理需连 `PerceptionState24`/`PerceptionV40` 类型一并下沉，属另一批次 |
| 全仓 24 处 `m3/types/perception-40d` 消费方（m4/m5/webui/app/测试） | 经 m3 转发桩继续供给，**一行不改** |

## 五、回滚

见 [V51 §五](../V51-40D字典层级归位与锚点隔离列-变更说明.md)。**配置变更：无**；**数据回滚：不需要**（只改写入路径，不迁移数据、不改 schema）。顺序敏感：先恢复 m3 真源、再撤 m2 桩。

## 六、待办

- [ ] `migration.ts:14` 业务编排反向依赖 —— 单独立项（已记 LEDGER）
- [ ] type-only 反向引用彻底下沉 —— 另一批次
- [ ] 落地后 `tsc --noEmit` + 全量 `vitest` 实测结果回填本表
