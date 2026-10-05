# ADR-010: 记忆单元由单消息迁移至 dialog_group 对话块

- **状态**: 提议中 — 待实施（Phase 1）
- **决策**: 唤醒休眠的 dialog_group 架构，把记忆的基础单元从「单条消息」升级为「对话块」；`conversations` 原文永久只增不删；块级元数据落独立表 `dialog_groups`；块的价值判定只用仓内已有确定性规则（零 LLM）；隔离判据收敛到 `belong_entity_uuid`
- **日期**: 2026-10-06
- **依据**: 《UUID户籍管理法 WS-HUKOU-LAW-V1.0》第五/六/七条、本仓系统不变量 #1–#8、V35-A/B/C/D 批次结论
- **相关**: ADR-003（最小语义单元）、V35 四批修复（`3d49208`/`5a07755`/`7cc9ea7`/`4456ff1`）

---

## 一、S1 诊断摘要（全部结论来自生产库只读实测）

业主提出的问题：与徐诗雨会晤时**多轮语义连贯性差** ——「刚还在说上电梯，多说几句就变成别的事了」「话题惯性弱」「聊着聊着忘了前面说的」。

诊断定位到 **5 处结构性缺陷**，共同点不是某行代码写错，而是：

> **系统没有「块」这个存储单位，只有「单条消息」；同一概念又有多套互不知情的口径。**

### 1.1 四层存储的真实记录粒度（实测）

| 层 | 物理载体 | **粒度** | 实测条数 | 平均体量 |
|---|---|---|---|---|
| 上下文 | `conversations` | **单条消息**（user/assistant 各一行） | 6358 | 246 字符 |
| 金库·逐轮 | `memories` `mem_*` | **单条消息** | 5710 | 184 字符 |
| 金库·对话组锚点 | `memories` `*_ANCHOR` | 整组（但见 1.3） | 1231 | 284 字符 |
| 金库·碎片 | `memories` `*_CHUNK_*` | 单轮问答对 | **6** | 252 字符 |
| 黑钻 | `black_diamond` | **一句话摘要** | 1973 | **87 字符** |

**「一问一答」作为一个单位在库里从未存在过** —— user 一条、assistant 一条分开存，配对只发生在读取那一刻。

### 1.2 对话组名义上存在，实际近六成只有 1 轮

实测 1297 个对话组的轮数分布：

```
1 轮  747 组 (57.6%)      5 轮   37 组
2 轮  215 组 (16.6%)      6–9 轮 64 组
3 轮  127 组               10 轮  46 组  ← 封顶
4 轮   61 组
```

封组条件 [chat.ts:2659-2663](../../src/webui/chat.ts)：**满 10 轮 / 30 分钟 / 话题切换 / 退出会晤**。

### 1.3 🔴 碎片层是死的 —— 每次重启被销毁且不重建

[SQLiteAdapter.ts:2483](../../src/m2/SQLiteAdapter.ts) 服务启动时：

```sql
DELETE FROM memories WHERE id LIKE '%\_ANCHOR' ESCAPE '\' OR id LIKE '%\_CHUNK%' ESCAPE '\'
```

后只重建 ANCHOR，**明说不重建 CHUNK**（:2510-2512 注释自认「碎片每次重启被永久销毁」）。

实测：全库碎片仅存 **6 条**，全部产生于最近一次重启之后。按现存 1297 组轮数推算应有 ~1615 条 → **99.6% 已销毁**。

### 1.4 🔴 运行期锚点被重启替换为「截断版」

| | 运行期 `flushDialogGroup` 写 | 重启后 `_rebuildMemoryAnchors` 重建 |
|---|---|---|
| 形状 | `【核心】` + **峰值轮全文** | `【核心·名字】` + 最多 10 行、**每行截 150 字符** |
| 实测条数 | **4** | **1227** |

**1227 : 4** —— 99.7% 的锚点是截断版。闭组时合并的【重要补充】（承诺/约定/引文轮）仅 1 条存活。

### 1.5 🔴 场景/氛围在金库路径被主动剥掉

各层带 `（…）` 场景描写的比例（实测）：

| 层 | 带场景描写 |
|---|---|
| `conversations`（原文） | **79.2%** |
| 重建型锚点（从 conversations 捞） | 91.9% |
| **`memories` 逐轮砂金** | **0.3%** |
| 黑钻 summary | 14.2% |

