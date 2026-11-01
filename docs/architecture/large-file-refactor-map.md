# 大文件拆解与天枢归属报告

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期：2026-08-07 · 性质：只读扫描 · 关联任务：《WenStarOS 天枢架构全局复盘与重设》
> 范围：wenstar-cc `src/**/*.ts` 大文件（总计约 11.2 万行 TS）

---

## 一、大文件分档总览

```
3000+ 行    1 个    FamilyGraph.ts（5924）
2000-2999   3 个    server.ts（2849）/ chat.ts（2627）/ SQLiteAdapter.ts（2207）
1500-1999   0 个    （1165 与 2207 之间断层）
1000-1499   1 个    server-observability-routes.ts（1165）
500-1000    ~30 个  （见第三节）
```

**危险特征列**：DB | LLM | Srch(检索) | RPC | 40D | Tmr(定时器)，✓ 命中。

---

## 二、Top 大文件明细（≥500 行）

| 行数 | 文件 | 职责 | 热路径 | DB\|LLM\|Srch\|RPC\|40D\|Tmr | 天枢归属 |
|---|---|---|---|---|---|---|---|---|---|
| 5924 | src/m4/household/FamilyGraph.ts | 户籍数据层：nodes/edges + dossier 卷宗 + BFS 推理 | 基 | ✓\|–\|✓\|–\|–\|✓ | **DomainCenter** |
| 2849 | src/webui/server.ts | HTTP 组合根：装配 M1-M8、chat 路由、40D 状态、定时器群 | 聊 | ✓\|✓\|✓\|✓\|–\|✓ | **SystemCenter** |
| 2627 | src/webui/chat.ts | 聊天主链 processChat 全链路编排 | 聊 | ✓\|✓\|✓\|✓\|✓\|✓ | **IntentCenter** |
| 2207 | src/m2/SQLiteAdapter.ts | 存储引擎：sql.js + 40D 编解码 + n-gram + FTS 初始化 | 写 | ✓\|–\|✓\|–\|✓\|✓ | **WriteCenter + VectorCenter** |
| 1165 | src/webui/server-observability-routes.ts | 可观测性路由 | 基 | ✓\|–\|✓\|✓\|–\|– | **SystemCenter** |
| 973 | src/app/knowledge/KnowledgeEngine.ts | 知识引擎：分块/嵌入/向量+FTS5+RAG | 检 | ✓\|–\|✓\|✓\|–\|– | **SearchCenter + VectorCenter** |
| 933 | src/engine/tianquan/temporal/SleepTimeConsolidator.ts | 睡眠期记忆巩固流水线 | 后 | ✓\|–\|–\|–\|–\|✓ | **TaskCenter** |
| 912 | src/m4/household/ProfileAcquisitionEngine.ts | 档案自动采集（LLM 主） | 基 | ✓\|✓\|–\|–\|–\|– | **DomainCenter** |
| 896 | src/m3/PerceptionAnalyzer.ts | 24D 语义感知 + 钙质强度 | 检 | –\|–\|–\|–\|✓\|– | **VectorCenter** |
| 890 | src/m4/MemoryRetriever.ts | 记忆检索 + 缓存 + 上下文压缩 | 检 | ✓\|–\|✓\|✓\|✓\|✓ | **SearchCenter** |
| 864 | src/agent-cnc/cli.ts | CNC 治理 CLI | 基 | –\|✓\|–\|–\|–\|– | BusinessModule |
| 828 | src/engine/tianquan/prefrontal/PrefrontalCortex.ts | 天权前额叶决策皮层 | 聊 | ✓\|–\|✓\|–\|–\|✓ | **IntentCenter** |
| 788 | src/m2/MigrationManager.ts | DB schema 增量迁移器（v2→v12） | 写 | ✓\|–\|✓\|✓\|✓\|– | **WriteCenter** |
| 763 | src/m4/UnifiedSearchEngine.ts | 七层仿生检索管线 L0-L7 | 检 | ✓\|–\|✓\|✓\|✓\|✓ | **SearchCenter + VectorCenter** |
| 755 | src/app/vault/VaultManager.ts | 三库全生命周期管理 | 写 | ✓\|–\|✓\|✓\|–\|– | **WriteCenter** |
| 749 | src/m5/MockLLMProvider.ts | 本地回退 LLM | 聊 | –\|✓\|–\|–\|–\|– | **LLMCenter** |
| 703 | src/webui/chat/retrieval-stage.ts | 聊天检索阶段（话题切换/情感/V13/底座） | 聊 | ✓\|✓\|✓\|✓\|✓\|– | **SearchCenter** |
| 684 | src/cli/migrate-entity-relations.ts | 实体关系迁移 CLI | 写 | ✓\|–\|✓\|✓\|–\|– | **WriteCenter** |
| 645 | src/m4/household/EntityMeeting.ts | 实体会晤管理器 | 基 | –\|✓\|–\|–\|–\|– | **DomainCenter** |
| 615 | src/app/alignment/VectorAlignmentGuard.ts | 向量对齐三层防护 | 基 | ✓\|✓\|✓\|–\|–\|– | **DomainCenter** |
| 551 | src/webui/maintenance.ts | 后台维护（健康检查/对话压缩） | 后 | ✓\|✓\|–\|–\|–\|✓ | **TaskCenter** |
| 539 | src/m7/M7Orchestrator.ts | 梦境空闲批量处理 + 定时器 | 后 | ✓\|–\|✓\|–\|–\|✓ | **TaskCenter** |
| 504 | src/m2/FusionStorageAdapter.ts | 统一存储适配器 | 写 | ✓\|–\|–\|–\|–\|– | **WriteCenter** |
| 504 | src/app/knowledge/KnowledgeContextBuilder.ts | 知识库检索管线 | 检 | ✓\|✓\|✓\|✓\|–\|✓ | **SearchCenter** |
| 491 | src/m5/DeepSeekLLMProvider.ts | DeepSeek V4 真实 LLM 驱动 | 聊 | –\|✓\|–\|✓\|–\|✓ | **LLMCenter** |
| 454 | src/app/vault/MemoryAssessor.ts | 三库自动流转调度 | 后 | ✓\|–\|–\|–\|–\|✓ | **TaskCenter + WriteCenter** |
| 441 | src/m4/M4Orchestrator.ts | M4 知识融合层主控 | 检 | ✓\|–\|✓\|–\|✓\|– | **SearchCenter** |
| 422 | src/m8/M8FusionAdapter.ts | M8 年轮/疤痕视图 | 写 | ✓\|–\|✓\|–\|✓\|– | **WriteCenter** |
| 417 | src/webui/chat/persistence-stage.ts | 对话持久化（三写） | 写 | ✓\|✓\|–\|–\|✓\|– | **WriteCenter** |
| 394 | src/m4/household/UUIDGatekeeper.ts | 户籍门阀白名单过滤器 | 检 | –\|–\|–\|–\|–\|– | **DomainCenter** |
| 380 | src/m1/DNAEncoder.ts | DNA 编码流水线 L0→L3 | 基 | –\|–\|–\|–\|–\|– | **DomainCenter** |
| 377 | src/cli/health-check.ts | CLI 健康检查 | 基 | ✓\|✓\|–\|–\|–\|– | **SystemCenter** |
| 376 | src/app/somatic/SomaticMemory.ts | 躯体感知记忆层 | 基 | ✓\|✓\|✓\|–\|–\|– | **DomainCenter** |
| 375 | src/app/knowledge/JinghuanBatchAPI.ts | 警幻仙姑 8 批量 API | 后 | ✓\|✓\|–\|–\|✓\|– | BusinessModule |
| 369 | src/app/knowledge/RelationshipExtractor.ts | 人际关系图谱提取 | 基 | ✓\|–\|–\|✓\|–\|– | **DomainCenter** |
| 355 | src/m1/L3EntityAnnotator.ts | L3 实体基因槽标注 | 基 | –\|✓\|–\|–\|–\|– | **DomainCenter** |
| 351 | src/m5/clue/M5ClueAssistant.ts | 线索协助回忆助理（≤200ms） | 聊 | –\|–\|✓\|–\|–\|– | **IntentCenter** |
| 339 | src/m2/ConversationDB.ts | 对话独立存储库 | 写 | ✓\|–\|✓\|✓\|–\|✓ | **WriteCenter** |
| 338 | src/m5/expression/IntimateLexicon.ts | 私密场景词库（纯数据） | 基 | –\|–\|–\|–\|–\|– | Legacy/BusinessModule |
| 334 | src/m7/InductionScheduler.ts | 每小时情感归纳 | 后 | ✓\|✓\|–\|–\|–\|✓ | **TaskCenter** |
| 333 | src/engine/temporal/celestial/CalendarEngine.ts | 历法引擎 | 基 | –\|–\|–\|–\|–\|– | **DomainCenter** |
| 328 | src/m4/household/EntityContextBuilder.ts | 实体会晤上下文构建 | 基 | ✓\|✓\|–\|–\|–\|– | **DomainCenter** |
| 324 | src/engine/tianquan/temporal/HippocampalIndex.ts | 海马体稀疏索引 + CA1 | 检 | ✓\|✓\|–\|✓\|–\|✓ | **SearchCenter** |
| 321 | src/app/ingestion/ConversationIngestionService.ts | 对话→知识自动沉淀 | 后 | –\|✓\|–\|✓\|–\|– | **TaskCenter** |
| 320 | src/app/fg/HumanWorldGraph.ts | 人类世界关系图 | 基 | ✓\|–\|–\|–\|–\|– | **DomainCenter** |
| 313 | src/engine/tianquan/temporal/HippocampusRhythmCoordinator.ts | 海马体四重节律调度 | 后 | –\|–\|–\|–\|–\|✓ | **TaskCenter** |
| 312 | src/m4/EntityTopologyManager.ts | 实体关系拓扑 | 基 | ✓\|✓\|✓\|–\|–\|– | **DomainCenter** |
| 311 | src/governance/auth/AuthzPolicy.ts | 授权策略纯函数评估器 | 基 | –\|–\|–\|✓\|–\|– | **ConfigCenter** |
| 301 | src/engine/tianquan/prefrontal/ConstraintValidator.ts | 前额叶五维约束校验 | 聊 | ✓\|✓\|–\|–\|–\|– | **IntentCenter** |
| 299 | src/m2/math.ts | 24D 向量/记忆动力学纯函数 | 检 | –\|–\|✓\|–\|–\|– | **VectorCenter** |
| 297 | src/engine/tianquan/temporal/SceneSnapshotBuilder.ts | 天权场景快照 | 聊 | ✓\|✓\|✓\|–\|✓\|– | **IntentCenter** |
| 293 | src/webui/server-household-routes.ts | 户籍 HTTP API | 基 | ✓\|–\|✓\|✓\|–\|– | **DomainCenter** |
| 293 | src/engine/orchestrator.ts | 全链路编排器 | 基 | –\|–\|–\|–\|–\|✓ | **SystemCenter** |
| 286 | src/m4/household/RelationHeatTracker.ts | 关系热力追踪 | 基 | ✓\|–\|–\|–\|–\|– | **DomainCenter** |
| 285 | src/app/learning/DailyMaintenanceScheduler.ts | 每日知识维护 | 后 | ✓\|–\|–\|–\|–\|✓ | **TaskCenter** |
| 281 | src/webui/server-chat-routes.ts | Chat/Reset/Stream HTTP 端点 | 聊 | ✓\|–\|✓\|✓\|–\|✓ | **IntentCenter** |
| 281 | src/engine/tianquan/heart/HeartStateStore.ts | 边缘系统状态仓库 | 基 | –\|–\|✓\|–\|–\|– | **DomainCenter** |
| 281 | src/agent-cnc/guard-event.ts | CNC 守卫事件运行时 | 基 | –\|–\|–\|✓\|–\|✓ | BusinessModule |

