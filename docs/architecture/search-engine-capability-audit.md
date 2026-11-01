# 搜索引擎能力与接入点审查报告

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期：2026-08-07 · 性质：只读扫描 · 关联任务：《WenStarOS 天枢架构全局复盘与重设》
> 范围：wenstar-cc 全搜索栈（UnifiedSearchEngine / MemoryRetriever / 知识库 / 检索底座 m4/retrieval）

---

## 一、结论先行

- **搜索栈已具备多路并发底座 + 长文本召回 + 统一权限过滤**，但**治理要素缺失**：无统一 timeout（仅 KB FTS 一处熔断）、无审计落盘、无 query 缓存、上下文预算按字符非 token、snippet 无结构化 excerpt。
- **并发只有一处**：底座 `runAllAdapters`（`Promise.all`）；V13/V11/retrieveMultiRank 主链全部**串行**。
- **检索底座（m4/retrieval）是 SearchCenter 的现成工程基础**：8 域适配器 + RRF/MMR 融合 + backref 回源键 + police 权限内建，缺的恰是治理要素。
- 已注册 5 域（knowledge/black_diamond/work/vault/note），conversation/memory/family_graph 三域适配器备好未接（避免与 V13/V11 重复注入）。

---

## 二、搜索入口清单

| 入口 | 路径 | 签名 | 行号 |
|---|---|---|---|
| 统一搜索引擎 | `src/m4/UnifiedSearchEngine.ts` | `search(db, query, perception?, opts)`（V11 n-gram→40D 精排） | L80 |
| | | `searchByEntity(...)`（**串行 for 逐实体**） | L272 |
| | | `searchV12(...)`（RRF+MMR） | L348 |
| | | `async searchV13(db, multiRank, query, perception?, opts, pipelineConfig?, dagRepo?, perceptionV40?)`（七层 L0-L7） | L470 |
| 记忆多路召回 | `src/m4/MemoryRetriever.ts` | `retrieveMemories(locusPath, entities, opts)` | L69 |
| | | `retrieveMultiRank(locusPath, entities, opts)`（6 路：emotion/keyword/spine/locus/entity/work，**串行**） | L433 |
| | | `retrieveMemoriesStructured(...)` | L755 |
| | | `retrieveFullClue(roleplay, message, m4Ctx, ...)`（L1-4 五层串行截断） | L833 |
| 知识库搜索 | `src/app/knowledge/KnowledgeEngine.ts` | `search(keyword, limit?, emotionalContext?, interactionType?, belongEntityUuid?)`（内存 BM25 + Zvec + RRF） | L472 |
| FTS 全文 | `src/app/knowledge/FtsSearch.ts` | `class FtsSearch`；`init()` 全量加载建倒排、`search()` BM25 | L50/L78/L133 |
| 向量引擎 | `src/m2/ZvecAdapter.ts` | `createZvecAdapter(path?)`；native 失败降级 InMemory | L55/L177/L226 |
| RRF 融合 | `src/m4/RRFFusion.ts` | `weightedRRF(lists, config, topK)` | L47 |
| MMR 多样性 | `src/m4/MMRDiversifier.ts` | `mmrDiversify(candidates, relevanceScores, config)` | L51 |
| 知识库精排 | `src/app/knowledge/Reranker.ts` | `rrfFuse(sources, topK)`（RRF_K=60） | L30/L35 |
| 多路检索底座 | `src/m4/retrieval/orchestrate.ts` | `runFoundationRoutes(ctx, query, opts)`（适配器并行→RRF→MMR→格式化） | L57 |
| | `src/m4/retrieval/adapter.ts` | `runAllAdapters`（**Promise.all 并行**）/ `runAdapter` / `buildPolicePolicy` / `policeFilterHits` | L108/L77/L144/L59 |
| 指称解析/长文直取 | `src/app/works/ReferentResolver.ts` | `resolveReferent(message, repo, activeEntityUuids)`（强/弱指称） | L64 |
| | `src/webui/chat/long-text-retrieval.ts` | `detectDetailLevel` / `fetchLongText` / `buildLongTextFragment` | L32/L52/L82 |
| 对话级检索 | `src/webui/chat/retrieval-stage.ts` | `runRetrieval(input)`（V22 指称→V23 长文直取→会晤墙→时间导航→情感→V13/V11 主链→Foundation 底座） | L43 |