原因在 [persistence-stage.ts:386](../../src/webui/chat/persistence-stage.ts)：

```ts
const cleanReply = input.reply.replace(/（[^）]*）/g, '').trim();
```

剥离理由成立（防「LLM 读到自己写的场景 → 重新走进那个场景 → 死循环」），**但代价是金库存的全是「去掉氛围的语义骨架」，氛围只在 conversations 原文层**。

### 1.6 🔴 roleplay 隔离状态随重启翻转（口径分歧，现行存在）

写入侧两套口径互相矛盾：

| 位置 | 口径 |
|---|---|
| 运行期 `persistence-stage.ts:319` / `dialog-group-stage.ts:195,222` | `会晤 ? 'roleplay' : 'episodic'` |
| 重建侧 `SQLiteAdapter.ts:2554` | `const kind = 'normal'`（理由：S2-H1「系统已只有会晤模式」） |

读侧是**条件式过滤** [MemoryRetriever.ts:448](../../src/m4/MemoryRetriever.ts)：

```ts
if ((options?.isBackgroundTask || _nonMeetingContext) && dna.memory_kind === 'roleplay') return false;
```

实测：`memory_kind` = episodic 4327 / **normal 1332** / roleplay 3600，其中 `normal` 1332 ≈ 重建锚点数 1227。

**⇒ 会晤锚点的隔离状态随重启翻转**：重启前 `roleplay`（非会晤上下文被排除），重启后 `normal`（不再被排除）。而 `conversations.roleplay_char` **6402 条全空、无生产者**，重建路径**永远无法**还原 roleplay 口径。

### 1.7 其余已核实事实

- **块级字段没有载体**：`dialog_group` 不是表，只是 `conversations`/`memories` 上的 TEXT 字符串列。挂锚点行 → 每次重启被 1.3 的 DELETE 清空。
- **`virtual_world_ts` 无生产者**：全仓 grep `virtual_world`/`worldState`/`世界状态` = 0 命中；[SceneMap.ts:7](../../src/engine/tianquan/temporal/SceneMap.ts) 明写瑶光「客观物理世界空间（**后续对接**）」，即尚未接入。
- **衰减体系已存在且已解耦**：[MemoryConfig.ts:43](../../src/config/MemoryConfig.ts) 注释「P2-1：衰减速率按内容类别独立控制（**与 calcium_score 晋升/召回解耦**）」；`runDecay()` 实测按 `narrative_tag` 选率，不按钙分。
- **价值体系已存在**：`retentionDecay`（emotional 0.02 / relational 0.05 / neutral 0.10）、`autoPromoteCandidatesV2`、`lifecycle_state`、`is_landmark`、`manual_quota_consumed`、`vault_log` 全部在跑。
- **块判定所需原料已存在**：括号正则、`dg.perceptions[]`、`computeCalcium`、`FEATURE_ROUND_RE`（承诺/约定/引文）、`_locusChanged`、`MemoryWriteGateway` 退化内容拦截。

---

## 二、决策

### D1 · 记忆基础单元 = dialog_group 对话块

`dialog_group` = 一个自闭合的连贯场景事件：多轮对话 + 场景描写 + 情绪曲线 + 闭合原因。块闭合后成为中期记忆（检索的主要候选源）。

三层记忆模型（与既有三库对齐，非新建概念）：

| 层 | 载体 | 留存策略 |
|---|---|---|
| 短期 · 工作窗口 | `conversations` 最近 N 轮 | 滚动淘汰（内存窗口标记，不删原文） |
| 中期 · 块库 | `dialog_groups` + 派生行 | 按价值衰减、可归档、**索引可剔除** |
| 长期 · 黑钻 | `black_diamond` | 只增不硬删（现状保持） |

### D2 · 重新定义「只增不删」

> **「只增不删」约束的是「原始事实的可得性」，不是「每一层都必须保留副本」。**

| 层 | 策略 | 理由 |
|---|---|---|
| `conversations` 原文 | **永久保留，任何清理逻辑不得触碰** | 场景/氛围的唯一存档（79.2% vs 0.3%） |
| `memories` 派生行 / `*_CHUNK*` | **可按价值治理** | 派生物，**可从原文重建** |
| `search_index` 检索条目 | **可剔除** | 加速结构，不是事实 |
| `black_diamond` | 只增不硬删（超限归档 `status='removed'`） | 已是现状 |

