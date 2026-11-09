# WenStar OS 大脑记忆系统 TS 代码清单（给 Claude 5.5 评审用）

> 生成时间：2026-11-02
> 项目根：D:\tools\wenstar-cc
> 总计：380 个记忆相关 TS 文件（含测试）

---

## 一、M2 存储层（记忆写入与持久化）

**核心职责：记忆写入、对话块生命周期、向量存储、SQLite 适配**

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m2/SQLiteAdapter.ts | 192.9 KB | SQLite 存储适配器（最大的核心文件） |
| src/m2/MigrationManager.ts | 92.3 KB | 数据库迁移管理器 |
| src/m2/ConversationDB.ts | 25.6 KB | 对话数据库 |
| src/m2/FusionStorageAdapter.ts | 25.4 KB | 融合存储适配器 |
| src/m2/math.ts | 10.7 KB | 钙化/向量数学计算 |
| src/m2/ZvecAdapter.ts | 10.8 KB | Zvec 向量适配器 |
| src/m2/PerceptionVector40DCodec.ts | 13.6 KB | 40D 感知向量编解码 |
| src/m2/Perception40DStore.ts | 3.1 KB | 40D 感知向量存储 |
| src/m2/DialogGroupLifecycle.ts | 5.8 KB | 对话块生命周期（active→consolidating→archived） |
| src/m2/DualHelixWriter.ts | 7.4 KB | 双螺旋写入器 |
| src/m2/MemoryWriteGateway.ts | 5.8 KB | 记忆写入网关 |
| src/m2/MemoryLifecycleProtocol.ts | 5.5 KB | 记忆生命周期协议 |
| src/m2/calciumWatch.ts | 8.7 KB | 钙化监控 |
| src/m2/EntityNameCodec.ts | 4.9 KB | 实体名称编解码 |
| src/m2/Transcoder.ts | 8.7 KB | 转码器 |
| src/m2/YaoguangNormalizer.ts | 6.2 KB | 瑶光规范化器 |
| src/m2/migration.ts | 4.7 KB | 迁移脚本 |
| src/m2/DataAuthority.ts | 3 KB | 数据权限 |
| src/m2/KnowledgeBase.ts | 3.3 KB | 知识库 |
| src/m2/retrieval-constants.ts | 0.7 KB | 检索常量 |
| src/m2/BackfillGlobalUID.ts | 4.6 KB | 全局 UID 回填 |
| src/m2/types/index.ts | 8.6 KB | M2 类型定义 |
| src/m2/types/perception-40d.ts | 14.1 KB | 40D 感知类型 |

---

## 二、M4 检索层（记忆检索与注入）

**核心职责：记忆召回、编排、融合、注入上下文**

### 2.1 核心引擎
| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m4/MemoryRetriever.ts | 69.6 KB | 记忆检索器（主入口） |
| src/m4/M4Orchestrator.ts | 26.9 KB | M4 编排器 |
| src/m4/MemoryInjector.ts | 21.1 KB | 记忆注入器 |
| src/m4/UnifiedSearchEngine.ts | 24.3 KB | 统一搜索引擎 |

### 2.2 检索编排（v11 结构化召回）
| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m4/retrieval/StructuredRecall.ts | 32.3 KB | 结构化召回（v11 核心） |
| src/m4/retrieval/meeting-recall.ts | 56.1 KB | 会晤召回（最大文件） |
| src/m4/retrieval/recall-quota.ts | 15.8 KB | 召回配额管理 |
| src/m4/retrieval/Backfill.ts | 16.1 KB | 回填 |
| src/m4/retrieval/fusion.ts | 6.6 KB | 融合 |
| src/m4/retrieval/orchestrate.ts | 5.5 KB | 编排 |
| src/m4/retrieval/element-picker.ts | 7.3 KB | 元素拾取器（MemSym 用） |
| src/m4/retrieval/memsym-path-router.ts | 4.3 KB | MemSym 路径路由器 |
| src/m4/retrieval/memsym-metrics.ts | 2.5 KB | MemSym 指标 |
| src/m4/retrieval/Flags.ts | 9.4 KB | 检索标志 |
| src/m4/retrieval/ShadowLog.ts | 13.9 KB | 影子日志 |
| src/m4/retrieval/types.ts | 10.1 KB | 检索类型 |
| src/m4/retrieval/index.ts | 6.5 KB | 检索入口 |
| src/m4/retrieval/adapter.ts | 7.1 KB | 检索适配器 |
| src/m4/retrieval/CompositeUrchin.ts | 5.1 KB | 复合海胆 |
| src/m4/retrieval/format.ts | 3 KB | 格式化 |
| src/m4/retrieval/meetingIsolation.ts | 2.6 KB | 会晤隔离 |
| src/m4/retrieval/backref.ts | 4 KB | 反向引用 |
| src/m4/retrieval/SearchOrchestrator.ts | 2.6 KB | 搜索编排器 |

