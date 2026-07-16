# app/learning/ — 知识演化与自学习

**职责:** 知识条目的自动分类、衰减、关系图谱构建、行为模式挖掘、人格反哺。

**关键文件:**
- AutoClassifier.ts — 自动分类新知识
- KnowledgeDecayEngine.ts — 知识衰减/休眠/垃圾清理
- ImpressionModel.ts — 印象值模型（recall_count → impression_score）
- KnowledgeRelationGraph.ts — 共召关联图谱
- EnhancedKnowledgeGraph.ts — 增强知识图谱
- BehaviorPatternMiner.ts — 用户行为模式挖掘
- EntityStrengthTracker.ts — 实体关联强度追踪
- EmotionBaseline.ts — 情绪基线学习
- PersonaFeedService.ts — 知识→M6 人格反哺
- DailyMaintenanceScheduler.ts — 每日维护调度

**与 knowledge/ 的关系:**
- learning/ 管"条目"的演化（分类/衰减/关系图谱/行为挖掘）
- knowledge/ 管"条目"的生命周期（CRUD + 检索）
- Phase 3 建议: AutoClassifier/KnowledgeDecayEngine/ImpressionModel/KnowledgeRelationGraph 更适合归入 knowledge/
