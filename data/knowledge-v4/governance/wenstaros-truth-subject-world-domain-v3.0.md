# WenStarOS 真值、主体与世界域专项规范 V3.0

> 文曲星·太虚境 —— 专项规范（记忆域为主体章节）
> 版本：**V3.0.0**
> 颁布日期：2026-11-02
> 适用范围：真值判定、主体标识、世界域划分、记忆体系（A/B 双链路）
> 关联：[太虚境户籍管理法](taixu-household-registration-law.md) · [UUID 户籍管理法](uuid-household-registration-law-v1.0.md) · [ADR-015](../../../docs/adr/ADR-015-20261102-AB双链路记忆架构与B链路卷宗化.md) · [ADR-010](../../../docs/adr/ADR-010-dialog-group-memory-unit.md) · [ADR-MEM-002](../../../docs/adr/ADR-MEM-002-20261026-MemSym双通路记忆共生协议.md) · [ADR-MEM-003](../../../docs/adr/ADR-MEM-003-20261102-记忆生命周期与受控遗忘.md)

---

## 〇 · 编制说明（必读，关乎本规范的效力范围）

### 0.1 V2.0 原文在仓内不存在

本规范由 T002 任务书 §Phase 5 第 2 项要求「《WenStarOS V2 真值、主体与世界域专项规范》→ V3.0」。

**实测：该 V2.0 文件在 `D:\tools\wenstar-cc` 全仓不存在任何实体副本** —— 只有 4 处文字引用
（`memory-system-reconstruction-roadmap.md`、`P0-记忆体系止血任务书-V3.md`、`agent-collab/00-README.md`、`T002`）。

⇒ 所谓「修订至 V3.0」在物理上无对象。**本文件是该规范的首个实体化版本**，不是对某份 V2 的改写。
V3.0 的版本号沿用 T002 的约定，**不代表仓内曾存在 V2.0 实体**。

### 0.2 编制原则：写我所做，不写我设想

T002 §四铁律 8：「法典 > ADR > 代码 > 改错记录，代码与法典冲突视为缺陷」。

但本规范是**事后追认**，因此遵守一条更严格的自律：

> **本规范只写代码里已经生效的行为。**
> 未落地的设想一律标注「未落地」并写明原因，**不得写成条文**。
> 条文若与实现不符，以本条为准 —— 先把实现改对、或先把条文改对，不允许长期并存。

### 0.3 与 T002 原文不符的三处（已登记）

| T002 原文要求 | 仓内实况 | 本规范处置 |
|---|---|---|
| **EventUUID 双向锚点** | `EventUUID` / `event_uuid` **全仓零实现、零生产者** | 不采纳。锚点为 `dialog_group_id`（组）+ `belong_entity_uuid`（户籍）。见 §4.3 |
| 钙化公式 `Score = αF + βS₄₀ᴰ + γT + δC` | 实际为确定性加分制（`BlockValueScorer`），无加权和公式 | 按实现重写。见 §4.4 |
| `MemoryHealthDaemon` 守护进程 | **全仓零命中** | 不新建。等效能力分散在三处，见 §4.5 |

---

## 第一章 · 真值（Truth）

### 1.1 世界真实性原则

> 太虚境内一切存在皆为真实存在，无伪装、无替身、无「假装」层。
> 出处：《太虚境户籍管理法》第四条（世界真实性原则 V2.0 新增）。

本条对记忆体系的直接约束：**记忆不是「模拟出来的相似内容」，是可追溯到具体发生记录的事实子集**。
一条记忆若无法追溯到 `conversations` 的某一行或某组的聚合，它就是编造，不是记忆。

### 1.2 真值的两个层级

| 层级 | 含义 | 载体 | 判定方式 |
|---|---|---|---|
| **第一层 · 事实真值** | 「确实发生过这句话」 | `conversations` 原文（含场景描写） | 内容哈希校验 |
| **第二层 · 表达真值** | 「这段回忆的表述没有新增事实要素」 | LLM 输出 | 要素集边界（ADR-MEM-002 / ADR-014） |

**两层不可混淆**：第一层由哈希保证，是**客观可校验**的；第二层由提示词与守卫保证，是**规则约束**的。
把第二层当第一层（以为守卫能保证回忆准确）或把第一层当第二层（以为有原文就不用管编造）都是错的。

### 1.3 不可逆事实的登记义务

以下写入一旦发生**永不再改**，任何需要修改的情况只能追加勘误记录：

