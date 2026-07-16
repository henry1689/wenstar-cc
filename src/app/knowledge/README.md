# Knowledge 域（app/knowledge/）

**职责：** 知识条目生命周期的全部管理——CRUD、分块、嵌入、搜索、排序。

## 与 Learning 域的边界

| knowledge/ | learning/ |
|-----------|----------|
| KnowledgeEngine — 增删改查 | AutoClassifier — 自动分类 |
| FtsSearch — 全文搜索 | KnowledgeDecayEngine — 衰减 |
| Reranker — 重排序 | ImpressionModel — 印象值 |
| EmotionMatcher — 情绪匹配 | BehaviorPatternMiner — 模式挖掘 |
| FileUploadService — 文件解析 | EntityStrengthTracker — 衰减 |
| TopicTracker — 话题追踪 | PersonaFeedService — 人格反哺 |

**铁律：**
- knowledge/ 管"条目"：存哪、怎么查。只读不推断。
- learning/ 管"规律"：从数据中蒸馏模式、衰减、建图。
- 两者都操作 knowledge_base 表，但 direction 不同。
