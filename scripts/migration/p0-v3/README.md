# P0-3 存量清洗（记忆体系止血 · 第三批）

> 依据：`docs/P0-记忆体系止血任务书-V3.md` §3
> 背景诊断：`docs/P0-5-钙化升级机制调查报告.md`、`docs/P0-4-全零向量根因调查报告.md`
> 日期：2026-10-07 ｜ 执行人：业主 ｜ 脚本：`run-p0-v3-cleanup.cjs` / `p0-v3-cleanup.sql`

---

## 一、本批做什么

| 项 | 动作 | 条数（2026-10-07 复核） |
|---|---|---|
| **A** | `memories.belong_entity_uuid` 的字符串 `'null'` → SQL NULL | **24** |
| **A′** | `black_diamond.belong_entity_uuid` 的字符串 `'null'` → SQL NULL | **19** |
| **C** | `vault_log` 归属回填（`source_id → memories.id`） | **353** |
| **E** | **P0-3c**：还原 24 条「被文本推断认领」的归属 → SQL NULL | **22**（另 2 条已 NULL） |

**E 步是 A 步的补完**，让它第一次真正落地：A 把 24 条置 NULL 后，服务重启的 V10.5 启动回填
（按正文提及的人名推断）把其中 22 条**重新认领**；P0-3b（`ea1f9cb`）删掉了那条回填的文本判据，
本步再把这 22 条还原为 NULL ⇒ 全表回到 `已归属 9431 · SQL NULL 166`，即 V3 §3.3 的原始判据。
详见 §三之三。

### B / D 刻意不动作（**这是结论，不是遗漏**）

| 项 | 内容 | 为什么不动 |
|---|---|---|
| **B** | `memories` 的 142 条 SQL NULL 归属 | B3（`global_uid` 关联）实测救回 **0/166**；按正文人名推断会让 **29.2%** 串档（全表对照实测）⇒ **保持 NULL 是正确答案** |
| **D** | `vault_log` 的 `promote_sand`(139) / `auto_promote`(5) | 根因已查明：这两类是**批次汇总日志**（detail 形如「砂金晋升金库 N 条」），`source_id` 从未被写入 ⇒ **源信息不可恢复**，强行赋值 = 编造 |

---

## 二、执行（必须停服）

🔴 **本库是 sql.js 全量驻内存 + 整库写回。服务运行期间的外部改动会被内存态 flush 静默覆写**
（见 `src/app/locking/ServerLock.ts` 头注释）。runner 会自行检查 `server.lock`，
但**端口检查请人工确认一遍**。

```bash
# 1) 停服
pm2 stop wenstar-webui
# 确认端口 3000 无监听（Windows）：
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue"

# 2) 预览（默认 dry-run，不写任何数据）
node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs

# 3) 执行
node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs --apply \
  --operator owner --reason "P0-3 存量清洗：字符串null归一 + vault_log归属回填" \
  --ticket <harness 任务单号> --confirm <确认令牌>

# 4) 重启并复核
pm2 restart wenstar-webui
```

**runner 的内置安全契约**（沿用本仓 `scripts/_governance-gate.cjs`）：
`riskLevel=HIGH` · `operationType=update`（破坏性）· 有界 scope ⇒ 触发 R001–R003 / R008–R010+R013 / R011。
另加两道自查：**停服检查**（存活进程持有 lock 即拒绝）、**备份大小校验**（不一致即中止，绝不带未校验的备份往下走）。

执行成功会产出：
- 备份 `data/backups/p0-v3/p0-v3-preapply-<ts>.db`
- 报告 `data/backups/p0-v3/p0-v3-report-<ts>.json`（含 preview / applied / verify / 不动作项清单）

---

## 三、验收标准（V3 §3.3）

- [ ] **B3：执行前后 NULL 数一致（预期 166 → 166）** —— 本批对 B **零改动**，属预期 ✅
- [ ] B3 不含任何按正文推断的逻辑 ✅（无此类 SQL）
- [ ] B4：`landmark` null **327 → ≤17**、`promote` null **60 → ≤19**、`merge_promote` **2 → 0**
- [ ] `promote_sand` / `auto_promote` 有根因分析报告 ✅（见上表 D 行）
- [ ] SQL 与 runner 存档到 `scripts/migration/p0-v3/` ✅
- [ ] 无回归（`npx vitest run`）
- [ ] **（本批新增）全表「字符串 `'null'`」残留归零**：`memories` 24 → 0、`black_diamond` 19 → 0

