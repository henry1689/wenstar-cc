---
name: context-injection-v10
description: 上下文注入 V10 蓝皮书 — finalKnowledgeText 22段注入完整顺序与决策树
metadata:
  node_type: implementation
  type: blueprint
  version: V10.5
  last_updated: 2026-07-26
  s4_verified: true
  s4_notes: >
    S4 确认 MemoryInjector 已接入 chat.ts (L56 import, L1224-1231 调用, L1370 消费)。
    领域14 "记忆背景注入" 已更新为 injectMemories() + KnowledgeTextAssembler.withMemoryBackground()。
    22段注入表已添加 Assembler 方法交叉引用列，覆盖全部 16 个语义注入方法。
  source_file: src/webui/chat.ts
---

> **⚠️ 表达法部分已被取代（2026-11-09，MEM-UNIFY-V1 批1）**
> 本文档中「反编造 / 记忆表达 / 三档」相关措辞与守卫表，以 `src/m5/prompts/memory-expression-law.ts`（MEMORY-LAW-V1）为唯一法源；旧二元禁令（绝对禁止编造 / 禁止脑补 / 不确定就说不记得）已废止。本文档保留为 22 段注入顺序与决策树的历史记录，不再作为表达法依据。

# 上下文注入 V10 蓝皮书

## 一、注入架构概述

`finalKnowledgeText` 是发送给 LLM 的最终系统提示词，由 22 段按固定顺序拼接而成。注入遵循三条优先级规则：

1. **守卫优先**：幻觉防护在前，知识在后
2. **身份优先**：角色/实体身份在知识之前
3. **知识优先**：知识在记忆之前

## 二、22 段注入完整顺序

> S4 更新：新增"Assembler 方法"列，将 S3 引入的 KnowledgeTextAssembler 16 个语义方法交叉引用至各注入段。

| 序号 | 段名 | 说明 | 触发条件 | Assembler 方法 | 注入渠道 |
|------|------|------|----------|---------------|---------|
| 1 | 时间守卫 | 北京当前时间 + 农历日期 | 始终注入 | — | allGuardMsgs |
| 2 | 记忆幻觉防护 | 禁止编造过去事件/日期/生活细节 | 始终注入 | — | allGuardMsgs |
| 3 | 重复检测防护 | 禁止输出与上一轮完全相同 | 检测到重复时 | — | allGuardMsgs |
| 4 | 亲密知识守卫 | KB 门外预警（禁止倾诉私人知识） | intimacyFilter 触发时 | withIntimacyFilter | prepend |
| 5 | 未知守卫 | "不知道就是不知道"防护（含自引用去重） | 无知识匹配时 | withDontKnow | prepend |
| 6 | 日常感受防护 | 禁止编造"我在做什么" | 日常闲聊时 | — | allGuardMsgs |
| 7 | 家族铁律 | 角色/人格/关系约束 | 角色为非 neutral 时 | withFamilyConstraint | prepend |
| 8 | 社交关系约束 | 社交图谱边规则 | 有社交关系数据时 | — | ctx_m4 |
| 9 | 自我模型 (M6) | 性格/偏好/身份记忆三段注入 | 非会晤模式 | withM6SelfModel | prepend |
| 10 | 实体上下文 (会晤) | "你叫XX，以下是XX的所有记忆" | 会晤激活时 | withBaseText | body |
| 11 | 实体上下文 (多人) | 多人会晤的参与者列表和K线图 | 多人会晤时 | — | ctx |
| 12 | 金库知识 | 从知识库检索的相关知识 | 有匹配知识时 | withBaseText | body |
| 13 | 砂金库补充 | 金库不足时从砂金库降级补充 | timeline < 2 时 | — | knowledgeBaseText 直拼 |
| 14 | 记忆背景注入 | injectMemories() 统一去重/排序/预算 → Assembler.withMemoryBackground() 注入（chat.ts L1224-1231 调用，L1370 withMemoryBackground 消费） | 有相关记忆碎片或 timeline 时（S4 已接入 MemoryInjector） | withMemoryBackground | prepend |
| 15 | PFC override | 前额叶皮质覆写结果 | PFC.processEnhanced 返回时 | withPFCUnified | prepend |
| 16 | factualRecall | 事实召回（从 fusion_memory 检索） | 有事实匹配时 | withFactualRecallGuard | prepend |
| 17 | roleHint | 角色提示（秘书/知己/伴侣等） | 非会晤模式且非 neutral | withRoleHint | append |
| 18 | intimacyFilter | 亲密过滤器输出 | 触法亲密检测时 | withIntimacyFilter | prepend |
| 19 | KB 路由 | 知识库路由决策 | 有路由结果时 | — | M4 orchestrator |
| 20 | familyConstraint | 家族关系约束 + 外观防编造 | 有 family 数据时 | withFamilyConstraint | prepend |
| 21 | masterProfile | 主人画像上下文 | 有画像数据时 | withAboutYou | prepend |
| 22 | followUp + engineContext | 追问上下文 + 引擎上下文（含反编造铁律） | 有追问或引擎上下文时 | withFollowUp + withEngineContext | prepend |

