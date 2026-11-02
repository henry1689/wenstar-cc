# 任务书 · n-gram 拆除遗留问题收口 v1

> **状态**：待业主确认后执行
> **立项**：2026-11-02 ｜ 来源：`任务书_V11彻底完成-n-gram拆除-v1.md` 结项 review
> **范围**：n-gram 拆除（B1–B5）完成后遗留的死代码、死配置、过时文档
> **不范围**：全量测试基线红（归 LEDGER #9，属其他车道，本任务只做归因台账）

---

## 〇、为什么要做

B1–B5 把 `search_index` 从**代码**层面拆干净了，但 review 逐条核查时发现
**拆除留下的「尸体」还在**：死配置、零消费函数、以及一批仍在描述已消失机制的注释。

这类遗留的危险不在运行时（它们不执行），而在**认知**——
下次有人读到 `MemoryConfig` 里「砂金库倒排索引启动补齐」的注释，
很可能照着它把机制重新接回来。这正是业主 2026-11-02 指出的
「**每次改善不沉底**」的成因之一：拆除只做了代码，没做文档。

---

## 一、问题清单（全部实测确认，附复现命令）

### A1 · 死配置 `sandboxIndexBackfillBatch` 🔴 P2

- **位置**：`src/config/MemoryConfig.ts:199`
- **实测**：`grep -rn "sandboxIndexBackfillBatch" src/ config/` → **仅定义 1 处，零消费者**
- **注释原文**：「砂金库倒排索引**启动补齐**的单次批量上限……只索引 `search_index` 里还没有的对话」
- **为什么死**：该机制（`SANDBOX_INDEX_BACKFILL_BATCH` / `SANDBOX_INDEX_BACKFILL_DONE`）
  已在 B3a-4 从 `retrieval-stage.ts` 整段删除
- **处置**：删除配置项与其注释

### A2 · 死函数 `chunkLongText` + 死常量 `WORK_CHUNK_SIZE` 🔴 P2

- **位置**：`src/app/works/WorkRepository.ts:34,133`
- **实测**：`grep -rn "chunkLongText\|WORK_CHUNK_SIZE" src/` → **仅定义 2 处，零调用方、零测试引用**
- **注释原文**：「长文切块（**供 search_index 分块索引**）」
- **为什么死**：n-gram 索引不再存在，切块后无人消费
- **处置**：删除函数、常量及其注释

### A3 · 过时注释 ×6（描述已消失的机制）🟡 P3

| # | 文件:行 | 现状 | 处置 |
|---|---|---|---|
| A3-1 | `WorkRepository.ts:132` | 「供 search_index 分块索引」 | 随 A2 一并删除 |
| A3-2 | `MemoryConfig.ts:191-193` | 「控制单次 SQL 的 **IN** 规模」 | 实为 `LIKE OR` 分片（B3b-5），改写 |
| A3-3 | `MemoryConfig.ts:196-198` | 「倒排索引启动补齐」 | 随 A1 一并删除 |
| A3-4 | `CompositeUrchin.ts:11` | 「不进 `search_index`」 | 改为「不落任何持久化表」（语义保留，去掉已消失的表名） |
| A3-5 | `types.ts:39-40` | 「两者共用同一份 `search_index`……差异只在聚合粒度，不在索引」 | 改为「两者都无中间索引，直接对源表做分片 LIKE」 |
| A3-6 | `MemoryRetriever.ts:146` | 「不写 `search_index`」 | 同 A3-4，改「不碰任何业务表」 |

> **更正**：上一轮 review 把 `UnifiedSearchEngine.ts:88` 也列为过时 —— 那是**本次拆除自己写的
> 解释注释**，内容正确，**不改**。

### A4 · `ConversationDB` warn 文案提及已下线表 🟡 P3

- **位置**：`src/m2/ConversationDB.ts:319-322`
- **文案**：「`search_index.source_id` 将与本表主键口径不一致（D5 复现）」
- **问题**：表已不存在，该后果描述失效；且它是**日志文案**（非 SQL），
  现被 B5 守卫的「须含 SQL 动词」判据放行
- **处置**：改为不提该表的表述（如「降级返回 seqPos 将使 `id` 口径偏离主键」）

### A5 · `ShadowLog` 头注语义失效 🟡 P2

- **位置**：`src/m4/retrieval/ShadowLog.ts:1-16`
- **原文**：「**双跑期**的唯一观测出口。**影子链路与旧链路并行跑**，结果只写日志、不参与返回。」
- **问题**：旧链路已于 B3a-4 删除，**没有并行对象可比**。但日志本身仍在写
  （`data/retrieval-v11/shadow/2026-11-02.jsonl` 实测今日 2 行，`MemoryRetriever.ts:207` 仍在调用），
  记录的是 v11 自身的 `candidates_in/out` 与 top-5 id —— **仍有观测价值**
