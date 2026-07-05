# 🏛️ 太虚境·全系统综合评估报告

**评估日期**: 2026-07-05
**系统范围**: M1(编码) → M2(存储) → M3(感知) → M4(融合) → M5(生成) → M6(演化) → M7(梦境) → M8(年轮) → M9(工作记忆) → Engine(新引擎)
**代码规模**: ~132个源文件，~33,000行TypeScript
**运行模式**: hybrid（新旧双链路并行，开关切换）

---

## 一、系统统一性 (System Unity) — 评分: ⚠️ 6/10

### 1.1 架构统一性：两条并行的技术栈

太虚境实际运行着**两条技术栈**，互有重叠但未统一：

| 维度 | 旧管线 (M1-M9) | 新引擎 (Engine) | 统一度 |
|------|----------------|-----------------|--------|
| **24D情感向量** | M3 `Perception24D` [-1,1] 规则词表 | Engine Heart `EmotionVector24D` [0-100] 刺激响应 | ❌ **双系统并行** |
| **关系模型** | M6 `NarrativeLayer[]` 事件列表 | Engine `RelationSynapse` 连续评分+反抖动 | ❌ **双系统并行** |
| **人格模型** | M6 `OCEAN` 大五人格 | Engine 无对应模块 | ⚠️ 单向 |
| **提示词组装** | chat.ts 硬编码拼接 | Engine `PromptComposer` 7层碎片 | ❌ **未接通** |
| **持久化** | M2 `SQLiteAdapter` | Engine `SQLiteStorage`(包装M2) | ✅ 复用 |
| **事件驱动** | 无 | Engine `EventBus` 优先级/短路 | ⚠️ 仅Engine有 |

**核心问题**: M3和Engine Heart同时计算24D情感向量，维度名不同、范围不同、算法不同，但M2记忆里同时存两者的数据，下游消费者(M5)不知道用哪一套。这是一条数据流上的两套独立情绪计算。

### 1.2 数据流统一性：混合模式的代价

```
hybrid模式下：

  user:input → Engine Brain → Engine Heart → LegacyAdapter → M1→M2→M3→M4→M5
                (预处理)       (算情绪)        (调旧管线)      (旧管线再算一次24D)

  EngineContext注入prompt
  M3的24D也注入prompt
  → LLM看到两份情绪数据，可能冲突
```

### 1.3 类型统一性

| 问题 | 影响 |
|------|------|
| `M6SelfModel`(m6/types) 和 `SelfModelV1`(m1/types/dna.ts) 两个类型表示同概念 | 桥接代码做有损转换 |
| `is_summary`(schema.sql) vs `is_compacted`(ConversationDB) 表示同概念 | 过滤互相遗漏 |
| `EmotionVector24D`(Engine bus) vs `Perception24D`(M3) 24维名称/范围不同 | 同一对话产出两份情绪 |
| `WriteCycle`(post-process.ts幻想) 不存在于任何接口 | 每轮静默失败 |

---

## 二、向量对齐性 (Vector Alignment) — 评分: ⚠️ 5/10

### 2.1 24D情感向量双系统对比

| 维度 | M3 Perception24D | Engine EmotionVector24D | 对齐度 |
|------|-----------------|------------------------|--------|
| 范围 | [-1,1]或[0,1] | 0-100 | ❌ 不兼容 |
| 维度名 | pleasure/arousal/dominance/-1~1 | joy/sadness/anger/fear 0-100 | ❌ 完全不同 |
| 维度数 | 24(4象限×6) | 24(8基础+4关系+4唤醒+4社交+4附加) | ⚠️ 仅数量相同 |
| 算法 | 关键词词典计数 | 刺激响应+衰减+突触 | ❌ 天差地别 |
| 持久化 | 写入memories表perception_json | 写入engine_store | ❌ 两套存储 |
| 写入时机 | 每轮对话 | 每轮对话(通过LegacyAdapter) | ⚠️ 同时写 |
| 消费者 | M4检索/决策路由 | EngineContext→prompt | ❌ M5两套都吃 |
| 测试覆盖 | PerceptionAnalyzer无专用测试 | HeartStateStore有6个测试文件 | ⚠️ Engine优 |

