# 太虚境 · 数据存储清单

> 所有存储位置的完整索引 — 数据库 / 数据文件 / 缓存 / 日志
> 最后更新: 2026-06-28

---

## 一、数据库（SQLite）

### 1.1 核心主库

| 数据库 | 路径 | 大小 | 包含表 |
|:-------|:-----|:---:|:-------|
| **fusion_memory.db** | `D:\wenstar\data\webui\fusion_memory.db` | ~32 MB | conversations(547条), memories(124条), black_diamond(45条), knowledge_base(35条), knowledge_chunks(182块), master_profile(227条), master_affairs(19条), master_network(22条), dream_logs, 等 |

### 1.2 家族图谱库

| 数据库 | 路径 | 包含表 |
|:-------|:-----|:-------|
| **family_graph.db** | `D:\wenstar\data\webui\knowledge\family_graph.db` | nodes(39节点), edges(105边) |
| family_graph.db(副本) | `D:\wenstar\data\knowledge\family_graph.db` | 同上(副本) |

### 1.3 其他数据库

| 数据库 | 路径 | 用途 |
|:-------|:-----|:------|
| vault.db | `D:\wenstar\data\memory-vault\vault.db` | 记忆库备份 |
| conversations.db | `D:\wenstar\data\webui\conversations.db` | 旧版对话库(迁移后保留) |
| audit.db | `D:\wenstar\bionic-cognitive-engine\data\audit.db` | 仿生智脑审计 |
| __m7_test_*.db | `D:\wenstar\__m7_test_*.db` | M7测试库 |

---

## 二、数据库备份

### 2.1 统一备份

| 位置 | 文件格式 | 数量 | 说明 |
|:-----|:---------|:---:|:------|
| `D:\wenstar\data\backups\` | `family_graph_*.db` | ~100个 | 家族图谱每15-30分钟备份 |
| `D:\wenstar\data\backups\` | `knowledge_*.db` | ~100个 | 融合存储每15-30分钟备份 |
| `D:\wenstar\data\backups\` | `vault_*.db` | ~100个 | 记忆库备份 |

### 2.2 记忆库独立备份

| 位置 | 文件格式 | 保留 |
|:-----|:---------|:-----|
| `D:\wenstar\data\memory-vault\backups\` | `vault_2026-06-*.db` | 每日备份，保留约20天 |

### 2.3 历史快照备份

| 位置 | 内容 |
|:-----|:------|
| `D:\wenstar\backups\20260612-171509\` | 2026-06-12全量快照(fusion_memory + family_graph) |

---

## 三、结构化数据（JSON文件）

### 3.1 运行时数据

| 文件 | 路径 | 用途 |
|:-----|:-----|:------|
| **api_keys.json** | `D:\wenstar\data\webui\api_keys.json` | API Key存储 |
| **calendar.json** | `D:\wenstar\data\webui\calendar.json` | 日历事件(旧系统) |
| **reminders.json** | `D:\wenstar\data\webui\reminders.json` | 提醒数据(旧系统) |
| **notes.json** | `D:\wenstar\data\webui\notes.json` | 笔记数据(旧系统) |
| **self_model.json** | `D:\wenstar\data\self_model.json` | M6自我模型持久化 |
| **somatic_memory.json** | `D:\wenstar\data\webui\somatic_memory.json` | 躯体记忆数据 |
| conversations.json | `D:\wenstar\data\webui\conversations.json` | 旧版对话记录 |
| tts_test_response.json | `D:\wenstar\data\webui\tts_test_response.json` | TTS测试响应 |

### 3.2 梦境与归纳

| 文件/目录 | 路径 | 数量 |
|:----------|:-----|:----:|
| **pending_dreams.json** | `D:\wenstar\data\dreams\pending_dreams.json` | 待处理梦境队列 |
| **interaction_logs.json** | `D:\wenstar\data\dreams\interaction_logs.json` | 交互日志 |
| **induction_*.json** | `D:\wenstar\data\inductions\` | 75个归纳记录文件 |

### 3.3 观测数据

| 文件/目录 | 路径 | 数量 |
|:----------|:-----|:----:|
| **snapshot-*.json** | `D:\wenstar\data\observation\` | 34个观测快照 |
| quick-checks.json | `D:\wenstar\data\observation\quick-checks.json` | 快速检查结果 |
| final-report.json | `D:\wenstar\data\observation\final-report.json` | 最终观测报告 |

### 3.4 词库与路由

| 文件 | 路径 |
|:-----|:------|
| **emotion_lexicon.json** | `D:\wenstar\data\lexicons\emotion_lexicon.json` |
| **l0_routing.json** | `D:\wenstar\data\lexicons\l0_routing.json` |
| **entity_rules.json** | `D:\wenstar\src\m1\config\entity_rules.json` |
| **taxonomy_v1.json** | `D:\wenstar\src\m1\config\taxonomy_v1.json` |
| **self_model_v1.json** | `D:\wenstar\src\m1\config\self_model_v1.json` |

### 3.5 区域数据 (Zone)

| 文件 | 路径 |
|:-----|:------|
| emotion_valence_zone.json | `D:\wenstar\data\webui\zones\emotion_valence_zone.json` |
| language_semantic_zone.json | `D:\wenstar\data\webui\zones\language_semantic_zone.json` |
| social_schema_zone.json | `D:\wenstar\data\webui\zones\social_schema_zone.json` |

### 3.6 报告

| 文件 | 路径 | 用途 |
|:-----|:-----|:------|
| kb-intimate-scan-*.json | `D:\wenstar\data\reports\` | 知识库亲密内容扫描报告 |
| migration-*.json | `D:\wenstar\data\reports\` | 数据迁移报告 |

### 3.7 测试数据

| 文件 | 路径 |
|:-----|:------|
| critical.json | `D:\wenstar\test\scenarios\critical.json` |
| empathy_baselines.json | `D:\wenstar\test\baselines\empathy_baselines.json` |

---

## 四、文件存储

### 4.1 知识柜（文件同步）

| 目录 | 路径 | 文件数 | 说明 |
|:-----|:-----|:-----:|:------|
| **docs/** | `D:\wenstar\data\knowledge-cabinet\docs\` | 84个 | 知识库文件同步目录 |
| images/ | `D:\wenstar\data\knowledge-cabinet\images\` | 0 | 图片类知识 |
| videos/ | `D:\wenstar\data\knowledge-cabinet\videos\` | 0 | 视频类知识 |
| data/ | `D:\wenstar\data\knowledge-cabinet\data\` | 0 | 数据文件类 |

### 4.2 Markdown同步

| 目录 | 路径 | 文件数 |
|:-----|:-----|:-----:|
| **knowledge-md/** | `D:\wenstar\data\knowledge-md\` | 100个.md文件 |

### 4.3 音频文件

| 目录 | 路径 | 文件数 | 说明 |
|:-----|:-----|:-----:|:------|
| **audio/** | `D:\wenstar\data\webui\audio\` | 61个.mp3 | TTS生成的语音缓存 |

### 4.4 上传文件

| 目录 | 路径 | 文件数 | 说明 |
|:-----|:-----|:-----:|:------|
| **uploads/** | `D:\wenstar\data\webui\uploads\` | 32个 | 用户上传的原始文件(含重复上传) |

### 4.5 缓存

| 目录 | 路径 | 文件数 |
|:-----|:-----|:-----:|
| cache/ | `D:\wenstar\data\webui\cache\` | 4个 |

### 4.6 外部知识

| 目录 | 路径 | 说明 |
|:-----|:-----|:------|
| 01-待处理素材/ | `D:\wenstar\data\external-knowledge\01-待处理素材\` | 待导入素材 |
| 02-知识笔记库/ | `D:\wenstar\data\external-knowledge\02-知识笔记库\` | 已处理笔记 |
| 03-原始附件归档/ | `D:\wenstar\data\external-knowledge\03-原始附件归档\` | 原始文件归档 |
| 04-回收站/ | `D:\wenstar\data\external-knowledge\04-回收站\` | 已删除文件 |

---

## 五、日志文件

| 文件 | 路径 | 用途 |
|:-----|:-----|:------|
| **server.log** | `D:\wenstar\server.log` | 后端服务运行日志 |
| **bionic.log** | `D:\wenstar\bionic.log` | 仿生智脑适配器日志 |
| **start-all.log** | `D:\wenstar\start-all.log` | 前端守护进程重启日志(自动生成) |

---

## 六、配置与环境

| 文件 | 路径 | 用途 | 敏感 |
|:-----|:-----|:------|:----:|
| **.env** | `D:\wenstar\.env` | 环境变量(DEEPSEEK_API_KEY等) | 🔴 **是** |
| .env.example | `D:\wenstar\.env.example` | 环境变量模板 | 否 |
| package.json | `D:\wenstar\package.json` | 后端依赖声明 | 否 |
| tsconfig.json | `D:\wenstar\tsconfig.json` | 后端TypeScript配置 | 否 |
| ui/package.json | `D:\wenstar\ui\package.json` | 前端依赖声明 | 否 |
| ui/vite.config.ts | `D:\wenstar\ui\vite.config.ts` | Vite构建配置 | 否 |
| ui/tsconfig.json | `D:\wenstar\ui\tsconfig.json` | 前端TypeScript配置 | 否 |
| ingestion-guard.ts | `D:\wenstar\src\config\ingestion-guard.ts` | 摄入守卫配置 | 否 |
| CLAUDE.md | `D:\wenstar\CLAUDE.md` | Claude Code项目指令 | 否 |

---

## 七、外部依赖与模型

| 目录 | 路径 | 大小 | 说明 |
|:-----|:-----|:---:|:------|
| **node_modules/** | `D:\wenstar\node_modules\` | 大 | 后端Node.js依赖 |
| **ui/node_modules/** | `D:\wenstar\ui\node_modules\` | 大 | 前端Node.js依赖 |
| voxcpm2/ | `D:\wenstar\voxcpm2\` | 大 | ChatTTS/MOSS语音模型 |
| bionic-cognitive-engine/ | `D:\wenstar\bionic-cognitive-engine\` | 大 | 仿生智脑(离线) |
| chi_sim.traineddata | `D:\wenstar\chi_sim.traineddata` | — | Tesseract OCR中文模型 |
| eng.traineddata | `D:\wenstar\eng.traineddata` | — | Tesseract OCR英文模型 |

---

## 八、文件存储关系图

```
用户上传文件
    │
    ▼
