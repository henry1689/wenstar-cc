# 批次3：运行时堵漏方案

**日期**: 2026-09-15
**流水线**: wenstaros_core_repair_flow.yaml
**S2 审批依据**: 本文件

## 根因

三类列存在但零覆盖率，根因各异：

| 列 | 根因 |
|---|---|
| `time_period`/`season`/`lunar_term` | `writeMemory()` SQL 未包含这三列；`FusionStorageAdapter.setTemporalContext()` 从未被调用 |
| `topic_label` | `writeMemory()` SQL 有该列但调用方硬编码 `topicLabel: null` |
| `anchor_score` | `dialog-group-stage.ts` chunk 行 INSERT 无 anchor_score 参数 |
| `scar_type` | 无写入点，列存在但无逻辑 |
| `sub_type` | YuyaoMemoryService 已写入，但 episodic/dialog 记忆无 |

## 改动清单

### 1. `src/m2/SQLiteAdapter.ts` — writeMemory 补参数+SQL列

**新增 opts 参数**：
```ts
timePeriod?: string | null;
season?: string | null;
lunarTerm?: string | null;
anchorScore?: number | null;
scarType?: string | null;
subType?: string | null;
```

**SQL VALUES 增加**：`time_period, season, lunar_term, anchor_score, scar_type, sub_type`

**对应 ? 占位符**在 namespace 之后。

### 2. `src/webui/chat/persistence-stage.ts` — 传时空标签+topic

两处 writeMemory 调用（用户消息、助理回复）各加：
```ts
timePeriod: input.temporal?.period ?? null,
season: input.temporal?.season ?? null,
lunarTerm: input.temporal?.lunarTerm ?? null,
topicLabel: input.topic || null,
```

`input.temporal` 来自 `input.dna` 或从 `TemporalContextAggregator` 实时取。

### 3. `src/webui/chat/dialog-group-stage.ts` — chunk 行补 anchor_score

chunk INSERT（第203行）补 `anchor_score` 参数，值为 `chunkCalcium * 0.5`（碎片重要性是锚点的一半）。

### 4. `src/m2/FusionStorageAdapter.ts` — 恢复 setTemporalContext 调用

在 `chat.ts` 每轮对话开始时调用 `setTemporalContext`，从 `TemporalContextAggregator` 取当前值。

## 影响范围

- `writeMemory()` 签名扩展（新增可选参数，向后兼容）
- `persistence-stage.ts` 两处调用（+4参数）
- `dialog-group-stage.ts` 一处 INSERT（+1参数）
- `FusionStorageAdapter` 调用链（+1方法调用）

## 验证

- `tsc --noEmit` 零错误
- 启服后发一条消息，查 DB：`time_period/season/lunar_term/topic_label` 非空
- 对话组生成后查：`anchor_score` 非空（锚点行）
