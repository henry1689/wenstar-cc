# app/knowledge/ — 知识条目生命周期管理

**职责:** 知识条目的增删改查、分块、嵌入、检索、情绪匹配、去重。

**关键文件:**
- KnowledgeEngine.ts — 核心引擎（add/search/update/delete + FTS + 向量 + RAG）
- FtsSearch.ts — 内存倒排索引 BM25
- RelationshipExtractor.ts — 对话→实体关系提取
- EmotionMatcher.ts — 情感感知重排序
- AutoEnhancer.ts — 自动增强
- DedupService.ts — 去重
- Reranker.ts — RRF 融合重排

**与 learning/ 的关系:**
- knowledge/ 管"条目"的生命周期（CRUD + 检索）
- learning/ 管"条目"的演化（分类/衰减/关系图谱/行为挖掘）
- 两者操作同一张 `knowledge_base` 表，但职责不同
- Phase 3 建议: 将 learning/ 中的 AutoClassifier/KnowledgeDecayEngine/ImpressionModel 合并到 knowledge/