> 注：agent-cnc 全部 12 个文件（cli/report/guard-event/types + 9 测试）为自成体系的 **BusinessModule**（治理工具）；`audit-baseline/structure-guard/validate` 等测试文件归 **Test**。

---

## 三、优先级排序：哪些最该拆

### Tier 1 — 最该拆（巨型 + 热路径重叠）

| 优先级 | 文件 | 问题 | 建议 |
|:---:|---|---|---|
| 1 | **FamilyGraph.ts（5924）** | 单一文件承载整个户籍数据层（nodes/edges/dossier）+ 推理 + 检索，DB 引用 248 处 | 按层拆：nodes/edges 持久层、dossier 卷宗逻辑、图谱检索（getRelatedPersons/BFS）、状态规则（StatusRules）。**改造成本高但只读面大，最高优先** |
| 2 | **server.ts（2849）** | 组合根过重：.env 加载、模块装配、M7/M8 启动、40D 状态、路由注册杂糅 | 路由注册彻底化（server-*-routes 模式）+ 生命周期独立 |
| 3 | **chat.ts（2627）** | 聊天主链核心 processChat，LLM 30 + Search 18 + DB 13 | 按意图分支拆（fact/emotion/persona/clue/tool 调用）+ prompt 组装抽模块 |
| 4 | **SQLiteAdapter.ts（2207）** | 存储引擎单文件，213 DB 引用 + 40D 编解码（46） | 表级 DAO 化、40D/感知编解码抽离、FTS/n-gram 初始化独立 |

