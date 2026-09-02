# WenStar OS 天权工程蓝皮书 V3.0

> **版本**: V3.0（战略升级 · 取代 V2.0）
> **日期**: 2026-07-14
> **适配**: 大一统架构 V1.0 / DNA V2.0 / Master-Harris V1.0 / 天权底座 V1.0 / 五级闸门 V1.0 / Transcoder V1.0 / 知识库 V2.0 / 瑶光域 V1.0 / 海马体中枢 V1.0
> **文档定位**: 内部工程规范——开发团队唯一技术参考

---

## 第一章 · 系统总览

### 1.1 模块地图（V3.0）

```
太虚境主进程 (TypeScript, Node.js, ~60,000 行)
│
├─【天权底座 — 四层不可变基础设施】
│   ├── 第一层: DNA 编码总线 (M1)
│   │     ├── L0Router.ts       关键词规则匹配 + 情绪极性兜底
│   │     ├── L1Sequencer.ts    分支路由 + 会话序列号
│   │     ├── L2ContentExtractor.ts 5 大语义区映射
│   │     ├── L3EntityAnnotator.ts  73 条实体规则 + FMM 分词
│   │     ├── GlobalSequenceCounter 跨日重置全局序列号
│   │     ├── SemanticBoundaryDetector push/flush 流式边界
│   │     └── DNAEncoder.ts     12 节点管道编排 + GlobalUID 生成
│   │
│   ├── 第二层: 双螺旋存储 + 记忆块管理 (M2)
│   │     ├── state_spines          32D 语义向量 (HNSW 索引)
│   │     ├── atom_address_timeline 寻址元数据 (B+Tree + 倒排)
│   │     ├── atom_repair_index     断链修复索引
│   │     ├── memories / conversations  壳肉 (原始数据层)
│   │     ├── math.ts               钙化公式 + 遗忘衰减 + 回溯增强 + **惊讶度公式**
│   │     ├── FusionStorageAdapter  统一读写入口
│   │     ├── SQLiteAdapter         底层 SQLite (WAL/NORMAL/64MB cache)
│   │     ├── **Core Memory Manager**  核心记忆块管理（V3.0 新增）
│   │     └── **Selective Forgetting Engine**  选择性遗忘引擎（V3.0 新增）
│   │
│   ├── 第三层: 五级闸门 (P0 核心) 🔴 默认激活，不可关闭
│   │     ├── G1 语义初筛    → HNSW Top-K
│   │     ├── G2 时空校验    → location_fingerprint 比对 + P1/P2/P3
│   │     ├── G3 仿生遗忘    → **统一 math.ts applyDecay 公式**
│   │     ├── G4 意图区分    → 主动回忆 vs 被动闲聊
│   │     └── G5 话题壁垒    → 跨话题记忆冻结
│   │
│   └── 第四层: 双核推理
│         ├── BIOS 核 (实时): DNA 编码 / 32D 校验 / 安全阈值 / 闸门
│         └── Mind 核 (推理): 上下文组装 / LLM 生成 / 策略选择 / **Core Memory 管理**
│
├─【天权业务层】
│   ├── Master-Harris 调度器 (五层架构)
│   ├── M3 感知决策: PerceptionAnalyzer (规则引擎, 无 LLM)
│   ├── M4 知识融合: MemoryRetriever + FamilyGraph + Reranker + **DualHelixReader**
│   ├── M5 表达生成: CognitionAssembler + StrategySelector + DeepSeekLLMProvider
│   ├── M6 自我进化: 大五人格 + 边界管理 + 叙事构建
│   ├── M7 梦境引擎 + **Sleep-Time Consolidator**（V3.0 新增）
│   │     ├── 4 维分析 + 闲置巩固 + 每小时归纳
│   │     ├── **Episodic→Semantic Pipeline**（情景→语义归纳）
│   │     └── **跨 session 行为模式提取**
│   ├── M8 年轮引擎: 地标/疤痕/愈合/生理推导
│   ├── M9 工作记忆: 缓存 → 分级毕业 → M2 写入
│   ├── 三库管道: 砂金→金库→黑钻 + AQC 质检
│   ├── 知识库: Zvec HNSW + 三源融合 + 双模式 + 警幻 8 API
│   ├── 人物图谱: 节点+边模型 / 10模块档案 / 角色分支隔离
│   └── FG 世界关系网络: 人类关系图谱（与知识库双核并列）
│
├─【心脑引擎 Engine】
│   ├── EventBus (优先级事件总线 + 追踪记录)
│   ├── Heart (欲望栈/情绪衰减/关系突触/涌现)
│   └── Temporal (天时引擎)
│
├─【WebUI】 HTTP :3000
│
├─【天权内核 Python】 (stdin/stdout RPC 子进程)
│
├─【瑶灵 Python 独立进程】 (TCP :9100 连接)
│
└─【瑶光 Python 独立进程】 (TCP :9100 连接)
```

