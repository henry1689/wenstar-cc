# 🏛️ 太虚境·全系统架构改善蓝皮书

**编制日期**: 2026-07-05
**系统范围**: M1-M9 + Engine 十层全栈
**代码规模**: ~33,000行 / ~132源文件
**当前评分**: 6.8/10

---

## 一、问题全景（按严重度分层）

### P0 — 数据/逻辑错误（19项）

#### P0-A: 运行时静默失败（3项）

| ID | 位置 | 问题描述 | 影响 | 修复方案 |
|----|------|----------|------|----------|
| A01 | `src/webui/chat/post-process.ts:95` | 调用 `ctx.m8.writeCycle()` 但 M8FusionAdapter 无此方法 | **每轮对话的M8年轮写入完全失效**，已持续整个S1阶段 | 改为 `ctx.m8.write({...})` 或删除 |
| A02 | `src/webui/chat/post-process.ts:112` | 调用 `ctx.m7.triggerInduction()` 但 M7Orchestrator 无此方法 | **每次高钙化对话企图触发归纳但静默失败** | 实现该方法或删除调用 |
| A03 | `src/m7/DreamQueue.ts` | `ClueTracker.record()` 和 `generateAdvice()` 全库零调用 | 线索跟踪模块完全死代码，但仍在初始化/运行 | 删除 ClueTracker |

#### P0-B: 条件判断错误（2项）

| ID | 位置 | 问题描述 | 修复方案 |
|----|------|----------|----------|
| B01 | `src/m9/WorkingMemory.ts:148` | `calciumLevel >= 0.3` 永远为真（calciumLevel是0/1/2/3枚举），**M9毕业门控完全失效** | 改为 `calciumScore >= 0.3`（1行） |
| B02 | `src/engine/brain/L05IntentRouter.ts:33-55` | L05匹配后通过EventBus发射**第二个**`intent:classified`事件→HeartStateStore每轮处理两次→情感影响翻倍 | 修改原始事件载荷而非二次发射 |

#### P0-C: 数据不一致（4项）

| ID | 位置 | 问题描述 | 修复方案 |
|----|------|----------|----------|
| C01 | `M3 ↔ Engine Heart` | **双24D系统并行**：Perception24D[-1,1]和EmotionVector24D[0-100]独立运行，无任何交叉验证 | 统一为Engine格式，M3降级为感知种子输入 |
| C02 | `src/m2/schema.sql` vs `ConversationDB.ts` | `is_summary`(schema) 和 `is_compacted`(ConversationDB) 表示同一概念但互相过滤不到 | 统一字段名+数据迁移 |
| C03 | `m6/types/index.ts` vs `m1/types/dna.ts` | `M6SelfModel` 和 `SelfModelV1` 两套类型表示自我模型，桥接代码做有损转换 | 统一为M6SelfModel |
| C04 | `src/webui/server.ts:2058` | `/api/modules` M8节点硬编码 `healed_scars: 0`，永不反映真实数据 | 改为从 `getStatus()` 读取（4行） |

#### P0-D: 配置/参数死代码（5项）

| ID | 位置 | 问题描述 | 修复方案 |
|----|------|----------|----------|
| D01 | `src/m6/BoundaryManager.ts` | `recordHit()` 从未被调用，2条默认边界永远不变 | 删除文件 (1文件) |
| D02 | `src/m9/WorkingMemory.ts` | `cycleCount` 初始化为0但**永不递增**，配置的 `graduateCycleMax/discardCycleMax/forceGraduateCycle` 全部死代码 | 实现cycleCount++逻辑 (5行) |
| D03 | `src/m2/VaultManager.ts` | 双黑钻晋升路径v1和v2用不同标准(AQCEngine调v1, MemoryAssessor调v2) | 废弃v1保留v2 |
| D04 | `src/m4/QueryDecomposer.ts` | 文件存在但**全库零import** | 删除或集成到MemoryRetriever |
| D05 | `src/m4/Reranker.ts` | 6条计分规则定义完整但**从未被MemoryRetriever/orchestrator调用** | 在情感检索合并前接入 (3行) |

#### P0-E: 架构冲突（5项）

| ID | 位置 | 问题描述 | 严重性 |
|----|------|----------|--------|
| E01 | `M6 ↔ Engine Heart` | M6 OCEAN人格和Engine Heart情感向量完全独立，无人格→情感基线联动 | ★★★ |
| E02 | `M3 ↔ Engine` | M3 24D存入M2记忆但Engine 24D不参与检索 | ★★★ |
| E03 | `M5 DeepSeekLLMProvider` | 角色路由 `classify()` + `TransitionManager` 在LLM Provider内部执行，无法独立测试 | ★★☆ |
| E04 | `M5 SceneAnchor+ContextMemory` | 两模块跟踪重叠状态(location/nudity/activity) | ★★☆ |
| E05 | `Engine GenerationOrchestrator` | `setM5()` 定义但从未调用，PromptComposer 7层碎片闲置 | ★☆☆ |

---

### P1 — 性能瓶颈（37项，列Top15）

