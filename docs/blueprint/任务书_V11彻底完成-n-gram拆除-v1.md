# 任务书 · V11 彻底完成与 n-gram 拆除 v1

> **状态**：执行中 · 2026-11-02 立项
> **上位**：`白皮书_检索架构-v11-结构化召回取代ngram索引.md` §S4 · `拆除计划_检索v11-旧链路下线.md`
> **性质**：架构收口。目标是让**所有召回**走同一套 `StructuredRecall`，不再存在第二份实现。

---

## 〇、业主决策（2026-11-02 原文）

| # | 决策 | 含义 |
|---|---|---|
| 1 | 「新开，彻底与过去决裂」 | 新开关 `dialog_group_v11_recall`；旧开关 `enable_dialog_group_memory` 删除 |
| 2 | 「建好就拆，不用观察」 | 不设双跑观察期、不留共存状态 |
| 3 | 「绝对不用旧方案兜底」 | 🔴 **旧 n-gram 路径代码直接删除，不保留 fallback、不做降级回退** |
| 4 | 标签 | **不做**（实测证明不需要，详见 §二） |

> 「每次改善不沉底」—— 业主明确指出的历史病根：改动上线后旧路径不删，导致问题反复。
> 本任务书以「删干净」为验收标准，而不是「新路径能跑」。

---

## 一、为什么必须拆（实测证据）

| 证据 | 数值 |
|---|---|
| `dialog_groups` 实际数据量 | 3,076 行，摘要合计 **0.48 MB** |
| 为它维护的 n-gram 索引 | **769,131 行 / 110.4 MB**（230 倍） |
| n-gram 查询耗时（中位，生产日志） | **55 ms** |
| v11 围栏+精排耗时（同批查询实测） | **27.4 ms（快 9.4 倍）** |
| 召回质量对比（40 条真实查询） | 两路均 40/40 召回，质量相当 |
| 索引内容构成 | 72.1% 的 term 只出现 1 次（跨词碎片）；高频 term 全是摘要模板套话（`标签`/`叙事`/`情感` 各命中 2,585 块，区分度为零） |

**结论**：索引不仅不必要，且**系统性劣化排序**——`COUNT(DISTINCT term)` 让每个块都有的模板词拿到最高分。

---

## 二、为什么不加「标签」

| 依据 | 说明 |
|---|---|
| 实验 | B 路只喂 `rawQuery` 分片，召回质量已达 A 路水平（3 个抽查查询：2 个 B 路更好，1 个 A 路略优） |
| 数据 | tags 共 8,706 个不同值，**73.9% 只出现一次**——自由生成，天然不收敛 |
| 成本 | 加标签 = 新增列 + 迁移 + 回填 + prompt 改造，四个新增面 |
| 替代 | `DOMAIN_SPECS.dialog_group.vecCol` 改为 `perception_40d_snapshot`（列已存在），40D 提供语义维度 |

> 例外条款：若日后出现「用户问法完全对不上摘要用词」的真实召回缺口，**有具体案例**再加标签。

---

## 三、目标架构（闭环）

```
【产出】闭组 → BlockSummaryService → block_summary + block_calcium_score → dialog_groups
       闭组 → BlockArchiveService → perception_40d_snapshot（组级 40D 聚合）

【消费】DialogGroupAdapter
   └─ recallByStructured(domain='dialog_group')          ← 唯一实现
        ├─ ① UUID 闸门 buildSqlClause（第一个拼进 SQL）
        ├─ ② 关键词分片 LIKE 围栏（LIMIT 500）
        ├─ ③ scoreAndRank：hit 0.45 / 钙化 0.30 / 近因 0.15 / 语义 0.10
        └─ ④ top-K → MeetingOrchestrator → LLM 上下文

【去除】search_index 表 / buildNgrams 落索引 / rebuildAllIndexes / 全部维护入口
       （buildNgrams 函数本体保留——v11 的分片切词复用它）
```

---

## 四、分批实施

