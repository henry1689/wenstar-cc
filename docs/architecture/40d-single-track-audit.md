# 40D 单轨审查报告

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期：2026-08-07 · 性质：只读扫描 · 关联任务：《WenStarOS 天枢架构全局复盘与重设》
> 范围：wenstar-cc（TS）+ wenstar_os（Python 三域）+ fusion_memory.db 实测

---

## 一、结论先行

- **存储层 40D 已 100% 单轨**：数据实测 `memories.perception_40d` 抽样 834 行全部 len=40、`state_spines` dimension_id 1-40（80376 行）、`black_diamond`/`knowledge_base` emotion_vector 全部 len=40。codec 硬校验（len≠40 拒绝）。
- **契约层存在 Python 侧 32D 残留错配**（运行代码已 40D，契约/常量/测试仍锁 32D）——本轮最大风险点。
- **检索层非真单轨**：`PERCEPTION_40D_ONLY` 默认 false（40D 优先 + 24D 回退双轨）。存储/收集可 enforce，检索层 enforce 需 3 个前置。
- **生产无 `VectorCenter` 组件**（全库 grep = 0），向量契约治理仍是规划态。

---

## 二、40D 当前定义（权威源）

| 项 | 位置 | 内容 |
|---|---|---|
| 类型 | `src/m3/types/perception-40d.ts` L32-124 | `PerceptionV40`：40 个命名键 `d01_muscle_load … d40_possessiveness` |
| 常量 | 同文件 L151/L161-172 | `PERCEPTION_40D_DIM = 40`；`PERCEPTION_40D_KEYS`（固定键序） |
| 扇区权重 | 同文件 L141-148 | `PERCEPTION_40D_SECTOR_WEIGHTS`：`intimate_texture=0.30`（D33-D40 检索权重最高）/ `inner_spirit=0.15` / `social_bonds=0.15` |
| 定义依据 | 同文件 L21-29 | 40D = spine.proto **D1-D32**（瑶灵生理/时空/人际/成长）+ 新增 **D33-D40**（伴侣情感纹理） |
| 编解码 | `src/m2/PerceptionVector40DCodec.ts` L37-39 / L46-73 | encode → 40 元素 JSON 数组字符串；decode 长度≠40 返回 null（硬校验） |
| 24D→40D 映射 | 同文件 L84-102 / L110-116 | `MAP_24_TO_40` 仅 **14 维**派生（D09/D12/D14/D15/D17/D19/D33-D40），其余填 0 |
| 余弦 | 同文件 L177-194 | `cosineSimilarity40D`：扇区加权余弦 |

### M3 生成链
- `src/m3/PerceptionAnalyzer.ts` `buildPerceptionV40` L614-623：把注入上下文后的最终 24D 投影为 40D；D36/D37 双极 [-1,1] 原样，其余钳 [0,1]。
- `src/m3/M3LogicOrchestrator.ts` `decide` Phase 3.5 L78：`enhanced.perceptionV40 = buildPerceptionV40(enhanced.perception)` → 挂 `decision.enhanced.perceptionV40`（消费于 `webui/chat.ts:674`）。

### 产出形状示例（占位值）
```json
{
  "d01_muscle_load": 0.00, "d08_sensory_env": 0.00,   // 客观/时空维 P3 前全 0
  "d09_self_identity": 0.45, "d12_enjoyment": 0.31, "d15_partner_attachment": 0.62,
  "d17_family_belonging": 0.38, "d19_social_fit": 0.27, "d33_sexual_attraction": 0.55,
  "d34_energy_merge": 0.40, "d35_sincerity": 0.80, "d36_dominance": -0.10,
  "d37_moral_judgment": 0.20, "d38_humor": 0.30, "d39_dependency": 0.35, "d40_possessiveness": 0.10
}
// DB 存储形态（perception_40d 列）：
// "[0.00,0.00,...,0.45,0.31,...,0.55,0.40,0.80,-0.10,0.20,0.30,0.35,0.10]"
```