data/webui/uploads/ (32个原始文件)
    │ 自动入库
    ▼
fusion_memory.db → knowledge_base 表 (35条)
    │ 同步到文件
    ├──→ data/knowledge-cabinet/docs/ (84个同步文件)
    └──→ data/knowledge-md/ (100个.md同步文件)
    │ 分块+向量化
    └──→ knowledge_chunks 表 (182块, 99%有向量)

TTS语音生成
    │
    ▼
data/webui/audio/ (61个.mp3临时文件)

对话数据
    │
    ▼
fusion_memory.db → conversations 表 (547条原始)
                      → memories 表 (124条结构化)
                      → black_diamond 表 (45条永久)

主人画像
    │
    ▼
fusion_memory.db → master_profile (227条)
                      → master_affairs (19条)
                      → master_network (22条)

家族图谱
    │
    ▼
data/webui/knowledge/family_graph.db → nodes (39) + edges (105)
```

---

## 九、存储策略说明

| 数据 | 保留策略 | 清理机制 |
|:-----|:---------|:---------|
| conversations | 永久保留(只标记`is_compacted`) | 无物理删除 |
| memories | 动态衰减+黑钻晋升 | 钙化衰减至0自动归档 |
| black_diamond | 永久保留 | 上限200条后降级最低钙化 |
| knowledge_base | 用户自主管理 | 无自动删除 |
| 记事记忆(note) | `is_valid=0`标记失效 | `cleanExpired(365)`定期清理 |
| TTS音频 | 临时缓存 | 无自动清理 |
| 归纳记录 | 永久保留 | 无自动清理 |
| 观测快照 | 永久保留 | 无自动清理 |

---

## 九·一、核心表写入通道（列清单单一事实源）

> 2026-09-19 批 2 立规（arch_structural_defect 收口）。本节**取代**任何“某个写入点该写哪几列”的口头约定。

### 规则

三张核心表的列清单**只允许一个事实源**，任何写入点不得自行手写列清单：

| 表 | 唯一事实源 | 强制入口 |
|:--|:--|:--|
| `conversations` | `ConversationDB.CONVERSATION_INSERT_COLUMNS` + `buildConversationInsert()` | 任何写入必须经 `buildConversationInsert()` |
| `memories` | `SQLiteAdapter.writeMemory()` 内置列清单 | 任何写入必须经 `writeMemory()` |
| `black_diamond` | 归属/溯源由**源记忆同源继承**（`VaultManager.addBlackDiamond` 一次回查取两列） | — |

`buildConversationInsert()` 的 bind 顺序**由列清单本身派生** ⇒ “占位符数 ≠ bind 数”与“列/值错位”在结构上不可能发生。
回归防线：`src/m2/__tests__/write-channel-single-source.test.ts`（含 SQL 逐字比对）。

### 为什么立这条规（已发生的事故）

同表多写入点各自维护列清单，导致同类漂移反复爆发：

1. **`conversations` 双通道**：`ConversationDB`（22 列）vs `SQLiteAdapter.insertConversation`（13 列）
   → `belong_entity_uuid` 恒 NULL、`message_id` 仅 4/3949、`entity_names` 被写成 JSON 数组
   （实库既定形态为逗号分隔）、`is_summary` 被绑成 `is_compacted`（V23.1 修复未同步）。
2. **`memories`**：`fg_entity_names` 全库 2012 条归零；锚点基因被抹（log 写 735 / 落库 348）；
   `writeMemory` 自身**也**缺 `source_type` 列、`effective_strength` 被硬编码 1.0。
3. **`black_diamond.dna_root_id`** 全库 0/390（251 行有 `source_id`，其中 247 行可从源记忆回填）。

### 归属语义（《UUID 户管管理法》第七条）

| 情形 | 取值 |
|:--|:--|
| 派生自单条源记录（记忆→黑钻、记忆→知识库） | **继承源记录**的 `belong_entity_uuid` / `dna_root_id` |
| 跨实体聚合 / 缓存派生（梦境洞察、月度主题、前瞻模拟、第二大脑文档） | **unowned（NULL）**，必须在列清单里显式写出并注明依据 |
| 会晤对话 | 会晤实体 UUID（由 `persistence-stage` 的 `resolveOwnership` 决定） |

⚠️ `OWNER_UUID = 'TXS-000000001'` 是**玉瑶（系统默认本体）**，不是用户本人 —— 系统生成的聚合件不得以“像户主的”为由写成它。

### 收口进度与数据回填（2026-09-19 批 0–4）

**收口的准确口径（修正批 2/3 当时过宽的说法）：**

- ✅ **适配器之外的写入点已全部归一** —— `VaultManager` / `SleepTimeConsolidator` / `YuyaoMemoryService` /
  `ConflictDetector` / `DailyMaintenanceScheduler` / `ProspectiveSimulator` / `AutoLearnPlugin`
  共 7 个写入点均已收口到 `SQLiteAdapter.writeMemory()`，全仓再无外部手写列清单。
- ⚠️ **适配器内部仍有 3 份 `memories` 列清单**：`write(record)`（:854，50 列，**主存储路径**，10 个调用点）、
  `writeMemory(opts)`（:1016，47 列）、锚点重建器（:2309，32 列）。它们**不是**由同一事实源派生，
  但均被守卫 D8v2 的文本扫描覆盖（改动任一份的登记列都会被报错）。
- ⚠️ **`conversations` 的列清单是运行时拼接**（`buildConversationInsert` 用 `cols.join(', ')`）
  ⇒ **文本扫描器看不到它**。它的守卫登记项仅为文档意图；真正的防线是语义测试
  `src/m2/__tests__/write-channel-single-source.test.ts`（断言列清单含 8 个关键列 + SQL 逐字比对 + 真实 schema prepare）。

守卫 D8v2 存量违规 **28 处（含判据误报）→ 0 处**，`REPORT_ONLY` 已置 **false**
⇒ 从「只报不管」转为 **fail-closed 回归防线**（新增违规即测试失败）；
并新增「**登记表零命中检测**」（防止某表被改成拼接 SQL 后登记项静默失效 —— 这正是 `conversations` 踩过的坑）。

`writeMemory` 列清单补齐了记事（note）子系统的五列：`note_key` / `is_valid` /
`remind_at` / `reminded` / `repeat_rule`（缺省值与 DDL 默认值完全一致，对现有调用方零行为变化）。

### 批 4：`memories` 写入语句的 P0 修复（2026-09-19）

**事故**：`writeMemory` 原先用 `INSERT OR REPLACE`，而 `memories` 除 `PRIMARY KEY(id)` 外还有
**`UNIQUE(seq_pos)`** ⇒ `OR REPLACE` 对**任一**唯一冲突都先 `DELETE` 再 `INSERT`，即用不同 id 撞上同
`seq_pos` 时会**静默删掉另一条记忆行**（已在库副本上复现：受害原行消失、表总行数不变）。
旧语句下的 DELETE 还会触发外键副作用（`memory_entities ON DELETE CASCADE` /
`black_diamond.source_id ON DELETE SET NULL`）。

**已发生的删除痕迹**：4 条 `black_diamond.source_id` + 21 条 `memory_entities` 指向不存在的记忆。
> ✅ **已于 2026-09-19 停服窗口清理并验证**：
> - 4 条黑钻悬空 `source_id` → `SET NULL`（**修复指针，未删任何黑钻行**），清理后悬空数 = 0（起服后再验仍为 0）；
> - `memory_entities` 孤儿（清理时已涨到 39 条 —— 正是修复前旧代码持续删行的证据）**未删除**（惰性数据，删它触犯「只增不删」）：**起服后降至 2 条** —— 启动时的锚点重建把曾被 REPLACE 删掉的锚点行（确定性 id `<dna>_DG`）重新写入，孤儿因此被重新关联；
> - 同窗口把 `data/webui/` 下 11 个 `fusion_memory.db.bak*`（2026-08-05~09-02 历史备份，共 ≈1.5GB）**移走至 `D:/work/wenstar-backup-archive/`**（移动，非删除，可回退）。

**验证证据（停服窗口后）**：改动过的测试文件 66/66 通过；之前因 `.bak` 残留而红的 3 个 CLI 测试 60/60 转绿；全量 `vitest run` 由 **23 → 10** 失败（2516 通过），剩余 10 个已用**隔离实验**逐个归因：2 个 runtime-smoke 单独跑 22/22 全绿（并行争抢超时假象），其余 8 个均为显式 `Test timed out in 30000/60000/160000ms`（LLM 延迟），**0 个可归因于代码**。

**修复（两层）**：

1. `writeMemory` 改为 **`INSERT ... ON CONFLICT(id) DO UPDATE SET <全列 = excluded.…>`**：
   - 同 id 重写的语义与 `REPLACE` 等价（全列覆盖），但**不再 DELETE** ⇒ 无级联副作用；
   - `seq_pos` 冲突从「静默删行」变为**抛错**（被方法 catch → `return false` + 日志）⇒ 失败可见。
   - 验收：库副本上同参数对比可复现 —— 旧语句删行，新语句报 `UNIQUE constraint failed: memories.seq_pos` 且受害行完好。
2. 砂金→金库晋升不再复用 `conversations.seq_pos`，改为**批量预分配 `MAX(seq_pos)+1, +2, …`**
   （与 `MemoryAssessor.ts:211` 同范式）；否则它与 `persistence-stage` 以同一个 `seq_pos` 写同一张表，
   是**构造性**相撞而非概率事件。

**同批其它修正**：`VaultManager` 的 `dna_root_id` 调用方分支补脏值净化（`'null'`/空串不落库）；
守卫新增登记表零命中检测；语义测试补 `dna_root_id` 断言并修正只匹配 `INSERT INTO` 的正则（曾漏
`INSERT OR IGNORE/REPLACE INTO`）。

### 批 5：同一 P0 机理的彻底收尾 + 守卫自愈（2026-09-19）

批 4 只改了 `writeMemory`，`SQLiteAdapter.write()`（**主存储路径**，10 个调用点）仍是 `INSERT OR REPLACE`
⇒ 同一机理（撞 `UNIQUE(seq_pos)` 就静默删行）仍在。本批收尾：

1. **`write()` 也改为 `ON CONFLICT(id) DO UPDATE`** —— 不再依赖“每个调用方自觉预分配 seq_pos”。
2. **另两处 `-(Date.now() % 1000000)`**（`_syncSecondBrainToGold` / `addGoldEntryFromKnowledgeVault`，
   值域每 ≈16.7 分钟循环一次 ⇒ 可重复）改为从**负值带单调向下分配 `MIN(seq_pos)-1`**，
   既保持“派生记忆排在最近序之后”的原语义，又结构上不可能重复。
3. **守卫自愈（修掉“收口反而让防线失明”的三例）**：
   - `src/m2/__tests__/memory-write-columns.test.ts`：匹配式从 `INSERT OR REPLACE INTO memories`
     扩到全形态（含新的 `ON CONFLICT`）—— 否则**主写入路径对旧守卫不可见**；
   - `src/__tests__/memory-insert-notnull-columns.test.ts`：`>= 6 个写入点` 的**计数断言 →
     能力断言**（“适配器自身 3 个写入点必须全被扫到”）—— 计数前提被收口工程自然打破；
   - `src/app/vault/__tests__/belong-uuid-propagation.test.ts`：**位置断言 `params[len-1]` →
     按列名取值**（新增 `colValue()` 助手，含固定字面量列处理）。

> 🔴 **操作教训（已写入全局 AGENTS.md 经验 21）**：“收口/重构”会**静默使依赖“字面形态、列清单顺序、写入点数量”的旧守卫失明**。
> 因此改动前必须 grep“谁会因我的改动而失明”；宣布完成前必须跑**全量** `vitest run` 并以「修前失败集 vs 修后失败集」的差集为证据，无法归因的失败必须标注“未归因”。
> 另注：流水线 `S5_Compile_Test`（声称“单元测试全量运行”）**未能报出**上述 3 个失败，不可当“测试全绿”的证据 —— 建议 Harness 侧排查。
> 全量跑中的 11 个 runtime-smoke 失败经实验证实是**并行争抢导致的 5s 超时假象**（串行跑：68/69 通过），不是代码缺陷。

---

### 数据回填（仅有确定来源的 274 行）

| 目标 | 回填行数 | 来源 |
|:--|:--|:--|
| `black_diamond.dna_root_id` | 247 | 回查源记忆 `memories.dna_root_id`（与写入端同一口径） |
| `memories.dna_root_id` | 27 | id 形如 `<dnaRootId>_DG` 的对话组锚点，前缀即 dna |

**不可回填（已实测确认，属历史缺口，不是漏做）**

| 项 | 行数 | 为何不可回填 |
|:--|:--|:--|
| `memories.fg_entity_names` | 3220 | 这些行的 `entity_genes` **全为 `'[]'`**，且 `memory_entities` 映射数为 **0** ⇒ 源头从未记录，无任何可推导来源（D3 修复 2026-09-11 之前的遗留行） |
| `conversations.message_id` | 3955 | 该列契约明写「原值写入，不 trim/coerce/**生成**/复用」⇒ 生成即违约；历史行无源 |
| `knowledge_base.belong_entity_uuid` | 95 | 94 行 `dream_behavior`（跳实体会话聚合）+ 1 行 `monthly_topic` ⇒ 按第七条为 **unowned**，保留 NULL 才是正确答案 |

**回填执行纪律（经验 #19）**：SQLiteAdapter 用 sql.js 内存库 + 定时 export 落盘 ⇒ **任何绕过它的直接文件修改都会被下一次 flush 用旧内存快照覆盖**。因此顺序固定为：
**停服 → 备份 → 改库 → 验证磁盘 → 起服 → 再验证一次**。

---

### 回滚方案

改动互相独立，可按需回退：

```bash
git checkout -- src/m2/ConversationDB.ts src/m2/SQLiteAdapter.ts \
  src/app/vault/VaultManager.ts src/engine/tianquan/temporal/SleepTimeConsolidator.ts