- **处置**（二选一，执行时定）：
  - **甲（推荐）**：保留机制，把头注改为「v11 检索观测日志」，删除「双跑/旧链路」表述
  - **乙**：整体下线 `ShadowLog`（连同 `metrics.json` 八项埋点）
- **判定依据**：`metrics.json` 中 `v11_retrieval_ms_p50=97ms` 是**唯一的耗时数据源**，
  下线它就失去性能观测能力 ⇒ 倾向甲

### A6 · 判据 #2：全量测试 30 项红 ⚪ P2（本任务**只记账，不修**）

- **实测**：3732 passed / **30 failed** / 17 文件
- **归因**（逐条看失败原因，非按数量吻合推断）：

| 失败簇 | 项数 | 真实原因 | 归属 |
|---|---|---|---|
| `write-channel-single-source` | 5 | `_isDuplicateNewWrite is not a function` | SQLiteAdapter 车道 |
| `ask-all-intent` + `meeting-multi-wake` | 6 | 意图判序 `addressOnly` vs `switch` | household 车道 |
| `preroute-order-guard` | 2 | `chat.ts` 缺锚点 `enrichedHistory = _ad.turnsFor` | 空间路由器车道 |
| `uuid-police-visibility` | 1 | 手写点在 `meetingIsolation.ts` | 户籍车道 |
| `recall-structure-guard S8` | 1 | 新 push 点 `【默契元素 · MemSym…` | MemSym 车道 |
| `evt-ownership` + `persistence-write-guard` | 3 | LEDGER #9 记录为第三层拆除遗留 | 既有 |
| `sql-schema-consistency` | 1 | `dialog_groups.dialog_group_id` 守卫 | **已做对照实验**：回退本批改动同样失败 |
| API key / smoke / e2e | 7 | 无 key 环境 + flaky | 既有 |

- **结论**：**0 项可归因于 n-gram 拆除**
- **处置**：本表写入 LEDGER 问题 #9 作为归因台账，修法属各车道

---

## 二、分批实施

### 批1 · 死代码清除（A1 + A2）
- 删 `MemoryConfig.ts` 的 `sandboxIndexBackfillBatch`
- 删 `WorkRepository.ts` 的 `chunkLongText` + `WORK_CHUNK_SIZE`
- **前置自检**：`grep` 双向确认零引用；`tsc --noEmit` 零错误

### 批2 · 文档债清偿（A3-1 ~ A3-6 + A4）
- 按上表逐条改写，**保留原注释的红线语义**，只去掉已消失的机制描述
- 与批1 合并提交（A3-1、A3-3 随批1 走）

### 批3 · ShadowLog 语义收口（A5）
- 按「甲」方案改写头注（除非业主改选「乙」）

### 批4 · 归因台账入账（A6）
- 本任务书 §一.A6 表格写入 `docs/LEDGER.md` 问题 #9

---

## 三、验收判据

| # | 判据 |
|---|---|
| 1 | `grep -rn "sandboxIndexBackfillBatch\|chunkLongText\|WORK_CHUNK_SIZE" src/` = **0** |
| 2 | `grep -rn "search_index" src/ --include=*.ts` 的**非注释行** = **0**（B5 守卫已保证） |
| 3 | 过时注释 6 处全部改写，`grep` 不再出现「倒排索引启动补齐」「供 search_index 分块索引」 |
| 4 | `npx tsc --noEmit` 退出码 0 |
| 5 | **全量测试失败数 ≤ 30**（不得新增）；`sql-schema-consistency` 仍为既有那 1 项 |
| 6 | `ShadowLog` 头注不含「双跑」「旧链路」字样 |

---

## 四、回滚

| 批 | 方式 |
|---|---|
| 批1/批2/批3 | `git revert <commit>`（纯删除与注释改写，无数据依赖） |
| 批4 | 文档，直接改回 |

**红线**：本任务**不得触碰** `data/` 下任何文件，尤其 `data/retrieval-v11/`（观测数据 append-only）。

---

## 五、风险登记

| 风险 | 处置 |
|---|---|
| `chunkLongText` 被**动态**调用（`repo['chunkLongText']()`）而 grep 看不到 | 删除前先 `grep -rn "chunkLongText"` 含字符串形式；删后跑 works 相关测试 |
| `sandboxIndexBackfillBatch` 被 yaml 用户配置引用 | `grep config/` 确认；已实测 yaml 中无该键 |
| 改注释时误伤仍有效的红线 | 逐条对照原文，只删「已消失的机制」，保留「禁止…」的规范语义 |

---

## 相关

- `任务书_V11彻底完成-n-gram拆除-v1.md`（上游，B1–B5 已结项）
- `docs/LEDGER.md` 问题 #9（全量测试基线红）
- B5 守卫：`src/__tests__/sql-schema-consistency.test.ts` `[B5] n-gram 拆除防复发守卫`
