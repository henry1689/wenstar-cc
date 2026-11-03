# 全链路盘点 · 从写入到注入 AI 对话（2026-10-24）

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 触发：业主指令"再看看从写入到用于与 AI 的全链路" | 方法：代码现场 + 生产日志实证
> 范围：写入 → 存储 → 召回 → 注入 LLM → AI 对话；标注重启（10-24 00:38）后的运行实证

## 一、五段链路全图与 40D 参与度

### ① 写入段
- M3 `decide` 产出原生 40D（`enhanced.perceptionV40`）→ `writePerceptionV40Dual` 写 `memories.perception_40d`
- DNA 编码（locus_path/dna_root_id/entity_genes）+ UUID 户籍（belong_entity_uuid）随写落库
- **⚠️ 残骸（批1 已就绪待落码）**：`buildPerceptionJson` 24D 链每条消息计算 → writeMemory 派生写 40D → 被原生**覆写**——算完即弃的双轨；`EmotionVectorCodec`（24D 感知量纲编解码）随之删

### ② 存储段
- 金库 `memories.perception_40d`（40D 真源，codec 硬校验 len=40）｜黑钻 `emotion_vector`（40D v2）｜知识库 `emotion_vector`（40D）
- 三库全 40D 单轨（state_spines 已删、perception_json 列已删）
- 寻址链 `atom_address_timeline`（DNA 藤载体，Phase 2 待启用 vine_group_id）

### ③ 召回段（重启后生产日志实证 ✅）
- **主链**：retrieval-stage → searchV13 → `retrieveMultiRank` 六路并行 → RRF 融合 → L6.5 40D 精排
  - **spine40D 语义联想路：18 次运行**（最新 1325 候选 / 双源 2206 行 = memories+黑钻）
  - **五级闸门主链：1397 候选过闸**（G1 路内 floor + G2-G5 容器，stats 正常）
- **会晤分支**：associative 40D 联想 **53 次运行**（"40D事件联想召回: 8 条"）+ 简要模式 40D 重排
- 查询向量 = M3 原生 p40（批1 前生产里仍有 24D 派生双写，批2 后彻底单轨）

### ④ 注入段
- 召回产物 → `memoryFragments[]` → `injectMemories`（M4/MemoryInjector 截断过滤）→ `withMemoryBackground` → `finalKnowledgeText` 22 段装配（守卫→身份→知识→记忆顺序，蓝皮书 V10）→ LLM

### ⑤ AI 对话段
- `DeepSeekLLMProvider` → 回复；可观测面：`retrieval_log`（6625 条，legacy 路记录）、pm2 日志（Spine40D/Gate/EntityMem·联想 三类活动均在刷）

## 二、批2清单 · 读取链剩余违法量纲（精确点位）

| # | 位置 | 内容 | 处置 |
|---|---|---|---|
| 1 | `VectorReranker.ts:157-169` | `parseStoredVector` 解析 len===24 旧数组 + `perceptionToArray`(24D) | 删 24 分支，仅 40D |
| 2 | `VectorReranker.ts:200-220` | "无 40D → 回退 24D 路径" | 删回退（40D 缺失即跳过精排） |
| 3 | `UnifiedSearchEngine.ts:189/218` | 候选 `perceptionJson` 旧名字段（内容已是 40D，与 `perception40d` 字段**完全同值冗余**） | 删旧名字段，统一 perception40d |
| 4 | `UnifiedSearchEngine.ts:257-263` | `queryVec`(24维,flag下恒中性) + rankByVector 24 维合成分支 | 删 24 维合成，rankByVector 收 40D-only |
| 5 | `math.ts:25/148` | `toNormalizedVector`(24) 等 —— 批1 删 EmotionVectorCodec 后复核消费方，若归零则删 | 批1 后验 |

**附带观察（非违法，优化项）**：spine 路无内部上限，单次曾产 1325 候选——建议 cap（如 top64）以更贴"对话只调 top-N"红线精神；不影响正确性（RRF/limit 截断在后）。

## 三、结论

- **写入到 AI 的全链路已贯通且 40D 化过半**：存储 100% 单轨、召回主链+会晤分支全部在生产实跑（日志实证）、注入末端 22 段装配正常
- **剩余违法量纲全部集中在两处**：写入链残骸（批1，票待确认）+ 读取链回退/冗余字段（批2 清单如上，均已精确到行）
- 下一步：业主确认批1 票 → 落批1 → 批2 → 批3 注释文档 → 批4 Python 契约（另仓）