### 1.2 能耗分配原则

```
┌─────────────────────────────────────────────────────────┐
│  WenStar OS 算力分配（V3.0 核心设计哲学）                 │
│                                                          │
│  在线模式（对话中）≈ 20% 算力                              │
│  ┌──────────────────────────────────────┐                │
│  │  M1 DNA 编码 → M3 感知 → M4 经验匹配  │                │
│  │  → 五级闸门精筛 → M5 LLM 生成 → 回复  │                │
│  │  特点: 只调取 top-N 经验，不扫全库     │                │
│  └──────────────────────────────────────┘                │
│                                                          │
│  离线模式（对话后 24h）≈ 80% 算力                         │
│  ┌──────────────────────────────────────┐                │
│  │  M7 梦境巩固 → 钙化重算 → 惊讶度评估  │                │
│  │  → 情景→语义归纳 → 跨 session 关联    │                │
│  │  → 衰减管理 → 知识提取 → 人格反哺     │                │
│  └──────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

### 1.3 启动流程

```
# 终端 1: 全局 TCP 总线
cd D:\wenstar\wenstar_os
python global_bus_main.py                    # localhost:9100

# 终端 2: 太虚境主进程 (唯一用户入口)
cd D:\tools\wenstar-cc
node start.cjs                                # HTTP :3000
  → spawn python tianquan_rpc_server.py       # 内置天权 RPC 子进程
  → 连接 global_bus                           # 仅用于跨域指令到瑶灵/瑶光

# 终端 3-4: 外围可插拔外设 (可选)
python mcp_harris_l.py                        # 瑶灵
python mcp_harris_g.py                        # 瑶光 (P3 建设)
```

---

## 第二章 · DNA 编码总线

（内容与 V2.0 保持一致，无变化）

---

## 第三章 · 双螺旋存储 + 记忆块管理

### 3.1 底座 1: 语义向量分片库

（DDL 与 V2.0 保持一致，无变化）

### 3.2 底座 2: 寻址治理存储池

（DDL 与 V2.0 保持一致，无变化）

### 3.3 底座隔离纪律

（内容与 V2.0 保持一致，无变化）

### 3.4 记忆块管理（V3.0 新增）

借鉴海马体的快速访问机制，引入**三级记忆块架构**：

```
Core Memory (核心记忆块)  ← 始终在上下文中
  ├── 玉瑶人设/身份声明
  ├── 用户关键画像摘要（从 UserCognitiveProfile 合成）
  │     ├── 思维风格（感性/理性/平衡）
  │     ├── 知识领域分布
  │     ├── 表达偏好
  │     ├── 近期核心关注
  │     └── 情绪基线（pleasure/arousal/intimacy）
  └── 当前会话上下文摘要
  
Recall Memory (召回记忆)  ← 情感检索 + 时序检索
  ├── memories 表 + 24D 情感向量索引
  ├── state_spines 语义向量检索（V3.0 已通车）
  └── FiveStageGate G1-G5 过滤

Archival Memory (归档记忆)  ← 长期珍藏
  ├── black_diamond 表（FTS5 全文索引）
  └── 双螺旋三底座（state_spines + atom_address_timeline）
```

**核心记忆块管理接口**：

```typescript
interface CoreMemoryBlock {
  label: string;        // 块标识（'persona', 'user_profile', 'session_context'）
  value: string;        // 块内容（JSON 序列化字符串）
  sizeLimit: number;    // 大小上限（tokens）
  priority: number;     // 优先级（0-100，高优先级在上下文不足时晚被淘汰）
  updatedAt: string;    // 最后更新时间
}