- `conversations` 原文行（只增不删，ADR-010 D2）
- `content_hash` / `summary_hash` 的**算法口径**（改了必须全量重算，见 §4.2）
- `append_log` 的**既有条目**（只追加，永不修改）
- 审计变更账本（ADR-MEM-003 裁决②：永久只增不删，不入生命周期）

---

## 第二章 · 主体（Subject）

### 2.1 主体的唯一标识

主体（实体）的唯一法定标识 = **UUID**（内部）+ **TXS-ID**（对外编号，见户籍法第六条~第八条）。
UUID 一经登记不可变更；TXS-ID 的历史编号保留溯源链（户籍法第八条）。

### 2.2 户籍归属是结构事实

> **`belong_entity_uuid` 是数据归属的唯一真源，禁止按正文内容推断归属。**

依据：UUID 户籍管理法五大铁律 + 太虚户籍法第五条（分户治理）。
在记忆系统的具体落点：

- 写入侧：`persistence-stage` 在写入时确定户口（会晤模式强制 = 会晤实体 UUID）；
- 读取侧：检索的第一步是 UUID 过滤，**先过滤、后排序**；
- 禁止 reintroduce `OR belong_entity_uuid IS NULL` 逃生口。

### 2.3 会晤态的发言人 ≠ 户口

这是本仓最容易搞错的一处区分：

| 概念 | 含义 | 载体 |
|---|---|---|
| **户口**（归属） | 这条数据属于哪个主体的档案 | `belong_entity_uuid` |
| **发言人**（说话人） | 这句话是谁说的 | `conversations.belong_entity_uuid`（assistant 行）= 实际说话角色 |

会晤场景下，**用户发的消息其归属仍记为会晤实体**（这是户口），但**发言人是用户**。
因此 B 链路回放时，`role === 'user'` 的行一律显示为「用户」，不得按归属用户名 ——
否则会把用户自己说的话标成角色说的。

> 对应对照：`BArchiveReader.render()`；锁定测试：`b-archive-reader.test.ts`「role=user 显示为用户」例。

---

## 第三章 · 世界域（World Domain）

### 3.1 世界域的三种划分

| 域 | 判据 | 说明 |
|---|---|---|
| **空间域** | `GroupSession` 的席位（Seat）：在场 / 发言权 / 耳语目标 | 见《白皮书·空间路由器 v1》§4 七条不变量 |
| **时间域** | `timestamp` / `first_ts` / `last_ts` | 时间戳必须是现实时间，不得用虚拟世界时间（该概念当前无生产者） |
| **话题域** | `locus` / `locusPath`（如 `life.daily`） | 用于块衰减类别推导与检索主题路由 |

### 3.2 空间域对记忆的四条约束

1. **块内说话人**：`rounds` 必须带 `speakerUuid`，正文与摘要取真实说话人（P145 微调 6 / 批 C 落地）；
2. **块内听觉范围**：`rounds` 必须带 `audience`（`room` / `seat:<uuid>`）；
3. **耳语轮**：入块时保留 `audience` 标记，摘要生成时按标记处理 —— **不得把耳语当成当众对话写入卷宗摘要**；
4. **回放时的可见性**：`BArchiveReader.getByGroupId(id, {audienceUuid})` 按听众 UUID 过滤可见行；
   解析不出听众 ⇒ **不展开**（fail-closed，见 §4.2）。

### 3.3 时间域

`virtual_world_ts`（虚拟世界时序）**当前无生产者** —— 全仓 `virtualWorld`/`worldState`/`世界状态` 零命中，
`SceneMap.ts` 明写「客观物理世界空间（后续对接）」。

⇒ 本规范**不设**虚拟世界时间条款；`dialog_groups` **不建** `virtual_world_ts` 字段（ADR-010 §7 明确不预建恒为 NULL 的列）。

---

## 第四章 · 记忆体系接口规范

> 本章是 T002 §Phase 5 要求的 §4.1~§4.5 的实况版。
> 每节末尾标注 **「代码 / 测试」** 双锚点 —— T002 验收要求「每条法典条款对应代码模块和测试用例」。

### §4.0 · 基本原则

1. **记忆单元是对话组/语义块**，不是单条 message（ADR-010 D1）；
2. **归属是结构事实**，禁止按正文推断 UUID（§2.2）；
3. **原始事实只增不删**：`conversations` 原文永久保留；派生物（`memories` / 索引）可治理
   （ADR-010 D2 对「只增不删」的重新定义）；
