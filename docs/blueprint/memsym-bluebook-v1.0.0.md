# 蓝皮书 · MemSym 记忆共生子系统（架构规范）

- **版本**: MemSym-v1.0.0｜效力：架构规范（宪法之下的技术结构、模块依赖、数据流）
- **定位**: MemSym 是 **WenStar OS M 层（记忆层）核心一级子系统**，支撑「长期亲密共生、渐进式情感沉淀、灵魂同频陪伴」的结构性底座。非守卫提示词补丁、非局部 ADR。
- **上游依赖**: SpaceRouter 命名空间路由（场景域，`src/m5/space/`）、A/B 双链路记忆检索引擎（`src/m4/retrieval/`）、M7 睡眠巩固管线、FG 档案（Dossier）、Harness 审计引擎
- **M 层定位**: M 层为总域；MemSym 为面向**长期亲密共生陪伴场景**的专项核心子系统。未来 M 层可承载其他记忆范式（任务记忆、知识库记忆、短期会话缓存），各自独立规范，**不使用 MemSym 双通路规则**——不把整套 OS 记忆模型绑定在亲密陪伴范式上。

## ⚠️ 临时运行模式（阶段性妥协，见宪法摘要条款）

v1.0「全域皆 REAL_HISTORY、无 FICTION_LORE 分流」为临时运行模式：域基础设施就绪前，通路分发器挂检索层入口，域门以接口占位；角色扮演/虚构叙事隔离推迟启用。

## 一、内部数据流

```
用户输入
   ↓
[命名空间门（预留钩子，v1.0 恒 REAL_HISTORY）]
├─ FICTION_LORE（未启用）：切叙事子系统，绕过 MemSym
└─ REAL_HISTORY：送入 MemSym 双通路分发器
        ↓
【主旨判定器】（RECALL_TRIGGER_RE 正则 + 句法特征 → 存疑送轻量 LLM 复核）
        │  判定保守方向偏向 A（误判代价不对称：A 被误判成 B = 违规风险；B 被误判成 A = 仅氛围受损）
        ├─ 主旨=回溯、询问、陈述往事 →【通路 A 回忆检索通路】
        │      召回引擎输出 RecallResult { tag【记得/印象/线索】, elementSet, anchorUUID, score }
        │      OutputGuard 校验：要素池校验、不确定标记校验、标签-表达匹配校验
        │      钙化增益：高系数加分，计入 A 链路权重
        └─ 主旨=当下对话、情绪陪伴、闲聊，无回溯叙事意图 →【通路 B 元素浸润复用通路】
               要素萃取器（主源：FG 档案 + M7 离线巩固；补充：在线 top-k 轻萃取）
               计算 fitScore = 40D 余弦相似度（+元素标签语义匹配加权），≥ 阈值才拾取 PickedElement
               生成层仅将原子元素融入当下句子，不构造往事叙事
               OutputGuard 校验：无新增事实要素、不隐性构造往事叙事
               钙化增益：低系数加分，带冷却、单位上限，权重自然衰减
        ↓
全部输出、全部权重变更、全部元素拾取记录送入 Harness 审计日志（标记 boostSource: A / B）
```

## 二、组件划分

| 组件 | 职责 | 实现载体（v1.0） |
|---|---|---|
| 要素萃取器 | 离线主萃取（M7 巩固管线「元素化输出」阶段 + FG 档案）+ 在线轻量补充萃取（召回层 top-k 原子化） | M7 / FG / retrieval-stage |
| 双通路分发器 | 主旨判定（规则+LLM 复核）+ B→A 降级控制器 | retrieval 层入口 |
| 要素池沙箱 | 只读封闭 elementSet，带 sourceAnchorUUID 溯源 + 主客体归属 | knowledge_base 扩展（impression/recall_count/软遗忘字段现成） |
| 钙化增益调节器 | A/B 两套独立增益系数、限流、冷却、自然衰减控制 | boost 配置层（math.ts / VaultManager / KnowledgeEngine） |
| OutputGuard 校验算子集 | hasNovelFactualElements、标签-表达匹配、B 路往事断言检测、主客体指称校验 | guard-builder / prompt-sanitizer |

## 三、接口契约

```ts
// 通路 B 元素检索请求（召回层调用）
interface ElementPickRequest {
  currentContext: string;               // 当前会话内容、情绪、场景标签
  purpose: 'enrich_empathy';            // 固定标记，区别于 recall_query
  allowedElementTags: Set<'preference' | 'mood' | 'style' | 'intimate_cue'>;
}
interface PickedElement {
  sourceAnchorUUID?: string;            // 来源记忆锚点，审计溯源
  subjectUUID?: string; objectUUID?: string;  // 主客体归属（防"错爱"窜台，指称级校验）
  content: string;                      // 萃取的单一原子元素（非完整事件）
  fitScore: number;                     // 40D 余弦 + 标签加权；≥ 阈值（默认 0.6，灰度校准）
  settled: boolean;                     // 未沉淀元素（新鲜素材）：权重极低 + 需 ≥2 次独立出现才转正（复用 PendingItem 机制）
}
// 通路 A 记忆包沿用 RecallResult + tag 三档
```

**约束**：只萃取原子特征元素（偏好、情绪、表达风格、意象、习惯），不抽完整事件片段；跨身份校验生效（含主客体指称级）；软遗忘状态过滤（impression×0.1 通道）；fitScore 候选严格限定于召回管线输出。

## 四、Legacy 迁移（校准②，两期）

masterProfile / 偏好注入通道（PFC/M6 领地）标记 **Legacy**：批γ 与 PickedElement 并行 → 批ε 灰度对比体感 → 裁决退役，统一收敛至 MemSym 标准接口。不一次动三模块。

## 五、演进路线（roadmap）

- **v1.0（本版）**：双通路基础协议全套
- **v1.1**：元素情感标签细分（安心、眷恋、俏皮等情绪维度，优化 fitScore 情绪对齐）
- **v1.2**：双向反馈回路（用户显性正/负反馈干预元素优先级与钙化衰减速率）
- **v2.0（远期）**：记忆冲突调解子模块（新旧感受矛盾、模糊记忆互相冲突）

## 关联

宪法摘要 `governance/memsym-constitution-v1.md` · 白皮书 `memsym-whitepaper-v1.0.0.md` · ADR-MEM-002 · 构建批次见 `docs/agent-collab/active/MemSym-v1.0.0-落地方案.md`
