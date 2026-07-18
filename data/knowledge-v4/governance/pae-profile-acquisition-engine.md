# 🧠 PAE 档案自动采集引擎 — 完整技术文档

> 文档类型：技术规格 + 运维手册  
> 所属系统：WenStar-cc / M4（知识融合层）  
> 版本：V3.3（V6 七子卷配套版）  
> 创建日期：2026-07-17  
> 最后更新：2026-07-18  
> 关联制度：[fg-kinship-redlines.md §十七](redlines/fg-kinship-redlines.md)  
> 定位：人机共享（供开发者查阅 + 供 LLM Agent 理解系统行为）

---

## 目录

1. [定位与架构](#一定位与架构)
2. [采集内容清单](#二采集内容清单)
3. [写入路径与存储位置](#三写入路径与存储位置)
4. [数据标识体系](#四数据标识体系)
5. [置信度评分机制](#五置信度评分机制)
6. [去重与冲突处理](#六去重与冲突处理)
7. [系统对接方式](#七系统对接方式)
8. [运行时触发流程](#八运行时触发流程)
9. [防护措施全览](#九防护措施全览)
10. [降级与容错策略](#十降级与容错策略)
11. [成本控制](#十一成本控制)
12. [代码文件索引](#十二代码文件索引)

---

## 一、定位与架构

### 1.1 是什么

PAE（`ProfileAcquisitionEngine`）是 FG（FamilyGraph，家族图谱）档案数据的 **唯一自动采集入口**。它替代了此前分散在 `chat.ts` 中的 4 套独立正则提取管道，以 LLM 为主、正则为辅，对对话中提及的人物信息进行结构化提取和受保护写入。

### 1.2 架构位置

```
WenStar OS 认知闭环
  │
  ├── M1 (DNA 编码) → 提取 entity_genes (人名列表)
  ├── M3 (感知分析) → 情绪/钙化决策
  ├── M4 (知识融合) → FamilyGraph + PAE ← 本引擎
  │     ├── FamilyGraph.ts      — 图谱存储与查询
  │     └── ProfileAcquisitionEngine.ts  — 自动采集引擎 ★
  ├── M5 (表达生成) → LLM 生成回复
  └── chat.ts (对话调度)
        ├── Hook B (L815) — 用户消息 → PAE 提取 → 写入 FG
        └── Hook C (L2509) — AI 回复 → PAE 提取 → 写入 FG
```

### 1.3 新旧对比

| | 旧管道（4 套正则） | PAE（统一引擎） |
|--|--|--|
| 提取方式 | 纯正则，无上下文理解 | LLM（温度 0.1）+ 正则验证 |
| 管道数量 | 4 套独立，互相不知 | 1 个统一入口 |
| 置信度 | 无（匹配即写入） | 三级评分（0-1） |
| 去重 | 无全局去重 | 精确+语义+冲突对三层去重 |
| 写保护 | 无 | 快照→写入→验证→回滚 |
| 字段覆盖 | ~26 条正则 ≈ 30% dossier | LLM 覆盖 80+ 字段路径（含 V6 七子卷） |
| 人物理解 | 非连续"张三…她很漂亮"无法匹配 | LLM 能理解非连续语义 |

---

## 二、采集内容清单

PAE 通过结构化 LLM prompt，覆盖 `PersonDossier` V6 七子卷的字段。旧 10 模块字段（contact / lifeResume / imageTraits / personalityPrefs / relationMap / familyNetwork / health / socialCapital）仍然可通过代码中的兼容路径写入，但新采集优先写入七子卷路径。

### 子卷① 基础信息（basicInfo）

| 字段路径 | 值类型 | 示例 | 提取条件 |
|----------|--------|------|----------|
| `basicInfo.gender` | 字符串 `"男"/"女"` | `"女"` | 明确提到性别 |
| `basicInfo.birthYear` | 数字 | `1985` | "今年 N 岁" → 年份核算 |
| `basicInfo.birthPlace` | 字符串 | `"北京"` | 提到出生地 |
| `basicInfo.education` | 字符串 | `"本科"` | 提到学历 |

注：V6 将 maritalStatus / zodiac / ethnicity 移入 misc，不再作为 basicInfo 的标准字段。

### 子卷② 完整人设（selfProfile）

| 字段路径 | 值类型 | 说明 |
|----------|--------|------|
| `selfProfile.traits` | 字符串数组 | 性格标签 `["开朗", "温柔", "幽默"]` |
| `selfProfile.appearance` | 字符串 | 外貌体态描述 |
| `selfProfile.bodyFeatures` | 字符串 | 身体特征 |
| `selfProfile.style` | 字符串 | 穿着风格 |
| `selfProfile.voice` | 字符串 | 声音特征 |
| `selfProfile.scent` | 字符串 | 气味/香水 |
| `selfProfile.distinguishingMarks` | 字符串 | 辨识特征（痣、纹身、疤痕） |
| `selfProfile.likes` | 字符串数组 | 喜好 |
| `selfProfile.dislikes` | 字符串数组 | 排斥 |
| `selfProfile.languageHabits` | 字符串 | 语言习惯/口头禅 |
| `selfProfile.taboos` | 字符串数组 | 禁忌话题 |
| `selfProfile.healthCondition` | 字符串 | 健康状况（整合自旧 health 模块） |
| `selfProfile.feminineDetails.*` | 对象 | 女性详细体征（保留原 imageTraits.feminineDetails 全部子字段） |

### 子卷③ 社会身份（socialIdentity）

| 字段路径 | 值类型 | 说明 |
|----------|--------|------|
| `socialIdentity.currentOccupation` | 字符串 | 当前职业 |
| `socialIdentity.currentWorkplace` | 字符串 | 当前工作单位 |
| `socialIdentity.timeline[].period` | 字符串 | 时间段 "2023-09 ~ 2026-06" |
| `socialIdentity.timeline[].role` | 字符串 | 角色描述 |
| `socialIdentity.timeline[].detail` | 字符串 | 补充细节 |
| `socialIdentity.maritalTimeline[].date` | 字符串 | 婚恋事件日期 |
| `socialIdentity.maritalTimeline[].event` | 字符串 | 婚恋事件描述 |

### 子卷④ 人生里程碑（lifeMilestones）

| 字段路径 | 值类型 | 格式 |
|----------|--------|------|
| `lifeMilestones[]` | 对象数组 | `{date, event, type: "relation"/"career"/"education"/"life"/"other", sourceRef?}` |

### 子卷⑤ 绑定典籍（boundDocuments）

| 字段路径 | 值类型 |
|----------|--------|
| `boundDocuments[].docId` | 字符串（TXJ 编号） |
| `boundDocuments[].title` | 字符串 |
| `boundDocuments[].type` | knowledge / task / note / setting |
| `boundDocuments[].boundAt` | ISO 时间戳 |

### 子卷⑥ 变更流水（_changeHistory — V6 格式）

| 字段 | 说明 |
|------|------|
| `time` | ISO 时间戳 |
| `operation` | 操作类型（"category修正"/"新建立户"/"字段更新"/"UUID重编号"/"V6迁移"等） |
| `field` | 变更字段路径 |
| `before` | 变更前值 |
| `after` | 变更后值 |
| `reason` | 变更原因 |
| `source` | 触发来源（"PAE自动采集"/"用户人工更正"/"图谱同步"/"V5迁移脚本"/"V6迁移脚本"） |

上限 10000 条，超出自动归档最早记录至 `_deprecated._changeHistoryArchive`。

### 子卷⑦ 兜底（misc）

| 字段路径 | 值类型 |
|----------|--------|
| `misc` | Record<string, any>（自由格式 JSON） |

### 兼容旧模块字段路径（仍可用，但不推荐新采集使用）

旧模块路径（`contact.*` / `imageTraits.*` / `personalityPrefs.*` / `health.*` 等）仍可通过 `_setNestedDossierField` 写入，但新采集优先使用七子卷路径。旧模块数据已归档至 `_deprecated`。

### 不归 PAE 采集的字段

以下字段由系统自动维护，不通过对话提取：

| 字段 | 维护方式 |
|------|---------|
| `name` | FG 节点创建时设定 |
| `relation_to_user` | FG 关系边推断（KINSHIP_MAP） |
| `mention_count` | 每次写入自动 +1 |
| `last_mentioned` | 每次写入自动更新为当前时间 |
| `completeness` | 每次写入后自动重算（加权累加） |
| `_changeHistory` | 每次写入自动追加 |
| `pendingItems[].confirmed` | `promotePendingItems` 自动管理 |
| `conflicts[]` | 冲突检测触发时自动记录 |

---

## 三、写入路径与存储位置

### 3.1 数据存储总览

```
WenStar 数据文件
  │
  ├── data/webui/knowledge/family_graph.db        ← FG 主库（所有人名、关系、档案）
  │     └── nodes 表
  │           ├── name (人物名)
  │           ├── type ('person')
  │           ├── aliases (JSON 别名数组)
  │           └── properties (JSON) ← PAE 写入目标
  │                 ├── occupation, appearance, traits ... (flat 字段)
  │                 ├── dossier { basicInfo, selfProfile, socialIdentity, lifeMilestones, ... } (V6 七子卷)
  │                 ├── pendingItems [ {field, value, source, ...} ]
  │                 ├── conflicts [ {field, oldValue, newValue, ...} ]
  │                 ├── _changeHistory [ {field, oldValue, newValue, timestamp} ]
  │                 └── completeness (0-1)
  │
  └── data/webui/fusion_memory.db                 ← 黑钻钙化库（永久沉淀）
        └── knowledge_base 表
              ├── tags: ['fg_person'/'fg_relation', '_pae', ...]
              └── calcium_level: 0-5 (completeness × 5)
```

### 3.2 两条写入路径

#### 路径 A：高置信度（≥0.7）→ 直接写入 dossier

```
用户消息: "我姐叫徐诗雨，在腾讯做设计师"

PAE LLM 提取 → {
  fieldPath: "occupation",
  value: "设计师",
  confidence: 0.95,
  certainty: "explicit",
  evidence: "在腾讯做设计师"
}

PAE 综合置信度:
  LLM自评(0.95×0.4) + explicit(1.0×0.3) + 证据≥20字(1.0×0.3) = 0.88

0.88 ≥ 0.7 → 直接写入路径:
  familyGraph.setDossierField("徐诗雨", "occupation", "设计师")
    → family_graph.db → UPDATE nodes SET properties = {...} WHERE name = "徐诗雨"
    → 自动追加 _changeHistory
    → 自动重算 completeness
    → 黑钻同步（带 _pae 标签）
```

#### 路径 B：中等置信度（0.4~0.7）→ 写入 pendingItems

```
用户消息: "他平时好像在做医疗相关的工作"

PAE LLM 提取 → {
  fieldPath: "occupation",
  value: "医疗相关工作",
  confidence: 0.45,
  certainty: "implied",
  evidence: "在做医疗相关的工作"
}

PAE 综合置信度:
  LLM自评(0.45×0.4) + implied(0.6×0.3) + 证据≥8字(0.7×0.3) = 0.57

0.4 ≤ 0.57 < 0.7 → pendingItems 路径:
  familyGraph.addPendingItem("张三", "occupation", "医疗相关工作", "user_message | 在做医疗相关的工作")
    → nodes.properties → pendingItems.push({
        field: "occupation",
        value: "医疗相关工作",
        source: "user_message | 在做医疗相关的工作",
        timestamp: "2026-07-17T...",
        confirmed: false,
        occurrences: 1
      })
```

**pending → 正式提升流程**：

```
同一字段被观察到 3 次（occurrences ≥ 3）
  → promotePendingItems() 自动执行
  → 3 次观察到"医疗" → 提升为 dossier 正式字段
  → pendingItem 删除
```

#### 路径 C：低置信度（<0.4）→ 丢弃

```
用户消息: "张三那边应该还好吧"

PAE 提取 → confidence = 0.25 → 丢弃
在 AcquisitionReport 中记录: fieldsDiscarded += 1
```

---

## 四、数据标识体系

### 4.1 来源标识

每个 pendingItem 的 `source` 字段格式：

```
"{source类型} | {原文证据前80字符}"
```

| source 类型 | 含义 | 触发钩子 |
|-------------|------|---------|
| `user_message` | 从用户消息中提取 | Hook B |
| `assistant_response` | 从 AI 回复中提取 | Hook C |
| `conversation` | 兜底标记 | 降级路径 |

**示例**：
```
"user_message | 我妈妈叫李秀兰，今年52岁，在县医院当护士长"
"assistant_response | 你之前提到过张丽是你的大学同学"
```

### 4.2 变更历史标识（V6 格式）

每条写入自动在 `_changeHistory` 中追加 V6 格式记录：

```json
{
  "time": "2026-07-17T08:30:00.000Z",
  "operation": "字段更新",
  "field": "socialIdentity.currentOccupation",
  "before": null,
  "after": "设计师",
  "reason": "用户明确陈述",
  "source": "PAE自动采集"
}
```

上限 10000 条，超出时自动归档最早记录至 `_deprecated._changeHistoryArchive`，不物理删除。全量数据永久可查询。

### 4.3 黑钻同步标识

PAE 写入的数据在 `syncToBlackDiamond()` 同步到 `fusion_memory.db` 时，附加 tags：

| Tag | 含义 |
|-----|------|
| `fg_person` | FG 人物档案条目 |
| `fg_relation` | FG 关系条目 |
| `_pae` | 由 PAE 自动采集（非手工录入） |
| `_pae_sync` | PAE 同步标记（幂等去重） |
| `source:user_message` 或 `source:assistant_response` | 采集来源 |
| `confidence:0.88` | 写入时的置信度 |

### 4.4 审计追溯

所有 PAE 采集报告的运行记录可通过 `AcquisitionReport` 结构体追溯：

```typescript
interface AcquisitionReport {
  personsProcessed: number;    // 采集到的人数
  fieldsWritten: number;        // 成功写入字段数
  fieldsDiscarded: number;      // 低置信度丢弃数
  fieldsSkipped: number;        // 去重/冲突跳过的数量
  details: Array<{
    personName: string;
    fieldsCommitted: string[];  // 写入成功的字段路径
    fieldsSkipped: string[];    // 跳过的字段及原因
    errors: string[];           // 错误信息
  }>;
  elapsedMs: number;            // 耗时
}
```

---

## 五、置信度评分机制

### 5.1 三因子加权公式

```
综合置信度 = LLM自评(权重0.4) + 确定性(权重0.3) + 证据质量(权重0.3)
```

### 5.2 各因子详解

| 因子 | 来源 | 取值规则 |
|------|------|---------|
| **LLM 自评** | LLM 在 JSON 输出中直接给每个字段打分 | 0.0 ~ 1.0，LLM 自主判断 |
| **确定性级别** | `explicit`=1.0 / `implied`=0.6 / `ambiguous`=0.3 | 由 LLM 判断：直接陈述 vs 可推断 vs 模糊 |
| **证据质量** | 证据句子长度 | ≥20字符=1.0 / ≥8字符=0.7 / <8字符=0.3 |

### 5.3 闸门规则

| 置信度范围 | 处理方式 | 适用场景 |
|-----------|---------|---------|
| **≥ 0.7** | 直接写入 dossier（`setDossierField`） | 用户消息（Hook B） |
| **≥ 0.8** | 直接写入（AI 回复专属高阈值） | AI 回复（Hook C，几乎不直接写） |
| **0.4 ~ 0.7** | 写入 pendingItems（需 3 次确认） | 两个 Hook 共用 |
| **< 0.4** | 丢弃 | 两个 Hook 共用 |

### 5.4 计算示例

**示例 1：显式陈述（高分）**
```
用户说: "李秀兰是护士长"
→ LLM 输出: {confidence: 0.95, certainty: "explicit", evidence: "李秀兰是护士长"}
→ 确定性: 1.0 × 0.3 = 0.30
→ 证据: 6字 < 8 → 0.3 × 0.3 = 0.09
→ LLM自评: 0.95 × 0.4 = 0.38
→ 综合: 0.38 + 0.30 + 0.09 = 0.77 ✅ 直接写入
```

**示例 2：含蓄推断（中等）**
```
用户说: "他每天都穿白大褂去医院"
→ LLM 输出: {confidence: 0.6, certainty: "implied", evidence: "每天都穿白大褂去医院"}
→ 确定性: 0.6 × 0.3 = 0.18
→ 证据: 10字 ≥ 8 → 0.7 × 0.3 = 0.21
→ LLM自评: 0.6 × 0.4 = 0.24
→ 综合: 0.24 + 0.18 + 0.21 = 0.63 → pendingItems ✅
```

**示例 3：模糊暗示（低分）**
```
用户说: "张三那边应该还好吧"
→ LLM 输出: {confidence: 0.3, certainty: "ambiguous", evidence: ""}
→ 综合: 0.3×0.4 + 0.3×0.3 + 0.3×0.3 = 0.30 → 丢弃 ❌
```

---

## 六、去重与冲突处理

### 6.1 三层去重

```
新值
  │
  ├─ Layer 1: 精确匹配
  │   JSON.stringify(新) === JSON.stringify(旧) → 跳过
  │
  ├─ Layer 2: 语义等价
  │   归一化（去标点/小写/去空格）后相同 → 跳过
  │   例: "腾讯科技" ≈ "腾讯科技。" → 跳过
  │
  └─ Layer 3: 冲突对检测
      新值与旧值构成 CONFLICT_PAIRS → 记冲突，保留旧值
      例: 旧="高" 新="矮" → 冲突（不覆盖）
```

### 6.2 冲突记录格式

冲突被检测到时，不覆盖旧值，而是记录到 `conflicts` 数组：

```json
{
  "field": "occupation",
  "oldValue": "医生",
  "newValue": "护士",
  "timestamp": "2026-07-17T08:30:00.000Z"
}
```

同时设置 `conflict: true` 标记，供 PFC 约束校验时读取（提示 LLM"此人的职业信息存在矛盾"）。

---

## 七、系统对接方式

### 7.1 不是独立插件

PAE 是**硬集成**到对话管道中的模块，不是独立进程或插件。原因：

- **延迟要求**：Hook B 在 LLM 生成回复前同步执行，必须在同一进程内完成
- **数据一致性**：直接操作 FG 的 SQLite，需要与 FG 共享事务上下文
- **保护深度**：写前快照+回滚需要直接访问 `nodes` 表

### 7.2 依赖关系

```
ProfileAcquisitionEngine
  ├── 依赖: FamilyGraph（用于读取档案 + 调用 setDossierField/addPendingItem）
  ├── 依赖: LLMProvider.rawCall()（DeepSeekLLMProvider 或 MockLLMProvider）
  ├── 依赖: profile-extraction.ts（LLM prompt 模板）
  ├── 依赖: profile-acquisition-guard.ts（配置常量）
  └── 被依赖: server.ts（初始化 + 注入 ChatContext）
```

### 7.3 初始化流程

```
server.ts 启动 → FG 初始化 → fgIntegrityGuard(5项) → 黑钻同步
  → M5Orchestrator 创建 (LLM Provider 就绪)
  → ProfileAcquisitionEngine 创建
      ├── 传入 familyGraph 实例
      ├── 传入 llmProvider.rawCall 绑定函数
      └── acquisitionIntegrityGuard(6项) 自检
          ├─ 通过 → console.log('PAE 就绪 ✓')
          └─ 失败 → console.warn('PAE 降级运行') + pae = undefined
  → 注入 ChatContext (_profileAcquisitionEngine)
  → 对话历史加载
```

### 7.4 ChatContext 注入

```typescript
// server.ts → processChatNew() 的上下文构建
{
  encoder, storage, m3, m4, m5, ...,
  _profileAcquisitionEngine: pae,  // ← PAE 通过此处注入
}

// chat.ts 中通过 ctx._profileAcquisitionEngine 访问
```

---

## 八、运行时触发流程

### 8.1 完整时序图

```
用户发送消息 "我姐徐诗雨在腾讯做设计师"
  │
  ├─ chat.ts: ChatEntry → DNA编码 → entity_genes: [{name:"徐诗雨", type:"person"}]
  ├─ chat.ts: M3 感知分析 → p (Pleasure24D), decision
  ├─ chat.ts: M4 orchestrate → ctx_m4.family_context
  ├─ chat.ts: KnowledgeContextBuilder → knowledgeBaseText
  │
  ├─ ★ Hook B (L815): PAE.acquire(message, ["徐诗雨"], ...)  ← 同步执行
  │     ├─ 检查 !_currentRoleplay → 角色扮演中跳过
  │     ├─ 限流检查 (≤20次/时)
  │     ├─ 缓存检查 (60s TTL)
  │     ├─ LLM 提取 (温度0.1, 超时5s)
  │     │     → system prompt (提取规则 + 字段映射表)
  │     │     → user message (对话文本 + 目标人物 + 已知档案)
  │     │     → LLM 返回 JSON: {persons: [{fields: [...]}]}
  │     ├─ 逐字段 commitField()
  │     │     ├─ 正则验证 (phone格式/年份范围等)
  │     │     ├─ 置信度评分 (三因子加权)
  │     │     ├─ 去重+冲突检测 (三层)
  │     │     ├─ 写前快照 (序列化 props JSON)
  │     │     ├─ 写入 FG (setDossierField 或 addPendingItem)
  │     │     └─ 写后验证 (读回对比，失败则回滚)
  │     └─ 返回 AcquisitionReport
  │
  ├─ chat.ts: familyConstraint 构建 → 注入 PAE 新提取的档案
  ├─ chat.ts: PFC 前额叶处理 → system prompt 组装
  ├─ chat.ts: M5 LLM 生成回复
  │
  ├─ chat.ts: 对话持久化 → Somatic 记录 → 黑钻提升
  │
  └─ ★ Hook C (L2509): PAE.acquire(reply, [...], ...)  ← 异步执行
        ├─ chatTaskQueue.enqueue (不阻塞)
        ├─ 更高阈值 (0.8)
        ├─ 只写 pendingItems (AI 可能幻觉)
        └─ 限流控制 (≤100次/天)
```

### 8.2 Hook B 详细说明

| 属性 | 值 |
|------|-----|
| 位置 | [chat.ts:815](src/webui/chat.ts#L815) |
| 时机 | `refinePostM4Context()` 之后、`familyConstraint` 构建之前 |
| 执行方式 | **同步**（await，必须等结果） |
| 角色扮演 | **跳过**（`!_currentRoleplay`） |
| 失败处理 | try-catch 包裹，失败不阻塞对话 |
| 使用 FG | `ctx.m4.getRealFamilyGraph()`（真实 FG，非角色扮演分支） |

### 8.3 Hook C 详细说明

| 属性 | 值 |
|------|-----|
| 位置 | [chat.ts:2509](src/webui/chat.ts#L2509) |
| 时机 | 对话持久化之后，与 `ingestFromConversation` 并列 |
| 执行方式 | **异步**（`chatTaskQueue.enqueue`，不阻塞） |
| 失败处理 | 静默失败，不影响用户 |
| 特殊规则 | 阈值 0.8，只写 pendingItems（不直接写 dossier） |

---

## 九、防护措施全览

### 9.1 7 层防护架构

```
┌─────────────────────────────────────────────────────────┐
│ Layer 0: fgIntegrityGuard（FG 核心守护）                │
│  启动时执行，5 项检查：                                  │
│  ① 核心表非空  ②"我"节点存在  ③无自指边                │
│  ④ 家族反向边完整  ⑤所有人有姓名                        │
├─────────────────────────────────────────────────────────┤
│ Layer 1: acquisitionIntegrityGuard（PAE 专属守护）       │
│  启动时执行，6 项检查：                                  │
│  ① 无空值污染 — dossier 字段不为 null/undefined         │
│  ② pendingItems 质量 — 无LLM对话文本混入                │
│  ③ 无重复 pendingItems — 相同 field::value 不重复       │
│  ④ changeHistory 合规 — 每人 ≤100 条（警戒线；实际存储上限 10000） │
│  ⑤ completeness 合法 — 所有值在 [0, 1] 区间             │
│  ⑥ 无孤儿 dossier — 子对象不为 null                     │
│  不通过 → PAE 降级运行（LLM暂停，正则继续）              │
├─────────────────────────────────────────────────────────┤
│ Layer 2: 字段值正则验证                                  │
│  ·电话号码格式: /^1[3-9]\d{9}$/                         │
│  ·出生年份范围: 1900-2020                               │
│  ·邮箱格式: /^[^\s@]+@[^\s@]+\.[^\s@]+$/                │
│  ·职业名称过滤: 不含疑问词（叫/什么/哪/吗/呢/吧）       │
│  ·LLM对话文本过滤: 不含"玉瑶:"、"（听到"、"（心想"等    │
├─────────────────────────────────────────────────────────┤
│ Layer 3: 置信度闸门                                      │
│  ·≥0.7 → 直接写入 dossier                               │
│  ·0.4-0.7 → pendingItems（需 3 次独立观察）             │
│  ·<0.4 → 丢弃                                           │
│  ·AI回复来源 → 阈值提升到 0.8                            │
├─────────────────────────────────────────────────────────┤
│ Layer 4: 去重 + 冲突检测                                 │
│  ·精确匹配 → 跳过                                        │
│  ·语义等价（归一化后相同）→ 跳过                          │
│  ·CONFLICT_PAIRS（高/矮、胖/瘦 等）→ 记冲突，保留旧值    │
├─────────────────────────────────────────────────────────┤
│ Layer 5: 写保护闸门                                      │
│                                                        │
│  写前快照:                                              │
│    node.properties → JSON.stringify → snapshot          │
│                                                        │
│  获取写锁（per-person mutex）:                           │
│    writeLock.get(personName) → 串行化                   │
│                                                        │
│  写入 FG:                                               │
│    setDossierField 或 addPendingItem                    │
│                                                        │
│  写后验证:                                              │
│    getPersonProfile → 读回字段 → 对比期望值             │
│    ├─ 匹配 → 释放锁 → 完成 ✅                           │
│    └─ 不匹配 → SQL回滚(snapshot) → 释放锁 → 失败 ❌     │
├─────────────────────────────────────────────────────────┤
│ Layer 6: 升级免疫铁律                                    │
│  ·修改 PAE 前后必须 integrityGuard 对比                  │
│  ·FIELD_VALIDATORS 字典不可删除或降级                    │
│  ·confidence 闸门阈值不可降低                            │
│  ·_isValidPendingValue 过滤逻辑不可移除                  │
│  ·写入必须走 setDossierField/addPendingItem             │
└─────────────────────────────────────────────────────────┘
```

### 9.2 各防护的代码位置

| 防护 | 文件 | 行号 |
|------|------|------|
| fgIntegrityGuard (5项) | `FamilyGraph.ts` | `fgIntegrityGuard()` |
| acquisitionIntegrityGuard (6项) | [ProfileAcquisitionEngine.ts:680-760](src/m4/ProfileAcquisitionEngine.ts#L680) | ~680 |
| 字段格式验证 | [ProfileAcquisitionEngine.ts:111-153](src/m4/ProfileAcquisitionEngine.ts#L111) | ~111 |
| LLM文本污染过滤 | [ProfileAcquisitionEngine.ts:119-123](src/m4/ProfileAcquisitionEngine.ts#L119) | ~119 |
| 置信度计算 | [ProfileAcquisitionEngine.ts:437-454](src/m4/ProfileAcquisitionEngine.ts#L437) | ~437 |
| 去重/冲突检测 | [ProfileAcquisitionEngine.ts:461-496](src/m4/ProfileAcquisitionEngine.ts#L461) | ~461 |
| 写前快照 | [ProfileAcquisitionEngine.ts:587-591](src/m4/ProfileAcquisitionEngine.ts#L587) | ~587 |
| 写后验证 + 回滚 | [ProfileAcquisitionEngine.ts:604-622](src/m4/ProfileAcquisitionEngine.ts#L604) | ~604 |
| 写锁串行化 | [ProfileAcquisitionEngine.ts:663-669](src/m4/ProfileAcquisitionEngine.ts#L663) | ~663 |
| 升级免疫声明 | [fg-kinship-redlines.md §十七](redlines/fg-kinship-redlines.md) | §17 |

---

## 十、降级与容错策略

### 10.1 降级场景与行为

| 场景 | PAE 行为 | 对话影响 |
|------|---------|---------|
| LLM API 超时（>5s） | 降级到正则管道（Pipeline 1/2） | 无影响 |
| LLM API 不可用（网络/配额） | 本次不提取，下次重试 | 无影响 |
| acquisitionIntegrityGuard 失败 | LLM 提取暂停（pae=undefined） | 无影响 |
| 单字段验证失败 | 该字段丢弃，其他字段继续 | 无影响 |
| 写入回滚 | 该字段回滚，其他字段继续 | 无影响 |
| LLM 返回非 JSON | 解析失败 → 本次提取跳过 | 无影响 |
| 限流触发（>20次/时） | 本次不调 LLM | 无影响 |

### 10.2 关键容错代码

```typescript
// chat.ts Hook B: 提取失败不阻塞
try {
  _acquisitionReport = await ctx._profileAcquisitionEngine.acquire(...);
} catch (_paeErr) {
  // 静默失败，对话继续
}

// chat.ts Hook C: 异步队列中，不阻塞
chatTaskQueue.enqueue(async () => {
  try {
    await ctx._profileAcquisitionEngine!.acquire(...);
  } catch (_paeErr2) {
    // 静默失败
  }
}).catch(() => {});

// server.ts: PAE 初始化失败时置为 undefined
try {
  pae = new ProfileAcquisitionEngine(familyGraph, rawCallFn);
} catch (e) {
  console.warn('PAE 初始化失败');
  pae = undefined;
}
```

---

## 十一、成本控制

### 11.1 限流器策略

```
┌──────────────────────────────────────────┐
│ RateLimiter (滑动窗口)                    │
│                                          │
│  每小时上限:  20 次 LLM 调用             │
│  每日上限:   100 次 LLM 调用             │
│                                          │
│  超出时: acquire() 直接 return 空报告     │
│  成本估算:  ~$0.50/天 (DeepSeek V4)      │
│                                          │
│  注意: Hook B 不受限流器控制（用户消息    │
│  是主要信号源），Hook C 受限流器控制      │
└──────────────────────────────────────────┘
```

### 11.2 缓存策略

| 参数 | 值 | 说明 |
|------|-----|------|
| 缓存 Key | `conversationText + persons.sort().join(',')` | 相同文本+相同人物 |
| TTL | 60,000ms（60 秒） | 防止同一消息在 B+C 两个 Hook 中重复调 LLM |
| 存储位置 | `extractionCache` (Map) | 内存缓存，重启时清空 |

### 11.3 Token 预算

| 参数 | 值 | 说明 |
|------|-----|------|
| 对话文本最大长度 | 500 字符 | 超出截断 |
| 已知档案摘要最大长度 | 300 字符 | 超出截断 |
| 单次 LLM 调用最多人数 | 5 人 | 超出分批 |
| LLM Temperature | 0.1 | 低温度=高确定性=少幻觉 |
| LLM Max Tokens | 1024 | 提取结果 JSON 的上限 |

---

## 十二、代码文件索引

### 新建文件

| 文件 | 行数 | 说明 |
|------|:--:|------|
| [src/m4/ProfileAcquisitionEngine.ts](src/m4/ProfileAcquisitionEngine.ts) | ~470 | 引擎主体：提取→验证→评分→去重→写入 |
| [src/m4/prompts/profile-extraction.ts](src/m4/prompts/profile-extraction.ts) | ~160 | LLM 提取 prompt 模板 + 档案摘要构建 |
| [src/config/profile-acquisition-guard.ts](src/config/profile-acquisition-guard.ts) | ~60 | 配置常量：闸门、限流、缓存 |
| [data/knowledge-v4/governance/pae-profile-acquisition-engine.md](data/knowledge-v4/governance/pae-profile-acquisition-engine.md) | 本文档 | 完整技术文档 |

### 修改文件

| 文件 | 改动内容 |
|------|---------|
| `src/m4/FamilyGraph.ts` | V6: PersonDossier 七子卷接口（selfProfile/socialIdentity/_deprecated）；`buildDossierFromFlat()` V6 适配；`_changeHistory` V6 格式；导出 PersonProfile/Dossier/PendingItem；新增 `setDossierField()`；新增 `_setNestedDossierField()`；扩展 `promotePendingItems` 支持全字段路径 |
| `src/m5/DeepSeekLLMProvider.ts` | 新增 `rawCall()` 公开方法（绕过 persona 的原始 LLM 调用） |
| `src/m5/types/index.ts` | LLMProvider 接口新增可选 `rawCall?` 方法签名 |
| `src/m5/MockLLMProvider.ts` | 新增 `rawCall()` mock 实现（返回空提取） |
| `src/webui/chat.ts` | ChatContext 扩展 `_profileAcquisitionEngine`；插入 Hook B（L815）；插入 Hook C（L2509） |
| `src/webui/server.ts` | PAE 实例化 + `acquisitionIntegrityGuard` 启动自检 + 注入 ChatContext |
| `data/knowledge-v4/governance/redlines/fg-kinship-redlines.md` | §十七 PAE 最高等级保护（7 条铁律） |

### 删除文件

| 文件 | 原因 |
|------|------|
| `src/webui/chat/ChatProfiles.ts` | 死代码，从未被 import |

### 运行验证

| 检查 | 命令 | 结果 |
|------|------|------|
| 类型检查 | `npx tsc --noEmit` | ✅ 零错误 |
| 单元测试 | `npx vitest run` | ✅ 744/766 通过（1 个失败是既存超时） |
| 启动自检 | PAE 启动日志 | 6 项检查通过 → "PAE 就绪 ✓" |

---

> **文档维护**：PAE 代码变更时需同步更新本文档。修改 PAE 前后必须运行 `acquisitionIntegrityGuard()` 对比通过项。  
> **归属制度**：[fg-kinship-redlines.md §十七](redlines/fg-kinship-redlines.md)