## 三、PFC 三分支注入决策

PFC.processEnhanced() 返回三个互斥注入分支：

| 分支 | 字段 | 触发条件 | 优先级 |
|------|------|----------|--------|
| A | `assembledSystemPrompt` | PFC 成功组装完整系统提示词 | 最高（直接替换） |
| B | `directive.payload` | PFC 覆写/修正指令 | 中（追加到 finalKnowledgeText） |
| C | `violations` | PFC 检测到违规 | 最低（追加违规警告） |

三分支互斥：一次 PFC 调用最多触发一个分支，A > B > C。

## 四、配置化常量

V10 将以下硬编码常量移至模块级配置：

| 常量 | 原位置 | 现位置 | 说明 |
|------|--------|--------|------|
| `DEFAULT_LOCATION` | chat.ts L511 内联 | chat.ts 模块级常量 | 默认地理位置 '深圳' |
| `DEFAULT_USER_NAME` | chat.ts L714 fallback | chat.ts 模块级常量 | 默认用户名 '鸿艺' |
| 农历日期 | chat.ts L1052-1060 硬编码映射表 | CalendarEngine.getLunarDateString() | 改为算法计算 |

## 五、注入顺序验证

注入顺序通过 S3 架构合规评审验证：
- 守卫优先（#2-#6） → 身份优先（#7-#11） → 知识优先（#12-#16） → 上下文补充（#17-#22）
- `chat_injection_order_changed: false` — 注入顺序在本次 S4 修复中保持不变

## 六、belong_entity_uuid 全链路标注

### 6.1 数据流向

`belong_entity_uuid` 是 V10.4 引入的实体归属标注字段，用于将每条对话和记忆关联到特定 FG 实体（人），支持按实体维度精确检索。

```
用户消息/助理回复
  │
  ├── 写入链路（persistence-stage.ts）
  │     │
  │     ├── resolveBelongUUID() → FG 查询 → conversations.db (belong_entity_uuid)
  │     ├── _detectSpeakerUUID() → 自称匹配 → conversations.db (assistant 角色)
  │     └── writeMemory() API → fusion_memory.db memories (belong_entity_uuid)
  │
  └── 检索链路
        ├── MeetingContextPipeline.ts → 按 belong_entity_uuid 过滤 conversations/memories
        └── KnowledgeEngine.ts → 支持 belongEntityUuid 过滤知识检索
```

### 6.2 写入点标注