**依据**：本仓既有设计决策 [meeting-recall.ts:7-8](../../src/m4/retrieval/meeting-recall.ts)「原文永久留存原则，压缩仅是内存窗口标记，原始对话只增不删，召回侧永远可原文直取」。

### D3 · 块价值判定只用确定性规则，禁止后台 LLM 打分

- **禁止**在后台定时任务中调用 LLM 打分（撞本仓「Harness 零 LLM 监控」铁律；且 LLM 判定不可复现 × 不可逆持久化决策 = 结构性风险）。
- 判据**收拢到单一模块** `src/app/memory/BlockValueScorer.ts`（铁律 #7：禁止同一业务规则多处实现），全部复用仓内已有算子。
- **LLM 只做单向增强**：只能把被低判的块捞回，**无权把高分块剔除**。失败模式因此是安全的。

### D4 · roleplay 隔离判据收敛到 `belong_entity_uuid`（口径乙）

**理由（硬事实，非偏好）**：口径甲（会晤即 `roleplay`）在重启路径上**不可实现** —— 重建从 `conversations` 出发，而 `roleplay_char` 全空，无从判断。硬撑口径甲的唯一结果是维持 1.6 的「重启翻转」。

- 隔离全权由 `belong_entity_uuid` 承担（与 V35-A 同源、与户籍法第五/七条同源、与 `MemoryRetriever.ts:391` 既有 UUID 直查路径同源）。
- 重建产物与运行期产物统一 `memory_kind = 'normal'`。
- 退役 `memory_kind === 'roleplay'` 的读侧排除（`MemoryRetriever.ts:448/463/702/780/815`）。
- **据此 A 选型落定为 A3：退役 CHUNK**（见下）。

#### A3 的依据（实施前调用链追踪查出，优于原 A1/A2 两个选项）

追踪 `_CHUNK` 全仓引用发现：**它没有任何专属消费者** —— 出现处只有「写入」(`dialog-group-stage.ts:213`) 与「删除」(`SQLiteAdapter.ts:2483`)，读取方为零（`backfill-temporals.cjs:81` 甚至是显式 `NOT LIKE` 排除它）。

内容上它与既有两层**完全重复**：

| CHUNK 的内容 | 已经存在的地方 |
|---|---|
| 单轮 Q+A 合并文本 | `conversations` 同 seq_pos 的两行（**原文，保留场景描写**） |
| 该轮的感知向量 | `mem_*` 逐条行（`perception_40d` 已落库） |

且重建时 `conversations` **没有感知向量列** —— 硬重建只能回填空向量，产出的是**低质量副本**。

⇒ A1（保留）维持一个每次重启即失效的冗余层；A2（重建）是让重建器生产冗余层，成本高、收益零。**两者都不做才是对的**：停写、停建、存量随下次重启自然清除。

### D5 · 低钙块走「保守版」

所有块**全部写入索引**；块钙分决定权重与衰减速率。低钙块降权 + 加速衰减，常规多路检索几乎不会命中，但**索引条目保留、兜底召回通道常开**。

**不做**（留待 Phase 2 灰度）：把低钙块从主索引摘除。理由：会产生两套判据（主索引/兜底）的架构分叉，且用户主动回忆时可能检索失败。

---

## 三、修正清单（A–G）

