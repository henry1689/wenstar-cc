# 天枢架构修订方案

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期：2026-08-07 · 性质：只读复盘 + 规划 · 关联任务：《WenStarOS 天枢架构全局复盘与重设》
> 关联报告：`40d-single-track-audit.md` / `search-engine-capability-audit.md` / `current-core-dataflows.md` / `large-file-refactor-map.md`

---

## 一、结论先行：**采用九大分枢，新增 SearchCenter（治理侧调度器壳）**

1. **八大分枢 → 九大分枢**：新增 `SearchCenter`（多路长上下文召回中枢）。检索已从普通工具升级为多路长文召回关键能力，且已有 `m4/retrieval` 底座工程基础。
2. **SearchCenter 定位**：**治理侧调度器壳**（管超时/熔断/预算/审计/编排），业务实现留在 `m4/retrieval` 底座。**不做独立重写**，避免过度设计。
3. **天枢现状**：生产 `src/kernel/` 不存在、`TIANSHU_*` flag 零命中、Dispatcher/Guardian 零实现——**天枢仍是规划态**。Lab（24D 镜像）已备好隔离区。
4. **40D 已事实单轨**（存储层 100%），但检索层非真单轨（双轨默认） + Python 契约错配——天枢 VectorCenter 上线前置。
5. **方案 B（检索作为 Dispatcher 首个真实试点）获佐证**：检索是主链延迟主源（retrieval-stage L670 P1 挂载点），底座缺口恰是治理要素，与"收权"职责精确对齐。

---

## 二、天枢现状核查（五路扫描关键事实）

| 维度 | 事实 | 证据 |
|---|---|---|
| 天枢代码 | **零落地** | 生产/Lab `src/kernel/` 不存在、`TIANSHU_*` flag 全库 0、Dispatcher/Guardian 0 实现 |
| Lab 状态 | **24D 旧镜像**，P2 基线验证挂起 | `D:\WST\wenstar-os-tianshu-lab\WenStarOS`，git `feature/tianshu-kernel` 2 commits，缺生产 40D 期新增的 `police/` |
| governance | police 已接入 13 文件；**audit 仍 Noop、auth 未挂主写路径** | `UUIDPoliceFilter` 主链收编；`AuditSink.ts:41 NoopAuditSink` |
| 调度底座 | TimerRegistry 已实现（A0-A6 的 G 阶段目标落地） | `engine/temporal/base/TimerRegistry.ts` |
| 检索底座 | **8 适配器 + runAllAdapters + fuseHits 已上线**（60 测试，WS_FOUNDATION_ROUTES=true） | `src/m4/retrieval/` 15 文件 1454 行 |
| 40D | 存储层 100% 单轨；检索层双轨；Python 契约错配 | 见 `40d-single-track-audit.md` |
| 测试 | wenstar-cc 118 文件/1434 用例；wenstar_os 91 用例（任务书"22+"不符） | vitest + pytest 实测 |

---

## 三、天枢总架构：九大分枢

```
TianshuKernel 总中枢（收权：Dispatcher 调度 + Guardian 守护）
│
├── IntentCenter    意图中枢     → 生产映射：chat.ts / M3LogicOrchestrator / ChatEntry / PrefrontalCortex
├── SearchCenter    召回中枢 ★   → 生产映射：m4/retrieval 底座 + UnifiedSearchEngine + MemoryRetriever + KnowledgeEngine + retrieval-stage
├── VectorCenter    40D 契约中枢 → 生产映射：PerceptionAnalyzer / PerceptionVector40DCodec / YaoguangNormalizer / VectorReranker
├── WriteCenter     写入治理中枢 → 生产映射：SQLiteAdapter / persistence-stage / FusionStorageAdapter / VaultManager / governance/auth
├── LLMCenter       模型调用中枢 → 生产映射：M5Orchestrator(:90 llm.generate) / DeepSeekLLMProvider / MockLLMProvider / common/const/llm-config
├── DomainCenter    三体跨域中枢 → 生产映射：FamilyGraph / MasterHarris / GlobalBusClient / TianquanRPCClient / spec_loader + wenstar_os 三域
├── TaskCenter      任务/定时中枢 → 生产映射：HippocampusRhythmCoordinator / TimerRegistry / AsyncTaskQueue / maintenance / M7Orchestrator
├── ConfigCenter    配置中枢     → 生产映射：config.ts / ConfigService / 各 Config + perception-40d-config
└── SystemCenter    系统生命周期 → 生产映射：server.ts(组合根) / engine/orchestrator / handleShutdown / CLI
```