### 2.2 向量检索链对齐

```
M3 24D → 写入 M2 memories.perception_json
  → M4 MemoryRetriever 情感相似度检索
  → 余弦比对 (暴力全表扫描，无向量索引)
  → M5 消费

Engine 24D → 存入 engine_store
  → 仅用作情绪标签/渴望生成
  → 不作为检索索引
  → EngineContext 注入提示词
```

E**ngine的24D向量不参与记忆检索**，M2记忆检索只用M3的24D。这意味着Engine算的更精准的24D（有衰减/突触/刺激响应）没有被用于找到相关记忆。

### 2.3 对齐改善建议

| 建议 | 工作量 |
|------|--------|
| 统一为Engine Heart的EmotionVector24D格式，M3降级为输入种子 | 大修 |
| 至少加一个双向映射函数，让两套24D可以互相转换 | 2天 |
| l2_norm预计算字段加速相似度搜索 | 1天 |

---

## 三、鲁棒性 (Robustness) — 评分: 🟡 7/10

### 3.1 错误隔离

| 机制 | 现状 | 评级 |
|------|------|------|
| **EventBus错误隔离** | 每个handler的异常被catch并打印，不影响其他handler | ✅ 强 |
| **LLM降级链** | DeepSeek → MockLLM → 硬编码兜底 (4层) | ✅ 强 |
| **M5回退** | LLM产出<6字符→MockLLM→HumanisticCalibrator→终极兜底 | ✅ 强 |
| **新引擎异常** | S1新链路异常→静默回退旧链路 | ✅ 强 |
| **M9写失败** | 即时毕业写M2失败→回退到缓冲区 | ✅ 合理 |
| **M8 scar检查异常** | try/catch吞掉→演化无伤疤保护继续 | ⚠️ 静默降级 |
| **post-process.ts** | 两个不存在的方法被调→try/catch吞掉→静默失败 | ❌ **静默失败** |
| **M7 triggerInduction** | 不存在方法被调→try/catch吞掉 | ❌ **静默失败** |

### 3.2 数据完整性

| 风险 | 现状 | 评级 |
|------|------|------|
| **进程崩溃丢M9缓冲区** | 只有SIGINT/SIGTERM才flush | ❌ 有风险 |
| **FG 500ms延迟落盘** | markDirty(true)即时落盘在关键路径 | ⚠️ 大部分已修 |
| **DreamQueue JSON文件** | 并发不安全，进程崩溃丢数据 | ⚠️ 有风险 |
| **M6 traits JSON写** | 每次mutation同步writeFileSync | ⚠️ 性能差但不丢数据 |
| **M2 双写（sql.js+JSON Zone）** | JSON Zone同步IO | ⚠️ 默认关闭 |
| **M9 cycleCount永为0** | 配置的强制毕业机制死代码 | ❌ 门控失效 |

---

## 四、稳定性 (Stability) — 评分: 🟢 8/10

### 4.1 运行时稳定性

| 指标 | 数据 | 评级 |
|------|------|------|
| **CPU/内存** | heap ~70MB, RSS ~300MB | ✅ 轻量 |
| **事件循环延迟** | ~15ms | ✅ 健康 |
| **新链路回退次数** | **0次** (全量检测期间) | ✅ 零回退 |
| **探针调用** | H15-H23 各100+次，全绿 | ✅ 全链路工作 |
| **回退旧链路** | 开关关闭→100%走旧逻辑 | ✅ 隔离完整 |
| **健康检查** | /api/health 响应正常 | ✅ 在线 |