### 2.3 检索适配器（12 种）
| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m4/retrieval/adapters/DialogGroupAdapter.ts | 22.2 KB | 对话块适配器（B链路） |
| src/m4/retrieval/adapters/HighCalciumGroupAdapter.ts | 5.5 KB | 高钙组适配器 |
| src/m4/retrieval/adapters/MeetingWallAdapter.ts | 4.9 KB | 会晤墙适配器 |
| src/m4/retrieval/adapters/WorkAdapter.ts | 3.8 KB | 工作适配器 |
| src/m4/retrieval/adapters/MemoryAdapter.ts | 3.2 KB | 记忆适配器 |
| src/m4/retrieval/adapters/VaultAdapter.ts | 3.3 KB | 金库适配器 |
| src/m4/retrieval/adapters/BlackDiamondAdapter.ts | 3.1 KB | 黑钻适配器 |
| src/m4/retrieval/adapters/FamilyGraphAdapter.ts | 3 KB | 家庭图谱适配器 |
| src/m4/retrieval/adapters/NoteAdapter.ts | 2.7 KB | 笔记适配器 |
| src/m4/retrieval/adapters/KnowledgeAdapter.ts | 2.7 KB | 知识适配器 |
| src/m4/retrieval/adapters/ConversationAdapter.ts | 2.3 KB | 对话适配器 |

### 2.4 家庭图谱/FG 档案
| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m4/household/FamilyGraph.ts | 359.7 KB | 家庭图谱（最大的单个文件！） |
| src/m4/household/EntityContextBuilder.ts | 32.9 KB | 实体上下文构建器 |
| src/m4/household/ProfileAcquisitionEngine.ts | 39 KB | 档案获取引擎 |
| src/m4/household/EntityMeeting.ts | 46.3 KB | 实体会晤 |
| src/m4/household/UUIDGatekeeper.ts | 17.2 KB | UUID 守门人 |
| src/m4/household/RelationHeatTracker.ts | 11.9 KB | 关系热度追踪器 |
| src/m4/household/EntityGreetingProtocol.ts | 10.4 KB | 实体问候协议 |
| src/m4/household/MeetingMinutesStore.ts | 9.3 KB | 会议纪要存储 |
| src/m4/household/LifecycleManager.ts | 7.5 KB | 生命周期管理器 |
| src/m4/household/EntityWriteGate.ts | 7 KB | 实体写入门 |
| src/m4/household/FGProfileWriteGateway.ts | 4.7 KB | FG 档案写入网关 |
| src/m4/household/SocialGroupResolver.ts | 3 KB | 社交组解析器 |
| src/m4/household/RelationResolver.ts | 3.3 KB | 关系解析器 |
| src/m4/household/GarbageEntityGuard.ts | 3.2 KB | 垃圾实体守卫 |
| src/m4/household/EntityPrivacyFilter.ts | 5.8 KB | 实体隐私过滤器 |
| src/m4/household/pae-fallback-extractor.ts | 3.5 KB | PAE 回退提取器 |
| src/m4/household/DossierService.ts | 2.1 KB | 档案服务 |