**边界公式**：
```
SearchCenter = 找回材料；M4 = 记忆治理；M5 = 生成组织；
LLMCenter = 模型边界；WriteCenter = 持久化副作用；VectorCenter = 40D 契约。
```

---

## 四、SearchCenter 定位（核心决策）

### 管什么
- 多路并发调度（chat_history / long_memory / novel_text / family_graph / knowledge / black_diamond / vault / note）
- 召回排序（RRF+近因+MMR）、snippet、上下文预算、timeout、熔断、缓存、降级
- 搜索审计（retrieval_log 落盘 + trace）、搜索结果进 Prompt 前过滤（police 统一）

### 不管什么
- 不直接写入记忆（必须走 WriteCenter）
- 不直接调用 LLM（必须走 LLMCenter）
- 不自行判定 40D 契约（必须走 VectorCenter）
- 不直接决定最终回复、不绕过 M4/M5、不跨域调三体

### 内部结构建议（治理壳）
```
SearchCenter（治理侧，收权）
  ├── SearchGate / SearchGuard          （入口鉴权 + 行级 police）
  ├── SearchRouter                      （按 query 特征选路）
  ├── MultiRouteSearchPlanner           （长问题→多路，短问题→快路）
  ├── SearchSourceRegistry              （包装 m4/retrieval AdapterRegistry）
  ├── SearchRanker / SnippetBuilder / ContextBudgeter
  ├── SearchCache / SearchTimeout / SearchCircuitBreaker
  └── SearchAudit（retrieval_log 落盘）
        │  业务实现委托
        ▼
   m4/retrieval 底座（8 适配器 + runAllAdapters + fuseHits + backref）
```

### 分配原则
| 场景 | 路由策略 |
|---|---|
| 短问题 | 快速记忆搜索（单路 topK 小） |
| 长问题 | 多路并发召回 |
| 剧情/小说问题 | work/novel route 优先 |
| 关系问题 | family_graph route 优先 |
| 近期聊天 | chat_history route 优先 |
| 人格/生命态 | memory + 40D metadata route |
| 复杂生成 | 多路并发 + 排序压缩 |

### 性能原则
1. 多路并联；2. 每路 timeout；3. 每路 topK；4. 统一 rank；5. 长文本只返 snippet+metadata，必要时取 fullText；6. Prompt 上下文有 token 预算；7. 可缓存高频 query；8. 搜索失败不阻断聊天主链；9. 慢搜索降级快速召回；10. 审计异步写。

---

## 五、底座缺口 → SearchCenter 补什么（基于审计）

| 治理要素 | 现状（缺） | 补法 | 复用先例 |
|---|---|---|---|
| withTimeout | `runAllAdapters` Promise.all 无超时 | 每路包 `Promise.race` 超时 | `UnifiedSearchEngine.ts:604 cfg.crossEncoderTimeoutMs` |
| 熔断 | 无连续失败计数/半开/摘路 | adapter 级熔断器（连续失败→摘 route） | `RetrieverCircuitBreaker.ts` / 对照 MH-6 |
| 缓存 | 无 query 缓存 | query 级 LocalCache | `app/tools/LocalCache.ts` |
| 审计 | 仅 console.log，retrieval_log 不写 | runAllAdapters 接 audit sink 落盘 | `governance/audit`（现 Noop，需实现） |
| 上下文预算 | 只 topK，无 token 预算 | ContextBudgeter（topK+token 上限） | `V13 narrativeMaxTokens` / MemoryInjector 8000 |
| 并发上限/abort | Promise.all 无限制、无 abort | 并发池 + abort 信号 | `AsyncTaskQueue.ts` |
| 失败可见化 | 43 处空 catch 吞异步失败 | 降级链记录 `degradations[]` | searchV13 L537-713 |
| 重复注入 | 砂金高钙化块仍独立执行 | 收编到 MemoryAdapter（memory 域） | — |

---

## 六、SearchCenter 独立 vs 并入：判定