| # | 项 | 结论 |
|---|---|---|
| **A** | `_rebuildMemoryAnchors()` 启动 DELETE | 选 **A3 · 退役 CHUNK**：停写（`dialog-group-stage` 删写入循环）、停建、DELETE 语句移除 `%_CHUNK%` 分支；存量 6 条随下次重启自然清除。**保留 ANCHOR 重建**（它有消费者：`MemoryRetriever` 通用检索）。口径依 D4 |
| **B** | 块级元数据载体 | 新建独立表 **`dialog_groups`**（见 §7）；配套存量 1297 组迁移 |
| **C** | 块钙分 ↔ 衰减率映射 | **不耦合**。衰减率由块的 `narrative_tag`/`primary_emotion` 推导（复用 P2-1）；`block_calcium_score` **仅用于检索权重与 `autoPromoteCandidatesV2` 晋升门槛** |
| **D** | 括号场景加分 | 加**区分度**：括号内容 **≥30 字符**才判有效场景描写计入加分（阈值配置化）；两三字语气括号不计分 |
| **E** | T1 超时封组 | **不新增第二套**。把 `chat.ts:2662` 的硬编码 `30*60*1000` 抽成配置项 `dg_idle_close_ms`；T2（短关窗续聊阈值）同样入 `MemoryConfig.compaction`，**同一处真源** |
| **F** | 大块注入 | **检索单元 = 块**（块内按 800 字切块索引，复用 `indexWorkChunks` 先例）；**注入单元 = 预算内摘取**，禁止整块灌入 prompt |
| **G1** | FeatureFlag | Phase 1 用 `enableDialogGroupMemory`（总开关）；Phase 2 另设 `enableLowCalciumBlockPrune`（激进修剪）。两者解耦 |
| **G2** | 工作量 | Phase 1 每批走 Harness S1→S7-B 十阶段；单元/集成/回归测试计入评估 |

---

## 四、分阶段落地

### Phase 1 · 保守模式（三批，各独立文件集 + 独立流水线 + 独立提交）

**P1-A · 地基（让「块」第一次物理存在）**

1. 新建 `dialog_groups` 表 + 索引（MigrationManager），**块级元数据唯一载体**
2. `dialog-group-stage.ts`：**删除 CHUNK 写入循环**（退役，A3；留 tombstone 注释说明依据）
3. `SQLiteAdapter._rebuildMemoryAnchors()`：DELETE 语句移除 `%_CHUNK%` 分支（已无生产者）；显式声明**不触碰 `dialog_groups`**；ANCHOR 重建保持不变
4. 存量 1297 组迁移脚本（回填元数据；`block_calcium_score` 可后台补算）
5. **新增「重启不变量」测试**（见 §6）

**P1-B · 闭组写入（块元数据落库）**

5. `src/app/memory/BlockValueScorer.ts`（新建）：确定性块钙分，收拢 §1.7 全部原料
6. `dialog-group-stage.ts`：写 `dialog_groups`（钙分 / `scene_anchor_hash` / `emotion_curve` / 闭合原因）；CHUNK 写入保留场景描写
7. `chat.ts` + `MemoryConfig.ts`：解除 10 轮硬封顶（→ 配置）；T1/T2 落地（修正 E）

**P1-C · 检索与组装**

8. `SearchIndexBuilder`：`source_type='dialog_group'` + 块内 800 字切块
9. `UnifiedSearchEngine`：`SOURCE_TYPES` 加 `dialog_group` + enrich 分支
10. L0 块级户籍过滤 / L4 `scene_anchor_hash` 去重 / RRF 权重入配置
11. `MemoryNarrativeAssembler`：分层注入（**原文块**保氛围 / **摘要块**做索引）+ 预算内摘取（修正 F）
12. `enableDialogGroupMemory` FeatureFlag

### Phase 2 · 灰度备选（视 Phase 1 实测数据）

`enableLowCalciumBlockPrune` 灰度：低钙块不再写主索引，保留兜底通道。**依然不碰 `conversations` 原文**，随时切回保守版。

### 观测指标（Phase 1 起采集）

低分块占比 / 常规检索误召回率 / 兜底召回命中次数 / token 均值与峰值 / 场景保留率 / 场景复读循环触发次数 / 时空错误（场景卡死、时序矛盾）次数 / 拼装痕迹人工评分(1–5)

---

## 五、涉及文件清单

| 批次 | 文件 |
|---|---|
| P1-A | `src/m2/SQLiteAdapter.ts`、`src/m2/MigrationManager.ts`、`src/webui/chat/dialog-group-stage.ts`、`scripts/migrate-dialog-groups.cjs`、`src/m2/__tests__/restart-invariant.test.ts`(新) |
| P1-B | `src/app/memory/BlockValueScorer.ts`(新)、`src/webui/chat/dialog-group-stage.ts`、`src/webui/chat.ts`、`src/config/MemoryConfig.ts`、对应 `__tests__` |
| P1-C | `src/m4/SearchIndexBuilder.ts`、`src/m4/UnifiedSearchEngine.ts`、`src/m4/narrative/MemoryNarrativeAssembler.ts`、`src/config/retrieval-fusion-config.ts`、`src/webui/chat/retrieval-stage.ts`、对应 `__tests__` |