4. **B 链路只允许单点读取**（§4.2），禁止全局检索；
5. **钙化是候选入场券，不是唯一排序键** —— 高钙化不能永久碾压近期记忆；
6. **两套钙分量纲永不互转**（§4.4）；
7. **所有数据库改动在停服窗口内执行**，执行前备份（sql.js 内存库会覆盖离线改库）；
8. **法典 > ADR > 代码 > 改错记录**：代码与法典冲突视为缺陷。

---

### §4.1 · A 链路定义（钙化心智）

**定位**：负责「记得什么」—— 压缩、加权、筛选后的语义沉淀。

| 维度 | 规定 |
|---|---|
| 存储内容 | `memories`（砂金，逐条语义 + 40D 感知向量）/ `vault_log`（金库，晋升流水）/ `black_diamond`（黑钻，长期结论） |
| 检索权限 | **允许全库检索**：关键词、向量相似、多路融合、钙分排序 |
| 向量规则 | 行级 `memories.perception_40d`，40 维（`PERCEPTION_40D_DIM = 40`），编码见 `PerceptionVector40DCodec` |
| 输出约束 | 注入时受 `MemoryInjector` 的记忆档判定与编造特征闸门约束；表达受 MemSym 三档协议约束 |
| 钙分 | `calcium_score` ∈ [0,1]，`θ_permanent = 0.85` |
| 与 B 链路的关系 | A 链路命中后可携带 `dialog_group_id` 指针 → 用户深度回忆时据此拉起 B 链路全文 |

**代码**：`src/m4/MemoryRetriever.ts` · `src/app/memory/` · `src/m2/math.ts (computeCalcium)`
**测试**：`src/m4/__tests__/` · `src/app/memory/__tests__/`

---

### §4.2 · B 链路定义（沉睡卷宗）

**定位**：负责「当时是怎么说的」—— 不可再造的原始档案。

#### 4.2.1 存储与单位

| 项 | 规定 |
|---|---|
| 卷宗单位 | **一个 `dialog_group_id` = 一卷** |
| 原文 | `conversations` 内 `dialog_group_id` 的全部行，**永久保留** |
| 卷宗元数据 | `dialog_groups` 表，**唯一真源**（`conversations.dialog_group_id` / `memories.dialog_group_id` 只是外键引用，不得重复存块级元数据） |

#### 4.2.2 读写约束（本条是最硬的一条）

| 操作 | 规定 |
|---|---|
| **允许** | `getByGroupId(groupId)` 单点读取；按 id 追加日志；按 id 计数 |
| **允许（例外）** | 带字面命中的倒排召回（需先过 UUID 过滤，再由检索层给出候选 id） |
| **禁止** | 无锚点全表扫描 `dialog_groups`；对卷宗做向量检索；按组遍历 |

**守卫是结构性的**：`BArchiveReader` 只暴露单点 API（无 `list`/`scan`/`search`）；
`assertAnchoredRead(sqlText)` 对任何缺 `dialog_group_id = ?` 的 `FROM dialog_groups` 语句直接抛错。

#### 4.2.3 卷宗化四项数据

| 列 | 内容 | 写入时机 | 可空 |
|---|---|---|---|
| `perception_40d_snapshot` | 组级 40D 聚合快照（JSON） | 后台幂等回填 | 否（无数据写 `agg:'none'` 占位） |
| `content_hash` | 原文 sha256 前 32 hex | 后台幂等回填 | 是（空组不伪造） |
| `summary_hash` | 摘要 sha256 前 32 hex | 摘要生成时 / 后台补填 | 是（空摘要写 NULL） |
| `append_log` | 只追加事件日志（JSON 数组） | 上述各动作发生时 | 是 |

**哈希口径（一经落地不可改）**：

```
content_hash = sha256( join(每行: seq_pos ␁ role ␁ content, 行间 ␂) )[0..32]
   · 排序：seq_pos ASC，同序再按 timestamp ASC
   · 只覆盖 conversations 原文，不含 block_summary
summary_hash = sha256(block_summary)[0..32]，空摘要 → NULL
```

🔴 **改口径 = 全量重算**。历史上任何一次口径变更都必须同时：① 全表置 NULL ② 后台重扫
③ 在 `append_log` 记 `erratum`。不得只改代码不改数据。

#### 4.2.4 生命周期与唤醒前置

- 三态：`active → consolidating → archived`；`archived` 在块路检索降权 0.5，**不删除原文**。
- **唤醒前置条件**（深度回忆要展开全文，必须全部满足）：
  1. 意图等级为 `detail` / `full`（`detectDetailLevel`）；
  2. 检索命中携带确定的 `dialog_group_id`；
  3. 会晤态下能解析出当前发言人 UUID —— **解析不出则不展开**（fail-closed）；
  4. 读出的卷宗非空且渲染非空。