rm src/m2/__tests__/write-channel-single-source.test.ts
```

- **无表结构变更、无数据迁移** —— 回退不需动库，也不需停服。
- 回退后新数据回到“部分列不写”的旧行为；**已写入的正确归属不会被破坏**（改动只在写入端，不修改历史行）。
- 数据面唯一残留：本批之前已产生的无归属历史行（黑钻 `dna_root_id` 0/390 等）需另行回填
  （批 3，顺序：停服 → 改库 → 验证磁盘 → 起服 → 再验）。

---

## 九·二、数据安全守卫（2026-09-19 数据丢失事故后加固）

### 事故实录

**现象**：生产库 `data/webui/fusion_memory.db` 由 **229MB / 4068 对话** 被覆盖为 **3.9MB / 84 对话**（数据一度只剰空库）。

**机理（三环相扣）**：
1. `sql.js` 内存库落盘 = `export()` + `writeFileSync(dbPath)` —— **直接覆盖整个磁盘文件**；
2. 全仓该写法共 **4 处**（repair / startup-verify / flushNow / shutdownFlush），**全部无任何空库保护**；
3. 一旦某实例以「空库 / 加载异常」状态跑起来，它的一次 flush 就抹掉全部生产数据。

**触发（含人为因素）**：
- 批 4/5 把 `write()` 从 `INSERT OR REPLACE` 改为 `ON CONFLICT(id) DO UPDATE` 后，`seq_pos` 冲突由“静默替换”变成**抛错**（这是有意的“失败可见”）；而 M9 `WorkingMemory.consolidate()` 这类**批处理**路径无 catch ⇒ 出现 `[Server] 未捕获Promise拒绝: UNIQUE constraint failed: memories.seq_pos`。
- 为摄入 PM2 托管而反复 start/kill（37 → 324 → 1075 次重启 + 孤儿子进程）⇒ **多实例并存**，放大了“空库实例 flush”的窗口。

**处置**：停服阻断 → 备份完整性先行校验（220.7MB / conversations=4068 / memories=5970）→ 回滚 → 被清空的库留证（`data/backups/fusion_memory.EMPTIED-*.db`）→ 起服并核验历史数据在位（最早对话 2026-08-27）。

### 两层守卫（已落地并有回归测试）

| 层 | 位置 | 行为 |
|:--|:--|:--|
| **① 加载期** | `SQLiteAdapter.initialize()` | 磁盘库 ≥5MB 但载入后 `memories`/`conversations` **均 0 行** ⇒ **抛错拒绝启动**（宁停不毁数据） |
| **② 落盘期** | `SQLiteAdapter._safeWriteDbFile()` | 将原 **4 处** `writeFileSync(dbPath, ...)` 收成**单一咽喉**；写入前若“内存库两表空 + 磁盘文件大”⇒ **拒绝覆盖** + CRITICAL 告警 |

阈值常量：`DB_EMPTY_GUARD_MIN_BYTES = 5MB`（生产库常态 ≥ 200MB；≤5MB 的新建/测试库不受影响）。
回归防线：`src/m2/__tests__/empty-db-guard.test.ts`（4 例：加载期拒绝、落盘期拒绝且文件字节数不变、正常库不误伤、原子写无 `.tmp-*` 残留）。

### **③ 原子写**（2026-09-20 补上“数据丢失”的另一半风险）

上表两条防的是“**空库**覆盖”；还有同类而更隐蔽的一种：`writeFileSync(dbPath, ...)` **直接写目标文件、不是原子操作** ——
若写入过程中进程被杀 / 磁盘满 / 分配失败，磁盘上的库会被留在**截断/损坏**状态；后果与空库事故同源
（加载守卫抛错 ⇒ 停机，数据只能回到最近一次备份）。

**修法**（`_safeWriteDbFile` 内）：`openSync(tmp) → writeSync → fsyncSync → renameSync(tmp, dbPath)`：
- 同盘 `rename` 在 NTFS 上是**原子替换**，因此磁盘上永远只有“旧完整库”或“新完整库”两种状态；
- `fsyncSync` 强制刷盘，避免 rename 后内容仍在页缓存、掉电丢失；
- 失败时删除 tmp 并返回 false（**原文件保持完好**）。

验证：真实对话写入后 `PRAGMA integrity_check = ok`、行数正确、`data/webui/` **无 `.tmp-*` 残留**；
服务响应回到 0.03–0.06s（无性能回归）。

### **④ 批处理失败可见性**（2026-09-20，批次 B）

事故链的一环：`M9 WorkingMemory.consolidate()` 抛错时**没有 catch**，异常会一路冒到
`setInterval(async () => …)` 的回调 → 变成 `unhandledRejection`；而 `push()` 里的
`.catch(() => {})` 又把失败**静默吞掉** ⇒ 既不可见也不可控。

**修法**（`src/m9/WorkingMemory.ts`）：
- `consolidateSafe()` 补上 `catch`：**计数（累计/连续）+ 告警（含原因与滞留条数）**，且 **不 rethrow**
  （定时器不再产生未捕获拒绝）；
- `startFlushTimer` 回调由 `async` 改为普通回调 + 显式 `.catch()`；`push()` 的静默 catch 改为告警；
- `getStatus()` 新增 `consolidateFailures` / `consecutiveConsolidateFailures`（健康检查可据此告警）。

**不变量**：失败时 **buffer 保持不动**（失败条目留在缓冲待下一轮重试，不静默丢弃）。
回归防线：`src/m9/__tests__/working-memory-failure-visibility.test.ts`（3 例：
①手动路径不 reject + 打印 + 计数 + 条目不丢；②定时器路径不产生 unhandledRejection；③换可用存储后计数清零且条目毕业）。

> 注：`m7/M7Orchestrator.ts` 的同类定时器已在 try/catch 内（本次核查确认，无需改）。
>
> **2026-09-20 收尾（`src/webui/maintenance.ts`）**：实体离线终审的 `setInterval(async)` 原先**无 catch**、
> 首轮 `void this.runEntityTriage()` 是**浮空 promise**、首轮 compaction/GC 两处 `.catch(() => {})` 静默吞错
> —— 4 处一并补齐（失败告警 + 非阻塞），与本节不变量一致（失败可见、不静默）。
>
> **同批：`DEDUP_SKIP` → 「重复即更新」**（2026-09-20，用户决定；`src/app/knowledge/KnowledgeEngine.ts` + `src/webui/server-knowledge-routes.ts`）：
> 知识重复提交不再直接拒给（409），而是**更新既有条目**；合并策略采用**追加不覆盖**
> （纯函数 `mergeDuplicateContent`：新内容为空⇒不变；旧已包含新⇒不重复追加（幂等）；否则旧+分隔线+新）
> ⇒ **旧条目的独有信息不会因“准重复”而永久丢失**。状态码区分：新建 **201** / 命中重复并更新 **200**（响应体带 `updated:true` 与 `dedup_hit`）；
> 既有条目被 `locked` 或读不到时，仍退回 409 + 既有条目信息（可发现、可定位）。
> 回归防线：`src/app/knowledge/__tests__/dedup-merge.test.ts`（5 例：空新内容不追加 / 幂等 / 旧内容完整保留 / 空旧取新 / 非字符串安全）。

### **⑤ 异步落盘 + 防抖窗口 60 秒**（2026-09-20，C1-a / C1-b / C1-d）

**问题（实测）**：sql.js 每次落盘都是**全库重写**（当前 224MB），而 `writeSync`/`fsyncSync` 是同步 API
⇒ 落盘期间**整个服务被冻结**。实测：一轮真实对话触发 **19 次整库重写（≈4.16GB）**；
正常响应 30ms，而**落盘当秒平均 807ms、峰值 2033ms**；空闲时 120 秒 0 次（由活动驱动，非空转）。
根因：150ms 防抖窗口合并不上一轮对话里**时间上分散**（约每 2 秒一次）的写入。

**修法**
- `_safeWriteDbFileAsync`（新增）：`fsp.open → write → FileHandle.sync → rename`，**异步**；
  语义与同步版**完全一致**（共用空库守卫 + tmp→fsync→原子 rename + 失败删 tmp 保原文件）；
- `flushNowAsync()`：周期路径入口，`_flushing` 防重入 + `_flushPending` 保证"最后一次写入仍会落盘"；
- `_writeSeq` **写入代次**：在途的旧写入在 rename 前重新校验代次，若期间已有更新的落盘则**放弃本次 rename**
  （防"旧内容覆盖新内容"，含 `shutdownFlush()` 同步写的场景）；
- `_passesEmptyDbGuard`：空库守卫抽为同步/异步**共用**的单一事实源（避免"一个口子守、一个不守"）；
- `_FLUSH_INTERVAL` 150ms → **10s**（C1-b）→ **60s**（C1-d/A，2026-09-20，用户决定；可 `TIANQUAN_FLUSH_INTERVAL_MS` 覆盖）；
  `_FLUSH_BATCH=50` 仍为硬上限兜底。60s 与上层 M9 缓冲窗口对齐；实测写盘频率由 ~3.0 次/分钟 降到 ~1.3 次/分钟。
  ⚠️ 该值**必须保持纯数字字面量**（`src/cli/health-check.ts` 静态提取 + `INTERVAL_MAX=60000`），详见 `SQLiteAdapter` 内注释；
- `shutdownFlush()` 保留**同步**全量落盘 ⇒ **正常关闭/重启不丢**；仅断电/强杀最多丢一个窗口。

回归防线：`src/m2/__tests__/flush-async-window.test.ts`（4 例：异步落盘期间事件循环持续推进 /
同步落盘必然阻塞的对照 / 窗口默认 10s 与 env 可配 / 窗口内不落盘·超窗落盘·落盘后仍能再排程）。

### 同批修复：`write()` 的 seq_pos 冲突

批 4/5 引入的副作用已收尾：`write()` 在写入前**预检** `seq_pos` 是否已被别的 id 占用，占用则重分配 `MAX(seq_pos)+1` 并写日志 —— 不再把异常抛入**无 catch 的批处理链路**（M9 工作记忆巩固）。

### 操作纪律（必须遵守）

1. **单实例**：服务由 PM2 托管（`pm2 start start.cjs --name wenstar-webui --max-memory-restart 1536M` + 日志重定向 + `pm2 save`）。**禁止再手动起第二个实例**；`start.cjs` 的 `server.lock` 会拒绝，但“杀父不杀子”会留下**孤儿子进程**（它占着端口+锁 ⇒ 新实例永远启不来 ⇒ PM2 无限重启）。
2. **启停用 PM2**：`pm2 restart wenstar-webui` / `pm2 stop wenstar-webui`；需要彻底清场时，先按**端口占用的 PID** 精确杀（`netstat -ano | grep :3000`），确认无监听后再删 `data/webui/server.lock`。
3. **改库前先停服**（经验 #19），并**先备份**；事后起服**再验一次**（防内存态覆盖）。
4. **可观测性优先**：启动服务必须带日志重定向（PM2 `--output/--error`）。本仓曾因“启动时丢弃 stdout/stderr”而在同一个根因周围排查数小时。

---

### **⑥ FG 幂等迁移与 M 层埋点**（2026-09-20）

- **FG 幂等加列**：`FamilyGraph.ensureColumn(table, colDef)` —— 先 `PRAGMA table_info` 再 `ALTER`，
  替掉原先 `try{ALTER}catch{warn}` 的写法（列已存在时每次启动都刷 `duplicate column name`，实测 **72 次**）。
  本方法**不改 schema**（仅在缺失时补齐既有列，DB 实际已有），异常仅告警不中断启动。
- **M 层埋点**：`ensureColumn` 输出 `module_entry/module_exit + 耗时`；`DNAEncoder.encodeSingle` 为热路径，
  改为**每 100 次汇总一次**（计数/失败数/平均耗时），兼顾可观测性与日志体积。
- 参考治理文档：`docs/fg-profile-entry-governance.md`（FG 人物档案录入治理）；
  角色扮演隔离判定在 `src/engine/tianquan/prefrontal/ConstraintValidator.ts:192`（`roleplay_forbidden`，本次未触动）。

### **⑦ 基因回填的别名口径修复**（2026-09-22）

`loadFgPersonEntries` 原先把姓氏过滤（防滑窗垃圾）也套在**别名**上 ⇒ 「诗雨」这类无姓氏别名被丢弃
⇒ 只写别名的记忆永远匹配不上：实测基因回填只填 **3 条**（修正后应能填 **39 条**）。
现改为：姓氏过滤只作用于**节点主名**（节点级判断）；别名保留最小防护（非空 / ≠主名 / 长度≥2）。
⚠️ 姓氏过滤本身抓不到“周末（周是姓氏）”“宿舍（宿也是姓氏）”这类垃圾 —— 那由上游滑窗检测负责（测试注释已说明）。

### **⑧ roleplay 记忆也回填基因**（2026-09-22，用户决定 A）

原策略：roleplay 记忆**按设计不建基因**（回填 SQL 显式 `!= 'roleplay'`）⇒ 实测全库 **1667 条** /
徐诗雨 **909 条** 长期无基因。现改为**也回填**，依据：
- 读侧已按 `memory_kind='roleplay'` **对称隔离**（`MemoryRetriever`：非会晤场景→排除；会晤场景→只保留本实体会晤记忆）
  ⇒ 补基因**不会泄漏**到户主（玉瑶频道）检索；
- `memory_entities`（第5 段）直接读 `entity_genes` 产物且无 roleplay 过滤 ⇒ 自动同步受益。

**未改**：写侧的“五要素豁免（roleplay）”—— 新建 roleplay 仍允许无基因，由启动回填后续补齐。
（注：`person-entries-alias` 测试中已说明姓氏过滤抓不到“周末/宿舍”类垃圾，那由上游滑窗检测负责。）

### **⑨ 砂金→黑钻晋升的量纲归一**（2026-09-22）

**根因**：晋升规则阈值（4.5 / 4.0 / 3.5）是按 **0–5** 量纲写的，而 `calcium_score` 实测为 **0–1**
⇒ `calcium_score>=4.5` 与 `recall>=5` **均为 0 条** ⇒ 晋升通道等于死路；candidate 堆积至 **2927 条**（最老 08-02，51 天）。

**修法**：归一（`≤1` 视为 0–1 量纲 ⇒ ×5 归到 0–5；`>1` 视为已在 0–5/0–10 量纲 ⇒ 原值）；
阈值 4.5/4.0/3.5 原样适用；候选预筛 SQL 兼容两种量纲；**排序改用归一后分值**
（否则高数值的混合量纲行会把真正合格行挤出 `LIMIT` 窗口 ⇒ 永远升不动）；定时提炼上限 5 → **200**。

**上限与“只增不删”（用户决定 A，2026-09-22）**：原上限 200，且超出时 **`DELETE FROM black_diamond`**
—— 与铁律「记忆/卷宗/黑钻记录禁止删除」**冲突**。现定为：
- 上限 200 → **800**（`MemoryConfig.blackDiamond.maxCount`），且**只统计 `status='active'`**；
- 超出时**归档**（`status='removed'` + `notes` 记原因，**记录保留**）而非物理删除；源记忆仍降级回金库层；
- 已归档（removed）的源可**重新晋升**（`alreadyPromoted` 仅取 active）。

**实测（A 落地后）**：重启后一次批量晋升 **222 条**（此前 51 天零晋升）；
黑钻 511 → **694（只增不减）**；status 无新增 removed（上限未触发）；candidate 2927 → **2846**。

**干跑预测**（修正量纲后）：高钙化 31 + landmark 152 + 多因子 190 ⇒ 约 **373 条**可晋升；
其余 ~2554 条为 level 0–1 低钙化砂金 ⇒ **不应晋升**（不得滥发黑钻）。
防御：元对话/自我陈述仍不具资格（与钙化分无关）；回归防线
`src/app/vault/__tests__/diamond-promotion-scale.test.ts`（6 例，含 0–1/0–5 双量纲与“不滥发”断言）。

### **⑩ 存量测试垃圾隔离**（2026-09-22，用户决定 C）

**背景**：写入端守卫（⑥四/批 A）只能挡**新的**；存量里混入大量测试串（如“你好”×**427**、“帮我记个事”×124、
“徐诗雨”×103、“test-location…”×52、“<3 😊👍🎉 test”×73），且其中 **656 条处于 active/promoted（正在参与检索）**。

**判据（两条取并集，均可量化、可复核）**：
- **A 退化内容**：空白 / 长度<2 / 单字符重复 ≥6 / 不含字母数字汉字（纯表情标点）；
- **B 完全相同的短句重复 ≥20 次**（≤30 字）—— 真人不会把同一短句说上百次。

**执行结果（2026-09-22）**：共隔离 **1437 条**（A 206 + B 1231，去重后占全库 21%），
方式为 `lifecycle_state='suppressed'` + `suppression_reason` 注明原因 ——
**不删除任何记录**（符合「只增不删」），且可随时恢复：
```sql
UPDATE memories SET lifecycle_state='active', suppression_reason=NULL WHERE id=?;
```
**效果**：可检索记忆 6853 → **3082** 条；目标测试串残留 **0 条**；`integrity_check=ok`。
备份：`data/backups/fusion_memory.pre-junk-isolation-*.db`。

> 根治靠**测试隔离**（测试方应用独立 namespace）——否则清完又会脏。

### **⑪ 上下文历史排除测试行**（2026-09-22，连贯性修复）

**现象**：用户反馈“对话上下文连贯性不强”。

**诊断（数据）**：上下文由 KB（**8.4–8.6k 字符**）+ 历史（**1.1–1.4k**）构成 ⇒ **历史是连贯性主载体**；
而近 200 轮历史中 **30.5% 是测试行**（`is_test=1` **58 条** + `namespace='test'` 2 条 + 疑似测试/极短 61 条）
⇒ 她的对话流被「你好」「散会」「今天天气真好」「【隔离测试】…」类行打断。

**根因**：历史来自 `getRecentConversations()`（`server.ts:302`）→ `SQLiteAdapter` / `ConversationDB`
两条 SQL **只看 `is_compacted = 0`，从不读 `is_test` / `namespace`**（标记早就有，却没人读）。

**修复**：两条 SQL 加 `AND COALESCE(namespace,'default') <> 'test' AND COALESCE(is_test, 0) = 0`。
**实测**：近 200 轮历史 **145 → 111 条**；过滤后抽样全为真实对话（无「你好/散会」类）。

**排除项（本次排查确认未误伤）**：
- #C 隔离**未伤真人**：抽查 30 条 suppressed 全为测试串；
- 写入守卫**未拦真人短回复**：近 3 天 user 消息含 1 字数 2 条、2–3 字 148 条 ⇒ 短句正常入库。

**未根治**：未打标记的存量测试对话（如无 `is_test` 的「你好」）仍在历史里 —— 需把「⑩」判据应用于 `conversations` 表；
摘要（`is_summary`）路径待核；M4 检索单次耗时达 **19s**（性能观察项）。

### **⑫ 摘要通道打通**（2026-09-22，上下文连贯性 A+C）

**现象**：用户反馈“上下句不连贯、相关性不强、语义跳跃”。

**诊断（溢出路径三处断链，均实测）**：
1. `is_compacted=1` 占 **97%**（4593/4742）⇒ 旧对话全部移出历史；
2. 【对话摘要】内容行仅 **14 条**（其中 `is_summary=1` **11 条**）⇒ 摘要几乎没有生成；
3. **`src/webui/`+`src/m4/`+`src/m5/` 里没有任何 `is_summary` 读取方** ⇒ 摘要通道全程死；
⇒ 被压实的**前文既不在历史、也无摘要** ⇒ 上下文只剩 KB（8.4–8.7k，占 84%）+ 极少原始轮次 ⇒ **语义跳跃**。
（代码注释早已写明：`ConversationDB.ts:28/254`、`SQLiteAdapter.ts:798`、`maintenance.ts:380` ——“is_summary 与 is_compacted 占位符被绑到同一个值”。）

**修复**：
- **A（拼装）**：`ConversationDB.getRecentConversations` 独立取**最近 5 条 `is_summary=1`**（排除 test/roleplay），
  按时间升序**前置**作为“更早背景”，再接最近原始轮次；独立取数以免被主查询 LIMIT 挤占；异常兵底不阻塞历史。
- **C（数据+守卫）**：修正 `【对话摘要】` 行中 `is_summary≠1` 的标记；新增守卫
  `src/m2/__tests__/summary-channel-guard.test.ts`（4 例：**必须有读取方** / 必须排 test / 必须前置 / 异常兵底）。

**B（2026-09-22）：摘要改成 LLM 真摘要**

原实现（`compressTurnsSmart`）**不是 LLM 摘要**而是机械截断：`combinedUser = userTexts.join('').substring(0,60)`
⇒ `(已存金库) + 前 40 字` / `【历史对话】 + 前 80 字` ⇒ “摘要”实为残片（样本含测试串、原始片段）。

修法（**保持 maintenance 不感知 LLM 的既有设计**）：
- `maintenance.injectDeps` 新增可选项 `summarizeTurns`（与 `runDecay`/`entityTriageRunner` 同风格）；
- `server.ts` 注入实现（**服务层变更**）：惰性取 `llmProvider.rawCall` + 中性 system 提示词（400 tokens / temp 0.3）；
- maintenance 侧 `_summarizeChunk`：**LLM 优先**（`Promise.race` 20s 超时）→ 失败/未注入**回退机械压缩**（兵底放宽到 160 字）⇒ **不阻塞压缩**；
- 导出两个纯函数（可单测）：`normalizeCompactionSummary`（去换行/去嵌套前缀/限长/空值返回空串）、`buildCompactionPrompt`（标说话人、超长**保留尾部**、第三人称+禁止编造）；
- 摘要拼接上限 **200 → 600** 字。

回归防线：`src/webui/__tests__/compaction-summary.test.ts`（7 例）。
⚠️ 端到端：重启后调 `/api/maintenance/compact` 返回 `{before:86, after:86}`（历史未达压缩阈值）⇒ **真实路径上的 LLM 摘要输出待下次真实压缩验证**。

**未根治**：摘要**生成量**极少（源头：压实前的摘要生成几乎不触发，见 `maintenance.ts:438`）
⇒ 需扩大生成覆盖；另有 **M4 检索单次 12.5–21.7s**、**KB 占上下文 84%** 两个待评估项。

### **⑬ M4 延迟修复：PAE 提取不再内联阻塞**（2026-09-22）

**现象**：用户反馈“调取不顺 / 上下文不连贯”。

**实测（M4·timing 分段，prod 日志）**：
```
total= 1827ms | integrateFG=  569   ← 常态
total=20874ms | integrateFG=19774   ← 慢时（10–20 秒，占该次 assemble 的 95%+）
total=11605ms | integrateFG=10448
```
⇒ 慢的不是 batchProfile（稳定 ~300ms）、也不是 M4 里的 LLM 调用（M4 本体无 LLM 调用），而是 **`integrateFG`**。

**根因**：`FamilyGraph.integrateFromEntity` 内 `await this.extractProfileFromText(...)` ——
PAE 的 **LLM 档案提取**（超时 30s；成功时单次 10–20s）被**内联等待**
⇒ 整个回复栈在等一次**档案富化**（其产物是 dossier，属背景富化，**不需在回复前完成**）。
（配置注释写着“PAE 已异步化不再阻塞主链”，但这**两处从未改成异步** ✗；
而 `src/webui/chat/dialog-group-stage.ts:260` 一直是 fire-and-forget `.catch(()=>{})` ✔。）

**修复**：两处改为 `void …catch(告警)`（与既有写法一致；失败不丢数据，下次提及会重试）。
**实测**：修复后真实对话 `[M4·timing] total=1533ms | integrateFG=308`（由 10–20s ⇒ **0.3s** ✔）。
**回归防线**：`src/m4/household/__tests__/pae-nonblocking-guard.test.ts`（2 例：禁止内联 await / 必须有 fire-and-forget + catch）。

### **⑭ M4 三项缓存优化**（2026-09-22）

背景：M4 是 assemble 的最大头（修复前 P95 10.4s / 均值 2.9s）。已先修 `integrateFG`（PAE 内联等待）
⇒ 19s → **0.3s**（见⑬）。本次再优化两项（`retrieve` 每轮仅调用一次，缓存收益有限 ⇒ **未动**）：

- **fgSummary**（P95 **1,442ms** / 最大 **7,490ms**）：改为 **stale-while-revalidate** ——
  有旧缓存时**先返回陈旧摘要（不阻塞本轮）** + 后台刷新一次（最多一个在途）；仅**完全冷启动**才同步等待。
  正确性：新实体最迟下一轮可见。新日志：`[M4] FG 摘要：陈旧-后台刷新（本轮不阻塞）` / `…缓存命中`。
- **batchProfile**（P95 **1,370ms** / 最大 **6,660ms**）：加**短 TTL（60s）缓存**（键=排序后名字集）
  ⇒ 命中时 **0ms**。

**实测（连发 3 轮真实对话）**：`[M4·timing] total=1131ms | decompose+uuid=13 retrieve=322 integrateFG=454
fgSummary=341 **batchProfile=0** …` ⇒ 两项缓存均生效；M4 总量从 1.6–2.9s 降到 **1.1s** 级。

> 未动/待查：`retrieve`（303–322ms 常态、P95 1,151ms / 最大 5,887ms）、`fgSummary` 残留的 ~341ms
> （疑为实体集比对/`_mark` 区段内的其他工作）、**启动到可用 3–4 分钟**、定时维护任务耗时未埋点。

## 十、快速查找

```
要找什么?                    → 去哪里找?
─────────────────────────────────────────────
所有对话原始记录             → fusion_memory.db → conversations 表
所有金库记忆                 → fusion_memory.db → memories 表
所有黑钻永久记忆             → fusion_memory.db → black_diamond 表
所有知识库条目               → fusion_memory.db → knowledge_base 表
所有主人画像                 → fusion_memory.db → master_profile/affairs/network
所有人物档案                 → family_graph.db → nodes(properties JSON)
所有人物关系                 → family_graph.db → edges
所有API Key                  → data/webui/api_keys.json
所有提醒                     → data/webui/reminders.json(旧) / memories表(新)
所有梦境数据                 → data/dreams/
所有归纳记录                 → data/inductions/
所有配置文件                 → .env + 各config目录
所有TTS音频                  → data/webui/audio/
所有上传文件                 → data/webui/uploads/
所有知识柜文件               → data/knowledge-cabinet/docs/
所有MD同步文件               → data/knowledge-md/
所有数据库备份               → data/backups/
所有日志                     → server.log + bionic.log
