# MemArch v2 — 记忆系统完整架构设计方案

> **版本**: **v2.0.0-Baseline**
> **日期**: 2026-11-03
> **定位**: 新一代记忆系统架构，取代现有 M2/M4/Vault 旧架构
> **状态**: ✅ 基线已锁定，待业主签字确认后拆分任务书
>
> ---
> **🔒 基线快照信息（所有任务书溯源绑定）**
> - **基线版本号**: MemArch-v2.0.0-Baseline
> - **MD5 哈希**: `C3DCBFC83B96EBE88D06D230F26CF503`
> - **锁定时间**: 2026-11-03
> - **变更规则**: 任何需求变更必须走【变更单】，禁止口头修改；变更后重新计算哈希并升版本号
> - **所有 6 份任务书必须标注：基于基线版本 MemArch-v2.0.0-Baseline (MD5: C3DCBFC8...)**
> ---

---

## 〇、设计总纲

### 0.1 设计目标

1. **只存值得记住的东西**：编码有门控，存储可遗忘，存储量随时间亚线性增长。
2. **记得牢的是重要的，不是常被系统翻出来的**：强化必须由用户的真实回应驱动。
3. **不编往事**：每一句回忆都必须有证据，标签由证据类型决定。
4. **变化可追踪**：事实会过时（搬家、换工作），旧事实失效但不覆盖。
5. **可回滚、可审计、可关闭**：所有破坏性操作有墓碑期、配额、账本和总开关。

### 0.2 八条设计原则

| # | 原则 | 落地含义 |
|---|---|---|
| P1 | 原文先落盘，痕迹后建立 | 写入顺序固定：L1 → L0 → L3，崩溃不丢原文 |
| P2 | 两个分数，永不互转 | 只保留 consolidation ∈ [0,1] 和 activation（对数尺度） |
| P3 | 永生必须经历时间 | 编码时巩固度上限 0.6，进入永生层必须跨过多个睡眠周期 |
| P4 | 晋升只用"且"，不用"或" | 不允许单一信号（召回次数、关键词）通往永生 |
| P5 | 重活离线做 | LLM 打分、萃取、合并、遗忘都放在睡眠流水线 |
| P6 | 标签由证据决定 | 「记得 / 印象 / 线索」由检索到的证据类型决定，不由模型自评 |
| P7 | 遗忘不带价值评判 | 只由巩固度、提取历史、唤醒度驱动，与内容类别无关 |
| P8 | 用户主权优先 | 用户可以要求"别再提"（抑制）或"忘掉"（删除），优先级高于系统规则 |

### 0.3 理论 → 机制映射

| 理论 / 研究 | 核心观点 | 本设计中的机制 |
|---|---|---|
| 互补学习系统 CLS（McClelland 1995；Kumaran 2016） | 海马快速记情节，新皮层慢速学语义 | L3 痕迹快写，L4 语义慢慢萃取 |
| 海马索引理论（Teyler & DiScenna） | 海马存的是"指向皮层内容的索引" | L3 痕迹 + 实体图，作为检索入口 |
| 事件分割理论（Zacks 2007） | 人按事件边界切分经验 | 对话切分成 episode |
| 预测误差驱动编码 | 意外的内容更容易被记住 | 显著性中的新颖度因子 |
| 自我参照效应 | 和自己相关的内容记得更牢 | 显著性中的自我相关因子 |
| 杏仁核调制 | 高唤醒增强巩固，效价不直接决定 | 只用 arousal，不用 valence |
| ACT-R 基础激活（Anderson） | 记忆可提取性随使用历史按幂律衰减 | activation：同时用作检索先验和遗忘判据 |
| 间隔效应（Cepeda 2006；Pavlik & Anderson 2005） | 分散提取比集中提取更牢 | 间隔增益函数 g(Δ)、"不同日期召回数" |
| 突触标记与捕获 STC（Frey & Morris 1997） | 强事件附近的弱记忆会被顺带巩固 | 睡眠期"行为标记"步骤 |
| 优先回放（海马 replay） | 睡眠中优先回放重要经历 | 睡眠期按优先级选回放集 |
| 再巩固（Nader 2000） | 提取后的记忆会暂时可修改 | 用户纠正时生成新版本，旧版失效 |
| 提取诱发遗忘 / 主动抑制（Anderson） | 人可以主动压制某段记忆 | suppressed 作为检索抑制标志 |
| 自我定义记忆（Singer & Salovey 1993） | 生动、情绪强、反复回想、与人生主题相关 | 黑钻准入的五维评分 |
| 前瞻记忆 | 记得将来要做的事 | 独立的承诺 / 约定表 |
| 习惯化 | 重复刺激的反应会下降 | 通路 B 曝光惩罚，防止反复用同一元素 |

**工程参考**：Generative Agents（相关性/重要性/近因三因子）、Letta/MemGPT（sleep-time compute）、HippoRAG（实体图 + PPR）、Zep/Graphiti（双时态知识图谱）、A-MEM（卡片互链）。

---

## 一、总体架构

### 1.1 四个平面

```
┌──────────────────────────── 治理面 Governance ────────────────────────────┐
│ 命名空间隔离 · 敏感度/加密 · 用户遗忘权 · 哈希链审计账本 · 总开关 · 配额     │
└───────────────────────────────────────────────────────────────────────────┘
        │                       │                          │
┌───────▼────────┐   ┌──────────▼──────────┐   ┌───────────▼───────────┐
│ 在线编码面      │   │ 离线巩固面（睡眠）    │   │ 检索面                 │
│ L1 原文落盘     │──▶│ 事件封口 · 复评       │   │ 查询理解 → 多路召回     │
│ L0 工作记忆 WAL │   │ STC 标记 · 合并       │   │ → 折叠 → RRF → 重排     │
│ 事件分割        │   │ 语义萃取 · 冲突消解    │   │ → 先验 → MMR → 打包     │
│ 显著性三岔门控  │   │ 晋升 · 生命周期推进    │   │ → MemSym 呈现 → 守卫    │
│ L3 痕迹写入     │   │ 墓碑清理 · 索引重建    │   │ → 强化归因回写          │
└────────────────┘   └─────────────────────┘   └───────────────────────┘
        │                       │                          │
┌───────▼───────────────────────▼──────────────────────────▼───────────────┐
│ 存储：L1 原文 | L2 事件 | L3 痕迹 | L4 语义/图谱 | L5 黑钻指针 | 前瞻记忆      │
│ 索引：FTS5（全文）| 语义向量 | 情感 40D 向量 | 实体图                         │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.2 存储分层

| 层 | 名称 | 表 | 内容 | 生命周期 | 对应 ADR |
|---|---|---|---|---|---|
| L0 | 工作记忆 | wm_buffer（持久化） | 待门控的编码条目 | 分钟级，门控后清除 | — |
| L1 | 砂金·原文 | conversations | 逐条消息原文 | 低钙且无锚点的组可遗忘 | B 层 |
| L2 | 砂金·事件 | episodes | 事件边界、要点、情绪曲线、参与者 | 跟随锚点，要点长于原文 | B 层 / A 层 |
| L3 | 金库·痕迹 | memories | 语义片段、双向量、实体边、激活历史 | 遗忘状态机 | B 层，巩固后进 A 层 |
| L4 | 语义·自我 | semantic_facts + FG/dossier/KB | 结论、偏好、关系、人设 | 永生，可失效，不删除 | A 层 |
| L5 | 黑钻 | black_diamond_v2 | 只存指针 + 固化元数据 | 永生 | A 层 |
| 横切 | 前瞻记忆 | prospective_items | 约定、承诺、提醒 | 完成或过期后归档 | 新增 |

**横切属性（不再算作层）**：
- `is_landmark`：地标，任何层都可以有；
- `lifecycle_state`：生命周期状态；
- `suppressed`：抑制标志，即"别再主动提"，不删除；
- `sensitivity`：敏感度 0/1/2；
- `namespace`：default / test / roleplay。

### 1.3 双向量说明

现有 40D 向量是情感/感知向量，不是文本语义向量。两者用途不同：

| 向量 | 维度 | 用途 |
|---|---|---|
| 语义向量 | 512–1024 维（bge-small-zh-v1.5 / bge-m3） | "内容相关"的检索 |
| 情感向量 | 40D（沿用现有） | 通路 B 的情绪契合度 fitScore、情绪相似检索 |

---

## 二、数据模型

### 2.1 L1 原文：conversations 改造

```sql
ALTER TABLE conversations ADD COLUMN ts_utc INTEGER;            -- 唯一时间口径
ALTER TABLE conversations ADD COLUMN episode_id TEXT;
ALTER TABLE conversations ADD COLUMN lifecycle_state TEXT DEFAULT 'fresh';
ALTER TABLE conversations ADD COLUMN sensitivity INTEGER DEFAULT 0;