### B1 · 对话块接入 v11
- `src/m4/retrieval/adapters/DialogGroupAdapter.ts`：`search()` 改为 `recallByStructured` + `scoreAndRank`
- 保留：lifecycle `archived` 降权、摘要前置正文、`backref`
- 新开关：`dialog_group_v11_recall`（配置项）；关闭 = 该路不注册，**不回退旧实现**
- `src/m4/retrieval/StructuredRecall.ts`：`DOMAIN_SPECS.dialog_group.vecCol` 由 `null` → `'perception_40d_snapshot'`

### B2 · 删除旧实现
- 删 `DialogGroupAdapter` 的双通道 SQL（约 60 行）与 `SUMMARY_HIT_NORM` / `POOL_FACTOR`
- 删旧配置项 `enable_dialog_group_memory`
- 删 `BlockSummaryService.indexSummary()` 与 `BLOCK_SUMMARY_SOURCE_TYPE`

### B3 · 拆除 search_index（不可逆，需停服 + 全库备份）
- 停写：`KnowledgeEngine`（2 处）、`MemoryAssessor`、`WorkRepository`、`ConversationDB`
- 删维护入口：`rebuildAllIndexes`、`KnowledgeEngine.reindexAll`、`scripts/rebuild-search-index.ts`、`server-observability-routes` 的分区统计
- 删读取：`meeting-recall.recallSandboxConversations` 的倒排分支、`MemoryRetriever.recallByKeywordIndex`、`UnifiedSearchEngine` 的 n-gram 初筛
- `schema.sql`：删 `search_index` 建表与索引
- 新迁移（v33）：`DROP TABLE search_index`
- 下线 `GapLedger`（业主 2026-10-28 已裁「甲」）

### B4 · 修降级路径
- `retrieval-stage.ts:1391`：V13 失败时的 V11 兜底改走 `recallByStructured`，**不得再依赖 search_index**
- 兜底失败即返回空 + 告警，**不静默**

### B5 · 防复发守卫
- `src/m4/__tests__/search-index-removed.test.ts`：全仓静态扫描 `search_index` 必须为 0（迁移历史白名单除外）
- `sql-schema-consistency` 增断言：运行库 `sqlite_master` 无 `search_index`

---

## 五、验收判据

| # | 判据 |
|---|---|
| 1 | `npx tsc --noEmit` 退出码 0 |
| 2 | 全量测试通过（含新增守卫） |
| 3 | 生产会晤实测：对话块召回条数 ≥ 改造前，耗时不升 |
| 4 | 库体积 **254 MB → 约 144 MB** |
| 5 | `grep -rn "search_index" src/ scripts/` = 0（迁移历史白名单除外） |
| 6 | `buildNgrams` 仍存在且 v11 分片可用（不得误删自身依赖） |

---

## 六、回滚

| 批 | 方式 |
|---|---|
| B1/B2 | `git revert` 单 commit |
| B3 | 🔴 **DROP TABLE 不可逆** —— 停服前须全库备份并记录路径（红线 D5） |
| B4/B5 | `git revert` |

---

## 七、风险登记

| 风险 | 处置 |
|---|---|
| 40D 快照当前 **0 行有数据**（`BlockArchiveService` 未产出） | B1 允许 `vecCol` 指向该列：无向量时 `cosine=undefined`，`scoreAndRank` 按语义权重 0 重归一（法规第四条：无向量只能跳过，不得填 0 冒充）。同时排查归档服务为何未产出 |
| 会晤场景无 `dialog_group` 命中时退化为 3 条 | 由 hitShards 主导权重保证召回不塌陷（实测 40/40） |
| 并行会话共享工作树 | 每批一个 commit，提交前 `git status` 确认仅含本批文件 |

---

## 相关

- `拆除计划_检索v11-旧链路下线.md`（原计划，本任务书为其「不留一行旧代码」的收敛版）
- `白皮书_检索架构-v11-结构化召回取代ngram索引.md` §4.2.2（分片切词复用 buildNgrams，但不建索引）
- 记忆：`wenstar-retrieval-v11-s2s3`、`wenstar-adr010-dialog-group`