| 写入点 | 文件:行号 | 目标表 | 归属解析方式 |
|--------|-----------|--------|-------------|
| 用户消息 | persistence-stage.ts:130 | conversations.db | resolveBelongUUID() → FG 查询 |
| 助理回复 | persistence-stage.ts:138 | conversations.db | resolveBelongUUID() 回退 _detectSpeakerUUID() |
| 用户记忆 | persistence-stage.ts:170 | fusion_memory.db memories | resolveBelongUUID() |
| 助理记忆 | persistence-stage.ts:194 | fusion_memory.db memories | resolveBelongUUID() 回退 _detectSpeakerUUID() |

### 6.3 UUIDGatekeeper 三层过滤

UUID 标注写入后，检索时经过 UUIDGatekeeper 三层白名单过滤：
1. `baseWhitelist` — 基础允许列表
2. `sessionEntities` — 会话级实体白名单
3. `tempGrants` — 临时授权

无关实体的记忆在检索阶段被滤除，不进入上下文注入管道。

## 七、V10.5 启动回填机制

### 7.1 触发时机

`SQLiteAdapter.init()` 完成数据库初始化后，自动执行回填（可设置环境变量 `SKIP_BACKFILL=true` 跳过）。

### 7.2 三表联级传导

```
entities 表
  ↓ 按 name 匹配
conversations 表 (belong_entity_uuid)
  ↓ 按 content → raw_input 子串匹配
memories 表 (belong_entity_uuid)
  ↓ 按 source_id → memories.id
black_diamond 表 (belong_entity_uuid)
```

### 7.3 回填策略

| 阶段 | 表 | 匹配方式 | 实现位置 |
|------|-----|----------|----------|
| 1 | conversations | 全文匹配 + 自称检测（6种模式） | SQLiteAdapter.ts L348-354 |
| 2 | memories | 从 conversations 按文本子串传导 | SQLiteAdapter.ts L358 |
| 3 | black_diamond | 从 source_id → memories 传导 | SQLiteAdapter.ts L361 |

### 7.4 持久化保障

回填完成后立即调用 `this.flush()` 落盘（L367），避免历史数据因进程重启丢失。

## 八、writeMemory() 公共 API 契约

### 8.1 接口定义

```typescript
// SQLiteAdapter.ts L561-608
writeMemory(memory: {
  id: string;                    // 唯一标识
  seqPos: number;                // 序列位置
  createdAt: string;             // ISO 时间戳
  perceptionJson: string;        // JSON 序列化的感知向量
  calciumScore: number;          // 钙化分 (0-1)
  calciumLevel: number;          // 钙化等级 (1-5)
  locusPath: string;             // 轨迹路径
  leafZone: 'user' | 'assistant'; // 叶区
  rawInput: string;              // 原始输入文本
  primaryEmotion: string;        // 主要情绪标签
  memoryType: 'dialog';          // 记忆类型
  memoryKind: 'episodic';        // 记忆种类
  lifecycleState: 'active' | 'candidate'; // 生命周期状态
  confidenceScore: number;       // 置信度 (0-1)
  stabilityScore: number;        // 稳定性 (0-1)
  threadId: string;              // 线程 ID
  sourceConversationIds: number[]; // 源对话 ID 列表
  globalUid?: string;            // 全局 UID
  locationFingerprint?: string;  // 位置指纹
  dialogGroupId?: string | null; // 对话组 ID
  topicLabel?: string | null;    // 话题标签
  belongEntityUuid?: string;     // V10.4: 实体归属 UUID
}): boolean;
```

### 8.2 调用方

`persistence-stage.ts` L157 和 L181 通过 `sqlite.writeMemory()` 写入用户消息和助理回复，不再使用 `as any` 逃逸路径直接操作内部 db。

### 8.3 防抖保障

`writeMemory()` 写入后调用内部 `save()` → `flush()` 防抖链：150ms 窗口合并写入，50 次硬上限兜底，确保数据最终落盘。

## 九、知识归纳服务架构

### 9.1 职责分离

V10.1 P1-2 的「对话→知识归纳」逻辑已从 `persistence-stage.ts` 迁至独立服务：