CREATE INDEX idx_conv_episode ON conversations(episode_id);
CREATE INDEX idx_conv_ts ON conversations(ts_utc);
```

### 2.2 L2 事件：episodes（新建）

```sql
CREATE TABLE episodes (
  id               TEXT PRIMARY KEY,
  namespace        TEXT NOT NULL DEFAULT 'default',
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  status           TEXT NOT NULL DEFAULT 'open',      -- open / sealed
  gist             TEXT,                               -- 要点（睡眠期生成，可迭代）
  gist_version     INTEGER DEFAULT 0,
  participants     TEXT,                               -- JSON: entity uuid[]
  arousal_peak     REAL,
  valence_mean     REAL,                              -- 只做标签
  affect_curve     TEXT,                               -- JSON: [[ts, a, v], ...]
  salience         REAL,
  consolidation    REAL DEFAULT 0,
  is_landmark      INTEGER DEFAULT 0,
  lifecycle_state  TEXT DEFAULT 'fresh',
  anchor_exempt    INTEGER DEFAULT 0,                 -- 含 A 层锚点 → 整组豁免
  raw_available    INTEGER DEFAULT 1,                 -- 原文是否还在（决定能否说"记得"）
  suppressed       INTEGER DEFAULT 0,
  sensitivity      INTEGER DEFAULT 0,
  dna_root_id      TEXT
);
```

### 2.3 L3 痕迹：memories 扩展列

```sql
ALTER TABLE memories ADD COLUMN consolidation REAL DEFAULT 0;     -- 取代 calcium_score 三量纲
ALTER TABLE memories ADD COLUMN n_refs INTEGER DEFAULT 1;          -- 编码 + 有效强化总次数
ALTER TABLE memories ADD COLUMN first_ref_at INTEGER;
ALTER TABLE memories ADD COLUMN recent_refs TEXT;                  -- JSON: 最近 k=5 次强化时间
ALTER TABLE memories ADD COLUMN last_reinforced_at INTEGER;
ALTER TABLE memories ADD COLUMN distinct_recall_days INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recall_day TEXT;              -- 'YYYY-MM-DD'（本地日）
ALTER TABLE memories ADD COLUMN sleep_cycles_survived INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN salience REAL;
ALTER TABLE memories ADD COLUMN importance REAL;                   -- LLM 打分归一 [0,1]
ALTER TABLE memories ADD COLUMN arousal REAL;
ALTER TABLE memories ADD COLUMN novelty REAL;
ALTER TABLE memories ADD COLUMN self_relevance REAL;
ALTER TABLE memories ADD COLUMN activation_cache REAL;             -- 睡眠期刷新
ALTER TABLE memories ADD COLUMN lifecycle_changed_at INTEGER;
ALTER TABLE memories ADD COLUMN episode_id TEXT;
ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN supersedes_id TEXT;                -- 再巩固新版本指向旧版本
ALTER TABLE memories ADD COLUMN suppressed INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN sensitivity INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN exposures_7d INTEGER DEFAULT 0;    -- 通路 B 习惯化
ALTER TABLE memories ADD COLUMN calcium_legacy REAL;               -- 迁移前原值，只读留档
```

### 2.4 L4 双时态语义事实（新建）

```sql
CREATE TABLE semantic_facts (
  id              TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,        -- fg / dossier / kb / relation / preference
  subject_uuid    TEXT NOT NULL,
  predicate       TEXT NOT NULL,        -- 规范化谓词：lives_in / likes / works_at ...
  object_text     TEXT,
  object_uuid     TEXT,
  valid_from      INTEGER,              -- 世界时间：事实何时开始为真
  valid_to        INTEGER,              -- 世界时间：何时不再为真（NULL = 仍然为真）
  recorded_at      INTEGER NOT NULL,     -- 系统时间：何时得知
  invalidated_at  INTEGER,              -- 系统时间：何时判定失效
  superseded_by   TEXT,
  confidence       REAL DEFAULT 0.7,
  source_ids      TEXT NOT NULL,        -- JSON: 来源 trace/episode id（溯源链）
  sensitivity     INTEGER DEFAULT 0
);

CREATE INDEX idx_fact_subj ON semantic_facts(subject_uuid, predicate, valid_to);
```

### 2.5 实体图（供 PPR 检索）

```sql
CREATE TABLE entity_edges (
  src_uuid TEXT, dst_uuid TEXT, rel TEXT, weight REAL DEFAULT 1.0,
  trace_id TEXT, updated_at INTEGER,
  PRIMARY KEY (src_uuid, dst_uuid, rel, trace_id)
);

CREATE TABLE trace_entities (trace_id TEXT, entity_uuid TEXT, PRIMARY KEY (trace_id, entity_uuid));
```

### 2.6 L5 黑钻（指针化）

```sql
CREATE TABLE black_diamond_v2 (
  id              TEXT PRIMARY KEY,
  ref_type        TEXT NOT NULL CHECK (ref_type IN ('episode','trace','fact')),
  ref_id          TEXT NOT NULL,
  title           TEXT,                      -- 展示用短标题，不承载内容
  entry_channel   TEXT NOT NULL,            -- auto / manual / user_confirmed
  entry_reason    TEXT,
  self_defining   REAL,                     -- 自我定义度评分
  user_confirmed  INTEGER DEFAULT 0,
  snapshot_hash   TEXT,                      -- 引用内容的哈希，防止被静默篡改
  status          TEXT DEFAULT 'active',    -- active / revoked
  created_at       INTEGER NOT NULL
);
```

旧的 `black_diamond` 表保留为只读，迁移完成后通过视图兼容。

### 2.7 前瞻记忆、墓碑、遗忘请求

```sql
CREATE TABLE prospective_items (
  id TEXT PRIMARY KEY, kind TEXT,           -- promise / reminder / plan / anniversary
  content TEXT, owner TEXT,                  -- user / assistant（谁承诺的）
  trigger_type TEXT,                         -- time / event / entity
  due_at INTEGER, trigger_entity TEXT,
  status TEXT DEFAULT 'pending',            -- pending / fired / done / expired / cancelled
  source_id TEXT, created_at INTEGER
);

CREATE TABLE tombstones (
  id TEXT PRIMARY KEY, target_type TEXT, deleted_at INTEGER NOT NULL,
  reason TEXT NOT NULL,                     -- decay / user_request / merge / test_cleanup
  dna_root_id TEXT, consolidation REAL, last_recall INTEGER,
  content_hash TEXT, purge_after INTEGER NOT NULL
);

CREATE TABLE forget_requests (
  id TEXT PRIMARY KEY, mode TEXT,           -- suppress（别再提）/ forget（忘掉）
  query TEXT, matched_ids TEXT, confirmed INTEGER, created_at INTEGER, executed_at INTEGER
);
```

### 2.8 审计账本（哈希链，永久只追加）

```sql
CREATE TABLE audit_ledger (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc        INTEGER NOT NULL,
  actor        TEXT NOT NULL,           -- system / sleep_run:<id> / user / owner
  action       TEXT NOT NULL,           -- promote / tombstone / purge / restore / migrate ...
  target_type  TEXT, target_id TEXT,
  meta         TEXT,                     -- JSON：只放元数据，绝不放内容原文
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL            -- sha256(prev_hash || 本行规范化序列)
);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON audit_ledger BEGIN
  SELECT RAISE(ABORT,'append-only');
END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON audit_ledger BEGIN
  SELECT RAISE(ABORT,'append-only');
END;
```

账本只记元数据（id、内容哈希、原因），不记原文。这样"账本永久"和"用户要求忘掉"不冲突：内容被物理删除后，账本里只剩"某个 id 在某时因用户请求被删除"。

### 2.9 运行与遥测

```sql
CREATE TABLE sleep_runs (
  id TEXT PRIMARY KEY, cycle_no INTEGER, started_at INTEGER, finished_at INTEGER,
  current_step TEXT, checkpoint TEXT, status TEXT, stats TEXT
);