### 4.2 已知稳定性风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| **全表扫描衰减** | 每轮 | 随数据量增长性能下降 | 加LIMIT/分页 |
| **情感相似度暴力检索** | 每轮 | >1000条时延迟显著 | 加l2_norm预计算 |
| **关键词检索内存扫200条** | 每轮 | 可预测但浪费 | 改FTS5 |
| **M6 JSON同步IO** | 每次mutation | 高频对话时可能堆积 | 加debounce 30s |

### 4.3 持续运行测试

服务器连续运行>6小时（从之前的uptime=23898s可见），探针累计调用8109次，零回退。**稳定运行是系统的强项。**

---

## 五、流畅性 (Fluency) — 评分: 🟡 7/10

### 5.1 架构流畅性

| 维度 | 现状 | 评级 |
|------|------|------|
| **M1→M2→M3→M4→M5流水线** | 完整，清晰 | ✅ |
| **Engine→旧管线桥接** | LegacyAdapter干净，一站式 | ✅ |
| **M2 三库晋升** | 砂金→金库→黑钻完整 | ✅ |
| **M7 梦境管线** | 三个触发源→队列→内化→M6/M8 | ✅ 但缺LLM梦境内容 |
| **四层装配+RAG** | 角色扮演域独立完整 | ✅ |
| **事件订阅链** | user:input→5个handler按优先级 | ⚠️ Engine好但旧管线无事件 |

### 5.2 阻塞点

| 阻塞点 | 位置 | 影响 |
|--------|------|------|
| 单LLM调用无流式 | M5 | 用户等待完整回复 |
| 角色路由耦合在LLM内部 | M5 DeepSeekLLMProvider | 无法独立测试 |
| SceneAnchor+ContextMemory状态重叠 | M5 | 跟踪相同信息两遍 |
| L0/L05/Heart三重意图处理 | Engine | L05双重发射导致Heart处理两遍 |
| GenerationOrchestrator未接M5 | Engine Cortex | 新提示词引擎闲置 |

---

## 六、可靠性 (Reliability) — 评分: 🟢 8/10

### 6.1 降级链完整性

```
DeepSeek API → 超时? → MockLLMProvider → 空回复? → HumanisticCalibrator → <2字符? → 硬编码兜底
     ↑2次重试           ↑模板池40+                      ↑动作池                     ↑6种常见场景

砂金库写入 → 失败? → 内存保持 → 下一轮重试
M9写入M2  → 失败? → 缓冲区保持 → consolidate()重试
FG integrate → 失败? → 跳过 → 不影响主流程
M6→M8 scar检查 → 失败? → ⚠️ 静默继续演化(无保护)
```

### 6.2 数据持久化可靠性

| 数据 | 存储 | 崩溃安全 | 评级 |
|------|------|----------|------|
| 对话记录 | 砂金库 SQLite | ✅ 每条即时写入 | ✅ |
| 24D记忆 | 金库 SQLite | ✅ 通过M9毕业写入 | ✅(但M9有Bug) |
| 黑钻珍藏 | SQLite black_diamond | ✅ 即时写入 | ✅ |
| 家族图谱 | SQLite family_graph.db | ⚠️ 500ms延迟落盘 | ⚠️ 已部分修复 |
| M6自我模型 | JSON文件 | ❌ 崩溃丢最新数据 | ⚠️ |
| M7梦境队列 | JSON文件 | ❌ 崩溃丢队列 | ⚠️ |
| M9缓冲区 | 内存 | ❌ 崩溃全丢 | ❌ |
| 引擎状态 | SQLite engine_store | ✅ 写入 | ✅ |

---

## 七、检查与校验机制完整性 — 评分: 🟡 6.5/10

### 7.1 输入侧校验

| 机制 | 位置 | 评级 |
|------|------|------|
| **SafetyInterceptor** | Engine Brain priority100 | ✅ 自杀/辱骂拦截 |
| **L0路由** | M1 | ✅ 分类树 |
| **语义边界检测** | M1 SemanticBoundaryDetector | ✅ |
| **角色路由** | M5 RoleClassifier | ✅ 5角色+TransitionManager |
| **情景锚点校验** | M5 SceneAnchor | ✅ 冲突词替换 |

