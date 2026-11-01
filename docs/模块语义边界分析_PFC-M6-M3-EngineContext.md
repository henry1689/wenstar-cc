# 模块语义边界分析：PFC / M6 / M3 / EngineContext

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> **日期**: 2026-07-28 | **问题编号**: P2-6 | **类型**: 架构分析文档

## 一、四个模块的职责声明

| 模块 | 文件 | 声明职责 |
|:---|:---|:---|
| **M3** | `src/m3/M3LogicOrchestrator.ts` | 24D 感知向量计算 + 场景调整 + 钙化强度 + 情绪标签推导 |
| **M6** | `src/m6/M6Orchestrator.ts` | 大五人格/偏好/自传叙事/边界管理 — AI 人格的长期演化 |
| **PFC** | `src/engine/tianquan/prefrontal/PrefrontalCortex.ts` | 统一上下文门控: CoreMemory / Facade / Emotion / Forgetting / context assembly |
| **EngineContext** | `src/engine/` | 时间/天气/会话环境上下文 |

## 二、语义重叠矩阵

### 2.1 M3 ↔ PFC：情绪/情感双重计算

| 维度 | M3 做什么 | PFC 又做了什么 | 重叠度 |
|:---|:---|:---|:--:|
| **情感向量** | `PerceptionAnalyzer.analyze()` 生成 24D perception 向量 | `prefrontalCtxV2` 读取 HeartStateStore 生成另一套 emotion vector | 🔴 高 |
| **情绪标签** | `deriveEmotionLabels()` 输出 primary/secondary 情绪 | `snapshot.emotion.pleasure > 0.2 ? 'pos' : 'neg'` 自己重新判断 | 🟡 中 |
| **钙化强度** | `computeCalcium()` 计算 calcium score/level | `snapshot.calciumScore` 存储但不重新计算 | 🟢 低 |

**根因**: M3 是 "对话级感知"，PFC 是 "任务级状态"。但两者都在计算"当前情绪"，来源不同（M3 从文本，PFC 从 HeartStateStore + SensationAdapter），结果可能冲突。

**建议**: PFC 读取 M3 输出的 24D 向量作为 emotion context 的基础，叠加躯体感知 (SensationAdapter) 和环境 (EngineContext) 做增量修正，不再独立从头计算。

---

### 2.2 M6 ↔ PFC：自我模型的层级冲突

| 维度 | M6 做什么 | PFC 做了什么 | 重叠度 |
|:---|:---|:---|:--:|
| **人格** | `getTraits()` 大五人格阈值 + 偏好列表 + 自传叙事 | `CoreMemoryManager` 管理"记忆中的自我" | 🟡 中 |
| **说话风格** | 输出性格描述 → PromptBlock persona | PFC assembledSystemPrompt → hardRule（优先级更高） | 🔴 高 |
| **成长信号** | `narrative.addLayer()` 记录人格演化事件 | 无（PFC 不管人格演化） | 🟢 无 |

**根因**: M6 和 PFC 都向 LLM 上下文注入"我是谁"的信息，但优先级不同。M6 作为 persona block (priority 300) 可能被 PFC assembledSystemPrompt (priority 1000 as hardRule) 覆盖。

**建议**:
```
PFC systemPrompt = 硬约束 (身份规则 / 安全边界)
M6 persona = 软风格 (性格 / 偏好 / 说话方式)
```
PFC 的 assembledSystemPrompt 应只包含"禁止做什么"，不包含"应该怎么说话"——后者是 M6 的职责。

---

### 2.3 PFC ↔ EngineContext：时空上下文的双重注入

| 维度 | PFC 做什么 | EngineContext 做了什么 | 重叠度 |
|:---|:---|:---|:--:|
| **时间** | processEnhanced 接收 temporalBlock 参数 | `getExtra('weather_current')` 提供天气 | 🟡 中 |
| **气象** | `_temporalBlock = '气象环境' + weatherCurrent` | `EngineContext.getExtra('weather_permission')` 控制是否注入 | 🟡 中 |
| **会话环境** | `snapshot.spatial.sceneLabel` 记录场景 | `EngineContext` 是全局 KV 存储 | 🟢 低 |

**根因**: temporalBlock 在 chat.ts 中拼接后传给 PFC，但数据来源是 EngineContext + ENABLE_TEMPORAL_RULE_ENGINE 开关。两者分工：EngineContext 是数据源，PFC 是组装器。当前分工基本合理，但拼接逻辑散在 chat.ts 中。