| ID | 位置 | 问题 | 影响评估 | 修复方案 |
|----|------|------|----------|----------|
| F01 | M4→M2 关键词检索 | `findBySeqPosRange(0..∞,200)` 加载200条+内存filter O(N×K) | 随数据量线性增长 | 改FTS5全文索引 |
| F02 | M4→M2 情感检索 | `findByEmotionalSimilarity()` 暴力遍历所有记录+JS余弦 | >1000条时显著延迟 | l2_norm预计算+B+树近似 |
| F03 | M2 衰减维护 | `runDecayMaintenance()` SELECT * FROM memories 无LIMIT | 数据量大时IO暴增 | 分页1000条/批 |
| F04 | M4 FG查询 | `getFamilySummary()+getSocialSummary()` 各扫一次所有nodes+edges | FG越大越慢 | 加TTL=30s缓存 |
| F05 | M4 N+1 profile | 每个亲属逐一调getPersonProfile()→JSON.parse | 20+亲属时20+次查询 | 批量SQL IN |
| F06 | M2 写路径 | 每次write调N次ensureEntity + N次memory_entities INSERT | 高频对话N上涨 | 批量多行INSERT |
| F07 | M6 JSON写 | 每次mutation调writeFileSync同步写 | 高频场景磁盘IO瓶颈 | 30s debounce |
| F08 | M6 缓冲区清空 | `maintenance()`每15分钟清空TraitEvolver信号缓冲区 | 高钙化信号永远攒不够15次 | 不清空只做衰减 |
| F09 | M9 缓冲区丢弃 | consolidate()完 `this.buffer = []` 未毕业的条目**直接丢弃无日志** | 丢失24D感知+实体数据 | 加丢弃计数+摘要日志 |
| F10 | M8 matchByClue | 读50条+内存关键词匹配 | 无索引 | FTS5 |
| F11 | M8 getStatus | 扫描200条在内存中计数 | 无SQL浪费 | 改COUNT WHERE查询 |
| F12 | Engine L0Classifier | 全映射到casual_chat，无视locus_path | 下游Heart失去语义粒度 | 映射真实意图 |
| F13 | M5 无流式 | 单LLM调用返回完整Promise | 用户体验等待 | 加generateStream() |
| F14 | M5 无连接池 | 直接fetch DeepSeek API，429重试无背压 | 限流时无全局协调 | 加rate-limit |
| F15 | Engine 情感不空闲衰减 | 只有消息触发时才跑衰减 | 闲置数天后情感仍高 | 30分钟定时器触发 |

---

## 二、综合改善建议（按目标分类）

### A. 架构统一（消除双系统）

| 目标 | 涉及层 | 方案 | 工作 | 收益 |
|------|--------|------|------|------|
| **统一24D向量** | M3 / Engine / M2 | Engine Heart作为唯一24D来源，M3降级为感知种子输入分析器。M2记忆存Engine格式24D，M3的PerceptionAnalyzer保留仅作词表命中统计 | 5-7天 | 消除最大架构债，简化M5提示词，统一检索索引 |
| **人格→情感联动** | M6 / Engine Heart | M6的OCEAN作为HeartStateStore的基线偏置：agreeableness高→joy基线+5，neuroticism高→anxiety基线+5 | 2-3天 | 人格影响情绪行为，更仿生 |
| **记忆检索用Engine 24D** | Engine / M2 / M4 | findMemoriesByEmotionalSimilarity 改用Engine Heart的情感向量 | 2天 | Engine算的更精准的24D被用于检索 |
| **类型统一** | M6 / M1 | 删SelfModelV1，全系统用M6SelfModel | 1天 | 消除有损转换 |

### B. 校验闭环补齐

| 缺失项 | 实现方案 | 工作 |
|--------|----------|------|
| **M9毕业校验** | 修calciumLevel→calciumScore（1行） + 加cycleCount递增 | 0.5天 |
| **M6边界校验** | 删BoundaryManager（死代码） | 0.2天 |
| **M8伤疤计数** | 修hardcoded 0（4行） | 0.1天 |
| **M6偏好读取** | 在chat.ts M6 trait注入段后加preference注入 | 0.5天 |
| **双24D一致性断言** | 在EngineContext注入前加断言：两套24D的pleasure/intimacy方向一致 | 0.5天 |
| **Schema版本管理** | 加schema_version表+迁移函数 | 1天 |

### C. 性能优化（检索/衰减/IO）

| 优化项 | 当前 | 目标 | 提升预期 |
|--------|------|------|----------|
| 关键词检索FTS5 | 全表扫描200条内存filter | 索引直达 | 10-100x |
| 情感相似度l2_norm | 暴力余弦全部记录 | B+树近似 | 10-50x |
| 衰减分页 | SELECT * 无LIMIT | 1000条/批 | 内存占用降90% |
| FG摘要缓存 | 每轮扫全表 | 30s TTL | 减少100%冗余查询 |
| M6 JSON debounce | 每次同步写 | 30s合并 | IO降95% |
| M9缓冲区分页 | 50条数组 | 200条环形 | 防溢出 |
| 黑钻FTS5 | LIKE+向量扫描 | 全文索引 | 10x |