> Sentinel 监控范围 = `src/ dist/ .claude/ mcp/ sentinel/ scripts/ hooks/ data/flows/`。上表 `scripts/` 与 `src/` 均在监控内 ⇒ 每批必须先 `harness_run_flow` 拿令牌再改。文档（`docs/`、根 `GOVERNANCE.md`）不在监控内。

---

## 六、验收判据

### 机械

- `npx tsc --noEmit` exit 0
- 相关目录 `vitest run` 全绿

### 🔴 新增：重启不变量测试（本次诊断的元教训）

本轮找出的坑 —— 锚点被销毁、碎片被销毁、roleplay 状态翻转 —— **全部发生在「服务启动」这条路径上**，而现有测试几乎不覆盖它。

> **测试形态**：写数据 → 调 `_rebuildMemoryAnchors()` → 断言**语义不变**。
> 至少锁三条：① `dialog_groups` 块级元数据仍在 ② `*_CHUNK*` 仍在 ③ `memory_kind` 与 `belong_entity_uuid` 不翻转。

### 定量（生产口径）

| 判据 | 现状 | 目标 |
|---|---|---|
| 单组平均轮数 | 2.4（57.6% 为 1 轮） | 显著上升（解除 10 轮封顶后） |
| 带场景描写比例（中期块） | 0.3%（memories 层） | **≥ 原文层水平** |
| 重启后块级元数据存活 | 0（无载体） | **100%** |
| CHUNK 冗余层 | 每次重启销毁（内容仍双份重复） | **已退役**（写入循环删除，全仓无残留） |
| roleplay 隔离重启翻转 | 会发生 | **不发生** |
| 会晤 `hist` vs `kb` | hist 7878 / kb 10092 | 维持 hist ≥ 存储预算约束（V35-C 已定） |

### 行为（业主验收）

- 连续 15+ 轮后问「我们前面说过的那件事的细节」→ 能答上
- 关窗 10 分钟内重开 → **不弹全新欢迎旁白**，场景续上
- 关窗长时间后重开 → 不卡在未完成动作
- 话题不因注入旧原文而漂移

---

## 七、Schema：`dialog_groups`

```sql
CREATE TABLE IF NOT EXISTS dialog_groups (
  dialog_group_id     TEXT PRIMARY KEY,               -- 与 conversations.dialog_group_id 同源
  belong_entity_uuid  TEXT NOT NULL,                  -- 户籍法：归属唯一真源；无户口不得写入
  narrative_tag       TEXT,                           -- 内容类别 → 推导衰减率（复用 P2-1，修正 C）
  primary_emotion     TEXT,
  block_calcium_score REAL NOT NULL DEFAULT 0,        -- 确定性规则聚合；仅权重 + 晋升门槛
  scene_anchor_hash   TEXT,                           -- 防复读指纹 + 块去重
  emotion_curve       TEXT,                           -- JSON：块内情绪序列
  block_close_reason  TEXT,                           -- idle_timeout|topic_switch|max_turn|meeting_exit|user_trigger
  block_summary       TEXT,                           -- 后台异步预生成（检索加速用，不替代原文）
  lifecycle_state     TEXT NOT NULL DEFAULT 'active', -- active|archived|suppressed
  is_landmark         INTEGER NOT NULL DEFAULT 0,     -- 人工永久标记，最高优先级
  turn_count          INTEGER NOT NULL DEFAULT 0,
  first_ts            TEXT,
  last_ts             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_dg_belong   ON dialog_groups(belong_entity_uuid);
CREATE INDEX IF NOT EXISTS idx_dg_state    ON dialog_groups(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_dg_landmark ON dialog_groups(is_landmark);
CREATE INDEX IF NOT EXISTS idx_dg_hash     ON dialog_groups(scene_anchor_hash);
```

**单一真源声明**：`dialog_groups` 是**块级元数据的唯一真源**；`conversations.dialog_group_id` 与 `memories.dialog_group_id` 只是外键引用，**不得重复存块级元数据**（防本仓「归属被丢两次」类双写不一致）。

**刻意不含的字段**：