CREATE TABLE reinforcement_events (       -- 遥测，不属于治理账本，滚动保留 180 天
  trace_id TEXT, ts_utc INTEGER, path TEXT, signal TEXT, delta_c REAL
);
```

### 2.10 索引

- **全文**：SQLite FTS5，外部内容表绑定 conversations 和 episodes.gist。中文分词有两种选择：
  - 内置 trigram：SQLite 3.34+ 自带，零依赖；但查询词少于 3 个字时无法匹配
  - 推荐 simple 扩展（wangfenjin/simple，支持 jieba 分词）
- **向量**：sqlite-vec 的 vec0 虚表，语义向量和情感向量各建一张。

> ⚠️ **sql.js 迁移提示**：代码里的 `stmt.step()` / `getAsObject()` 是 sql.js 风格。sql.js 是 WASM 内存库，持久化要整库导出，不支持 WAL，也不方便加载 sqlite-vec 和分词扩展。如果确实在用 sql.js，建议在 P0/P1 阶段评估迁移到 better-sqlite3 或 node:sqlite。这是本设计里很多能力的前提。

---

## 三、核心度量与公式

全系统只保留两个核心变量，对应 ADR"两套量纲永不互转"的红线。

### 3.1 巩固度 consolidation ∈ [0,1]

**含义**：这条记忆被巩固了多少、值不值得长期沉淀。它取代 calcium_score 的三种量纲。

**初值**：编码时由显著性 S 决定，并设上限（原则 P3）：

```
c₀ = κ · S,    κ = 0.6
```

**更新**：每次有效强化后按渐近公式增长，并乘上间隔增益：

```
c ← c + η_src · g(Δ) · (1 - c)
g(Δ) = 1 - e^(-Δ / Δ₀),    Δ₀ = 1 天
```

其中 Δ 是距上一次强化的时间。g(Δ) 就是间隔效应：1 小时后再提取，g ≈ 0.04；1 天后约 0.63；3 天后约 0.95。同一天内反复提取几乎不加分。

| 强化来源 | η | 触发条件 |
|---|---|---|
| 通路 A（回溯）+ 用户确认 | 0.15 | 用户说"对""是啊"或补充细节 |
| 通路 A + 用户接话 | 0.09 | 用户沿话题继续 |
| 通路 B（浸润）+ 用户正向回应 | 0.03 | 冷却 24h，每日上限 |
| 睡眠回放 | 0.02 | 每个睡眠周期最多一次 |
| STC 行为标记 | 0.01–0.04 | 邻近高唤醒事件，按时间距离衰减 |

**标定**：从 c = 0.3 起，靠间隔充分的通路 A 确认召回到达 0.85，需要满足：

```
0.7 × 0.85ⁿ ≤ 0.15  ⇒  n ≥ 10
```

也就是说，大约要 10 次分散在不同日子、且被用户确认的回忆才能达到永生门槛。这与"高被关注 ≠ 自动永生"一致。

### 3.2 激活度 activation（ACT-R 基础激活）

**含义**：这条记忆此刻有多容易被想起。它取代 strength(t)、7 天线性近因和 effective_strength 三套衰减。

```
B_i(t) = ln( Σⱼ₌₁ⁿ (t - tⱼ)^(-d) ),    d = 0.5
```

**O(1) 存储近似**（Petrov 2006 混合近似）：只保存最近 k = 5 次强化时间、总次数 n 和首次时间。时间单位为天，最小年龄截断为 1 小时。

```
Σ ≈ Σⱼ₌₁ᵏ aⱼ^(-d) + (n - k) · (aₙ^(1-d) - aₖ^(1-d)) / ((1-d)(aₙ - aₖ))
```

**总激活度**：

```
A_i = B_i(t) + w_c · c_i + w_a · arousal_i,    w_c = 1.0,  w_a = 0.5
```

**遗忘判据**（二者满足其一即进入 expiring）：
1. `A_i < θ_forget`，基线 `θ_forget = -1.5`；
2. 最后一次强化距今超过 `τ_max = 365` 天，且 `c < 0.85`（保留 ADR 的封顶语义）。

**标定**：只编码一次、从未被提取的记忆，进入 expiring 的时间有解析解：

```
t* = exp( (w_c · c + w_a · a - θ_forget) / d )
```

| 场景 | c | arousal | 进入 expiring 约需 |
|---|---|---|---|
| 平淡寒暄的残余 | 0.1 | 0.1 | 27 天 |
| 普通日常 | 0.3 | 0.3 | 49 天 |
| 情绪较强的事件 | 0.5 | 0.8 | 122 天 |
| 接近巩固的重要事件 | 0.7 | 0.9 | 200 天 |
| 多次被提及但未达标 | — | — | 由 τ_max 封顶在 365 天 |

普通日常约 49 天，比 ADR 的 τ₀ = 30 天略长。整体曲线是幂律长尾，比指数衰减更接近人类数据（Wixted & Ebbesen 1991）。

```typescript
const DAY = 86_400_000;

export interface RefHistory {
  nRefs: number;
  firstRefAt: number;
  recentRefs: number[];
}

export function baseLevel(nowMs: number, h: RefHistory, d = CFG.act.d): number {
  const minAge = CFG.act.minAgeDays;                       // 1/24
  const ages = h.recentRefs
    .map(t => Math.max((nowMs - t) / DAY, minAge))
    .sort((a, b) => a - b);

  let sum = ages.reduce((s, a) => s + Math.pow(a, -d), 0);
  const k = ages.length;

  if (h.nRefs > k && k > 0) {
    const an = Math.max((nowMs - h.firstRefAt) / DAY, minAge);
    const ak = ages[k - 1];
    if (an > ak) {
      sum += (h.nRefs - k) * (Math.pow(an, 1 - d) - Math.pow(ak, 1 - d)) / ((1 - d) * (an - ak));
    }
  }

  return Math.log(Math.max(sum, 1e-12));
}

export function activation(nowMs: number, m: TraceRow): number {
  return baseLevel(nowMs, m) + CFG.act.wC * m.consolidation + CFG.act.wA * (m.arousal ?? 0);
}
```

### 3.3 显著性 salience ∈ [0,1]（编码门控用）

```
S = 0.30 · imp + 0.25 · self + 0.20 · arousal + 0.15 · nov + 0.10 · ent
```

| 因子 | 在线（快速） | 睡眠期（精确） |
|---|---|---|
| imp 重要度 | 规则启发：是否包含计划、决定、首次、身体或情绪事件 | LLM 打 1–10 分并归一，缓存 |
| self 自我相关 | 是否出现第一人称经历、关系词 | 与 dossier 核心主题的语义相似度 |
| arousal 唤醒度 | 沿用 PerceptionState 的 VAD 输出 | 同左 |
| nov 新颖度 | 1 - max cos(e⃗, 近30天痕迹) | 同左，全库 ANN |
| ent 实体 | 沿用 hasMeaningfulEntity | 实体链接后确认 |

### 3.4 自我定义度 self_defining ∈ [0,1]（黑钻准入用）

依据 Singer & Salovey 的自我定义记忆五特征：

```
SD = 0.20 · viv + 0.25 · aff + 0.20 · rep + 0.15 · link + 0.20 · theme
```

| 维度 | 计算 |
|---|---|
| viv 生动性 | 细节丰富度：实体数、感官词、时间地点完整度 |
| aff 情感强度 | arousal 峰值 |
| rep 反复回想 | min(1, distinct_recall_days / 8) |
| link 关联度 | 实体图中关联痕迹数的对数归一 |
| theme 人生主题 | 与 dossier 核心信条、关系主线的相似度 |

### 3.5 尺度规则

| 变量 | 范围 | 可用于 | 禁止 |
|---|---|---|---|
| consolidation | [0,1] | 晋升、检索增益、遗忘修正 | 换算成激活度 |
| activation | 对数尺度，约 [-6, 3] | 检索先验（经 sigmoid）、遗忘判据 | 写回巩固度 |
| salience | [0,1] | 编码门控、c₀ | 编码之后再用于晋升 |
| self_defining | [0,1] | 黑钻准入 | 遗忘判据 |

---

## 四、在线写入路径

在线链路只做轻量计算，目标耗时 ≤ 30ms（不含异步向量化）。

### 4.1 时序

```
① 消息到达
② L1 原文同步落盘（conversations，带 ts_utc / namespace / episode_id）   ← 永远第一步
③ L0 编码：DNA / 感知 24D→40D / 实体 / 在线显著性
④ 写入 wm_buffer（持久化，崩溃可恢复）
⑤ 事件分割器：判断是否切分 episode（切分则把旧 episode 标记为待封口）
⑥ 三岔门控：
     WRITE    → 写 L3 痕迹（c₀ = 0.6·S），异步生成语义向量
     RAW_ONLY → 不建痕迹，挂在 episode 上，等睡眠期复评
     DISCARD  → 不建痕迹（原文仍在 L1）
⑦ 前瞻记忆抽取：识别"答应 / 提醒 / 下周 / 纪念日"等，写入 prospective_items
⑧ 重要度累计：同一 episode 累计 S 超过阈值 → 触发一次在线微反思（可选）
```

### 4.2 事件分割器

边界分数综合四个信号：

```
E_t = 0.4 · (1 - cos(e⃗ₜ, ē_win))
    + 0.25 · min(1, gap / 30min)
    + 0.2 · |Δa|
    + 0.15 · cue
```

- `ē_win`：最近 3 轮的语义向量均值；
- `cue`：显式转场词，例如"对了""换个话题""说起来"；
- E ≥ 0.55，或者间隔超过 2 小时，或者 episode 超过 40 轮，就切分。

```typescript
export function isBoundary(prev: TurnFeat[], cur: TurnFeat): boolean {
  if (!prev.length) return true;

  const gapMin = (cur.ts - prev[prev.length - 1].ts) / 60_000;
  if (gapMin > CFG.seg.hardGapMin || prev.length >= CFG.seg.maxTurns) return true;

  const win = meanVec(prev.slice(-3).map(p => p.emb));
  const E = 0.4 * (1 - cosine(cur.emb, win))
          + 0.25 * Math.min(1, gapMin / 30)
          + 0.2 * Math.abs(cur.arousal - prev[prev.length - 1].arousal)
          + 0.15 * (hasTransitionCue(cur.text) ? 1 : 0);

  return E >= CFG.seg.threshold;
}
```

### 4.3 工作记忆缓冲（重写版）

修复了旧版的强制毕业、并发重入和崩溃丢失问题：

```typescript
type Gate = 'WRITE' | 'RAW_ONLY' | 'DISCARD';