各存储域适配器（`src/m4/retrieval/adapters/`）：`KnowledgeAdapter` / `BlackDiamondAdapter` / `WorkAdapter` / `VaultAdapter` / `NoteAdapter` / `ConversationAdapter` / `FamilyGraphAdapter` / `MemoryAdapter`（每类 `search(ctx): Promise<SearchHit[]>`）。

---

## 三、多路并行现状

- **并发的只有底座**：`runAllAdapters` 用 `Promise.all(adapters.map(ad => runAdapter(ad, ctx)))`（`adapter.ts` L116）。每个适配器异常被 `runAdapter` 的 try/catch 隔离（L83-88，失败返回 `[]`）——这是唯一的**部分失败降级**。
- **V13/V11 主链是串行**：
  - V11 `search()`：`for (const gram of ngrams…)` 逐 term 查 search_index（L101）。
  - `searchByEntity()`：`for (const uuid of entityUuids)` 串行逐实体（L280）。
  - `retrieveMultiRank()`：6 路 await/同步顺序执行（L457-679）。
  - `retrieveMemories()`：byLocus→byKeyword→byEmotion→bySpine→byEntityUuid 串行。
- **无 withTimeout / 无统一熔断**：
  - 底座 `runAllAdapters` 无超时包装（`Promise.all` 不带 race）。
  - 唯一熔断器 `RetrieverCircuitBreaker`（`src/app/knowledge/RetrieverCircuitBreaker.ts`，timeout+熔断+半开）只用于 KnowledgeEngine 的 FTS 调用（KnowledgeEngine L456/L475）。
  - `OnnxCrossEncoderReranker` 有 `Promise.race` 超时（L79-82）；`AlgorithmicCrossEncoder` 为默认（零网络）。
  - 其余所有 SQL/存储域检索无 timeout、无熔断（sql.js 同步查询天然阻塞）。

---

## 四、搜索源 × 存储表 × 长文本字段

| 搜索源 | 存储表 | 查询字段 | 长文本字段 | FTS5 索引 | 注入截断 |
|---|---|---|---|---|---|
| 对话 | `conversations` | `content` (LIKE/n-gram)、`is_compacted=0` | `content`（长文直取 >800 字） | **否**（n-gram search_index + LIKE） | V11 `substring(0,800)`；MemoryInjector 250 |
| 记忆/金库 | `memories` | `raw_input`、`perception_json`、`perception_40d`、钙化列 | `raw_input` | **否** | V11 800 / 注入 250 |
| 黑钻 | `black_diamond` | `summary`、`emotion_tag`、`tags` | `summary` | **是**：`black_diamond_fts`（SQLite FTS5，SQLiteAdapter L401；live DB 实测无 fts 表） | 500 |
| 知识库 | `knowledge_base` | `title`、`content` | `content` | **否**（内存倒排=FtsSearch，非 SQLite FTS5；`knowledge_chunks` 存向量分块） | 500 |
| 金库日志 | `vault_log` | `detail`、`content_md`、`operation='promote'` | `content_md` | 否（LIKE） | 100 |
| 作品/小说 | `works` | `title`、`summary`、`full_text`（LIKE）；search_index 按 800 字分块 | **`full_text`（小说正文）** | **否**（n-gram 分块索引） | WorkAdapter 200；注入 full_text ≤4000 |
| 家族图谱 | FG（无表直查） | `searchPersonWithMemories`/`getUUIDByName` | 档案 bio | — | 200 |
| 玉瑶记事 | `memories`（`memory_type='note'`） | `raw_input`、`note_key`、`is_valid=1` | `raw_input` | 否 | 150 |