- ~~`conversation_id`~~ —— 组是 1:N，单数外键语义错误；如需可用 `first_ts`/`turn_count` 表达
- ~~`virtual_world_ts`~~ —— **当前无生产者**（瑶光世界模型尚未接入，见 §1.7）。待 Phase 3 该项立项后再以迁移方式加入，**不预先建一个恒为 NULL 的字段**

---

## 八、FeatureFlag

| 开关 | 阶段 | 作用 |
|---|---|---|
| `enableDialogGroupMemory` | Phase 1 | 总开关。关 = 回退旧单碎片模式，随时可回滚 |
| `enableLowCalciumBlockPrune` | Phase 2 | 激进修剪（低钙块不写主索引）。与总开关解耦 |

---

## 九、风险矩阵与回滚

| 风险 | 对策 |
|---|---|
| 重启丢失块级元数据 | `dialog_groups` 独立表 + **重启不变量测试**锁死 |
| 破坏 P2-1 解耦设计 | 衰减率按块类别推导；钙分只做权重（修正 C） |
| 多套超时口径并存 | T1/T2 全部入 `MemoryConfig.compaction` 单一真源（修正 E） |
| prompt 字符溢出 | 检索单元=块 / 注入单元=预算内摘取（修正 F）+ 压力高时不注入 |
| 角色记忆跨域泄漏 | 块级 `belong_entity_uuid` fail-closed；走 `UUIDPoliceFilter`，禁手写 UUID SQL |
| 场景复读死循环 | `scene_anchor_hash` 指纹比对；重合场景只取事实、剔除动作描写 |
| 块存储与检索延迟上升 | 块摘要异步预计算；召回上限 2–3 块；Phase 2 可降级 |
| 测试数据污染生产库 | ⚠️ 本仓「memories 不隔离 test」⇒ 测试按**精确 rowid** 清理，禁止按时间窗；停服后再清理（sql.js 内存库会覆盖离线改库） |
| 改动面大、回滚难 | 三批独立提交；每批独立流水线；`enableDialogGroupMemory` 一键回退 |

---

## 十、系统不变量核对

| # | 不变量 | 本次核对 |
|---|---|---|
| 1 | 角色扮演时禁止向主 FG 写入 | ✅ 不涉及 FG 写入路径 |
| 2 | FG 真人绝不可被角色扮演 | ✅ 不涉及 |
| 3 | 分支数据隔离 | ✅ 块级 `belong_entity_uuid` 强隔离 |
| 4 | **状态单一 owner** | ✅ `dialog_groups` = 块元数据唯一 owner（§7 显式声明） |
| 5 | 公共 API 变更 = 契约+类型+Mock+测试同步 | ✅ 新建表/新模块同步测试（§6） |
| 6 | 禁止静默吞错误 | ✅ 块写入失败必须告警可追责（P-13 精神） |
| 7 | **禁止同一业务规则多处实现** | ✅ 本次正是在**消除**违规：判据收拢到 `BlockValueScorer`；roleplay 判据收敛到 UUID（D4） |
| 8 | UI 层不含业务逻辑 | ✅ 全部改动在 m2/m4/app/webui-chat 领域层 |
| — | 户籍法第五/六/七条 | ✅ 块级 fail-closed；无户口不得写入；`UUIDPoliceFilter` |

---

## 十一、留待后续（不在本 ADR 范围）

| 项 | 说明 |
|---|---|
| 瑶光虚拟世界时序（双时间轴） | 概念**当前不存在**（grep 0 命中，SceneMap 标注「后续对接」）。**先定位「隔天续聊卡在旧动作」的真实根因**（候选：旧轮次留窗口 / 场景状态未随块关闭重置 / 摘要带旧场景 / 重建锚点混入旧组对话行），根因支持才立项。**不得预先建 `virtual_world_ts` 字段** |
| 主动遗忘 / 记忆重写 | 未纳入 |
| L7 叙事重写的「有损」取舍 | 本次采用**分层**（原文块保氛围 / 摘要块做索引）规避；若后续要引入 LLM 叙事重写，须单独评估氛围损失 |

---

## 附：诊断证据

- 只读脚本：`D:/tmp/v36-storage-granularity-probe.cjs`、`v36-dialoggroup-probe.cjs`、`v36-probe3.cjs`、`v36-probe4.cjs`、`v36-probe5.cjs`
- 数据源：`data/webui/fusion_memory.db`（sql.js 载入内存只读，未回写）