### DB 写入/读取
- 写入：`src/webui/chat/persistence-stage.ts` `writePerceptionV40Dual` L66-80（SQL L75）→ 用户消息 L199、助理回复 L252；`src/m2/Perception40DStore.ts` `writePerceptionV40` L23-39；`src/webui/chat/yaoguang-backfill.ts` `_writeP40` L45-61（瑶光客观维异步回填）；`src/webui/chat/dialog-group-stage.ts` L114/L132（会晤/核心记忆 INSERT）；`src/m2/SQLiteAdapter.ts` write() 保留 L600-611/L722-728。
- 读取：`src/m4/UnifiedSearchEngine.ts` L647 `SELECT id, perception_40d`；`src/m4/VectorReranker.ts` L157 decode。
- **存储形态**：`memories.perception_40d TEXT` 独立双轨列（24D 仍走 `perception_json`）。

---

## 三、旧维度残留清单

### 功能性/硬编码（影响单轨判断）

| 位置 | 内容 | 严重度 | 建议 |
|---|---|---|---|
| `src/m4/UnifiedSearchEngine.ts:242-250` | 40D 主模式 `PERCEPTION_40D_ONLY` 默认 **false**；`queryVec`（24D 全维）仍用于 24D 精排，`queryVec40D` 并行 → **检索双轨混合** | P2 | 单轨需把 `PERCEPTION_40D_ONLY` 默认改 true |
| `src/m4/VectorReranker.ts:157-186` | L176 "无 40D → 回退 24D 路径"（`parseStoredVector(item.perceptionJson)`） | P2 | 保留为降级是设计意图；硬 enforce 前需评估 |
| `src/app/alignment/VectorAlignmentGuard.ts:76,105,353-367` | "24D 向量完整率/标准维度"检查点只统计 `perception_json`，**不检查 perception_40d** | **P1** | 40D 单轨后此检查失真，应改为校验 perception_40d 长度=40 |
| `src/m2/Dim24to32Migration.ts`（整文件） | 24D→32D 迁移蓝图（`map24DTo32D`、`DIM_COUNT_TARGET=32`），全 src 无任何调用 | P2 | 休眠死代码且与 40D 冲突，建议归档 |
| `src/common/user_state_schema.json:4,6,9,38` | 三域契约仍写 "heart 24D + yaoling 32D + yaoguang 6D"，`required: emotional_24d/somatic_32d/environmental_6d` | P2 | 与 40D 现实脱节，需更新 |
| `scripts/backfill-perception-40d.cjs:26-35` | `D40_KEYS` 键名过期（`d01_muscle_fatigue`/`d04_hormones`/`d10_desire`/`d12_pleasure`/`d14_self_protect`/`d22_home_atmosphere`），与现 `PERCEPTION_40D_KEYS`（`d01_muscle_load`/`d04_endocrine_hormones`/`d10_desire_drive`/`d12_enjoyment`/…）不一致 | P2 | 位置索引写入故功能无害，但命名契约错位，建议重命名 |

### 仅注释/设计说明（非残留）

| 位置 | 内容 | 判定 |
|---|---|---|
| `perception-40d.ts:2-6,27`、`PerceptionVector40DCodec.ts:4-13,81-82`、`config/perception-40d-config.ts:4-10,25-26`、`yaoguang-backfill.ts:4-11`、`PerceptionAnalyzer.ts:601-611,626` | 注明 "24D 全链路保留不动 / 24D 仅作 M3 内部语义引擎 / 40D 为投影" | **设计声明**，P3 |
| `src/m2/math.ts:25,148`、`structure-guard.test.ts:147-151` | `Float64Array(24)` 是 24D EmotionVectorCodec 通道 | 有意保留，P3 |
| `src/engine/bus/types.ts:115-127` + `engine/cortex/prompts/emotion-state.ts:7`、`intimate-scenes.ts:7` | Heart 层 `EmotionVector24D`（joy/sadness/…24 字段） | **独立子系统**情感向量，与感知维度无关，P3 |
| `src/m2/ZvecAdapter.ts:7,75` | knowledge_semantic 32D embedding | 知识库向量维度（Zvec collection），非感知维度，P3 |
| `src/m1/DualCoreKernel.ts:49`、`src/m6/TraitEvolver.ts:42-65` | `dimension` 指安全违规维度/大五人格维度 | 与感知无关，P3 |

---

## 四、DB 字段事实（fusion_memory.db 只读实测）