- **小说存 `works` 表**（`work_id` PK，`full_text` 存正文；`MigrationManager.ts` L388 建表，含 `semantic_vector` 512 维摘要向量）。`conversations.content` 也存长 assistant 消息（V23 长文直取对象）。
- **唯一真实 SQLite FTS5**：`black_diamond_fts`（外部内容表，live DB 实测未建出）。知识库"FTS5 BM25"实为内存倒排。`search_index` 是 2-3 字 n-gram 倒排表（schema.sql L253），跨 4 域，**实测 100 万行**。

---

## 五、结果类型字段对照

| 类型 | 位置 | 字段 |
|---|---|---|
| `RankedItem` | `src/m4/types/retrieval.ts` L16 | `id / text(≤200) / score / source(6路) / entityUuid / calciumScore / createdAt / isForesight? / validStartMs? / validUntilMs? / foresightStatus?` |
| `MultiRankResult` | `MemoryRetriever.ts` | `lists: RankedList[] / totalCandidates / indexHit / indexedIds` |
| `MemoryCandidate` | `src/m4/VectorReranker.ts` L61 | `id / text / source(仅4域) / perceptionJson? / perception40d? / calciumScore? / calciumLevel? / confidenceScore? / effectiveStrength? / createdAt? / entityUuid?` |
| `RankedMemory` | `VectorReranker.ts` | `item / score / emotionSim / fullSim / decay` |
| `SearchHit`（底座统一） | `src/m4/retrieval/types.ts` L49 | `id / domain(8域) / text / score / route? / entityUuid / calciumScore? / calciumLevel? / createdAt / payload? / backref?({table,id}) / dedupeKey? / timeMs? / isForesight? / validStartMs? / validUntilMs? / foresightStatus?` |
| `ScoredMemory` | M2 | `record + scores{emotional,topic,entity,calcium} + composite` |
| `SearchResult` | `UnifiedSearchEngine.ts` | `items: string[] / raw: RankedMemory[] / hitsBySource / totalCandidates`；V13 扩展 `closure / foresightWarnings / narrative / layerLatency / degradations` |

- **snippet/excerpt**：无结构化字段——`text` 本身是截断摘要（150-200 字）；MemoryInjector 端再 substring(0,250/300)。作品/长文有独立 `payload.full_text`/`【对话原文】` 完整注入。

---

## 六、排序/分数机制

- **V11**：n-gram 粗筛 → `rankByVector` 40D/24D 扇区加权余弦 + 钙化 + 衰减 + 置信度合成（`VectorReranker.ts` L166-171/L210-214）。
- **V13**：`weightedRRF`（k=60，spine .35 / keyword .30 / work .25 / entity .20 / emotion .10 / locus .05，≥2 路 ×1.2）→ 时间近因 `_timeBonus`（7 天线性，权重 0.10，searchV13 L523-535）→ L6.5 40D 重排 → MMR（λ0.7，相关性用**合成** `1.0 - i*0.02`）→ 输出 `score = mmrScore ?? score`（V13 最终分是合成/模糊，非真实 RRF）。
- **底座 fuseHits**（`fusion.ts`）：真实 `rrfScore + recencyFactor(0.10)·recencyRatio` 做 MMR 相关性项（**替代 V13 合成分**），`FOUNDATION_DEFAULT_WEIGHTS` 补充 diamond .25 / knowledge .15 / vault .10 / note .08 / profile .08 / conversation .05。
- **知识库**：`Reranker.rrfFuse`（FTS vs 向量，RRF_K=60）+ `EmotionMatcher.rerank` 情感重排 + `applyEmotionBoost`/`applySceneBoost`（KnowledgeEngine L540-560）。

---

## 七、性能策略（缓存 / timeout / 降级）