### D. 死代码清理清单

| 文件/代码 | 行数 | 删除理由 |
|-----------|------|----------|
| `src/m6/BoundaryManager.ts` | ~60 | recordHit()零调用 |
| `src/m7/ClueTracker.ts` | ~80 | record()零调用 |
| `src/m4/QueryDecomposer.ts` | ~100 | 全库零import |
| `src/m2/VaultManager.promoteToBlackDiamond(v1)` | ~70 | 被v2替代 |
| M6 `config.graduateCycleMax/discardCycleMax` | 配置 | cycleCount永为0 |
| post-process.ts 第95-107行 | 12行 | 两个不存在的方法调用 |

### E. 稳定运行加固

| 措施 | 当前风险 | 方案 |
|------|----------|------|
| M9缓冲区崩溃保护 | 进程崩溃丢所有 | 每轮consolidate()快照到SQLite |
| DreamQueue崩溃保护 | JSON文件并发不安全 | 迁移到SQLite dream_logs表 |
| FG关键路径即时落盘 | 500ms窗口丢数据 | `markDirty(true)` 在所有人物创建路径 |
| Engine状态定期持久化 | 仅事件触发存 | 30分钟定时器自动persist() |
| M6 traits定期快照 | JSON文件单点 | 加SQLite备份副本 |

---

## 三、推荐实施路线（三阶段）

### 第一阶段：止血（1-2天，8项）

| 顺序 | ID | 内容 | 改动量 |
|------|----|------|--------|
| 1 | B01 | M9毕业条件Bug修复 | **1行** |
| 2 | B02 | L05IntentRouter双重发射修复 | 15行 |
| 3 | A01 | post-process.ts m8.writeCycle修复 | 改调用 |
| 4 | A02 | post-process.ts m7.triggerInduction修复 | 删或实现 |
| 5 | C04 | /api/modules healed_scars硬编码修复 | 4行 |
| 6 | D01 | 删BoundaryManager | 1文件 |
| 7 | D05 | Reranker接入MemoryRetriever | 3行 |
| 8 | D03 | 统一黑钻晋升路径 | 删v1代码 |

**产出**: 8项P0修复，零新增功能，纯修复。预计8项可并行。

---

### 第二阶段：性能+数据完整性（3-5天，12项）

| 顺序 | ID | 内容 |
|------|----|------|
| 9 | D02 | M9 cycleCount递增实现 |
| 10 | F04 | FG摘要缓存TTL=30s |
| 11 | B04 | M4 integrateFromEntity加短路 |
| 12 | C03 | M6 Preference注入prompt |
| 13 | F07 | M6 JSON debounce 30s |
| 14 | F08 | M6缓冲区不清空只衰减 |
| 15 | F03 | M2衰减分页1000条/批 |
| 16 | F01 | M4关键词检索改FTS5 |
| 17 | F05 | M4 N+1 profile批量加载 |
| 18 | D04 | 删QueryDecomposer |
| 19 | C02 | 统一is_summary/is_compacted |
| 20 | C06 | 加schema_version表 |

---

### 第三阶段：架构统一（5-7天，6项）

| 顺序 | ID | 内容 |
|------|----|------|
| 21 | C01/E02 | **统一双24D系统**（Engine Heart为主，M3降级） |
| 22 | E01 | M6 OCEAN→Engine Heart基线联动 |
| 23 | E03 | M5角色路由从DeepSeekLLMProvider移到M5Orchestrator |
| 24 | E04 | SceneAnchor+ContextMemory合并为统一SceneState |
| 25 | E05 | GenerationOrchestrator.setM5()接通 |
| 26 | C03 | 删SelfModelV1统一为M6SelfModel |

---

## 四、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 统一24D时M3的PerceptionAnalyzer规则→Engine Heart算法转换导致历史记忆24D不一致 | 高 | 中 | 写迁移脚本，历史记忆标记为v0格式，新写用v1 |
| M9毕业条件修后导致所有实体条目不毕业 | 低 | 高 | 先用 `calciumScore >= 0.15` 过渡再调高 |
| Engine L0Classifier输出真实意图可能破坏现有M3决策路由 | 中 | 中 | 加 `ENABLE_ENGINE_INTENT` 开关，先灰度 |
| 双24D统一后M4情感相似度检索的索引格式要改 | 中 | 中 | 先加l2_norm兼容字段双写一段时间 |

---

## 五、验收标准

| 维度 | 验收标准 |
|------|----------|
| **架构统一** | 无双24D并行，Engine Heart为唯一情感向量来源 |
| **门控正常** | M9毕业门控按 `calciumScore` 判断，cycleCount递增生效 |
| **零静默失败** | post-process.ts 无不存在方法调用，try/catch必有日志 |
| **零死代码** | BoundaryManager/ClueTracker/QueryDecomposer/v1晋升 已清除 |
| **校验完整** | M9/M6/M8/M6偏好/双24D一致性 5处检查点全部就位 |
| **性能可观测** | 检索时间 <50ms（缓存命中）、<200ms（缓存未命中） |
| **稳定运行** | 24小时连续运行零回退，探针全部定期更新心跳 |