| 维度 | 独立 SearchCenter（第九分枢） | 并入 VectorCenter / m4 内建 |
|---|---|---|
| 治理权归属 | 收归调度层（符合"业务只做业务"） | 留在业务模块 m4（违背天枢初衷） |
| 工程基础 | 底座 80% 已实现，缺口恰是治理 | 复用 60 测试、改动面最小 |
| 过度设计风险 | 中（需防壳重于实） | 低 |
| 与方案 B 契合 | **天然契合**（检索=Dispatcher 首个试点） | 削弱试点价值 |
| P 阶段现状 | 需待 Lab 重建 40D | 可先行 observe |

**结论**：**独立 SearchCenter，但定位为"治理侧调度器壳"，业务实现留 m4/retrieval 底座**。既满足收权，又避免重复实现。分枢 = 治理职责边界，不是代码目录强约束——SearchCenter 治理代码可放 `src/kernel/centers/search/`，业务仍复用 `m4/retrieval`。

---

## 七、更新后的主聊天链路（SearchCenter 加入后）

```
用户输入
  ↓
IntentCenter：意图识别、trace、风险分级
  ↓
SearchCenter：多路长上下文召回
  ├── chat_history / long_memory / novel_text / family_graph / knowledge
  └── (复用 m4/retrieval 底座 + 治理要素)
  ↓
M4：记忆结构化选择/整合
  ↓
M3 / VectorCenter：必要时补充 40D 状态校验
  ↓
M5 / LLMCenter：Prompt 组装与模型调用
  ↓
ResponsePostProcessor
  ↓
WriteCenter：必要记忆/关系/聊天写入
  ↓
DomainCenter：必要时同步三体
  ↓
Audit / Recovery 回流天枢
```

---

## 八、40D 单轨与 VectorCenter enforce 路线

依据 `40d-single-track-audit.md`：

| 阶段 | 动作 | 归枢 |
|---|---|---|
| 前置 P1-1 | Python `dna_constants.DIM_COUNT` 32→40 + `SECTOR_DIM_MAP` 扩 40 + 更新锁死测试 | DomainCenter 契约 |
| 前置 P1-2 | `VectorAlignmentGuard` 增加 perception_40d 完整性检查 | VectorCenter |
| P2-1 | `PERCEPTION_40D_ONLY` 评估改默认 true（先验 24D 回退依赖） | VectorCenter/SearchCenter |
| P2-2 | 更新 `user_state_schema.json`、两份域 SPEC、spine.proto 头注 | 契约文档 |
| P2-3 | 归档 `Dim24to32Migration.ts`；修正 backfill 键名 | 清理 |

**VectorCenter enforce 条件**（三前置满足后才可 enforce）：
1. `PERCEPTION_40D_ONLY=true` 且移除 24D 回退路径（VectorReranker:176）
2. 修 VectorAlignmentGuard
3. 对齐 Python `DIM_COUNT` + SPEC
> 当前**不 enforce**：存储/收集层数据已全 40（可安全 enforce 写入校验），检索层保持 observe。

---

## 九、observe → warn → enforce 路线（第一批观察点）

| 级 | 观察点 | 方式 |
|---|---|---|
| **observe** | `WS_FOUNDATION_ROUTES=false` 影子比对（retrieval-stage:680-684），记录每路耗时/命中/失败不注入 | 现成开关 |
| **observe** | runFoundationRoutes 已返回 `latency`（orchestrate.ts:45），补 traceId + 事件总线上报 | 补观测 |
| **warn** | 单路超时阈值告警（复用 `maxTotalLatencyMs`）；adapter 连续失败计数告警 | 阈值告警 |
| **enforce** | withTimeout 硬超时 + 摘路降级（fail-open：天枢自身 bug 只丢观测不中断业务） | 硬超时 |
| **enforce** | 熔断（连续失败→摘 route，仿 MH-6） | 熔断 |
| **enforce** | audit sink 落盘 + 上下文预算（topK/token 上限注入） | 落盘 |

---

## 十、第一阶段 Skeleton 任务边界

**目标**：SearchCenter 治理壳 + Dispatcher 首个试点（方案 B），全程 observe 不动主链。