| 维度 | 现状 |
|---|---|
| **缓存** | `MemoryRetriever` 关键词缓存 `LocalCache` 30s（L17）+ 会话缓存 300s（L20，含 entityUuids 防串扰）；`KnowledgeEngine.searchCache` 30s（L130）；`FtsSearch` 全量内存倒排；`WorkRepository` 无缓存 |
| **timeout** | 仅 `RetrieverCircuitBreaker`（KB FTS 3s）+ `OnnxCrossEncoderReranker`。底座/主链 SQL 无 timeout |
| **熔断** | KB FTS 熔断（5 连败/30s 冷却/半开，`RetrieverCircuitBreaker.ts` L23-27） |
| **降级链** | KB：FTS→LIKE→拆词→向量→RRF；Zvec：native→内存 cosine；V13 失败→`_v13Failed` 标志→V11 兜底（retrieval-stage L511-538）；每层 try/catch + `degradations[]`（searchV13 L537-713）；Cross-Encoder 默认 `Algorithmic` |
| **失败返回** | 统一返回空结果，不抛错；适配器失败返回 `[]` |
| **上下文预算** | `MemoryInjector.maxChars=8000`，记忆 60%/KB 40%（有长文 30%/15%），长文 `max(4000, 0.8·maxChars)` 独立预算、作品 4000，总输出硬截断（`MemoryInjector.ts` L130-208） |

---

## 八、与 M4/M5/chat 集成现状

- **接线点**：`chat.ts` L671 调 `runRetrieval` → 产出 `memoryFragments` → L1424 `injectMemories({memoryFragments, m4Timeline, knowledgeBaseText, vaultHits, maxChars:8000, preserveLabels, entityNames})` → `memoryText`（L1425）→ `KnowledgeTextAssembler.withMemoryBackground`（`chat/KnowledgeTextAssembler.ts` L107）/ PFC `processEnhanced` 组装进 prompt（chat.ts L1601/L1772）。M5 prompt 通过 `PromptAssembler.ts` `knowledgeBlock`（priority 400）承接，`memoryText` 拼入 `finalKnowledgeText` 进入 LLM。
- **`retrieveMultiRankForSearch`**：`M4Orchestrator.ts` L429 薄封装 `MemoryRetriever.retrieveMultiRank`；searchV13 输入由 retrieval-stage L470 取，`_dagRepo = new MemoryAssociationRepository(_sqlite)`（L477）。
- **底座唯一调用点**：`retrieval-stage.ts` L672-689 `runFoundationRoutes(ctx, message, {meetingMode, activeEntityUuids, isTopicShift})`。
- **`WS_FOUNDATION_ROUTES = true`**（L586）：当前注入态——旧 KB 直连+金库块整体跳过（L587-641）；Foundation 块正常注入 `_fResult.fragments`（L680-684）；**砂金高钙化块（L643-669）仍独立执行**（无对应适配器）。
- **已注册 5 域**（`createDefaultRegistry`，`index.ts` L46）：`knowledge / black_diamond / work / vault / note`。**conversation / memory / family_graph 未注册**——`createExtendedRegistry`（L67）已实现未接线，注释明确"接入前必须先停用 V13/V11 主链对应召回，否则重复注入"。

---

## 九、权限 / 审计覆盖