export class WorkingMemory {
  private flushing = false;

  constructor(private db: Db, private writer: TraceWriter) {}

  /** 进程启动时先恢复未处理条目 */
  async recover() {
    const rows = this.db.all(`SELECT * FROM wm_buffer WHERE status='pending'`);
    for (const r of rows) await this.process(JSON.parse(r.payload), r.id);
  }

  async push(entry: WorkingEntry): Promise<Gate> {
    const id = this.db.insert('wm_buffer', { payload: JSON.stringify(entry), status: 'pending', ts_utc: Date.now() });
    return this.process(entry, id);
  }

  private async process(e: WorkingEntry, bufId: number): Promise<Gate> {
    const g = this.gate(e);

    if (g === 'WRITE') {
      await this.writer.writeTrace(e, { c0: CFG.enc.kappa * e.salience });  // 幂等键：message_id
    } else if (g === 'RAW_ONLY') {
      this.db.run(`UPDATE conversations SET lifecycle_state='raw_only' WHERE message_id=?`, [e.messageId]);
    }

    this.db.run(`UPDATE wm_buffer SET status='done', gate=? WHERE id=?`, [g, bufId]);
    return g;
  }

  private gate(e: WorkingEntry): Gate {
    if (e.namespace === 'test') return 'DISCARD';
    if (isMetaDiscourse(e.text) || isSmallTalk(e.text)) return 'DISCARD';
    if (e.salience >= CFG.enc.writeThreshold && e.hasMeaningfulEntity) return 'WRITE';
    return 'RAW_ONLY';
  }

  /** 定时清理已完成条目；互斥，防止重入 */
  async sweep() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      this.db.run(`DELETE FROM wm_buffer WHERE status='done' AND ts_utc < ?`, [Date.now() - 3_600_000]);
    } finally {
      this.flushing = false;
    }
  }
}
```

**写入并发**：SQLite 只有一个写者。建议所有写操作走同一个 WriteQueue，睡眠流水线按 ≤200 行的小事务分批提交，避免长时间阻塞在线写入。

---

## 五、睡眠巩固流水线（M7 SleepTime）

这是解决"顺序乱"的核心：把原来各自定时的任务（60 秒刷新、2 小时晋升、30 天压缩）统一到一次睡眠周期内按固定顺序执行。

### 5.1 触发与调度

| 触发 | 条件 |
|---|---|
| 主睡眠 | 本地时间 03:00 左右，且用户已空闲 ≥ 30 分钟 |
| 小睡 | 用户空闲 ≥ 2 小时，只执行步骤 1–3 |
| 手动 | 业主命令，可以只跑某几步（dry-run 模式） |

**工程保障**：
- 每一步写 checkpoint 到 sleep_runs，崩溃后从断点继续；
- 每一步都必须幂等，用 sleep_run_id + target_id 作为幂等键；
- 每一步有 LLM 调用预算和时间预算，超出就留到下一个周期；
- 主睡眠成功完成后，所有存活痕迹的 `sleep_cycles_survived + 1`。

### 5.2 十个步骤

| # | 步骤 | 输入 | 输出 | 认知对应 |
|---|---|---|---|---|
| 1 | 事件封口 | open 状态的 episode | gist、参与者、情绪曲线、episode 显著性 | 事件分割 |
| 2 | 复评 RAW_ONLY | 带 episode 上下文的原始消息 | 补写 L3 痕迹，或确认不写 | 带上下文的再编码 |
| 3 | 精确打分 | 当日新痕迹 | LLM 重要度、精确新颖度、自我相关度 | — |
| 4 | 优先回放 | 回放集（见 5.3） | 巩固度 +η_sleep，更新实体边权重 | 海马回放 |
| 5 | STC 行为标记 | 高唤醒 episode（a ≥ 0.7）前后 ±6 小时的弱痕迹 | 巩固度小幅上调 | 突触标记与捕获 |
| 6 | 合并去重 | 余弦 ≥ 0.92 且实体重合的痕迹对 | 合并成一条，n_refs 相加，溯源链保留 | 记忆整合 |
| 7 | 语义萃取 + 冲突消解 | 已巩固痕迹、gist | L4 事实；旧事实设置 valid_to | 系统巩固 |
| 8 | 晋升评估 | 全部 L3 / L2 | 进入巩固态、黑钻候选 | 固化 |
| 9 | 生命周期推进 | 刷新 activation_cache 后的 B 层 | 状态迁移，expiring 先尝试萃取 | 主动遗忘 |
| 10 | 墓碑清理 + 索引维护 + 指标 | 到期墓碑 | 物理清除、FTS 优化、Harness 指标 | 类淋巴清洗 |

### 5.3 优先回放集

人在睡眠中优先回放新颖的、情绪强的、还没巩固好的经历。回放优先级：

```
P_i = S_i · (1 - c_i) · (0.5 + 0.5 · nov_i)
```

每个周期按 `P_i` 取前 N = 100 条。已经巩固（c ≥ 0.85）的条目不再回放，因为没有边际收益。

### 5.4 冲突消解（步骤 7 细节）

```
新事实 F_new(subject, predicate, object)
  ├─ 查询同 subject + predicate 且 valid_to IS NULL 的旧事实 F_old
  ├─ 谓词为单值型（lives_in / works_at / relationship_status）：
  │     object 不同 → F_old.valid_to = F_new.valid_from；F_old.superseded_by = F_new.id
  ├─ 谓词为多值型（likes / has_pet）：并存，不冲突
  ├─ 无法判定 → 两条都保留，置信度各 −0.1，标记 conflict，等用户在对话中澄清
  └─ 全程写账本（只记 id 和谓词）
```

效果：用户问"我以前住哪"时，系统能回答"你之前住杭州，今年春天搬到了上海"，而不是只知道最新状态或两条混在一起。

### 5.5 编排骨架

```typescript
const STEPS: SleepStep[] = [
  sealEpisodes, reevaluateRawOnly, preciseScoring, prioritizedReplay,
  stcTagging, mergeDuplicates, extractSemantics, evaluatePromotions,
  advanceLifecycle, purgeAndMaintain,
];

export async function runSleep(mode: 'main' | 'nap'): Promise<void> {
  const run = SleepRuns.resumeOrCreate(mode);
  const steps = mode === 'nap' ? STEPS.slice(0, 3) : STEPS;

  for (const step of steps.slice(run.stepIndex)) {
    const budget = CFG.sleep.budgets[step.name];
    const res = await step.exec({ runId: run.id, budget, cycleNo: run.cycleNo });
    SleepRuns.checkpoint(run.id, step.name, res.stats);
    if (res.deferred) break;                      // 超预算，剩余留给下个周期
  }

  if (mode === 'main' && SleepRuns.allDone(run.id)) incrementSurvivedCycles(run.cycleNo);
  Harness.report(run.id);
}
```

---

## 六、生命周期与遗忘

### 6.1 状态全集

```
                  ┌──────(有效强化)──────┐
                  ▼                      │
[raw_only] ──▶ fresh ──▶ weakening ──▶ expiring ──┬─(萃取成功)──▶ consolidated(A) ──▶ pinned(L5)
     │                                             └─(萃取失败)──▶ tombstone ──▶ purged
     └─(睡眠复评不写)──▶ 随所属 episode 走 L1 生命周期                    │
                                                                      └─(仅人工/用户恢复)──▶ fresh
 任意非 purged 状态 ──(用户"忘掉")──▶ tombstone(reason=user_request)
 任意状态 ──(用户"别再提")──▶ suppressed 标志置 1（状态不变）
