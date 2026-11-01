# TS 与 Python 双系统边界定义

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> **日期**: 2026-07-28 | **问题编号**: P2-1 | **类型**: 架构收敛文档

## 一、当前双系统布局

```
D:\tools\wenstar-cc\       ← TypeScript 主脑 (当前运行态)
D:\wenstar\wenstar_os\     ← Python 三域后端 (建设中)
  ├── domain_tianquan/     ← 天权: 工程 RPC / 工作流 / YAML 调度
  ├── domain_yaoling/      ← 瑶灵: 32D 主观体感
  └── domain_yaoguang/     ← 瑶光: 32D 客观环境
```

## 二、能力重叠分析

| 领域 | TS 当前已有 | Python 规划中 | 冲突风险 |
|:---|:---|:---|:--:|
| **情绪感知** | M3 24D `PerceptionAnalyzer.analyze()` | 瑶灵 32D 主观体感 | 🔴 双重计算 |
| **躯体状态** | `SomaticMemory` / `SensationAdapter` | 瑶灵 D1-D8 躯体维度 | 🔴 双重维护 |
| **自我模型** | M6 `SelfModelManager` / `getTraits()` | 瑶灵 D9-D14 自我模型 | 🟡 人格分裂 |
| **社会关系** | M4 FG `edges` / `RelationResolver` | 瑶灵 D15-D20 社会维度 | 🟡 关系双源 |
| **时空环境** | `EngineContext` / `temporal/` | 瑶光 D21-D26 时空环境 | 🟡 环境双写 |
| **动态生长** | M7 梦境 / M8 年轮 / `SleepTimeConsolidator` | 瑶灵 D27-D31 动态生长 | 🔴 生长冲突 |
| **工作流** | `chat.ts` 编排 / `CognitivePipeline` | 天权 `Master-Harris` YAML 调度 | 🟢 互补 |
| **审计** | `MemoryAssessor` / `AQC` / `HallucinationValidator` | 天权 RPC 审计 | 🟢 互补 |

## 三、推荐分工原则

### 核心原则

> **Python 是感知外设、反射系统、审计系统和工作流引擎；TS 是对话主脑和记忆权威源。**

### 具体边界

| 职责 | 归属 | 理由 |
|:---|:--:|:---|
| 对话主链路 (接收消息→返回回复) | **TS** | 当前唯一运行态 |
| LLM 调用 (prompt 组装→API→回复) | **TS** | chat.ts 为核心 |
| 记忆存储 (conversations/memories/black_diamond) | **TS** | SQLiteAdapter 为权威源 |
| FamilyGraph 人物关系 | **TS** | 唯一真相源 |
| KnowledgeBase 知识库 | **TS** | KnowledgeEngine 为主 |
| Prompt 组装 | **TS** | PromptAssembler 为主 |
| 24D 感知向量计算 | **TS** | M3 为权威计算者 |
| 32D 主观体感补充 | **Python** | 瑶灵作为感知外设，TS 读取结果作增强 |
| 32D 客观环境采样 | **Python** | 瑶光作为环境外设，TS 通过 EngineContext 读取 |
| 后台工作流调度 | **Python** | 天权 Master-Harris YAML 编排 |
| 工程审计 | **Python** | 天权 RPC 审计，TS 提供数据 |
| 规则引擎 / 物理规则 | **Python** | 天权算力密集型计算 |
| 梦境/年轮巩固 | **TS** | M7/M8 已有完整体现 |
| 跨域事件总线 | **Python** | GlobalBus 统一事件 |
| WebUI | **TS** | 当前唯一前端 |

### 关于 32D 向量的特别说明

TS 侧已有 **24D** (M3 perception)，Python 侧规划 **32D**。

**建议**: Python 的 32D 是 TS 24D 的超集扩展，而非替代：
- TS 24D = 对话级语义感知（从文本计算，实时）
- Python 32D = TS 24D + 躯体维度(6维) + 环境维度(6维) = 完整态感知
- Python 通过 RPC 将额外的 8 个维度回传给 TS，TS 将其附在 perception_json 的扩展字段中
- **TS 24D 不废除**，因为没有 TS 就没有 Python 的输入（Python 需要从 TS 读取对话文本才能计算体感）

## 四、数据流方向

```
┌─────────────────────────────────────────┐
│  TS / wenstar-cc (主脑)                  │
│                                         │
│  用户消息 → M1 DNA → M3 24D             │
│    → M4 FG+记忆 → PromptAssembler       │
│    → LLM → 回复                         │
│                                         │
│  输出给 Python:                          │
│    - 对话文本 (raw_input)                │
│    - 24D 感知向量 (perception_json)       │
│    - 实体列表 (entity_genes)             │
│    - 会话状态 (ChatMode)                │
├─────────────────────────────────────────┤
│              ↕ RPC / GlobalBus           │
├─────────────────────────────────────────┤
│  Python / wenstar_os (外设+审计)         │
│                                         │
│  接收 TS 输出 →                          │
│    瑶灵: 32D 增强 (躯体+体感补充)         │
│    瑶光: 环境采样 (时间/天气/位置)         │
│    天权: 工作流调度 / 审计 / 规则验证     │
│                                         │
│  回传给 TS:                              │
│    - 32D 增强向量 (附加维度)              │
│    - 环境上下文 (天气/时间规则)           │
│    - 审计结果 (幻觉检测/一致性验证)        │
│    - 工作流触发 (定时任务/事件通知)        │
└─────────────────────────────────────────┘
```

## 五、禁止事项

| # | 禁止 | 原因 |
|:--:|:---|:---|
| 1 | Python 直接调用 LLM API | 对话主链路归 TS |
| 2 | Python 直接写 memories 表 | 记忆权威源归 TS |
| 3 | Python 独立维护一套人格状态 | 与 M6 冲突 |
| 4 | TS 和 Python 各自计算情绪向量后分别注入 prompt | 结论冲突时无仲裁 |
| 5 | Python 独立维护人物关系图谱 | FG 为唯一权威源 |

## 六、通信协议建议

```typescript
// TS → Python: 每轮对话后的感知请求
interface PerceptionRequest {
  sessionId: string;
  rawInput: string;
  perception24D: number[];   // M3 输出
  entityGenes: string[];
  chatMode: string;
  timestamp: string;
}

// Python → TS: 增强后的完整感知
interface PerceptionResponse {
  sessionId: string;
  somaticDimensions: number[];    // 瑶灵躯体 8维
  environmentalDimensions: number[]; // 瑶光环境 6维
  enhancedPerception32D: number[];   // 完整32维
  auditFlags: string[];           // 天权审计标记
  workflowTriggers: string[];      // 天权触发的工作流
}
```

## 七、迁移路径

| 阶段 | 动作 | TS 侧 | Python 侧 |
|:--:|:---|:---|:---|
| 1 (当前) | TS 独立运行，Python 仅作为审计旁路 | 无变动 | 读 TS DB 做离线审计 |
| 2 | Python 提供环境/体感增强，TS 通过 RPC 读取 | EngineContext 增加 RPC 回退 | 瑶光/瑶灵上线 |
| 3 | Python 接管工作流调度，TS 接收事件触发 | chat.ts 监听 GlobalBus 事件 | 天权 Master-Harris 运行 |
| 4 | 完整双系统闭环 | CognitivePipeline 整合 Python 输出 | 三域全部上线 |
