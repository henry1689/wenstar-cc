# WenStarOS 变更台账 — 统一语义搜索引擎 V11.0

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> **流程**: S1→S2→S3→S4→S5→S7 | **日期**: 2026-07-27 | **风险**: 🟡 中（检索管线重构）

## S1 审计：四层检索全断裂

| 存储层 | 存了什么 | 检索方式 | 断点 |
|:---|:---|:---|:---|
| 砂金(conversations) | 完整原文 | ❌ 从未被搜 | retrieval-stage不查此表 |
| 金库(memories) | 原文截断到2000字 | 24D情感向量余弦 | 按情感排序，语义匹配断裂 |
| 黑钻(black_diamond) | summary+tags | LIKE关键词 | 无分词、无语义桥、无entity过滤 |
| 知识库(knowledge_base) | 完整文档 | 仅LLM路由触发 | 正常聊天从不被调用 |

额外发现：
- `SQLiteAdapter.writeMemory()` 硬截断 raw_input 到2000字符
- `KnowledgeEngine.search()` 内存BM25功能完整但从未接入检索链
- `black_diamond_terms` 倒排表有DDL无填充
- 黑钻检索无 `belong_entity_uuid` 过滤

## S2 方案

锁定：**n-gram本地初筛 + 自有32D语义向量精排** 混合方案。
- n-gram仅做前置围栏过滤，不参与最终排序
- 最终排序权完全交给自有32D仿生心智向量
- 零外部API调用，全量本地闭环
- 三档检索力度：内敛(日常)/均衡(中间)/全开(复盘)

## S3 实施

### Phase 0: 数据层修复

| # | 改动 | 文件 | 行数 |
|:--:|:---|:---|:--:|
| S0 | 删除 raw_input 2000字符截断（保留超长监控warn） | `SQLiteAdapter.ts` | -2行 |
| S0b | 存量补写脚本：从conversations回填被截断的memories | `scripts/backfill_truncated.mjs` | 新建 +55行 |

### Phase 1-3: 核心搜索引擎（3个新模块）

| 模块 | 文件 | 职责 |
|:---|:---|:---|
| SearchIndexBuilder | `src/m4/SearchIndexBuilder.ts` 新建 160行 | 中文2-3字n-gram切词 + 停用词过滤 + 四表索引构建 + 存量回填 |
| VectorReranker | `src/m4/VectorReranker.ts` 新建 170行 | 32D余弦相似度 + 情绪维度优先加权 + 衰减惩罚 + 置信度增益 + 三档ef开关 |
| UnifiedSearchEngine | `src/m4/UnifiedSearchEngine.ts` 新建 220行 | 编排 n-gram初筛 → 向量精排全流程 + 实体UUID过滤 + 知识库直连 |

### Phase 4: 检索管线接入

| # | 改动 | 文件 | 行数 |
|:--:|:---|:---|:--:|
| S8 | 黑钻LIKE检索（145行）替换为 UnifiedSearchEngine 调用（45行） | `retrieval-stage.ts` | -100行 net |
| S9 | 新增知识库直接接入检索链路（不再依赖LLM路由） | `retrieval-stage.ts` | +15行 |
| S10 | 所有剩余检索追加 belong_entity_uuid 过滤 | `retrieval-stage.ts` | 内嵌于S8 |
| S11 | 移除 _bdVecCache + 更新调用点 | `chat.ts` | -5行 |

### Phase 5: 增量索引 + 启动回填

| # | 改动 | 文件 | 行数 |
|:--:|:---|:---|:--:|
| S12 | persistConversation 末尾追加异步 indexDocument 调用 | `persistence-stage.ts` | +15行 |
| S13 | 金库→黑钻晋升后追加 indexDocument | `MemoryAssessor.ts` | +10行 |
| S14 | 服务启动时检测 search_index 为空则触发 rebuildAllIndexes | `server.ts` | +15行 |

### 数据库

| 改动 | 文件 |
|:---|:---|
| 新增 search_index 表 + 2个索引（n-gram倒排，覆盖四层存储） | `schema.sql` +12行 |

## S4 编译: 零错误 | S5 测试: 802/815 (13 pre-existing) | FG 红线: ❌ 零触碰

## 检索架构对比

| 维度 | 旧方案 | 新方案 V11.0 |
|:---|:---|:---|
| 黑钻搜索 | LIKE精确匹配 + 全表向量扫描 | n-gram倒排初筛 + 32D向量精排 |
| 知识库 | 仅LLM路由触发 | 每轮自动搜索 |
| 砂金库 | 不搜索 | n-gram倒排索引覆盖 |
| 实体隔离 | 无 | belong_entity_uuid全链路过滤 |
| 向量排序 | 旧黑钻24D自研扫描 | 自有32D心智向量标准化重排 |
| 外部依赖 | 无 | 无（零API） |
| 代码行数 | ~200行分散逻辑 | ~550行集中架构 |