| 模块 | 文件 | 职责 |
|------|------|------|
| persistence-stage.ts | src/webui/chat/persistence-stage.ts | 数据持久化（三写保障） |
| knowledge-induction.ts | src/webui/chat/knowledge-induction.ts | 对话→知识归纳（模式匹配 + KB 写入） |

### 9.2 调用链路

```
chat.ts (薄调度层)
  → persistConversation()
    → persistence-stage.ts: 三写持久化
    → knowledge-induction.ts: 事实模式匹配 → KB.add()
```

`knowledge-induction.ts` 仅在消息匹配到地址/工作/家人等模式时触发，异步写入知识库，不阻塞主对话流程。

## 十、S3 新增：KnowledgeTextAssembler 装配器模式

### 10.1 背景

V10 的 `finalKnowledgeText` 由 chat.ts 内约 275 行内联拼接逻辑构成，22 段注入缺少统一的装配入口和顺序保障。S3 引入 `KnowledgeTextAssembler`（文件：`src/webui/chat/KnowledgeTextAssembler.ts`）作为 Builder 模式的装配器。

### 10.2 16 个语义注入方法

| 序号 | 方法 | 对应注入点 | 优先级 |
|------|------|-----------|--------|
| 1 | `withBaseText(entityCtx, kbText)` | 实体上下文 + 知识库文本 | body |
| 2-4 | `withPFCUnified(parts)` | PFC assembledSystemPrompt + guardMessage + assembledContext | prepend |
| 5 | `withPFCViolations(violations)` | PFC 违规警告 | prepend |
| 6 | `withFactualRecallGuard(guard)` | 事实回忆查询守卫 | prepend |
| 7 | `withRoleHint(hint)` | 角色路由提示 | append |
| 8 | `withIntimacyFilter(filter)` | 亲密度过滤器 | prepend |
| 9 | `withKBExtra(text)` | 知识库补充 | append |
| 10 | `withDontKnow()` | "不知道"守卫（含自引用去重） | prepend |
| 11 | `withMemoryBackground(text)` | 过往记忆背景（含自引用去重） | prepend |
| 12 | `withFamilyConstraint(constraint)` | 家族约束 + 外观规则 | prepend |
| 13 | `withAboutYou(text)` | 主人镜像 | prepend |
| 14 | `withM6SelfModel(blocks)` | M6 自我模型块 | prepend |
| 15 | `withFollowUp(text)` | 追问上下文 | prepend |
| 16 | `withEngineContext(block)` | 引擎上下文 | prepend |

### 10.3 三重优先级

`build()` 按三级优先级拼接：
1. **prepends**（守卫优先） — 通过 `prepend()` 注入
2. **body**（主体） — 通过 `setBody()` / `withBaseText()` 设置
3. **appends**（补充） — 通过 `append()` 注入

同优先级内按调用先后顺序排列。`snapshot()` 方法返回当前已组装文本（用于自引用去重检查）。

### 10.4 注入决策表（与 allGuardMsgs 的分工）

| 守卫内容 | allGuardMsgs (→ enrichedWithGuard) | KnowledgeTextAssembler (→ finalKnowledgeText) |
|----------|-----------------------------------|----------------------------------------------|
| hallucinationGuard | ✓ | — |
| repeatHint | ✓ | — |
| feelingGuard | ✓ | — |
| dailyGuard | ✓ | — |
| timeGuard | ✓ | — |
| classificationGuard | ✓ | — |
| _appearanceGuard | ✓ | — |
| factualRecallGuard | — (S4 移除) | ✓ (withFactualRecallGuard) |
| intimacyFilter | — (S4 移除) | ✓ (withIntimacyFilter) |

S4 修复：`factualRecallGuard` 和 `intimacyFilter` 从 `allGuardMsgs` 中移除，仅保留在 Assembler 中，消除双重注入冗余（约 200-400 tokens/轮）。