### 2.5 其他 M4 模块
| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m4/EntityTopologyManager.ts | 12 KB | 实体拓扑管理器 |
| src/m4/MMRDiversifier.ts | 2.9 KB | MMR 去重器 |
| src/m4/RRFFusion.ts | 3.5 KB | RRF 融合 |
| src/m4/VectorReranker.ts | 6.3 KB | 向量重排器 |
| src/m4/Reranker.ts | 4 KB | 重排器 |
| src/m4/QueryDecomposer.ts | 3.7 KB | 查询分解器 |
| src/m4/SearchConfig.ts | 2.4 KB | 搜索配置 |
| src/m4/SearchIndexBuilder.ts | 3.1 KB | 搜索索引构建器 |
| src/m4/EntityValidator.ts | 3.3 KB | 实体校验器 |

---

## 三、M5 群聊与空间层

**核心职责：空间路由、群聊会话、输出守卫、人设表达**

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/m5/DeepSeekLLMProvider.ts | 130.3 KB | DeepSeek LLM 提供者（最大） |
| src/m5/space/SpaceRouter.ts | 19.2 KB | 空间路由器（会晤/独处/耳语） |
| src/m5/space/types.ts | 13.2 KB | 空间类型定义 |
| src/m5/space/adapters/chat-adapter.ts | 24.1 KB | 聊天适配器 |
| src/m5/group/outputGuard.ts | 24.4 KB | 输出守卫（ speaker 头/自称检测） |
| src/m5/group/sessionReducer.ts | 22 KB | 会话状态机 |
| src/m5/group/speakerResolver.ts | 12.9 KB | 说话人解析器 |
| src/m5/group/GroupSession.ts | 8.8 KB | 群聊会话 |
| src/m5/group/contextBridge.ts | 5.2 KB | 上下文桥接 |
| src/m5/group/SessionStore.ts | 4.7 KB | 会话存储 |
| src/m5/group/types.ts | 10.6 KB | 群聊类型 |
| src/m5/group/identityFromState.ts | 2.6 KB | 从状态识别身份 |
| src/m5/expression/IntimateLexicon.ts | 19.1 KB | 亲密词汇表 |
| src/m5/expression/IntimateRenderer.ts | 6.7 KB | 亲密表达渲染器 |
| src/m5/expression/ThinkingPauseInjector.ts | 6.9 KB | 思考停顿注入器 |
| src/m5/expression/ContextualSafetyGateway.ts | 3.3 KB | 上下文安全网关 |
| src/m5/expression/ExpressionSpecController.ts | 4.2 KB | 表达规范控制器 |
| src/m5/expression/TierVocabMap.ts | 6.1 KB | 层级词汇映射 |
| src/m5/persona/lover-persona.ts | 12.2 KB | 恋人 persona |
| src/m5/prompts/PromptAssembler.ts | 7.5 KB | 提示词组装器 |
| src/m5/prompts/core-rules.ts | 10.5 KB | 核心规则 |
| src/m5/SceneAnchor.ts | 12.3 KB | 场景锚点 |
| src/m5/ContextMemory.ts | 12.2 KB | 上下文记忆 |
| src/m5/M5Orchestrator.ts | 8.8 KB | M5 编排器 |
| src/m5/CandidateSelector.ts | 6.2 KB | 候选选择器 |
| src/m5/CognitionAssembler.ts | 4.4 KB | 认知组装器 |
| src/m5/StrategySelector.ts | 2.6 KB | 策略选择器 |
| src/m5/HumanisticCalibrator.ts | 2.8 KB | 人文校准器 |
| src/m5/clue/M5ClueAssistant.ts | 13.2 KB | 线索助手 |
| src/m5/identity/resolveIdentity.ts | 3.1 KB | 身份解析 |
| src/m5/MockLLMProvider.ts | 39.6 KB | Mock LLM 提供者 |
| src/m5/types/index.ts | 4.4 KB | M5 类型 |

---

## 四、B 链路卷宗化（P145 新建）

**核心职责：B 链路沉睡卷宗读取、哈希、日志**

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/app/memory/BArchiveReader.ts | 20.4 KB | B 链路档案读取器（单点读取入口） |
| src/app/memory/BlockArchiveService.ts | 12.6 KB | 块档案服务 |
| src/app/memory/BlockSummaryService.ts | 18.1 KB | 块摘要服务 |
| src/app/memory/BlockValueScorer.ts | 14.8 KB | 块价值评分器 |
| src/app/memory/bArchiveHash.ts | 3.4 KB | B 档案哈希 |
| src/app/memory/bArchiveLog.ts | 5.1 KB | B 档案追加日志 |