| 任务 | 内容 | 归枢 | 风险 |
|---|---|---|---|
| S1 | `runAllAdapters` 加 withTimeout（复用 crossEncoderTimeoutMs 范式），影子日志 | SearchCenter | 🟢 底座 |
| S2 | 熔断器：adapter 连续失败→摘 route + 告警 | SearchCenter | 🟢 底座 |
| S3 | query 缓存（LocalCache 复用） | SearchCenter | 🟢 |
| S4 | 审计 sink 落盘（实现非 Noop audit）+ retrieval_log 覆盖底座/V13 | SearchCenter | 🟡 governance |
| S5 | ContextBudgeter：topK+token 预算注入 fuseHits | SearchCenter | 🟢 |
| S6 | Python `DIM_COUNT`→40 契约对齐 | DomainCenter | 🟡 三体 |
| S7 | VectorAlignmentGuard 补 40D 检查 | VectorCenter | 🟢 |

**红线（Skeleton 阶段禁做）**：不重构 chat.ts/SQLiteAdapter/FamilyGraph 等 12 文件（A0-A6 高风险红线）；不强制 enforce；不接 conversation/memory/FG 三域适配器（避免与 V13/V11 重复注入）；不触碰 40D 存储格式。

---

## 十一、大文件拆解与天枢渐进路线

依据 `large-file-refactor-map.md`：Tier 1 四巨怪（FamilyGraph 5924 / server 2849 / chat 2627 / SQLiteAdapter 2207）都是 12 文件高风险红线成员。

**渐进原则**：天枢 Skeleton（治理壳）先行，**拆解排在其后**。每个分枢拆解时"先旁路/trace/audit，后动刀"，且每拆一步都要重跑 1434 用例 + 冒烟。

| 阶段 | 拆解对象 | 先决条件 |
|---|---|---|
| P2+ | `UnifiedSearchEngine`（763）L0-L7 分层独立 | SearchCenter 壳就绪（observe 挂载点） |
| P3+ | `MemoryRetriever`（890）缓存/压缩/检索分离 | 同上 |
| P4+ | `SQLiteAdapter`（2207）表级 DAO + 40D codec 抽离 | VectorCenter 就绪 |
| P5+ | `chat.ts`（2627）意图分支拆 | IntentCenter 就绪 |
| P6+ | `FamilyGraph`（5924）按层拆 | DomainCenter 就绪 |
| P7+ | `server.ts`（2849）路由/生命周期独立 | SystemCenter 就绪 |

---

## 十二、测试与验证方式（现状盘点）

| 项 | 命令 | 现状 |
|---|---|---|
| build | `npm run build`（tsc） | 预存在 7 个 getPersonBio 基线错误 |
| 全量测试 | `npm run test`（vitest run） | 1434 用例，预存在失败（search-v12/v13 entityUuid 断言 + DAG） |
| 全量回归 | `npm run test:full`（scripts/test-full-local.cjs） | 关键回归 109 全绿 |
| typecheck | `npm run typecheck`（tsc --noEmit） | — |
| 冒烟 | `npm run smoke:api` 等 13 个 runtime-smoke | 服务级验证 |
| 40D 测试 | `p2-40d-verify`(5) + `p5-integration`(4) | 已有 |
| 检索底座测试 | `m4/retrieval/__tests__`（60） | 全绿 |
| Python 测试 | `pytest` | 91 用例（wenstar_os） |

**新增建议**：SearchCenter 治理要素（withTimeout/熔断/预算）单测补充；检索审计落盘验证。

---

## 十三、风险与缓解

| 风险 | 缓解 |
|---|---|
| 重复注入（V13/V11 vs 底座） | 三域适配器暂不接；砂金块收编到 MemoryAdapter 时同步停旧块 |
| SearchCenter 壳重于实 | 治理代码最小化，业务全委托 m4/retrieval |
| 40D 双轨语义漂移 | 按 §八 三前置渐进 enforce，先 observe |
| Python 契约错配截断 D33-D40 | P1-1 优先（DomainCenter） |
| 43 处空 catch 吞失败 | Skeleton 期间逐步降级可见化，不一次性全改 |
| sql.js 大字段直取阻塞 | withTimeout + snippet-first 策略 |

---

## 十四、执行证据

本方案基于 5 路只读 Agent 扫描（40D/搜索引擎/数据流/大文件/天枢），所有结论均对应实际代码路径、函数名、行号、数据表。详见四份关联报告。任务红线（不删旧逻辑/不强制 enforce/不改 DB/不重写搜索引擎/M4/M5/不引入外部框架/不写巨型文件/不绕过 M4/WriteCenter/LLMCenter/不记录密钥）全程未触碰。