### 7.2 输出侧校验

| 机制 | 位置 | 评级 |
|------|------|------|
| **HumanisticCalibrator** | M5 | ✅ 空/重复检测 |
| **RoleGuard** | M5 | ✅ 角色输出验证 |
| **HallucinationValidator** | chat.ts | ✅ 人名幻觉校验 |
| **角色扮演Validator** | roleplay/Validator.ts | ✅ 身份/事实/边界三层 |
| **向量对齐自检** | AlignmentGuard | ✅ 启动+全链路巡检(80/100分) |

### 7.3 监控探针

| 探针 | 数量 | 状态 |
|------|------|------|
| **全系统钩子** | 23个(H01-H23) | ✅ 全部运行中 |
| **角色扮演探针** | 9个(RP-H01~H09) | ✅ 全绿 |
| **健康检查** | /api/health | ✅ 响应正常 |
| **引擎心跳** | /api/engine/heart | ✅ 24D向量+关系指标 |
| **模块数据** | /api/modules | ✅ M6-M8全模块 |
| **探针不可观测** | 探针全红因心跳超时 | ⚠️ 冷启动/长时重启标志位问题 |

### 7.4 缺失的校验机制

| 缺失项 | 位置 | 风险 |
|--------|------|------|
| **M9毕业校验** | M9 shouldGraduate | ❌ calciumLevel≥0.3永远为真，门控失效 |
| **M6边界校验** | BoundaryManager | ❌ recordHit()从未被调用，2条默认边界无意义 |
| **M8 healed_scars计数** | /api/modules | ❌ 硬编码0 |
| **M6偏好写后校验** | PreferenceManager | ❌ 写入后从不被读取注入prompt |
| **双24D一致性校验** | M3↔Engine | ❌ 无交叉验证 |
| **M9 cycleCount死代码校验** | config | ❌ 配置定义了但永不使用 |

---

## 八、综合评分

| 维度 | 评分 | 一句话 |
|------|------|--------|
| **系统统一性** | ⚠️ **6/10** | 双24D系统并行是最大架构问题 |
| **向量对齐性** | ⚠️ **5/10** | 两套24D互不通，Engine的24D不用于检索 |
| **鲁棒性** | 🟡 **7/10** | 降级链完整，但3处静默失败 |
| **稳定性** | 🟢 **8/10** | 持续运行>6小时、8109次调用零回退 |
| **流畅性** | 🟡 **7/10** | 架构清晰但若干阻塞点 |
| **可靠性** | 🟢 **8/10** | 降级链4层，各关口有兜底 |
| **校验完整性** | 🟡 **6.5/10** | 入口出口均有校验，但4处缺失 |
| **综合** | 🟡 **6.8/10** | 生产可运行，双24D统一是必须修复的核心架构债 |

---

## 九、关键修复优先级（22个P0的综合排列）

```
立即修 (1-2天):
  [M9] 毕业条件Bug (1行)
  [Engine] L05双重发射 (15行)
  [M7] triggerInduction不存在
  [M7] writeCycle不存在
  [M8] healed_scars硬编码0 (4行)
  [M4] Reranker接入MemoryRetriever (3行)
  [M6] 删BoundaryManager

本周修 (3-5天):
  [M3↔Engine] 统一双24D系统 ← 最大架构债
  [M6] Preference注入prompt
  [M4] integrateFromEntity短路
  [M4] FG摘要缓存TTL
  [M2] 统一黑钻晋升路径
  [M6] Trait reversion-to-mean
  [M9] 实现cycleCount递增

本月修:
  [M5] 角色路由解耦
  [M2] FTS5检索/分页衰减
  [M7] DreamQueue迁SQLite
  [Engine] GenerationOrchestrator接M5
  [M5] SceneAnchor+ContextMemory合并
  [M6↔Engine] 人格→情感基线联动
```
