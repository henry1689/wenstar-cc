# MemArch Module 4 — 检索（Retrieval）任务书

> **模块编号**: M4-Retrieval
> **版本**: v1.0 任务书
> **日期**: 2026-11-03
> **基线溯源**: 基于 **MemArch-v2.0.0-Baseline** (MD5: `C3DCBFC83B96EBE88D06D230F26CF503`) 拆分
>
> ---
> **📊 任务书三级要素**
>
> | 要素 | 内容 |
> |---|---|
> | **P 优先级** | 🟠 **P1** — 高优先级，记忆系统的"出口漏斗" |
> | **交付物清单** | ① 查询理解器（p_A / 时间范围 / 实体 / 情绪）<br>② 八路召回（BM25 / 语义向量 / PPR / 情感40D / 黑钻 / 档案 / 知识库 / 前瞻）<br>③ Weighted RRF（权重随 p_A 插值）<br>④ Cross-encoder 重排<br>⑤ MMR 去重 + 上下文打包<br>⑥ 延迟降级方案<br>⑦ 单元测试 + 性能测试 |
> | **依赖关系** | 前置：M1 存储层（索引就绪）、M3 睡眠巩固（巩固度激活度）<br>并行：M2 在线写入可并行开发<br>下游：M5 MemSym 呈现层 |
> | **执行权限** | 🤖 **Claude Code 主导**<br>（多路召回编排、RRF 算法、PPR 实体图属于内核修改）<br>👥 **Pi 辅助**（各召回路封装、重排模型接入、测试用例、性能基准） |
> ---

---

## 一、模块概述与边界

### 1.1 模块定位

检索模块是记忆系统的"出口漏斗"，负责把用户的查询变成一组相关、不重复、按时序排列的记忆候选。它是**相关性为主、先验为辅**的统一检索链路，替代旧版散乱的多路召回。

### 1.2 模块边界

**本模块负责**：
- 查询理解（p_A / 时间范围 / 实体 / 情绪）
- 八路召回（并行，每路前 30）
- 规范化折叠（按 episode_id / dna_root_id 合并）
- Weighted RRF（权重随 p_A 插值）
- Cross-encoder 重排
- 先验叠加（激活度 + 巩固度 + 重要度）
- MMR 去重
- 上下文打包（按 token 预算分区）

**本模块不负责**：
- 记忆呈现与标签（→ M5）
- OutputGuard 校验（→ M5）
- 强化归因回写（→ M5）
- 写入（→ M2）

---

## 二、核心功能清单

### 2.1 总流程（十步）

```
① 查询理解（≤ 50ms）
   输出：p_A（回溯意图概率）、时间范围 [from, to]、实体、查询情绪 40D

② 硬过滤
   namespace='default' ∧ 未进墓碑 ∧（通路 B 时排除 suppressed）

③ 多路召回（并行，每路前 30）
   R1 全文 BM25（L1 原文 + L2 gist）
   R2 语义向量（L3 / L2 / L4）
   R3 实体图 PPR（HippoRAG）
   R4 情感 40D（仅通路 B 有权重）
   R5 黑钻直取（按实体或主题）
   R6 档案直取（按实体查 L4 有效事实）
   R7 知识库 / 笔记
   R8 到期前瞻记忆（命中即必入，不参与排序）

④ 规范化折叠：按 episode_id / dna_root_id 合并

⑤ Weighted RRF → 候选前 50

⑥ Cross-encoder 重排 → rel ∈ [0,1]

⑦ 先验叠加 → final score

⑧ MMR 去重（λ = 0.7）→ 前 10

⑨ 证据标签判定（交给 M5）

⑩ 上下文打包（按 token 预算分区）
```

### 2.2 意图权重插值

```
w_r = p_A · w_r^A + (1 - p_A) · w_r^B
```

| 召回路 | w_A（回溯） | w_B（浸润） |
|---|---|---|
| R1 全文（原文 / gist） | 0.30 | 0.05 |
| R2 语义向量 | 0.25 | 0.20 |
| R3 实体图 PPR | 0.15 | 0.10 |
| R4 情感 40D | 0.00 | 0.25 |
| R5 黑钻 | 0.15 | 0.15 |
| R6 档案 / L4 | 0.10 | 0.20 |
| R7 知识库 / 笔记 | 0.05 | 0.05 |

### 2.3 融合打分

```typescript
export function fuseV2(routes: RouteHits[], q: QueryUnderstanding, nowMs: number): Ranked[] {
  const w = interpolateWeights(q.pA);
  const groups = canonicalFold(routes);
  const rrf = weightedRRF(groups, w, CFG.fuse.k);               // k = 60
  const rrfMax = sumValues(w) / (CFG.fuse.k + 1);
  const top = rrf.slice(0, CFG.fuse.rerankTopN);                // 50
  const rel = crossEncoderScores(q.text, top);

  return mmr(top.map((h, i) => {
    const prior = isEpisodic(h) ? sigmoid(activation(nowMs, h) - CFG.fuse.actCenter) : 1;
    const habituation = q.pA < 0.5 ? CFG.fuse.lambdaHab * Math.log1p(h.exposures_7d) : 0;
    const timeFit = q.timeRange ? (inRange(h.ts, q.timeRange) ? 1 : 0.2) : 1;

    const score = timeFit * (
        CFG.fuse.wRel * rel[i]
      + CFG.fuse.wRrf * (h.rrf / rrfMax)
      + CFG.fuse.wPrior * prior
      + CFG.fuse.wImp * (h.importance ?? 0.5)
    ) - habituation;

    return { ...h, rel: rel[i], score };
  }), { lambda: CFG.fuse.mmrLambda, topK: 10, sim: (a, b) => cosine(a.emb, b.emb) });
}
```