**建议**: 将 temporalBlock 的拼接逻辑收敛到 EngineContext 的一个方法中：
```typescript
EngineContext.buildTemporalBlock(opts): string
```

---

### 2.4 M3 ↔ M6：情绪与人格的因果关系断裂

| 维度 | M3 输出 | M6 是否消费 | 断裂点 |
|:---|:---|:---|:--:|
| **24D 感知向量** | emotions[] + calcium | ❌ M6 不读取 M3 输出 | M6 的 trait 更新基于文本事件，不参考当时的情绪强度 |
| **场景上下文** | scene_tags + interaction_type | ❌ M6 不读取场景 | 同样的事件在不同情绪下应有不同的权重 |
| **钙化强度** | calcium_score | ❌ M6 不读取钙化 | 高钙化时刻应该对人格有更大影响 |

**根因**: M6 的 trait 演化 (`updateTraitsFromSignal`) 只看事件文本，不看该事件发生时的情绪强度和场景。这导致"哭着说的话"和"随便说的话"对人格的影响相同。

**建议**: M6 的 `updateTraitsFromSignal` 应接收 M3 的 perception 作为加权参数：
```typescript
updateTraitsFromSignal(signal, perception: Perception24D) {
  const emotionalWeight = 0.5 + Math.abs(perception.pleasure) * 0.5; // -1..1 → 0.5..1.0
  const calciumWeight = Math.min(1, perception.calcium_score / 5);
  const effectiveWeight = emotionalWeight * calciumWeight;
  // ...
}
```

---

## 三、分层原则建议

```
┌─────────────────────────────────────────────────┐
│  PFC: 硬约束层                                    │
│  身份规则 / 安全边界 / 记忆检索门控 / 遗忘压制      │
│  → PromptBlock type=hard_rule, priority ≥ 900     │
├─────────────────────────────────────────────────┤
│  M3: 感知层                                       │
│  当前对话的 24D 情感向量 / 钙化 / 情绪标签          │
│  → 供 PFC/M6/M4 消费，不直接生成 Prompt            │
├─────────────────────────────────────────────────┤
│  M6: 自我层                                       │
│  人格特质 / 偏好 / 自传叙事 / 说话风格              │
│  → PromptBlock type=persona, priority 300-600     │
├─────────────────────────────────────────────────┤
│  EngineContext: 环境层                            │
│  时间 / 天气 / 会话场景 / 全局开关                  │
│  → 数据源，由其他模块读取并组装                     │
└─────────────────────────────────────────────────┘
```

### 核心原则

1. **每个事实只有一个计算者**: M3 计算情绪向量，PFC 不重算。
2. **数据向上升级**: 低层模块输出数据，高层模块组装为 PromptBlock。
3. **硬约束 > 软风格**: PFC 的安全规则覆盖 M6 的人格注入，而非相反。
4. **环境数据集中在 EngineContext**: 时间/天气/场景均由 EngineContext 统一提供，不散落在 chat.ts。

## 四、当前可立即执行的轻量改善

| # | 动作 | 涉及文件 | 风险 |
|:--:|:---|:---|:--:|
| 1 | EngineContext 新增 `buildTemporalBlock()` 方法，迁移 chat.ts 中的 temporalBlock 拼接 | `EngineContext.ts`, `chat.ts` | 🟢 |
| 2 | PFC 的 emotion context 优先读 M3 输出，仅在 M3 不可用时降级到 HeartStateStore | `PrefrontalCortex.ts` | 🟡 |
| 3 | 文档化 PFC systemPrompt 与 M6 persona 的边界：PFC 只写 "不做什么"，M6 写 "怎么做" | 本文档 | 🟢 |
| 4 | M6 trait 更新增加 emotionalWeight 参数（可选，向后兼容） | `M6Orchestrator.ts` | 🟡 |

## 五、长期建议

M3/M6/PFC 理想状态下应形成一条清晰的数据流：

```
用户消息
  │
  ▼
M3: 感知分析 → 24D 向量 + 情绪标签 + 钙化
  │          ├→ PFC: 门控决策 (该想起什么/该压制什么)
  │          ├→ M6: 人格更新 (此事件的 emotionalWeight 是多少)
  │          └→ M4: 家族/记忆检索 (检索模式由 PFC 策略决定)
  │
  ▼
PFC + PromptAssembler: 组装最终上下文
  │
  ▼
LLM 生成
```

当前这条链路中 M3→M6 的 causal 连接是断裂的。