### Tier 2 — 推荐拆（500-1200 行，职责混杂）

| 文件 | 行数 | 拆法 |
|---|---|---|
| server-observability-routes.ts | 1165 | 按端点拆 |
| KnowledgeEngine.ts | 973 | 分块/嵌入/检索/RRF 四段 |
| SleepTimeConsolidator.ts | 933 | 巩固流水线按阶段拆 |
| ProfileAcquisitionEngine.ts | 912 | LLM 提取器与正则提取器分离 |
| PerceptionAnalyzer.ts | 896 | 24D 感知维度处理器 |
| MemoryRetriever.ts | 890 | 缓存/压缩/检索策略分离（40D 12 处） |
| PrefrontalCortex.ts | 828 | 天权五子模块编排 |
| UnifiedSearchEngine.ts | 763 | 七层检索 L0-L7 各层独立 |

### 数据层风险（非文件但高优先级）

- `search_index` **100 万行**（n-gram 倒排，内存加载 253MB 库的膨胀主因）。
- `state_spines` **8 万行** 40D 分片。
- `knowledge_memories` **1.1 万行** 关联。
- 这三张表是 fusion_memory.db 体积与启动耗时的主要贡献者。

---

## 四、分枢集中度统计

### 定时器集中点（Tmr ✓ 最多 → TaskCenter 拆解区）
`server.ts(16)` → `maintenance.ts(12)` → `MockLLMProvider(4)` / `PrefrontalCortex(4)` / `DeepSeekLLMProvider(4)` / `DailyMaintenanceScheduler(4)` / `InductionScheduler(3)` / `HippocampusRhythmCoordinator(3)` / `MemoryAssessor(3)`。