| 表 | 40D 相关字段 | 实测 |
|---|---|---|
| `memories` | `perception_json`(24D)、`perception_40d`(40D)、`perception_v2`(情绪增量对象)、`work_id` | `perception_40d` 抽样 834 行**全 len=40** |
| `conversations` | `perception_summary`、`work_id`（**无 40D 向量列**） | 10456 行 |
| `state_spines` | `dimension_id INTEGER CHECK(1-40)`（V11 重建后） | **min=1, max=40, 80376 行** |
| `knowledge_base` | `emotion_vector TEXT` | 67 行全部 len=40 |
| `black_diamond` | `emotion_vector TEXT`、`emotion_tag` | 203 行全部 len=40 |

- 库文件 253MB，存在 40D 迁移备份 `fusion_memory.db.bak-40d-20260805-202514`。
- 另有废弃库 `conversations.db.deprecated`（不再使用）。
- **结论：存储层 40D 已 100% 单轨化，无 24/32 长度残留数据。**

---

## 五、迁移状态

| 机制 | 位置 | 说明 |
|---|---|---|
| V11 迁移 | `src/m2/MigrationManager.ts:356-381` | state_spines CHECK 1-32→1-40（重建表），已应用 |
| 启动补全 | `src/m2/SQLiteAdapter.ts:1716-1766` `_backfillPerception40D` | sql.js 内存态内从 24D 幂等派生 perception_40d（只补空行） |
| 三库补全 | `src/m2/SQLiteAdapter.ts:1776-1844` `_backfillLibs40D` | state_spines 25-40 补 0、knowledge_base/black_diamond emotion_vector →40D |
| 停服脚本 | `scripts/backfill-perception-40d.cjs` | V20 一次性 better-sqlite3 回填（键名已过期） |
| Legacy 兼容层 | `map24DTo40D`、`buildFallbackV40`（`m2/YaoguangNormalizer.ts:117`）、`SEMANTIC_DIMS` 优先合并（L87-114）、VectorReranker 24D 回退 | **全部保留**（未销毁） |

转换时机：M3 生成（运行时）/ 启动补全（启动时）/ 回填脚本（停服一次性）。

---

## 六、Python 侧维度契约（错配分析）

### 契约仍锁 32D
| 文件 | 内容 |
|---|---|
| `wenstar_os/common/proto/spine.proto:1,16` | 头部 "32D 海胆语义快照"；`SpineEntry.dim_id` 注释 "1-32, CHECK(dimension_id BETWEEN 1 AND 32)"（结构是 `repeated SpineEntry` 泛型，实际可承载 D1-D40） |
| `wenstar_os/common/dna_constants.py:44-47` | `DIM_COUNT = 32` 注释 "永久锁定"；`SECTOR_DIM_MAP` 只到 0-32 |
| `wenstar_os/common/tests/test_dna_constants.py:12-13` | 断言 `DIM_COUNT == 32`（**把 32 锁死在测试里**） |
| `domain_yaoling/YAOLING_DOMAIN_SPEC.md:24,58-75,220,259` | 整篇 32D，"yaoling_state（32D 主观体感快照）" |
| `domain_tianquan/TIANQUAN_DOMAIN_SPEC.md:52-53` | "yaoling_state # 瑶灵32D快照（收）" |
| `domain_yaoguang/unlock_dispatcher.py:121` | 注释 "objective: Dict # d1...d32"（过期） |

### Python 运行代码已实际升 40D
| 文件 | 证据 |
|---|---|
| `domain_yaoling/channels/` | **已存在 d1-d40 共 40 个通道模块**（含 d33-d40 伴侣纹理） |
| `domain_yaoling/codec/sensation_encoder.py:131` | `for dim_id in range(1, 41)` 编码 40 维 |
| `domain_yaoling/workflow_executor.py:359` | `cmd = "yaoling_40d_snapshot_push"` |
| `workflows/wf_yaoling_snapshot.yaml:11-14,233`、`wf_sensation_pipeline.yaml:1,289-304` | 40D 快照、`yaoling_state_push` 载荷 40D_PACKET |
| `domain_yaoling/closed_loop.py:127,211,312`、`health_report.py:52,66,108`、`safety/guard_evaluator.py:216` | 均 `range(1,41)` / "40D" |
| `domain_yaoguang/channels/base_objective_channel.py:2,34,73`、`avatar_profile.py:389,418,588`、`mcp_harris_g.py:104,109` | "40 维客观参数通道"、D33-D40 修正 |