class CoreMemoryManager {
  getBlock(label: string): CoreMemoryBlock | null;
  setBlock(label: string, value: string): void;
  getContextWindow(): string;        // 组装所有块 → 注入 LLM 上下文
  refreshFromProfile(): Promise<void>;  // 从 UserCognitiveProfile 刷新
  refreshFromSession(summary: string): void; // 更新会话上下文
}
```

**对话时工作流**：
```
用户输入
  │
  ├── 读取 Core Memory（获取当前上下文 + 用户画像）
  ├── M4 检索 Recall Memory（top-N，情感+时序）
  ├── 五级闸门过滤
  ├── 合并 Core Memory + Recall Memory → 注入 LLM（~20%算力）
  └── 回复用户
```

---

## 第四章 · 五级闸门

### 4.1 管道架构

（管道架构图与 V2.0 一致，但 V3.0 强调：**闸门默认激活，不可关闭**）

```
用户查询 → [G1] HNSW Top-K (cosine≥0.3)
        → [G2] location_fingerprint 比对
        → [G3] 衰减: applyDecay (统一 math.ts 公式)
        → [G4] regex 意图检测 (active_recall / passive_chat)
        → [G5] 跨话题记忆冻结 (权重 ×0.1)
        → 最终候选集 → Mind 核
```

### 4.2 三级衰减参数

```
强情感 (calcium≥3.0):  calcium -= 0.02, strength ×= 0.995  (每24h)
工作相关:              calcium -= 0.05, strength ×= 0.985
中性:                  calcium -= 0.10, strength ×= 0.95
回溯增强 (每次被检索):  calcium += 0.2 (上限 10), strength += 0.05×(1-strength)
```

**V3.0 统一**：G3 衰减公式已从 `strength × exp(-λ×hrs)` 统一为 `math.ts` 的 `applyDecay()` 函数，消除两套公式并行问题。

### 4.3 V3.0 激活策略

```
# 五级闸门默认激活
# chat.ts 第 917 行：ENABLE_FIVE_STAGE_GATE !== 'false'
# 除非显式设置为 'false'，否则闸门始终开启
```

---

## 第五章 · 三库记忆体系

### 5.1 晋升管道

```
砂金 (conversations 表) → 30min 检查 (calcium≥1.0, role='user', ≥10 chars) → 金库 (memories 表)
金库 → 2h 检查 (calcium≥4.5 OR recall≥5) → 黑钻 (black_diamond 表, max 200)
黑钻: 永不衰减, 溢出淘汰最低钙化
```

### 5.2 钙化公式（V3.0 带惊讶度因子）

```
V2.0: calcium = ||24D 向量|| / √24
V3.0: calcium = ||24D 向量|| / √24 + w_surprise × surprise
       其中 surprise = |当前感知 - 用户情绪基线|（偏离程度）
       w_surprise 为惊讶度系数，默认 0.3

level 0 (<0.3): 粉末  |  level 1 (<0.6): 液体  |  level 2 (<0.8): 固体  |  level 3 (≥0.8): 晶体
```

**惊讶度原理**：越偏离用户日常情绪基线的信息，越值得巩固。这与生物学中"惊讶驱动学习"一致——意外的经历更容易被记住。

### 5.3 AQC 质检引擎

（内容与 V2.0 保持一致，无变化）

---

## 第六章 · 知识库 + FG 世界关系网络

### 6.1 双核心并列

V3.0 明确知识库与 FG 世界关系网络为**并列双核心**：

| 核心 | 职责 | 负责模块 |
|------|------|---------|
| 知识库（第二大脑） | 认知深度——懂思想、懂知识、懂专业 | KnowledgeEngine + FtsSearch + AutoEnhancer |
| FG 世界关系网络 | 世界广度——懂人情、懂关系、懂境遇 | HumanWorldGraph + FamilyGraph + KnowledgeBridge |

### 6.2 Zvec 集成

（内容与 V2.0 保持一致）

### 6.3 三源融合可信度

（内容与 V2.0 保持一致）

---

## 第七章 · 睡眠期巩固（V3.0 新增）

### 7.1 Sleep-Time Consolidator 设计

对话后 24 小时内，系统异步执行以下流水线：

```
对话结束
  │
  ├── [即时] 写入砂金库 + 双螺旋三底座
  │
  ├── [30min] 砂金→金库晋升评估
  │     └── 钙化≥1.0 晋升，否则保留
  │
  ├── [1h] 惊讶度评估
  │     └── surprise = |perception - baseline|
  │     └── 高惊讶度记忆优先巩固
  │
  ├── [2h] 金库→黑钻晋升评估
  │     └── 钙化≥4.5 OR recall≥5
  │
  ├── [6h] 情景→语义归纳
  │     └── 从多次对话提取行为规律
  │     └── 从碎片对话合成知识条目
  │
  ├── [12h] 跨 session 关联
  │     └── 识别跨对话的实体/话题关联
  │     └── 更新 FG 世界关系网络
  │
  ├── [24h] 衰减 + 归档
  │     └── 90天未提及 → dormant
  │     └── 180天未提及 → archived
  │
  └── [下一轮对话前] Core Memory 刷新
        └── 从 UserCognitiveProfile 合成最新画像摘要
        └── 更新当前会话上下文