### 40D 集中点（→ VectorCenter 拆解区）
`SQLiteAdapter(46)` → `UnifiedSearchEngine(23)` → `MigrationManager(18)` → `MemoryRetriever(12)` → `persistence-stage(11)` → `PerceptionAnalyzer(7)` → `M8FusionAdapter(6)` → `M4Orchestrator(5)`。
> 40D 向量处理横跨存储/检索/写入三链，建议独立成 VectorCenter 编解码模块。

### 检索集中点（→ SearchCenter 拆解区）
`UnifiedSearchEngine(763)` → `MemoryRetriever(890)` → `KnowledgeEngine(973)` → `KnowledgeContextBuilder(504)` → `M4Orchestrator(441)` → `HippocampalIndex(324)` → `retrieval-stage(703)` + `m4/retrieval/` 底座（15 文件 1454 行）。

---

## 五、风险最高排序（聊天主链 > 检索主链 > 写主链）

```
chat.ts(2627) → server.ts(2849) → SQLiteAdapter(2207) → FamilyGraph(5924)
  → UnifiedSearchEngine(763) → MemoryRetriever(890) → KnowledgeEngine(973)
  → persistence-stage(417) → retrieval-stage(703)
```

其中 `chat.ts`、`SQLiteAdapter`、`FamilyGraph` 三者在同一会话内同时被聊天主链与写主链命中，**拆分之战利品最大**；但它们也都是 12 文件高风险红线成员（见天枢修订方案 §十二），**第一阶段禁重构**，拆解必须排在天枢 Skeleton 之后的渐进阶段。