```

### 6.2 迁移表

| 从 | 到 | 条件（守卫） | 副作用 |
|---|---|---|---|
| fresh | weakening | `A_i < θ_forget + 1.0` | 无 |
| weakening | fresh | 有效强化 | 更新 refs 和巩固度 |
| weakening | expiring | `A_i < θ_forget`，或者超过 τ_max 且 c < 0.85 | 送入萃取队列 |
| expiring | consolidated | 萃取成功，L4 事实写入并通过校验 | 痕迹标为已晋升，原文可进入遗忘 |
| expiring | tombstone | 萃取失败或无可萃取内容，且通过豁免检查 | 从全部索引摘除，写墓碑行 |
| tombstone | fresh | 仅人工 / 用户恢复 | 重新建索引，写账本 |
| tombstone | purged | 墓碑满 30 天，通过五道闸，未超日配额 | 物理删除，写账本 |
| 任意 | consolidated | 满足 §七 晋升条件 | 不再进入遗忘扫描 |

### 6.3 豁免检查（按顺序执行，任一命中即跳过）

1. **A 层锚点豁免**：所属 episode 中包含任何 A 层条目或黑钻引用，整组豁免（ADR 乙案防护 1）；
2. **DNA 根保护**：本条是 ≥1 条 A 层记忆的 dna_root_id，豁免（P0 红线 2）；
3. **黑钻引用**：被 black_diamond_v2 引用，豁免；
4. **前瞻记忆引用**：被 pending 状态的承诺引用，豁免；
5. **L4 唯一来源**：是某条有效 L4 事实的唯一来源时，只删原文，保留溯源存根 {id, dna_root_id, content_hash}。

### 6.4 L1 原文的遗忘规则

- 原文以 episode 为单位遗忘，不逐条处理，避免留下断裂的对话碎片；
- 条件：episode 已封口、gist 已生成、整组未豁免、episode 的巩固度低于 θ_permanent、所有关联痕迹都已不在 fresh 状态；
- 原文删除后 `episodes.raw_available = 0`。之后系统对这件事最多只能说"印象"（§九.2），这和人一样：细节忘了，要点还在。

### 6.5 墓碑期只读（P0 红线 1）在代码层的落实

```typescript
export function reinforce(id: string, src: ReinforceSource, nowMs: number) {
  const m = db.get(`SELECT * FROM memories WHERE id=?`, [id]);
  if (!m || m.lifecycle_state === 'tombstone' || m.lifecycle_state === 'purged') return; // 硬拦截

  const deltaDays = (nowMs - m.last_reinforced_at) / DAY;
  const g = 1 - Math.exp(-deltaDays / CFG.cons.delta0Days);

  const c = m.consolidation + CFG.cons.eta[src] * g * (1 - m.consolidation);
  const refs = pushRecent(JSON.parse(m.recent_refs ?? '[]'), nowMs, 5);
  const today = localDay(nowMs);

  db.run(
    `UPDATE memories SET consolidation=?, n_refs=n_refs+1, recent_refs=?, last_reinforced_at=?,
       distinct_recall_days = distinct_recall_days + (CASE WHEN last_recall_day = ? THEN 0 ELSE 1 END),
       last_recall_day=?,
       lifecycle_state = CASE WHEN lifecycle_state IN ('weakening','expiring') THEN 'fresh' ELSE lifecycle_state END
     WHERE id=? AND lifecycle_state NOT IN ('tombstone','purged')`,
    [Math.min(c, 1), JSON.stringify(refs), nowMs, today, today, id],
  );

  telemetry.reinforcement(id, src, c - m.consolidation);
}
```

旧的 `applyRecallIncrement` 全部改为调用 `reinforce()`，固定 +0.2 的逻辑删除。

### 6.6 删除执行五道闸（沿用 ADR，补实现细节）

| 闸 | 实现 |
|---|---|
| 先忘后删 | tombstone 时同步删除 FTS 行和向量行，主表保留墓碑元数据 |
| 墓碑期 30 天 | purge_after = deleted_at + 30d |
| 硬配额 | 每日 purge 计数存在 kv_counters，达到 500 条即停；用户主动请求不占配额，但单次请求超过 200 条需二次确认 |
| 完整性 + 快照 + 事务 | 执行前 PRAGMA integrity_check，用 VACUUM INTO 备份快照，每批放在一个事务里 |
| 总开关 | MEMORY_FORGET_ENABLED=0 时步骤 9、10 只计算不执行（影子模式），状态全部冻结 |

---

## 七、晋升体系与黑钻

### 7.1 晋升路径总览

```
L0 ──[三岔门控 WRITE]──────────────────────────▶ L3 fresh（c₀ ≤ 0.6）

L3 ──[有效强化 + 睡眠回放]──────────────────────▶ c 渐近上升

L3 ──[c ≥ 0.85 ∧ 存活 ≥ 3 个睡眠周期 ∧ 不同日期召回 ≥ 3]──▶ consolidated（A 层）

L3/L2 ──[expiring 时萃取成功]───────────────────▶ L4 事实（A 层，原文可遗忘）

consolidated ──[SD ≥ 0.7 ∧ (地标 ∨ 用户确认)]────▶ L5 黑钻（指针）

用户手动 ──[二次确认 + 10% 配额 + 审计]─────────▶ L5 黑钻（指针）

敏感内容（sensitivity ≥ 1）进入 L5 ──▶ 必须用户确认，不允许自动
```

### 7.2 晋升判定代码

```typescript
export function evaluatePromotion(m: TraceRow, ctx: PromoCtx): PromoDecision {
  if (m.lifecycle_state === 'tombstone' || m.namespace !== 'default') return { to: null };

  const consolidated =
    m.consolidation >= CFG.promo.thetaPermanent &&
    m.sleep_cycles_survived >= CFG.promo.minSleepCycles &&
    m.distinct_recall_days >= CFG.promo.minDistinctDays;

  if (!consolidated) return { to: null };
  if (m.lifecycle_state !== 'consolidated') return { to: 'consolidated', reason: 'c+cycles+spacing' };

  const sd = selfDefiningScore(m, ctx);
  const diamondEligible = sd >= CFG.promo.sdThreshold && (m.is_landmark === 1 || ctx.userConfirmed);

  if (!diamondEligible) return { to: null };
  if (m.sensitivity >= 1 && !ctx.userConfirmed) return { to: 'diamond_pending_confirm', sd };
  if (ctx.autoDiamondThisWeek >= CFG.promo.autoDiamondWeeklyCap) return { to: null, reason: 'weekly_cap' };

  return { to: 'diamond', sd, reason: 'self-defining' };
}
```

**和旧版相比：**

| 旧通道 | 处理 | 理由 |
|---|---|---|
| 地标 + 钙 ≥ 3.5 | 地标改为黑钻的必要条件之一，不再单独成立 | 地标本身不等于已巩固 |
| 原生钙 ≥ 4.5 | 改为 c ≥ 0.85 且有时间与间隔条件 | P3：永生必须经历时间 |
| 召回 ≥ 5（SQL 里是 ≥3） | 取消 | 违反 ADR §五 |
| 亲密关键词情感通道 | 取消，改为分类器标记 + 用户确认 | 违反 P0 红线 3，且有隐私风险 |

### 7.3 "用户确认"怎么自然发生

用户不需要看到弹窗，可以在对话中自然完成。黑钻候选达标后，系统在合适的时机（用户情绪平稳、话题相关时）用通路 A 轻声提一句："那天你说的那句话，我一直记着。"用户回应正向，就视为确认；用户转移话题，就不确认，30 天内不再询问。

### 7.4 手动准入修复

```typescript
import { timingSafeEqual, createHash } from 'node:crypto';

function verifyPassword(input: string, storedHash: Buffer, salt: Buffer): boolean {
  const h = createHash('sha256').update(Buffer.concat([salt, Buffer.from(input)])).digest();
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}
```

生产环境建议用 scrypt 或 argon2 代替 sha256。黑钻指针化之后，手动添加流程变成：先把内容写成一条 L3 痕迹（来源标记为 manual），再创建一条指向它的黑钻指针，截断 500 字的问题随之消失。

---

## 八、检索链路 v2

### 8.1 总流程

```
① 查询理解（≤ 50ms，规则优先，存疑才调用小模型）
   输出：p_A（回溯意图概率）、时间表达 → [from, to]、实体、查询情绪 40D

② 硬过滤：namespace=:currentEntityNamespace ∧ 未进墓碑 ∧（通路 B 时排除 suppressed）
   🔴 v2.1.0（ADR-016 §三 #3）：原写 `namespace='default'` —— 按角色分 ns 写入的数据
      在 default 域 **0 条**（ns_yuyao/ns_shiyu/… 共 17335 条），走此硬过滤恒返回 0 条。
      现改为**只读当前实体域**，**不并集 default**（§2.1：并集即保留一条串台通道，
      历史「玉瑶的记忆被诗雨说出来」正是这类混流）。公共知识走 L4 `semantic_facts`。

③ 多路召回（并行，每路取前 30）
   R1 全文 BM25（L1 原文 + L2 gist）     R2 语义向量（L3 / L2 / L4）
   R3 实体图 PPR（HippoRAG）              R4 情感 40D（仅通路 B 有权重）
   R5 黑钻直取（按实体或主题）            R6 档案直取（按实体查 L4 有效事实）
   R7 知识库 / 笔记                        R8 到期前瞻记忆（命中即必入，不参与排序）

④ 规范化折叠：按 episode_id / dna_root_id 合并，保留证据最强的代表项

⑤ Weighted RRF（权重随 p_A 插值）→ 候选前 50

⑥ 重排：cross-encoder（如 bge-reranker-v2-m3）→ rel ∈ [0,1]

⑦ 先验叠加 → final score

⑧ MMR 去重（λ = 0.7）→ 前 10

⑨ 证据标签判定（§九）

