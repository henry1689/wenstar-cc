# Learning 域（app/learning/）

**职责：** 从对话和知识中学习规律——分类、衰减、印象建模、行为模式挖掘。

## 与 Knowledge 域的边界

详见 `../knowledge/README.md`

**learning/ 保留的功能有：**
- 行为模式挖掘（BehaviorPatternMiner）
- 情感基线学习（EmotionBaselineLearner）
- 定时维护调度（DailyMaintenanceScheduler）
- 实体衰减（EntityStrengthTracker）
- 人格反哺（PersonaFeedService）
- 知识衰减/休眠（KnowledgeDecayEngine）
- 印象值建模（ImpressionModel）
- 关系图谱（KnowledgeRelationGraph / EnhancedKnowledgeGraph）

这些都是"从历史数据中蒸馏规律"，而非管理知识条目。