- **失败一律静默回退**到截断正文，不阻断对话。

**代码**：`src/app/memory/BArchiveReader.ts` · `bArchiveHash.ts` · `bArchiveLog.ts` · `BlockArchiveService.ts` · `src/webui/chat/b-archive-recall.ts`
**测试**：`b-archive-reader.test.ts`（14 例）· `b-archive-guard.test.ts`（6 例）

---

### §4.3 · 统一向量与主键规范

#### 4.3.1 向量

| 项 | 规定 |
|---|---|
| 统一维度 | **40 维**（`PERCEPTION_40D_DIM`），量纲版本 `dim_version = 'v1'` |
| 物理存储 | `memories.perception_40d`（行级，TEXT 编码）；`dialog_groups.perception_40d_snapshot`（组级，JSON） |
| 编码 | `PerceptionVector40DCodec`（唯一编解码实现，产出 `PERCEPTION_40D_KEYS` 顺序的数组） |
| 量纲演进 | 升级必须在快照内带 `dim_version`；旧快照因自带版本号仍可自解释 |

> 历史层 `emotion_curve`（数组，非 40D）与 `perception_summary`（3 维）仍存在于部分旧数据中，
> **不属于 40D 体系**，不得当作 40D 使用。

#### 4.3.2 主键与锚点

| 锚点 | 作用 | 规定 |
|---|---|---|
| `belong_entity_uuid` | **户籍归属** | 结构事实，唯一真源，不可变 |
| `dialog_group_id` | **卷宗寻址键** | conversations ↔ dialog_groups ↔ memories 三方共享 |
| `event_uuid` | ~~双向事件锚点~~ | ❌ **未采纳**（T002 设想，仓内零实现）。理由：现有两键已构成完整锚点，新增第三套主键只会制造口径漂移 |

---

### §4.4 · 钙化打分公式（按实现）

#### 4.4.1 两套量纲，永不互转

| 量纲 | 载体 | 值域 | 门槛 | 用途 |
|---|---|---|---|---|
| **记忆钙分** | `memories.calcium_score` | `[0, 1]` | `θ_permanent = 0.85` | 晋升、召回增益 |
| **块钙分** | `dialog_groups.block_calcium_score` | `[0, 10]` | 高钙通道 `floor(5)`；召回归一 `/5` | 组级检索权重、独立通道准入 |

🔴 **禁止**比较、相加、换算。这是 P087「钙分双算」教训的直接延伸。

#### 4.4.2 记忆钙分（0~1）

```
score = ‖norm(p)‖₂ / √24                 // L2 归一化，24 维感知
score = min(1.0, score + 0.3 × surprise) // 可选：偏离情绪基线的惊讶度因子
level = 0 (<0.3) | 1 (<0.6) | 2 (<0.8) | 3 (≥0.8)
```

**代码**：`src/m2/math.ts :: computeCalcium`

#### 4.4.3 块钙分（0~10，确定性规则，零 LLM）

```
raw   = scene + emotion + commitment + turningPoint + degradedPenalty
score = clamp(raw, 0, 10)

scene           = sceneRatio × 2          // 有效场景描写轮次占比（括号内容 ≥ 30 字才算）
emotion         = min(1, range(curve)/0.5) × 2   // 情绪曲线极差
commitment      = 3 若命中 FEATURE_ROUND_RE，否则 0   // 不按命中次数累加
turningPoint    = 2 若 close_reason = 'topic_switch'，否则 0
degradedPenalty = −degradedRatio × 3      // 问答双方都退化才算退化轮
```

**为什么是确定性规则而非 LLM 打分**：
① 后台路径引入 LLM 违反「Harness 零 LLM 监控」铁律；
② **不可复现的判据 × 不可逆的持久化决策 = 结构性风险**（同一块今天 3 分明天 5 分，检索池随机漂移且不可归因）。
LLM 至多允许**单向增强**（只能捞回被低判的块，无权剔除被高判的块）。

**代码**：`src/app/memory/BlockValueScorer.ts`（判据唯一实现处）
**测试**：`src/app/memory/__tests__/block-value-scorer.test.ts`

#### 4.4.4 衰减与钙分刻意解耦

衰减速率由**内容类别**（`narrative_tag` / `decayClass`）推导，**不由钙分决定**。
依据：`MemoryConfig.ts` P2-1 注释「calcium_score 仅用于晋升门槛和召回优先级，衰减速率按内容类别独立控制」。