---

## 三之二、执行结果（2026-10-07 01:35，已实际执行）

```
停服检查 ✅（锁的持有进程 40776 已不存在 → 残留锁，放行）
备份      ✅ data/backups/p0-v3/p0-v3-preapply-2026-10-06T17-35-54-766Z.db（271.2 MB，大小校验一致）
治理闸门  ✅ 契约通过（HIGH / update / 有界 scope / 备份已校验）

dry-run 预览：A=24（基线 24 ✅） A2=19（基线 19 ✅） C=353（基线 353 ✅）
执行：      A 影响 24 行 · A2 影响 19 行 · C 影响 353 行
复核：      三项剩余待处理均为 0 ✅

全表「字符串 'null'」残留：memories 0 · black_diamond 0 · vault_log 0    ← 归零
memories SQL NULL：166（与执行前一致 —— 达成 V3 §3.3「166 → 166」验收判据 ✅）
vault_log SQL NULL：533 → 180（回填 353 条）

报告：data/backups/p0-v3/p0-v3-report-2026-10-06T17-35-54-766Z.json
```

### 🔴 重启后的复核发现（2026-10-07 回滚演练时暴露）—— 必读

runner 跑完时代码报告 `memories SQL NULL = 166`（142 原有 + 24 归一，**V3「166 → 166」判据达成**）。
但**服务重启之后**再做逐行比对（备份 vs 线上），真实结果是：

```
24 条字符串 'null' 里：
    2 条 → SQL NULL（本批 A 步做的）
   22 条 → 被赋予了**真实的归属值**            ← 不是本批做的
线上新增行 0 · 线上消失行 0 · 无任何行丢失归属
线上 memories SQL NULL：166 → 144
```

**认领那 22 条的是 `SQLiteAdapter.initialize()` 里的 V10.5 启动回填**
（`src/m2/SQLiteAdapter.ts:642-672`，开关 `SKIP_BACKFILL`，默认执行）。它有三处做的是
**按正文提及的人名推断归属**：

```
① conversations 全文匹配：  WHERE ... content LIKE '%${name}%'                  （对每个 person 实体跑一遍）
③ memories 从会话传导：     WHERE c.content LIKE '%' || substr(memories.raw_input,1,30) || '%'
④ roleplay 直接匹配：       WHERE ... memories.raw_input LIKE '%' || e.name || '%'
```

🔴 **这正是 V3 §3.1 明令禁止的做法**，其原话：「禁止按正文角色名推断（实测：166 条里 142 条根本
不提任何人名；全表对照 **29.2%** 的已归属记忆正文提到的是别人 ⇒ 名字推断会整体串档）」。
⇒ 那 22 条按实测概率**大概率含错认**，需要独立核查（**另立批次**）。

**对本批结论（B 项「保持 NULL」）的影响**：只要这条启动回填默认执行，
**任何把归属置 NULL 的清洗都会在下次重启时被推翻** ——
即 V3 §3.1 的「关联不上就保持 NULL」在**当前架构下不可达**。
这是本次清洗暴露出的**结构性阻塞**，已记入下方「已知边界」。

**验收核对**（对照 §三）：
- [x] B3：执行前后 NULL 数一致（166 → 166）✅
- [x] 不含任何按正文推断的逻辑 ✅
- [x] B4：vault_log 缺归属 **533 → 180**（回填 353）；其中 `landmark` 327→17、`promote` 60→19、
      `merge_promote` 2→0、`promote_sand` 139 与 `auto_promote` 5 **按结论保持 NULL**
- [x] `promote_sand`/`auto_promote` 有根因分析 ✅（见 §一 表 D 行）
- [x] SQL 与 runner 存档到 `scripts/migration/p0-v3/` ✅
- [x] 全表「字符串 `'null'`」残留归零 ✅

---

## 三之三、P0-3c · E 步（2026-10-07 追加并执行）

### 为什么是「还原」而不是「改对」

那 22 条被认领后，一度想「挑出认错的订正」。**这个想法被实测否掉了**：

用**结构列**（`entity_genes` / `fg_entity_names`）当参照，全表实测（9453 条已归属记忆）：

```
结构列不含该归属        1331 条（14.1%）
结构列为空              2399 条（25.4%）
不一致样例（人名标签）： [干脆] [妹妹] [那篇小] [尤其] [满足] [出差] [妈妈] [爸爸] [宿舍] [我]
```