---

## 五、知识引擎与 FG 档案

**核心职责：知识抽取、关系图谱、档案维护**

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/app/knowledge/KnowledgeEngine.ts | 59 KB | 知识引擎 |
| src/app/knowledge/KnowledgeContextBuilder.ts | 46 KB | 知识上下文构建器 |
| src/app/knowledge/JinghuanBatchAPI.ts | 13.6 KB | 静幻批量 API |
| src/app/knowledge/RelationshipExtractor.ts | 16.6 KB | 关系提取器 |
| src/app/knowledge/FtsSearch.ts | 8.9 KB | FTS 全文搜索 |
| src/app/knowledge/FileUploadService.ts | 9.8 KB | 文件上传服务 |
| src/app/knowledge/EmotionMatcher.ts | 6.8 KB | 情感匹配器 |
| src/app/knowledge/FamilyGraphSync.ts | 6.6 KB | 家庭图谱同步 |
| src/app/knowledge/EmbeddingProvider.ts | 6.3 KB | Embedding 提供者 |
| src/app/knowledge/TopicTracker.ts | 5.3 KB | 话题追踪器 |
| src/app/knowledge/AutoEnhancer.ts | 3.3 KB | 自动增强器 |
| src/app/knowledge/AppearanceExtractor.ts | 3.4 KB | 外貌提取器 |
| src/app/knowledge/DedupService.ts | 2.5 KB | 去重服务 |
| src/app/knowledge/RAGPipeline.ts | 4 KB | RAG 流水线 |
| src/app/knowledge/Reranker.ts | 4.2 KB | 重排器 |
| src/app/knowledge/RetrieverCircuitBreaker.ts | 3.5 KB | 检索熔断 |
| src/app/knowledge/SourceTypePolicy.ts | 3.3 KB | 源类型策略 |
| src/app/knowledge/VectorStore.ts | 2.7 KB | 向量存储 |
| src/app/knowledge/WebResearchService.ts | 3 KB | 网络研究服务 |
| src/app/knowledge/ChunkService.ts | 1.1 KB | 分块服务 |
| src/app/knowledge/KnowledgeMonitor.ts | 4.7 KB | 知识监控 |
| src/app/knowledge/types.ts | 2.8 KB | 知识类型 |
| src/app/fg/RelationshipTypes.ts | 14.1 KB | 关系类型 |
| src/app/fg/HumanWorldGraph.ts | 11.8 KB | 人类世界图谱 |
| src/app/fg/FGRelationExtractor.ts | 10 KB | FG 关系提取器 |
| src/app/fg/FGHealthCheck.ts | 9.7 KB | FG 健康检查 |
| src/app/fg/FGMaintenance.ts | 5.8 KB | FG 维护 |
| src/app/fg/ProgressiveProfile.ts | 5.2 KB | 渐进式档案 |
| src/app/fg/PersonTimeline.ts | 4.5 KB | 人物时间线 |
| src/app/fg/KnowledgeBridge.ts | 5.6 KB | 知识桥接 |

---

## 六、金库与其他记忆模块

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/app/vault/VaultManager.ts | 42.9 KB | 金库管理器 |
| src/app/vault/MemoryAssessor.ts | 24.3 KB | 记忆评估器 |
| src/app/vault/BlackDiamondGate.ts | 8 KB | 黑钻门 |
| src/app/vault/MemoryMetrics.ts | 4 KB | 记忆指标 |
| src/app/vault/belong-uuid.ts | 2.7 KB | 归属 UUID |
| src/app/memory-vault/MemoryVault.ts | 7.9 KB | 记忆金库 |
| src/app/somatic/SomaticMemory.ts | 14.4 KB | 躯体记忆 |
| src/app/conversation/MemoryGate.ts | 10.2 KB | 记忆门 |
| src/app/selfreview/MemorySelfReview.ts | 3.5 KB | 记忆自审 |
| src/app/observability/MemoryTracer.ts | 4.4 KB | 记忆追踪器 |
| src/app/learning/KnowledgeDecayEngine.ts | 4.3 KB | 知识衰减引擎 |
| src/app/learning/KnowledgeGrowthLogger.ts | 5.6 KB | 知识增长日志 |
| src/app/learning/KnowledgeRelationGraph.ts | 5.3 KB | 知识关系图谱 |
| src/app/learning/EnhancedKnowledgeGraph.ts | 6.8 KB | 增强知识图谱 |
| src/app/yuyao-memory/YuyaoMemoryService.ts | 9.6 KB | 余姚记忆服务 |
| src/m9/WorkingMemory.ts | 10.6 KB | 工作记忆 |
| src/engine/tianquan/prefrontal/WorkingMemory.ts | 5.1 KB | 天泉前额叶工作记忆 |
| src/engine/tianquan/temporal/CoreMemoryManager.ts | 5.7 KB | 核心记忆管理器 |
| src/engine/tianquan/temporal/KnowledgeAccessFacade.ts | 6.7 KB | 知识访问门面 |
| src/engine/temporal/TemporalEventArchive.ts | 7.3 KB | 时间事件归档 |