**默认权重**：wRel 0.55 / wRrf 0.20 / wPrior 0.15 / wImp 0.10

### 2.4 上下文打包

| 分区 | 预算（参考） | 位置 | 内容 |
|---|---|---|---|
| 档案摘要 | 300 tokens | 开头 | L4 中与当前实体相关的有效事实 |
| 到期约定 | 100 tokens | 开头 | R8 命中项 |
| 相关往事 | 800 tokens | 结尾 | 带标签的证据，按分数排列 |
| 元素池 | 200 tokens | 结尾 | 通路 B 的原子元素（只读，带溯源） |

---

## 三、技术实现要点

### 3.1 实体图 PPR

- 以查询中的实体为种子
- 在 entity_edges 上跑 Personalized PageRank（阻尼 0.5，迭代 10 次）
- 按节点分数把关联痕迹拉进候选
- 万级实体规模下，内存计算即可，毫秒级

### 3.2 延迟预算与降级

| 阶段 | p95 目标 | 降级方案 |
|---|---|---|
| 查询理解 | 50ms | 只用规则 |
| 多路召回（并行） | 120ms | 跳过 PPR |
| 重排 | 200ms | 前 50 降到前 20，或用更小的重排模型；p_A < 0.3 时跳过 |
| 融合 + MMR + 打包 | 30ms | — |
| **合计** | **≤ 400ms** | 超时直接用 RRF 结果 |

### 3.3 习惯化惩罚

- 只在偏通路 B 时生效（p_A < 0.5）
- 最近 7 天曝光越多，分数越低
- 防止反复用同一元素（对应习惯化理论）

### 3.4 时间区间约束

- 查询带时间表达时（"上个月那次"）
- 时间区间作为强约束，区间外的条目乘 0.2

---

## 四、验收标准

### 4.1 功能验收

| 验收项 | 通过标准 |
|---|---|
| 八路召回 | 每路都能返回结果，数量 ≤ 30 |
| 规范化折叠 | 同 episode 的多条痕迹合并为一条 |
| 意图权重插值 | p_A=0.65 时，R1 权重确实高于 R4 |
| Cross-encoder 重排 | 重排后 top10 与人工判断相关度 ≥ 80% |
| MMR 去重 | 去重后 top10 无高度重复内容 |
| 上下文打包 | 四个分区都正确生成，token 预算不超 |
| 时间约束 | 查询"上个月"时，区间外条目分数明显降低 |
| 习惯化惩罚 | 同一元素连续出现时，后续轮次分数下降 |

### 4.2 性能验收

| 验收项 | 通过标准 |
|---|---|
| 检索总 p95 | ≤ 400ms（万级条目） |
| 查询理解 p95 | ≤ 50ms |
| 多路召回 p95 | ≤ 120ms |
| 重排 p95 | ≤ 200ms |
| 降级生效 | 重排超时后自动用 RRF 结果返回 |

### 4.3 质量验收

| 验收项 | 通过标准 |
|---|---|
| 召回率@10 | 比基线提升 ≥ 15%（私有评测集） |
| MRR | 逐版本不下降 |
| 去重率 | top10 中无语义重复（cosine > 0.9 视为重复） |

---

## 五、⚠️ 加固防篡改要求（验收合格后强制执行）

### 5.1 加固时机

**本模块全部验收通过后**，由模块负责人执行加固，加固完成前不得交付给 M5 调用。

### 5.2 加固内容

#### 5.2.1 入口冻结

- 对外只暴露 `RetrievalEngine.search(query)` 单一入口
- 内部的八路召回、RRF、重排、MMR、打包全部**私有**
- 入口参数校验：必须包含 query 文本，否则拒绝

#### 5.2.2 内部代码保护

- 模块核心文件（RetrievalEngine.ts / WeightedRRF.ts / CrossEncoderReranker.ts / MMROrder.ts / ContextPacker.ts）标记为只读
- 提交时强制要求：commit message 中必须包含 `[M4-Retrieval-改动说明]`
- 所有权重（w_A / w_B / wRel / wRrf / wPrior / wImp）只能通过配置文件改，不能硬编码
- 召回路数、每路 topN、MMR λ 等参数只能通过配置改

#### 5.2.3 外接部分预留

- 保留以下必要外接点：
  - `onRetrievalComplete` 钩子：检索完成后的回调（供审计/统计扩展）
  - `onRouteResult` 钩子：单路召回结果回调（供监控扩展）
  - 自定义召回路注册接口：允许其他模块添加自定义召回路
- 除上述预留外接点外，**模块内部逻辑不允许外部直接修改**

#### 5.2.4 Harness 监管接入

- 模块状态上报到 Harness：检索次数、平均延迟、各召回路命中率、重排率
- 每次检索记录查询日志（脱敏）
- Harness 定期校验：检索延迟是否在阈值内、召回率是否下降、各权重是否被篡改
- 发现篡改或异常 → 自动告警 + 冻结检索模块

### 5.3 修改权限

| 操作 | 权限要求 |
|---|---|
| 正常检索查询 | 所有模块可用 |
| 权重参数调整 | 模块负责人 + Harness 备案 |
| 召回路增删 | 必须业主授权 + ADR 评审 |
| 重排模型更换 | 必须业主授权 + ADR 评审 |
| 内部代码修改 | 必须业主授权，否则视为篡改 |

---

## 六、依赖与协作

- **前置**：M1 存储层索引就绪（FTS5 / 向量 / 实体图）
- **并行**：M1 验收后即可启动开发，M3 验收后可联调激活度先验
- **下游**：M5 MemSym 呈现层拿到检索结果后做呈现与守卫