```

### 7.2 Episodic→Semantic 归纳管线

```
多次对话中用户提到"喜欢喝咖啡"
  │
  第1次: "早上喝了一杯咖啡，提神" → episodic (具体事件)
  第2次: "我习惯每天喝咖啡"     → episodic + 线索
  第3次: "不喝咖啡我会头疼"     → episodic + 线索
  第N次: 达到置信度阈值
  │
  ↓
  语义记忆: "用户偏好咖啡，每天饮用，有依赖倾向"
  分类: preference
  置信度: 0.85
```

**归纳条件**：同一主题被提及 ≥3 次、平均钙化 ≥0.3、情感极性一致。

---

## 第八章 · 选择性遗忘机制（V3.0 新增）

### 8.1 遗忘本质

**衰减不是遗忘，是算力资源优化**。低优先级记忆降权，为高频交互让路。所有被"遗忘"的记忆仍存在于数据库中，只是检索权重降低到几乎不可见。

### 8.2 三级遗忘

| 等级 | 机制 | 触发条件 | 效果 |
|------|------|---------|------|
| **自然衰减** | G3 applyDecay | 长期不检索 | 强度平滑下降，仍可检索 |
| **软遗忘** | impression_score ×0.1 | 用户指令"忘掉这个" | 几乎不被检索命中 |
| **硬遗忘** | lifecycle='suppressed' | 用户指令"彻底删除" | 检索时完全过滤 |

```
用户说"忘掉那件事"
  │
  ├── 解析指令 → 识别目标记忆
  ├── 软遗忘: impression_score ×0.1
  │     └── 检索权重骤降，但仍存在于数据库
  │
用户说"彻底删除这个"
  │
  └── 硬遗忘: lifecycle='suppressed'
        └── 检索时 filter out
        └── 数据仍保留（防误操作）
```

---

## 第九章 · Master-Harris 调度器

（内容与 V2.0 保持一致，无变化）

---

## 第十章 · 跨域通信

（内容与 V2.0 保持一致，无变化）

---

## 第十一章 · 安全与容灾

（内容与 V2.0 保持一致，无变化）

---

## 第十二章 · 开发红线（V3.0）

1. 语义层/状态层/知识库逻辑隔离，禁止混表
2. 无 GlobalUID 和 location_fingerprint 的数据拒入库
3. 未经 DNA 编码的记忆禁止存储
4. 全局唯一 DNA 编解码器，模块禁建自研解析
5. DNA 主干生成后永久只读，仅分支可追加
6. **五级闸门不可关闭，底层硬强制（V3.0 默认激活）**
7. L2 聚类必须叠加区位+时间，禁止纯语义
8. **32D 向量禁止 LLM 直接输出浮点值**
9. **32D 永久锁定**，永不扩容/缩维
10. 所有结构体必须 Transcoder Protobuf 序列化 + CRC32
11. BIOS 核永不调 LLM，Mind 核永不直接操作存储
12. 单次交互仅生成一颗海胆
13. **对话中只调取经验（top-N），不扫全库——~20% 算力**
14. **对话后 24h 流式整理巩固——~80% 算力**
15. **衰减=算力优化，非数据丢失——选择性遗忘是功能性的**
16. **惊讶驱动优先级——越偏离用户情绪基线的信息越优先巩固**
17. 产品主线优先无感陪伴，Vault 仅辅助
18. 前端编辑+后台处理底层同源同步，禁两套存储
19. Zvec 仅薄封装，禁止 fork C++ 源码
20. 内源激素绝对禁止混入 32D 语义向量

---

**文档状态**: ✅ V3.0 战略升级 · 取代 V2.0
