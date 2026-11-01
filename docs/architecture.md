# WenStar OS 系统架构全景

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 最后更新: 2026-07-16
> 版本: V4.0 双脑融合天权

---

## 一、产品定位

WenStar（文曲星·玉瑶·太虚境）是一个仿生认知 AI 操作系统。

**核心理念：** 一个 AI 能否拥有人类的记忆运作方式——工作记忆、中期记忆、永久记忆，会遗忘、能巩固、有情感？

**与其他产品的本质区别：** 不是"聊天机器人 + 知识库"的叠加，而是"硅基生命体的认知器官模型"。

---

## 二、双脑架构

```
┌─────────────────────────────────────────────┐
│              第 二 大 脑                      │
│         知识库 (Knowledge Base)               │
│    对标 Obsidian，用户全权管理的档案库          │
│    三层: raw/ (原始) wiki/ (编译) governance/ │
│    MD 文件是 Canonical, SQLite 是 Projection  │
└──────────────────┬──────────────────────────┘
                   │ 夜间批量萃取 (摘要/向量/标签)
                   ▼
┌─────────────────────────────────────────────┐
│          天 权 前 额 叶 (Prefrontal Cortex)   │
│    双脑之间的唯一门控，单向数据流              │
│    六维约束校验 + 指令生成 + 元认知复盘        │
└──────┬────────────────────┬─────────────────┘
       ▼                    ▼
┌──────────────┐   ┌──────────────────┐
│  第一大脑     │   │   第一大脑        │
│  金库 (Gold) │   │  黑钻库 (Black    │
│  中层可变记忆 │   │  Diamond) 核心永续│
│  自然衰减    │   │  极低衰减          │
└──────────────┘   └──────────────────┘
       │
┌──────────────┐
│  砂金库       │ ← 瞬时会话缓存，会话结束清空
└──────────────┘
```

---

## 三、天权五域仿生架构

```
tianquan/                     人脑映射
├── bus/                      胼胝体 — 跨域信息路由
├── prefrontal/               前额叶皮层 — 决策、约束、目标
│   ├── PrefrontalCortex      统一编排中心
│   ├── ConstraintValidator   六维闸门控制
│   ├── DirectiveGenerator    标准化指令编码
│   ├── WorkingMemory         7槽位 LRU 工作桌
│   ├── GoalStack             三层目标栈
│   └── MetacognitionReview   交互后复盘
├── temporal/                 海马体 — 记忆索引、巩固
│   ├── HippocampalIndex      稀疏索引 (θ节律)
│   ├── SleepTimeConsolidator 渐进巩固 (δ节律)
│   ├── CoreMemoryManager     核心记忆块
│   └── SceneSnapshotBuilder  海马→前额唯一契约
├── heart/                    杏仁核 — 情感状态机
│   ├── HeartStateStore       24D 情感向量
│   ├── EmotionRegulator      记忆驱动情绪调节
│   └── EmotionCycleTracker   情绪周期分析
└── knowledge/                新皮层 — 知识治理
    ├── SecondBrainGateway    第二大脑 MD 入口
    ├── MDFileWatcher         MD 变更监测
    ├── WikiLinkResolver      [[wikilink]] 图谱
    └── SourceTracker         MD↔记忆溯源
```

---

## 四、M1→M9 核心认知管线

```
用户消息
  ↓
M1 DNA编码     → 路由分类 + DNA 结构化
  ↓
M2 融合存储    → DNA 持久化 + 双螺旋向量
  ↓
M3 感知决策    → 24D 情感分析 + 五级闸门
  ↓
M4 知识融合    → 多路记忆检索 + 家族图谱
  ↓
M5 回复生成    → LLM 调用 + 候选选择
  ↓
M6 自我演化    → 大五人格 + 偏好学习
  ↓
M7 梦境引擎    → 离线巩固 + 梦境内化
  ↓
M8 年轮线索    → 生理状态派生
  ↓
M9 工作记忆    → DNA 临时缓冲区
```

---

## 五、三域协同 (TS + Python)

```
wenstar-cc (TypeScript)              wenstar_os (Python)
══════════════════════              ════════════════════

engine/tianquan/                     domain_tianquan/
  仿生智脑四域                        算力工程域

src/tianquan/      ── RPC ──→       tianquan_rpc_server.py
  MasterHarris     ←── TCP :9100 ──→ global_bus_main.py
  GlobalBusClient                       │
                                   ┌────┴────┐
                              domain_yaoling  domain_yaoguang
                              瑶灵·仿生认知    瑶光·感知采集
                              32D体感通道      32D客观通道
```

---

## 六、关键数据流

### 对话流 (Theta 节律)
```
chat.ts → M1 DNA → M3 感知 → M4 检索 → PFC 决策 → M5 LLM 生成
```

### 记忆巩固流 (Delta 节律)
```
SleepTimeConsolidator.runDaily():
  砂金→金库(0.5h) → 惊讶度(1h) → 金→黑钻(2h) →
  第二大脑同步(4h) → 语义归纳(6h) → 跨session(12h) →
  遗忘(24h) → 系统巩固(48h)
```

### 第二大脑同步流 (夜间批量)
```
MDFileWatcher 变更检测 → KnowledgeSyncPipeline 摘要+标签 →
  SleepTimeConsolidator 同步 → memories 表(source_type=knowledge_vault) →
  SourceTracker 溯源记录
```

---

## 七、命名约定

| 旧名称 | 新名称 | 含义 |
|--------|--------|------|
| engine/brain/ | engine/reflex/ | 脑干反射层 |
| engine/temporal/ | engine/chronos/ | 自然时空系统 |
| src/tianquan/ | src/tianquan-rpc/ | RPC 客户端 |
| 不变 | engine/tianquan/temporal/ | 海马记忆域 |

---

## 八、环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| WS_DISABLE_PFC | false | true=关闭 PFC，回退旧路径 |
| WS_LAZY_TIMERS | false | true=禁用所有后台定时器 |
| TIANQUAN_LITE | false | true=跳过向量索引加载 |
| ENABLE_FIVE_STAGE_GATE | true | false=关闭五级闸门 |
| ENABLE_SEMANTIC_FUSION | false | true=开启三源语义融合 |

---

## 九、相关文档

- `CLAUDE.md` — 永久行为规则
- `src/engine/tianquan/README.md` — 天权架构简述
- `data/knowledge-v4/governance/AGENTS.md` — 知识库 Agent 操作规范
- `data/knowledge-v4/governance/redlines/knowledge-redlines.md` — 知识库红线文档
- `D:\AI文件\personal-assistant\knowledge\tools\wenstar-system-wide-review.md` — 全系统审查报告