---

## 七、配置与 WebUI 路由

| 文件路径 | 大小 | 功能说明 |
|---|---|---|
| src/config/MemoryConfig.ts | 14 KB | 记忆配置 |
| src/config/retrieval-fusion-config.ts | 10.8 KB | 检索融合配置 |
| src/config/M5Config.ts | 2 KB | M5 配置 |
| src/webui/chat/retrieval-stage.ts | 106.1 KB | 检索阶段（WebUI 最大文件） |
| src/webui/chat/dialog-group-stage.ts | 27.3 KB | 对话块阶段 |
| src/webui/chat/long-text-retrieval.ts | 12.2 KB | 长文本检索 |
| src/webui/chat/KnowledgeTextAssembler.ts | 8.1 KB | 知识文本组装器 |
| src/webui/chat/b-archive-recall.ts | 4.5 KB | B 档案召回 |
| src/webui/chat/retrieval.ts | 5.4 KB | 检索 |
| src/webui/server-memory-routes.ts | 6.3 KB | 记忆路由 API |
| src/webui/server-vault-routes.ts | 7.1 KB | 金库路由 API |
| src/webui/server-knowledge-routes.ts | 14.5 KB | 知识路由 API |
| src/webui/server-knowledge-file-routes.ts | 7 KB | 知识文件路由 API |
| src/webui/server-fg-routes.ts | 4.9 KB | FG 路由 API |

---

## 八、核心设计文档（参考用）

| 文件路径 | 说明 |
|---|---|
| docs/blueprint/白皮书_检索架构-v11-结构化召回取代ngram索引.md | v11 检索架构白皮书 |
| docs/adr/ADR-015-20261102-AB双链路记忆架构与B链路卷宗化.md | A/B 双链路 ADR |
| docs/agent-collab/active/MemSym-v1.0.0-落地方案.md | MemSym 落地方案 |
| docs/agent-collab/active/P145-20261101-PI-B链路卷宗化V2.1-六项微调与落地方案.md | P145 B 链路方案 |

---

## 九、给 Claude 5.5 的评审重点

### 当前架构痛点（业主关心）
1. **M2 SQLiteAdapter.ts 192KB** —— 单文件过大，职责过多
2. **FamilyGraph.ts 359KB** —— 家庭图谱是最大的单个文件
3. **DeepSeekLLMProvider.ts 130KB** —— LLM 提供者过大
4. **retrieval-stage.ts 106KB** —— WebUI 检索阶段过大
5. **B 链路卷宗化刚落地（P145）** —— 需要验证设计是否合理
6. **MemSym v1.0.0 刚落地** —— 双通路设计是否最优
7. **钙化增益只有单一 +0.2** —— A/B 双系数待实现
8. **空间路由器粒度问题** —— 块 vs 席位×话题

### 待评审的架构方向
- 记忆系统是否需要进一步模块化拆分？
- B 链路"沉睡卷宗"设计是否最优？
- MemSym 双通路（A 诚实回溯 / B 元素浸润）是否合理？
- 钙化权重模型是否需要改进？
- 工作记忆（M9）与长期记忆（M2/M4）的边界是否清晰？

---

> 注：本清单只列核心业务文件，测试文件（__tests__/）已省略，完整数量见标题。