不一致的样例里混着**大量非人名 token**（句子片段与关系词）—— 与 `EntityGate` 的
`rescueNames` 拦截日志「L0: 句子片段/普通名词 — 非人名」是同一现象的佐证。
⇒ **结构列与归属不一致，只说明"不一致"，不能证明"错"**。

我们没有结构性归属真值，所以：

- 「保持现状」= 认可一个已被删除的方法的产物；
- 「只挑 2 条」= 重复刚被删掉的那种猜测；
- **「全部还原为 NULL」= 唯一不依赖新猜测的动作，且完全可逆** ← 业主 2026-10-07 选定（选项 A）。

### 🔴 更正：本仓 commit `ea1f9cb`（P0-3b）提交信息中的「2 条认错」

P0-3b 的提交信息写着「2 条认错：熊勇 vs 同事/玉瑶、徐诗雨 vs 徐诗韵」，判据是
「结构列指向别的实体」。**该判据经本批复核后不成立**（见上：结构列含非人名噪声）。

> 正确表述是「那 24 条由**已被删除的文本推断方法**给出，**来源不可靠**」，
> **而不是**「已证明其中 2 条错」。

提交信息无法追改，故在 `p0-v3-cleanup.sql`、`run-p0-v3-cleanup.cjs`（`CORRECTION_NOTE`
常量，写进 JSON 报告 `correction` 字段）与本文件三处留下更正。
**后人不得再拿那个不成立的判据去改数据。**

### 前置核对（执行前，只读）

```
清单 24 条 vs P0-3 执行前备份：缺失 0 · 非字符串'null' 0 · 命中 24/24  ✅
live 侧现状：已归属 22（熊梓铭 16 / 徐诗韵 4 / 熊勇 1 / 徐诗雨 1）· SQL NULL 2 · 字符串'null' 0
```

🔴 **E 步必须用显式 id 清单**：这 24 条在线上已是真实 UUID，无法再从线上反推「哪 24 条」。
清单写死在 runner 的 `E_IDS` 常量里，取自 A 步执行前的备份。

### 可逆性

被还原前的值记录在 JSON 报告的 `applied[].revertedFrom` 字段里，
同时在 P0-3 的备份 `p0-v3-preapply-*.db` 中。幂等：复跑时这 24 条已是 NULL，E 步影响 0 行。

### 执行结果（跑了**三次**才立住 —— 如实记录）

| # | 时刻 | E 步 | 结果 |
|---|---|---|---|
| 1 | 02:31 | 影响 22 行 | memories `9431/166` ✅ 复核通过 —— **但重启 60 秒内被抹回 `9453/144`** |
| 2 | 03:22 | 影响 22 行 | P0-3d 删掉 2a/2b 后重跑 —— 新日志当场暴露 `本次写入 21 条`（**2c** 独自认领） |
| 3 | 03:4x | 影响 21 行 | P0-3d 删掉 2c 后重跑 —— 重启后**那 24 条仍带归属的 = 0** ✅ |

**判据**：`SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND id IN (<24 条清单>)`
每次重启后都必须是 **0**。修复前它恒为 21~22。

---

## 三之四、P0-3d · 根除全部推断通道（2026-10-07）

E 步第一次执行后**被重启抹掉**，由此查出 P0-3b 漏掉的通道。共 **5 条**：

| # | 位置 | 写法 | 独立认领能力（实测） |
|---|---|---|---|
| ⑤ | `MigrationManager.repairDataIntegrity` 2a | `WHERE raw_input LIKE '%人名%'` | **17 条** |
| ⑥ | 同函数 2b | `WHERE fg_entity_names LIKE '%人名%'` | **22 条** |
| ⑦ | `EntityUUIDBackfill` 两处 | `conversations.content` / `memories.raw_input` LIKE | 潜伏（只在"对话里出现 FG 不认识的新人名"时触发） |
| ⑧ | 同函数 2c | `SELECT id, fg_entity_names …` → 按 id 写回 | **22 条** |

🔴 **⑤⑥ 所在的 `repairDataIntegrity` 不受 `schema_version` 门控、每次启动都跑、且立即强制 export 落盘**
—— 比 P0-3b 摘掉的那条（`SQLiteAdapter` V10.5）更顽固。

### 两个方法论教训（都写进守卫测试的注释里防复发）