### UUIDPoliceFilter 覆盖（`src/governance/police/UUIDPoliceFilter.ts`）
- **已收编**：V11 `search()` 四域源表全用 `buildSqlClause`（UnifiedSearchEngine L143/166/194/222）；V12/V13 `policePasses` deny-by-default（L377/L692）；KnowledgeEngine FTS LIKE 路径（L507）；retrieval-stage 砂金块（L654-658）；底座全部 8 个适配器（查询层 `buildSqlClause(ctx.policy)` + 行级兜底 `policeFilterHits`，`adapter.ts` L59，deny / allow-common 两模式）；会晤墙块按 `belong_entity_uuid=?` 直查；V22 作品 `policePasses` 鉴权（retrieval-stage L82）。
- **特殊豁免**：`family_graph` 无归属列，`entityUuid`=FG uuid 本身（`backref.ts` L28）；spine 路（state_spines 无归属列）会晤场景直接跳过（MemoryRetriever L540）；`screenContext` 文本级最终闸门（chat.ts L1401）。
- **潜在缺口**：
  1. V11 `search()` 在户主钥匙模式（entityUuids 空）**fail-closed**——`buildSqlClause({visibleUuids: empty})` 返回 `AND 1=0`（L59-62），户主模式 V11 检索恒空；V13 无此问题（L690 仅 entityUuids 非空过滤）。
  2. KnowledgeEngine FTS 主路径 `belongEntityUuid=undefined` 时全库放行（FTS5 不支持归属列，靠 post-filter L574）。
  3. `retrieveMultiRank` 内部存储路依赖 storage 透传 entityUuids，自身无 policePasses 兜底（靠 searchV13 L690 补）。
  4. KnowledgeContextBuilder `buildPreM4Context` 的 `ctx.yuyaoMemory.search`（note 域旧路径）已由 NoteAdapter 收编，但旧调用点可能仍在跑。

### 审计/追踪
- `retrieval_log` 表（schema L442）——**仅 `retrieveMemories` 写**（MemoryRetriever L415），`retrieveMultiRank`/V13/底座**不写**。
- `dag_retrieval_log`（V13 DAG，MigrationManager L247）——由 DAG 检索使用。
- `VectorAlignmentGuard.auditLog`（空检索/注入片段数审计，L166/L505）。
- 无统一搜索 trace / span；只有 `console.log`（`[searchV13]`/`[FoundationRoutes]`/`[RetrievalAdapter]`）和 `server-observability-routes.ts` L938 的 search_index 分布统计。

---

## 十、能力边界总结

### 已具备
- 长文本/小说：`works.full_text` 完整注入（≤4000）、`conversations.content` V23 长文直取（绕过截断+防编造）、指称解析、800 字阈值+1500 分段。
- 多路检索：V13 七层管线（逐层降级）+ 底座 Promise.all 并行 + 8 域适配器（5 注册 3 备好）+ backref 回源键根治 fake id + RRF/MMR/近因真实分数。
- 权限：UUIDPoliceFilter 全链路收编，deny-by-default、fail-closed。
- 缓存：三重 LocalCache + KB 内存倒排 + Zvec 内存降级。
- 上下文预算：MemoryInjector 8000 硬上限 + 长文/作品独立预算。

### 缺失/风险
- **timeout**：底座 `Promise.all` 与全部 SQL 检索无超时——熔断仅 KB FTS 一处；长文/作品大字段直取可能阻塞主线程（sql.js 同步）。
- **审计**：`retrieveMultiRank`/V13/底座无 retrieval_log；无 trace/span。
- **上下文预算**：只按字符（8000），非 token 精确；长文+作品+记忆可能互挤。
- **snippet**：无结构化 excerpt/高亮；只靠固定 150-250 字 substring。
- **V11 户主模式 fail-closed 空检索**（§九①），与 V13 语义不一致。
- **重复注入风险**：砂金高钙化块（旧块）仍与 Foundation 底座并存执行；conversation/memory/FG 三域若启用 `createExtendedRegistry` 而未停 V13 主链会重复。

---

## 十一、执行证据

扫描命令命中数：`UnifiedSearchEngine` → 16 文件；`searchV1[123]` → 10 文件；`retrieveMultiRank` → 12 文件；`search_index|fts5|FTS5` → ~28 处；`withTimeout|Promise.race|setTimeout(reject` → 11 处；`memoryText` → 9 处；`retrieval_log|_log|auditLog|.trace(` → ~26 处；`CREATE VIRTUAL TABLE` → 1 处（仅 black_diamond_fts）；`dag_retrieval_log|memory_associations` → 21 处。