⑩ 上下文打包（按 token 预算分区）
```

### 8.2 实体图 PPR

以查询中的实体为种子，在 entity_edges 上跑 Personalized PageRank（阻尼系数 0.5，迭代 10 次），按节点分数把关联痕迹拉进候选。它能处理"上次和小林去的那家店"这种多跳联想，纯向量检索做不到。实体规模在万级以内时，内存计算即可，耗时在毫秒级。

### 8.3 意图权重插值

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

### 8.4 融合打分

```typescript
export function fuseV2(routes: RouteHits[], q: QueryUnderstanding, nowMs: number): Ranked[] {
  const w = interpolateWeights(q.pA);                           // §8.3
  const groups = canonicalFold(routes);                         // 按 episode_id / dna_root_id 折叠
  const rrf = weightedRRF(groups, w, CFG.fuse.k);               // k = 60
  const rrfMax = sumValues(w) / (CFG.fuse.k + 1);               // 理论上界，用于归一
  const top = rrf.slice(0, CFG.fuse.rerankTopN);                // 50
  const rel = crossEncoderScores(q.text, top);                  // [0,1]

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

- 默认权重：wRel 0.55 / wRrf 0.20 / wPrior 0.15 / wImp 0.10，全部可配；
- 近因只通过激活度作用于情节类记忆（L1–L3）。L4 和 L5 的先验恒为 1，不随时间降权；
- 查询带时间表达时（"上个月那次"），时间区间作为强约束，区间外的条目乘 0.2；
- 习惯化惩罚只在偏通路 B 时生效：最近 7 天曝光越多，分数越低。

### 8.5 上下文打包

| 分区 | 预算（参考） | 位置 | 内容 |
|---|---|---|---|
| 档案摘要 | 300 tokens | 开头 | L4 中与当前实体相关的有效事实 |
| 到期约定 | 100 tokens | 开头 | R8 命中项 |
| 相关往事 | 800 tokens | 结尾 | 带标签的证据，按分数排列 |
| 元素池 | 200 tokens | 结尾 | 通路 B 的原子元素（只读，带溯源） |

重要内容放在首尾，规避长上下文的 lost-in-the-middle 效应（Liu 等，2023）。

### 8.6 延迟预算（参考值）

| 阶段 | p95 目标 | 降级方案 |
|---|---|---|
| 查询理解 | 50ms | 只用规则 |
| 多路召回（并行） | 120ms | 跳过 PPR |
| 重排 | 200ms | 前 50 降到前 20，或用更小的重排模型；p_A < 0.3 时跳过 |
| 融合 + MMR + 打包 | 30ms | — |
| 合计 | ≤ 400ms | 超时直接用 RRF 结果 |

---

## 九、MemSym v1.1 整合

MemSym 的理念保持不变，实现收敛到上面这条统一的检索漏斗上。

### 9.1 分发器：从二选一改为概率

| p_A | 呈现模式 | 说明 |
|---|---|---|
| ≥ 0.65 | 通路 A | 诚实回溯，带标签 |
| 0.35–0.65 | 混合 | 以通路 B 为主，允许最多一条带标签的轻量回溯 |
| ≤ 0.35 | 通路 B | 只融元素，不叙述往事 |

**B → A 降级**：通路 B 之后，用户追问"你还记得吗""那次是什么时候"，下一轮强制切到通路 A，并且提高 R1 原文路的权重。

### 9.2 证据标签：由证据类型决定

| 标签 | 证据要求 | 话术示例 |
|---|---|---|
| 「记得」 | 原文仍在（raw_available = 1）、rel ≥ 0.75、未进墓碑 | "记得，那天你说……" |
| 「印象」 | 只有 gist 或 L4 事实，或原文已压缩 / 遗忘，rel ≥ 0.55 | "我印象里是……细节有点模糊了" |
| 「线索」 | rel 在 [0.35, 0.55)，或只有实体重合 | "好像和小林有关？你再提醒我一下" |
| 不说 | rel < 0.35 | "这个我不太记得了，跟我讲讲？" |

```typescript
export function decideTag(ev: Evidence): RecallTag | null {
  if (ev.lifecycle === 'tombstone') return null;
  if (ev.rawAvailable && ev.rel >= CFG.tag.remember) return '记得';
  if ((ev.hasGist || ev.hasFact) && ev.rel >= CFG.tag.impression) return '印象';
  if (ev.rel >= CFG.tag.clue || ev.entityOverlap) return '线索';
  return null;
}
```

这样，遗忘机制和诚实标签自然连通：原文被遗忘后，系统最多只能说"印象"，不会凭空说"记得"。

### 9.3 OutputGuard 两级校验

1. **抽取**：从生成的回复中抽取"往事断言"。规则识别"那次 / 上次 / 你说过 / 我们一起"等句式，存疑再交给小模型；
2. **验证**：每条断言与 elementSet 做蕴含判断（NLI 模型或 LLM 判定）：
   - 通路 A：断言必须被证据蕴含，标签不能高于证据允许的档位；
   - 通路 B：`hasNovelFactualElements = false`，即不允许出现证据里没有的事实要素；
3. **失败处理**：先降低标签档位重写，仍然失败就删去该句，并记录一次"虚构拦截"指标。

### 9.4 强化归因：只有真实回应才强化

这一步打断通路 B 的自我强化回路：

| 信号 | 判定 | 效果 |
|---|---|---|
| used：模型确实用了这条记忆 | 回复与记忆元素的实体或 n-gram 重合超过阈值 | 前提条件，不满足则什么都不做 |
| confirm：用户确认 | "对""是啊"或补充细节 | 通路 A 用 η = 0.15 |
| engaged：用户接话 | 下一轮话题延续，情绪不转负 | A 用 0.09，B 用 0.03（有冷却） |
| ignored：用户转移话题 | 话题切换 | 不强化，只计入曝光次数 |
| correct：用户纠正 | "不是这样""记错了" | 不强化，触发再巩固（见下） |

**再巩固处理**：用户纠正时，生成新版本痕迹（supersedes_id 指向旧版本），旧版本的置信度下调；如果涉及 L4 事实，旧事实设置 invalidated_at。系统会自然地说一句"原来是这样，我记下了"。这正对应 Nader 提出的提取后记忆可修改。

### 9.5 组件变化

| v1.0 组件 | v1.1 处理 |
|---|---|
| 要素萃取器 | 离线部分并入睡眠步骤 7，在线部分保留轻量版 |
| 双通路分发器 | 输出 p_A，增加混合模式 |
| 要素池沙箱 | 不变，元素统一带 source_id 和证据类型 |
| 钙化增益调节器 | 改为强化归因器，统一调用 reinforce() |
| OutputGuard | 增加断言抽取 + 蕴含验证 |

---

## 十、治理、隐私与安全

### 10.1 命名空间隔离（解决测试污染）

所有读取都通过视图，禁止业务代码直接查原表：

```sql
CREATE VIEW v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(namespace,'default')='default'
    AND (roleplay_char IS NULL OR roleplay_char='')
    AND COALESCE(lifecycle_state,'fresh') NOT IN ('tombstone','purged');

CREATE VIEW v_mem_real AS
  SELECT * FROM memories
  WHERE COALESCE(namespace,'default')='default'
    AND lifecycle_state NOT IN ('tombstone','purged');
```

在 CI 里加 lint 规则：在 storage/ 目录之外出现 `FROM conversations` 或 `FROM memories`，构建直接失败。

### 10.2 敏感度分级

| 级别 | 含义 | 存储 | 检索 | 晋升 |
|---|---|---|---|---|
| 0 | 普通 | 明文 | 正常 | 自动 |
| 1 | 私密（健康、家庭、财务） | 字段级 AES-GCM 加密，密钥放在系统钥匙串 | 正常，日志脱敏 | 进黑钻需用户确认 |
| 2 | 亲密 | 同上 | 只在私密会话模式下注入 | 进黑钻需用户确认 |

敏感度由分类器判定（VAD + narrative_tag + 关系相关度 + 原关键词表）。原关键词表降级为分类器的一个弱特征，不再直接决定晋升。

### 10.3 用户主权：两种请求

| 用户说 | 模式 | 执行 |
|---|---|---|
| "别再提这件事了" | suppress（抑制） | 置 suppressed = 1；通路 B 完全排除；通路 A 只在用户明确问起时可用 |
| "把这件事忘掉" | forget（遗忘） | 先检索候选，向用户确认范围 → 进入墓碑（reason = user_request），跳过 expiring 和萃取 → 级联处理 |

**遗忘请求的级联处理**：
1. 只以这条记忆为来源的 L4 事实：设置 invalidated_at；
2. 有多个来源的 L4 事实：移除这个来源，置信度下调；
3. 引用它的黑钻指针：状态改为 revoked；
4. 实体边：删除这条痕迹贡献的边；
5. 账本：只记 id、内容哈希和原因；
6. 恢复：墓碑期内只有用户本人可以恢复。

### 10.4 审计账本校验

每个睡眠周期结束时校验哈希链：从上次校验点到当前末尾，逐行重算哈希。断链就告警，同时冻结遗忘模块，相当于自动执行 `MEMORY_FORGET_ENABLED=0`。磁盘压力大时，把超过 1 年的账本段导出为带签名的离线归档，主库只保留锚点哈希（ADR 的冷归档迁移）。

---

## 十一、存量数据迁移

迁移按"影子列 → 校验 → 切换"进行，原始列在两个版本周期内保留只读。

### 11.1 时间戳统一

```sql
-- conversations：ISO 字符串（UTC）→ epoch ms
UPDATE conversations SET ts_utc = CAST(strftime('%s', timestamp) AS INTEGER) * 1000 WHERE ts_utc IS NULL;

-- memories：本地时间字符串（Asia/Shanghai，无时区）→ 减 8 小时
UPDATE memories SET last_reinforced_at =
  (CAST(strftime('%s', last_recalled_at) AS INTEGER) - 8*3600) * 1000
WHERE last_recalled_at IS NOT NULL AND last_reinforced_at IS NULL;
```

迁移前抽样 50 行人工核对，确认 memories 表里的时间确实是本地时间。

### 11.2 修复 is_summary 误标

```sql
-- compactAlluvial 产生的行同时满足 is_summary=1 且 is_compacted=1，它们本来是原文
UPDATE conversations SET is_summary = 0 WHERE is_summary = 1 AND is_compacted = 1;
```

执行前抽样确认：真正的摘要行一般是 is_compacted 为 0 或 NULL，并且内容带有摘要特征。同时把 compactAlluvial 改成只设置 is_compacted，摘要统一写入 episodes.gist。

### 11.3 钙化分归一（最关键）

按"能重算就重算，不能重算才推断"的原则：

```
对每一行 memories：
  1) calcium_legacy = calcium_score（留档）
  2) 若 perception 快照存在 → c = κ · S(重新计算的显著性)          ← 首选，彻底消除量纲歧义
  3) 否则按时代推断原始量纲：
       created_at < v27 上线日       → 按旧量纲（1-5 或 5-10，由 calcium_level 区分）
       created_at ≥ v27 上线日       → 原值减去 0.2 × recall_count 还原初值，按 0-1 处理
     映射：0-1 → 原值；1-5 → (x-1)/4；5-10 → (x-5)/5；再乘 κ 并截断到 [0, 0.6]
  4) 根据 recall_count 补偿：c ← 按 §3.1 渐近公式回放 min(recall_count, 10) 次，g 取 0.5（无法知道间隔）
  5) 无法判定的行 → c = 0.3，标记 migration_ambiguous=1，写账本
  6) 已在 black_diamond 中的 → 直接设为 consolidated，并建立黑钻指针（保留既有永生承诺）
```

**激活历史回填**：`n_refs = 1 + recall_count`，`first_ref_at = created_at`，`recent_refs = [last_recalled_at]`。缺失部分由 Petrov 近似的均匀分布假设覆盖。

**迁移安全**：
- 迁移前用 VACUUM INTO 做全库快照；
- 迁移后对比"新判据下会进入 expiring 的数量"，超过总量 5% 就暂停，人工复核；
- 迁移完成后，遗忘模块先以影子模式运行 2 周（§十四）。

---

## 十二、观测与评测

### 12.1 Harness 面板指标

| 类别 | 指标 | 健康区间（初始参考） |
|---|---|---|
| 写入 | 门控分布（WRITE / RAW_ONLY / DISCARD） | WRITE 占 15–35% |
| 存储 | 存储增长斜率（周） | 逐月放缓 |
| 巩固 | 巩固度分布熵、consolidated 占比 | 熵不坍缩；consolidated 占 3–10% |
| 遗忘 | 遗忘速率、expiring → A 层晋升率、墓碑恢复率 | 恢复率 < 2%（过高说明删错了） |
| 检索 | 召回率@10、MRR（离线评测集） | 逐版本不下降 |
| 诚实 | 虚构率、标签校准度（「记得」的准确率） | 虚构率 < 1%；「记得」准确率 ≥ 95% |
| 交互 | 用户纠正率、通路 B 元素重复率 | 纠正率持续下降 |
| 性能 | 检索 p95、睡眠周期耗时 | ≤ 400ms；睡眠 ≤ 30 分钟 |

### 12.2 评测集

- **公开基准**：LongMemEval（Wu 等，2024）覆盖信息抽取、多会话推理、时间推理、知识更新和拒答，和本设计的双时态事实、诚实标签一一对应；LoCoMo（Maharana 等，2024）用于超长多会话对话记忆评测；
- **私有中文集**：从真实日志（脱敏后）构造 300–500 个问答对，按五类标注：直接回溯、时间推理、事实更新、多跳联想、应当拒答（不存在的往事，用来测虚构）；
- **回归门禁**：任何改动检索、晋升或遗忘参数的提交，都必须跑私有集，虚构率和召回率不能退化。

---

## 十三、配置基线

全部参数配置化，禁止硬编码（ADR §九）：

```yaml
memory:
  time: { storage: utc_epoch_ms, display_tz: Asia/Shanghai }

  encoding:
    kappa: 0.6                  # c0 = kappa * S
    write_threshold: 0.45
    salience_weights: { importance: 0.30, self: 0.25, arousal: 0.20, novelty: 0.15, entity: 0.10 }

  segmentation: { threshold: 0.55, hard_gap_min: 120, max_turns: 40 }

  consolidation:
    delta0_days: 1.0            # 间隔增益 g(Δ)
    eta: { A_confirm: 0.15, A_engaged: 0.09, B_engaged: 0.03, sleep_replay: 0.02, stc_max: 0.04 }
    B_cooldown_hours: 24
    B_daily_cap_per_element: 1

  activation:
    d: 0.5
    min_age_days: 0.0417        # 1 小时
    recent_k: 5
    w_c: 1.0
    w_a: 0.5

  lifecycle:
    enabled_flag: MEMORY_FORGET_ENABLED
    theta_forget: -1.5
    weakening_margin: 1.0
    tau_max_days: 365
    tombstone_days: 30
    daily_purge_quota: 500

  promotion:
    theta_permanent: 0.85
    min_sleep_cycles: 3
    min_distinct_days: 3
    sd_threshold: 0.7
    auto_diamond_weekly_cap: 5
    manual_ratio_cap: 0.10

  sleep:
    main_at_local: "03:00"
    min_idle_min: 30
    replay_top_n: 100
    stc: { arousal_min: 0.7, window_hours: 6 }
    merge_cosine: 0.92

  retrieval:
    per_route_top: 30
    rrf_k: 60
    rerank_top_n: 50
    final: { w_rel: 0.55, w_rrf: 0.20, w_prior: 0.15, w_imp: 0.10 }
    act_center: -1.0
    lambda_habituation: 0.05
    mmr_lambda: 0.7
    top_k: 10

  memsym:
    pA_thresholds: { A: 0.65, B: 0.35 }
    tag: { remember: 0.75, impression: 0.55, clue: 0.35 }
```

---

## 十四、落地路线

每个阶段都在功能开关下推进，并有明确的验收标准。

| 阶段 | 周期 | 内容 | 验收标准 |
|---|---|---|---|
| **P0 止血** | 1 周 | 时间统一 UTC；修复 is_summary 误标；工作记忆三岔门控 + 持久化 + 互斥；reinforce() 增加墓碑拦截；命名空间视图 + CI lint；融合尺度归一 | 低价值条目不再强制进金库；测试数据零召回；墓碑条目零加分 |
| **P1 统一量纲** | 1–2 周 | consolidation 迁移脚本；渐近增益 + 间隔函数；晋升改为"且"组合；取消召回单通道和关键词通道；评估 sql.js 迁移 | 迁移歧义行 < 5% 且全部记账；巩固度在 [0,1] 内单调 |
| **P2 结构升级** | 2–3 周 | episodes 表 + 事件分割；黑钻指针化；FTS5 + 中文分词；语义 / 情感双向量；重排器；意图权重插值；前瞻记忆表 | 私有评测集召回率@10 比基线提升 ≥ 15% |
| **P3 睡眠流水线** | 2–3 周（与批 γ 合并） | 十步编排 + 断点续跑；expiring 萃取钩子；STC；L4 双时态冲突消解；实体图 PPR | 睡眠周期 ≤ 30 分钟；事实更新类问题准确率 ≥ 80% |
| **P4 激活度与遗忘上线** | 2 周影子期 + 切换 | activation 先以影子模式运行，和 τ 判据并行计算、对比；业主裁决后切换；用户遗忘权上线 | 影子期两套判据分歧条目经人工复核；恢复率 < 2% |
| **P5 MemSym v1.1** | 2 周 | 概率分发 + 混合模式；证据标签；OutputGuard 蕴含验证；强化归因 + 再巩固 | 虚构率 < 1%；「记得」准确率 ≥ 95% |

**依赖关系**：P0 → P1 → P2 → P3 → P4；P5 可以在 P2 完成后与 P3 并行。

---

## 十五、ADR 修订提案清单（需业主裁决）

按红线声明，以下条目改变了法定行为，agent 不得自行实施，需要逐项裁决：

| # | 提案 | 涉及条款 | 紧迫度 |
|---|---|---|---|
| R1 | 修复遗忘判据矛盾：当前 θ_forget = 0.03 意味着约 3.5τ 才遗忘，与"最多一年"不符 | §五 | 🔴 P0 前必须裁决 |
| R2 | 用 ACT-R 激活度 + 间隔增益取代 τ / strength 公式（先走影子期） | §五、第十一条第二款 | P4 |
| R3 | A 层准入增加"跨 ≥3 个睡眠周期 + ≥3 个不同日期提取" | §三.A.1 | P1 |
| R4 | 新增用户主动遗忘权与抑制权，用户请求可以跳过萃取直接进墓碑 | 新增条款 | P4 |
| R5 | 账本只记元数据、不记内容；入法明示，与 R4 配套 | §三.A.5 | P4 |
| R6 | 黑钻改为指针，旧黑钻数据迁移为"巩固态 + 指针" | §三.A.4 | P2 |
| R7 | 取消亲密关键词晋升通道，改为敏感度分级 + 用户确认 | P0 红线 3 的延伸 | P1 |
| R8 | 原文遗忘以 episode 为单位，并设置 raw_available 联动 MemSym 标签 | 乙案执行细则 | P3 |

---

## 📝 总结

这份设计把原来散落的机制收拢成**两个分数、一条写入管线、一条睡眠流水线、一个检索漏斗**：

- **写入**：原文先落盘，事件自动分割，三岔门控代替强制毕业；
- **巩固**：渐近有界的巩固度加上间隔增益，永生必须经历时间和睡眠；
- **遗忘**：ACT-R 激活度同时充当检索先验和遗忘判据，豁免检查和五道闸保证不误删；
- **检索**：相关性为主，先验为辅，权重随意图变化，有重排、有多跳联想；
- **诚实**：标签由证据类型决定，原文忘了就只能说"印象"，用户纠正会触发再巩固。

**最终效果**：真正重要的事会随着一次次被提起而记得更牢；没人再提的细节会慢慢淡去，但结论会留下来；系统不会编造没发生过的往事。🌙

---

## 十六、跨模块接口契约汇总（统一冻结，禁止各模块自行定义）

> ⚠️ **重要**：以下接口契约是 6 个模块之间的统一约定，所有模块必须严格遵守。任何修改必须走 ADR 评审 + 业主授权。

### 16.1 数据结构统一约定

#### TraceRow（L3 痕迹统一结构）
`	ypescript
interface TraceRow {
  id: string;
  namespace: string;            // 'default' | 'test' | 'roleplay'
  raw_input: string;
  summary: string;
  consolidation: number;        // [0, 1]，取代 calcium_score
  n_refs: number;              // 编码 + 有效强化总次数
  first_ref_at: number;         // epoch ms
  recent_refs: number[];       // 最近 k=5 次强化时间戳
  last_reinforced_at: number;
  distinct_recall_days: number;
  last_recall_day: string;      // 'YYYY-MM-DD'（本地日）
  sleep_cycles_survived: number;
  salience: number;             // [0, 1]
  importance: number;           // [0, 1]，LLM 打分
  arousal: number;              // 0-1
  novelty: number;               // 0-1
  self_relevance: number;        // 0-1
  activation_cache: number;      // 睡眠期刷新
  lifecycle_state: string;       // fresh / weakening / expiring / consolidated / tombstone / purged
  lifecycle_changed_at: number;
  episode_id: string;
  version: number;
  supersedes_id: string;        // 再巩固新版本指向旧版本
  suppressed: number;           // 0/1
  sensitivity: number;          // 0/1/2
  exposures_7d: number;         // 通路 B 习惯化
  calcium_legacy: number;       // 迁移前原值，只读
  dna_root_id: string;
  is_landmark: number;          // 0/1
  perception_40d: number[];     // 情感 40D 向量
  semantic_embedding: number[]; // 语义向量（异步生成）
}`

#### EpisodeRow（L2 事件统一结构）
`	ypescript
interface EpisodeRow {
  id: string;
  namespace: string;
  started_at: number;           // epoch ms
  ended_at: number;
  status: string;               // open / sealed
  gist: string;
  gist_version: number;
  participants: string[];       // entity uuid[]
  arousal_peak: number;
  valence_mean: number;
  affect_curve: Array<[number, number, number]>;  // [[ts, a, v], ...]
  salience: number;
  consolidation: number;
  is_landmark: number;
  lifecycle_state: string;
  anchor_exempt: number;         // 0/1
  raw_available: number;         // 0/1（决定能否说'记得'）
  suppressed: number;
  sensitivity: number;
  dna_root_id: string;
}`

#### Evidence（检索结果统一结构）
`	ypescript
interface Evidence {
  trace_id: string;
  episode_id: string;
  content: string;              // 展示用内容
  source_type: string;          // 'trace' | 'gist' | 'fact' | 'diamond'
  raw_available: boolean;
  rel: number;                  // 重排后相关度 [0,1]
  rrf_score: number;
  activation: number;           // 激活度（对数尺度）
  consolidation: number;        // [0,1]
  has_gist: boolean;
  has_fact: boolean;
  entity_overlap: boolean;
  lifecycle: string;           // fresh / weakening / expiring / consolidated / tombstone
  suppressed: boolean;
  sensitivity: number;
  source_ids: string[];         // 溯源链
}`

### 16.2 模块间接口清单

#### M1 → M2：数据访问接口
`	ypescript
// 写入 conversations
writeConversation(entry: ConversationRowInput): number;  // 返回 id

// 写入 memories（L3 痕迹）
writeTrace(row: Partial<TraceRow>): string;  // 返回 trace_id

// 写入 wm_buffer
pushWorkingBuffer(payload: string): number;  // 返回 buffer_id
`

#### M2 → M3：RAW_ONLY 复评数据源
`	ypescript
// 取待复评的 RAW_ONLY 消息
getRawOnlyPending(limit: number): Promise<Array<{
  conversation_id: string;
  content: string;
  episode_id: string;
  context: string;  // episode 上下文
}>>;

// 复评后补写痕迹
reevaluateRawOnly(conversation_id: string, decision: 'write' | 'discard'): Promise<void>;
`

#### M3 → M4：巩固度/激活度更新
`	ypescript
// 刷新某条痕迹的 activation_cache
updateActivationCache(trace_id: string, activation: number): Promise<void>;

// 生命周期状态变更
updateLifecycleState(trace_id: string, newState: string): Promise<void>;
`

#### M4 → M5：检索结果输出
`	ypescript
// 检索主入口
search(query: string, options?: {
  pA?: number;                  // 回溯意图概率（不传则自动判定）
  timeRange?: [number, number]; // [from, to] epoch ms
  topK?: number;                // 默认 10
}): Promise<{
  candidates: Evidence[];
  pA: number;
  packedContext: string;       // 打包好的上下文
}>;
`

#### M5 → M3：强化归因回写
`	ypescript
// 强化某条记忆（巩固度 + 间隔增益）
reinforce(trace_id: string, source: 'A_confirm' | 'A_engaged' | 'B_engaged' | 'sleep_replay' | 'stc'): Promise<void>;

// 再巩固：生成新版本，旧版本失效
reconsolidate(trace_id: string, correction: string): Promise<string>;  // 返回新版本 id
`

#### M6 → 所有模块：治理检查接口
`	ypescript
// 治理检查（写操作前调用）
governanceCheck(action: string, target: string, meta?: Record<string, any>): Promise<{
  allowed: boolean;
  reason?: string;
}>;

// 写审计账本
writeAuditLog(action: string, targetType: string, targetId: string, meta: Record<string, any>): Promise<void>;
`

### 16.3 配置项统一约定

所有配置项必须走统一配置中心，禁止硬编码：

`yaml
memory:
  encoding:
    kappa: 0.6
    write_threshold: 0.45
    salience_weights: { importance: 0.30, self: 0.25, arousal: 0.20, novelty: 0.15, entity: 0.10 }
  segmentation: { threshold: 0.55, hard_gap_min: 120, max_turns: 40 }
  consolidation:
    delta0_days: 1.0
    eta: { A_confirm: 0.15, A_engaged: 0.09, B_engaged: 0.03, sleep_replay: 0.02, stc_max: 0.04 }
  activation:
    d: 0.5
    min_age_days: 0.0417
    recent_k: 5
    w_c: 1.0
    w_a: 0.5
  lifecycle:
    theta_forget: -1.5
    tau_max_days: 365
    tombstone_days: 30
    daily_purge_quota: 500
  promotion:
    theta_permanent: 0.85
    min_sleep_cycles: 3
    min_distinct_days: 3
    sd_threshold: 0.7
  retrieval:
    rrf_k: 60
    rerank_top_n: 50
    mmr_lambda: 0.7
    top_k: 10
  memsym:
    pA_thresholds: { A: 0.65, B: 0.35 }
    tag: { remember: 0.75, impression: 0.55, clue: 0.35 }
``n
---

## 📌 任务书溯源声明

> 以下 6 份任务书均基于本基线文档拆分：
> - **基线版本**: MemArch-v2.0.0-Baseline
> - **基线 MD5**: C3DCBFC83B96EBE88D06D230F26CF503
> - **拆分日期**: 2026-11-03
> - **任务书清单**: M1 存储层 / M2 在线写入 / M3 睡眠巩固 / M4 检索 / M5 MemSym 呈现层 / M6 治理与安全
> - **变更规则**: 任何需求变更必须走【变更单】，禁止口头修改；变更后重新计算基线哈希并升版本号。