---

## 六、DB 表结构要点（支撑拆解判断）

库：`data/webui/fusion_memory.db`（253MB，sql.js WASM）。schema 源：`src/m2/schema.sql` + MigrationManager 增量 ALTER。

| 表 | 关键列 | 长文本/向量 | 行数 |
|---|---|---|---|
| `memories` | id PK、perception_json(24D)、**perception_40d(40D)**、calcium_score/level、locus_path、raw_input、vad_spectrum、entity_genes、belong_entity_uuid、is_landmark/scar_type | JSON/向量 4 列，**无 FTS5** | 834 |
| `conversations` | id PK、content(长文)、message_id(幂等)、is_compacted/summary/promoted、belong_entity_uuid | 无向量列 | 10,456 |
| `knowledge_base` | id PK、title、content、source_type、emotion_vector、belong_entity_uuid | 向量 1 列，**无 FTS5 持久表** | 67 |
| `works` | work_id PK、full_text(长文)、semantic_vector、source_conversation_ids | 向量 1 列，**无 FTS5** | 1 |
| `vault_log` | id PK、operation、detail、content_md、belong_entity_uuid | 无向量 | 4,822 |
| `black_diamond` | id PK、summary、emotion_tag、emotion_vector、l2_norm、belong_entity_uuid | 向量 1 列，`black_diamond_fts` live 未建出 | 243 |
| `search_index` | **1,005,503**（n-gram 倒排） | 最大表 | 100 万 |
| `state_spines` | dimension_id CHECK 1-40、WITHOUT ROWID | 40D 分片 | 80,376 |
| `knowledge_memories` | 知识-记忆关联 | — | 10,947 |
| `aqc_records` | AQC 质检 | — | 22,222 |
| `retrieval_log` | 检索策略日志 | — | 2,307 |
| `memory_associations` | V13 DAG 关联 | — | 739 |
| `master_profile` | 主人大脑镜像 | — | 742 |
| `hippocampal_index` | 天权海马体稀疏索引 | — | 145 |

迁移机制：**无 migrations 目录**，代码内 `MigrationManager.ts` `MIGRATIONS[]` v2→v12，`schema_version` 表（11 行，最新 v12 2026-08-07），入口 `SQLiteAdapter.migrateSchema()` 启动时执行。独立 CLI：`scripts/apply-migrations.mjs`、`src/cli/migrate-entity-relations.ts`、`src/config/family-graph-migration.ts`、`src/m2/Dim24to32Migration.ts`。

---

## 七、执行证据

扫描命令：`find src -name "*.ts" -exec wc -l {} + | sort -nr | head -80`。DB 只读查询覆盖 memories/conversations/knowledge_base/works/vault_log/black_diamond/search_index/state_spines 等表结构与行数。