1. **三步彼此掩蔽，顺序测必然错判。** 第一版受控实验把 2a→2b→2c 顺序执行，前两步先把行填满，
   而 2c 的谓词含 `belong IS NULL` ⇒ 无行可填 ⇒ 错判"2c 贡献 0"（并据此向业主报告"2c 无害、可保留"）。
   改成**每步各自在全新副本上独立执行**才看清三个数。**测"某步有没有贡献"必须让它独占起跑线。**
2. **两个计数器叠加使回归隐身。** `[Backfill] memories标注: X→Y` **排在 `[Repair]` 之后**（读数时污染已发生），
   而 `[Repair] belong_entity_uuid 回填: N 条` 当时打印的是 `COUNT(*)` **总量**（恒约 9400）、**不打印增量**。
   → P0-3d 已把 `[Repair]` 改为回报增量，正是它当场抓出了 2c。

### 保留（只删推断，结构关联一律不动）

- `UPDATE memories SET belong_entity_uuid = NULL WHERE … LIKE 'uuid-%'`（清理历史上的假 UUID —— 收窄而非推断）
- black_diamond 走 `source_id → memories.id` 的结构传播（`SQLiteAdapter` 第⑤步 / `EntityUUIDBackfill` / vault_log C 步）
- `fg_entity_names` 的**幂等派生**（从 `entity_genes` 确定性派生；本批只禁"用它决定归属"，不禁"派生它"）
- `SKIP_BACKFILL` 总闸

### 遗留（已登记为待办，本批刻意不做）

删掉全部推断后，**写入期就没定归属的记录会永久保持 NULL**。
正解是**写入期就落值**（`persistence-stage` 写入时本就知道本轮的 `belongEntityUuid`，
`YuyaoMemoryService` 的 P0-2a 就是这么做的），而不是事后按正文猜。**另立批次。**

---

## 四、已知边界（如实记录）

1. **A/A′ 是纯格式归一，不改变任何行为** —— 字符串 `'null'` 与 SQL NULL 在
   deny-by-default 下都被排除。归一的价值在于**不再骗过只测 NULL 的完整性检查**。
2. **C 只回填 `landmark`/`promote`/`merge_promote` 三类**。其余 operation 的 `source_id`
   要么为空、要么指向非 memories 表，不在可关联范围。
3. **本批不引入表级 NOT NULL 约束** —— 需先清存量、且会改变写入失败语义，属独立议题。
4. **`promote_sand` / `auto_promote` 的"批次汇总日志缺逐条来源"这一设计缺口本批未修**，
   仅记录。若日后需要逐条溯源，需改 `MemoryAssessor.ts:334` 与 `server.ts:1545` 的调用方式
   （另立批次，且 `server.ts` 是 HIGH）。
5. 🔴 **启动回填与 V3 §3.1 直接冲突（本次清洗暴露的结构性阻塞）**：
   `SQLiteAdapter.initialize()` 的 V10.5 回填（`SKIP_BACKFILL` 默认关闭 ≠ 'true'）会按
   **正文提及的人名**认领无归属记录 —— 这与 V3「禁止按正文角色名推断、关联不上保持 NULL」
   直接矛盾，且**每次启动都会把上一步的 NULL 重新认领**。
   本批的 B 项结论在当前架构下**不可维持**。
   ✅ **已修（P0-3b，commit `ea1f9cb`）**：删掉 ①③④ 与 ②（②的 `XX来了`/`XX在呢`/`是XX呀`
   仍是"名字出现在句子里就认领"，同病根），只留 ⑤ `black_diamond` 走 `source_id` 的结构关联
   与 `fg_entity_names` 确定性派生；刻意不动 `SKIP_BACKFILL` 总闸（一关会把 ⑤ 一起关掉）。
   重启后实测零认领。附带消掉「实体名插值进 SQL」的注入面。
   → 之后 E 步才得以把 22 条真正还原（否则重启即被再次认领）。
6. ~~本批已执行完毕且不可逆地改变了 22 行的归属~~ —— **已由 P0-3c（E 步）处理**：
   那 22 条已还原为 SQL NULL。原注记里「需以 `SKIP_BACKFILL=true` 启动」的附加条件
   **不再需要** —— 全部推断通道已由 P0-3b + **P0-3d** 根除（见 §三之四）。
   ⚠️ P0-3b 当时说「重新认领的通道已断」**是错的** —— 见 §三之三。