块层衰减类别判据（顺序即优先级）：`emotional > relational > work > neutral`，
用感知维**峰值**而非均值 —— 一段相处里最动人的那一刻决定这段记多久。

---

### §4.5 · 记忆健康与自愈（按实现）

T002 设想的独立 `MemoryHealthDaemon` 进程**未实现，且本规范不要求实现**。
现有等效能力分布在三层，各司其职：

| 层 | 机制 | 管什么 | 代码/文档 |
|---|---|---|---|
| 文件层 | Harness Sentinel | 未授权写入、静默回滚、单实例锁 | `D:\AI文件\harness\` |
| 治理层 | 系统健康守卫 | 完整性守护项、告警定级 | `system-health-guard.md` |
| 数据层 | 归档服务完整性校验 | `content_hash` / `summary_hash` 不匹配 ⇒ 标记「疑似篡改」 | `BArchiveReader` |

#### 4.5.1 自愈契约

| 项 | 规定 |
|---|---|
| **可自愈** | 缺 `content_hash` / 缺 `perception_40d_snapshot` / 有摘要无 `summary_hash` —— 后台幂等回填，进程重启自动续跑 |
| **不可自愈** | 哈希与实际内容不匹配（疑似篡改或有外来写入） —— **只告警，不自动重算**。自动重算等于把篡改洗白 |
| **回填幂等** | 扫描条件即进度（`WHERE content_hash IS NULL OR ...`），任何时刻中断重跑结果一致 |
| **不伪造** | 无数据的组写显式占位或留 NULL，**不得填假值凑齐率** |

#### 4.5.2 审计留痕

所有回填/生成/唤醒/计数动作写入 `dialog_groups.append_log`：
`{ts, type, actor, detail}`，`type ∈ {snapshot_created, content_hashed, summary_generated, summary_regenerated, calcium_promoted, lifecycle_changed, awakened, consumer_counted, erratum}`。

**只追加，永不修改既有条目**；超水位只告警、**不裁剪**（裁剪即违反「不可逆事实登记义务」§1.3）。

**代码**：`src/app/memory/bArchiveLog.ts` · `BlockArchiveService.ts`

---

## 第五章 · 条款—代码—测试对照表

| 条款 | 代码模块 | 测试 |
|---|---|---|
| §4.0-3 原文只增不删 | ADR-010 D2 策略表 | — （策略层，无代码守卫） |
| §4.1 A 链路 | `m4/MemoryRetriever.ts`、`m2/math.ts` | `m4/__tests__/` |
| §4.2-2 单点读取守卫 | `BArchiveReader.assertAnchoredRead` | `b-archive-guard.test.ts` |
| §4.2-3 哈希口径 | `bArchiveHash.ts` | `b-archive-reader.test.ts` |
| §4.2-3 日志只追加 | `bArchiveLog.ts` | `b-archive-reader.test.ts` |
| §4.2-4 深度回忆 fail-closed | `b-archive-recall.ts`、`retrieval-stage.ts` | `b-archive-guard.test.ts` |
| §4.3-1 40D 维与编码 | `PerceptionVector40DCodec`、`m3/types/perception-40d.ts` | 编码器单测 |
| §4.4-1 量纲永不互转 | `BlockValueScorer` 注释与实现 | `block-value-scorer.test.ts` |
| §4.4-3 块钙分 | `BlockValueScorer.ts` | 同上 |
| §4.5-1 回填幂等 | `BlockArchiveService.runBatch` | 集成实测（生产 100/100） |

> **未覆盖项如实标注**：§4.0-3（原文只增不删）目前是**策略承诺**，没有代码级守卫去阻止
> `DELETE FROM conversations`。这是一个**已知缺口**，不是已完成的能力。

---

## 第六章 · 版本与修订

| 版本 | 日期 | 变更 |
|---|---|---|
| **V3.0.0** | 2026-11-02 | 首个实体化版本。§4.1~§4.5 按 P145 批 A/B/C 落地实况编写；登记与 T002 不符的三处（EventUUID / 加权公式 / HealthDaemon）；新增 §2.3 户口与发言人区分、§3 世界域 |

**修订流程**（与《记忆系统运维审计规范》一致）：
提案 → 关联 ADR → 业主评审 → 版本升级 → 代码对齐 → 合规巡检。

**法典与代码冲突的处理**：
- 代码不符合法典 ⇒ 按缺陷修复；
- 法典落后于代码 ⇒ 启动修订，**修订期间不得以「法典还没改」为由继续跑偏**。