### GlobalBus 频道载荷
- `yaoling_state` = 瑶灵 40D 主观体感快照（经 `tianquan_snapshot` 频道 `yaoling_40d_snapshot_push` 发布）。
- `yaoguang_snapshot` = 瑶光 40D 客观参数快照（逐维 `standard_value/standard_range`）。
- TS 消费：`MasterHarris.collect40DSnapshot`（`src/tianquan-rpc/MasterHarris.ts:168-191`）→ `TianquanRPCClient.collect40DSnapshot`（L109）→ `yaoguang-backfill.ts:96-104` 取 `objective` → `YaoguangNormalizer.fillObjectiveDims` 按 `d1..d40` 键归一化。

### 错配结论
- **TS 40D ↔ Python 40D 在 objective/快照通道上对齐**（TS 按 d1-d40 读，Python 发 D1-D40）。
- **真正错配在契约层**：spine.proto、`dna_constants.DIM_COUNT=32`、两份域 SPEC、Python 测试锁 32D，而实际 Python 代码发射 40D。凡依赖 `DIM_COUNT`/`SECTOR_DIM_MAP`(0-32) 做分配/校验的代码会把 D33-D40 截断或判非法。

---

## 七、风险等级与 VectorCenter enforce 评估

| 等级 | 项 | 说明 |
|---|---|---|
| **P0** | 无 | 存储层 100% 40D（数据实测）、codec 硬校验、检索 40D 优先 |
| **P1** | `VectorAlignmentGuard.ts:353-367,105` | 对齐守卫只查 24D `perception_json` 完整性，40D 单轨后失效，需加 perception_40d 检查 |
| **P1** | Python `dna_constants.DIM_COUNT=32` + `test_dna_constants.py:12` | 与 Python 40D 代码错配，可能截断 D33-D40 |
| **P2** | 检索默认双轨（`PERCEPTION_40D_ONLY=false`） | 24D 精排+回退仍启用，非真单轨（flag 可控） |
| **P2** | `Dim24to32Migration.ts` / `user_state_schema.json` / SPEC 文档 / backfill 脚本键名 | 死代码与过期契约，误导 |
| **P3** | Heart `EmotionVector24D`、Zvec 32D embedding、注释/命名 | 非感知维度，无需处理 |

### 是否可进入 VectorCenter enforce
- **`VectorCenter` 组件不存在**（wenstar-cc 全库 grep = 0）。最近的 enforce 门是 `PERCEPTION_40D_ONLY`（`UnifiedSearchEngine.ts:244`）与 VectorReranker。
- **存储/收集层可安全 enforce 40D**（数据已全 40、codec 拒绝非 40）。
- **检索层做硬 enforce 需 3 前置**：① `PERCEPTION_40D_ONLY` 默认改 true 并移除 24D 回退路径（VectorReranker:176）；② 先修 `VectorAlignmentGuard` 的 24D 完整性检查；③ 先对齐 Python `DIM_COUNT=32`→40 与 SPEC 文档。
- 否则 24D 仍以"回退/源泉"形态参与运行时。

---

## 八、建议处理顺序

| 优先级 | 动作 | 归属 |
|---|---|---|
| P1-1 | Python `dna_constants.DIM_COUNT` 32→40 + `SECTOR_DIM_MAP` 扩到 40 + 更新锁死测试 | wenstar_os（DomainCenter 契约） |
| P1-2 | `VectorAlignmentGuard` 增加 perception_40d 完整性检查（长度=40） | wenstar-cc（VectorCenter 候选） |
| P2-1 | `PERCEPTION_40D_ONLY` 评估改默认 true（先验证 24D 回退路径是否被真正依赖） | wenstar-cc（SearchCenter/VectorCenter） |
| P2-2 | 更新 `user_state_schema.json`、两份域 SPEC、spine.proto 头注到 40D | 契约文档 |
| P2-3 | 归档 `Dim24to32Migration.ts`；修正 backfill 脚本键名 | 清理 |
| P3 | Heart 24D / Zvec 32D 维持（独立子系统，不属感知维度） | 不动 |

---

## 九、执行证据

扫描命令命中数：`40D|40d`(i) → 48；`dimension` → 68；`24D|32D|…` → 150（含分页）；`length==24/32/40` 等 → 4；`PERCEPTION_40D_ONLY` → 20；`VectorCenter`(i) → **0**；wenstar_os 侧 `32D|40D|dim_count` → 80。DB 只读查询仅测维度长度分布，未读取具体感知值。
