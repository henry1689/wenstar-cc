-- ============================================================================
-- P0-3 存量清洗（记忆体系止血 · 第三批）
-- ============================================================================
-- 依据：docs/P0-记忆体系止血任务书-V3.md §3
-- 执行：由 run-p0-v3-cleanup.cjs 在**停服窗口内**调用；本文件仅作存档与审阅，
--       不直接 `sqlite3 < file`（本项目用 sql.js，无 sqlite3 CLI 依赖）。
--
-- 🔴 三条硬规则（V3 §3.1 定，不得违反）
--   1. **只走结构性关联**（id / source_id），绝不按正文提及的人名推断归属。
--      实测：166 条无归属记录里 142 条根本不提任何人名；全表对照 29.2% 的
--      已归属记忆正文提到的是**别人** ⇒ 名字推断会整体串档。
--   2. **关联不上就保持原样**。NULL 是安全态（会晤路径 deny-by-default 看不到、
--      户主路径 allow-unowned 能看到），比填错值安全得多。
--   3. **禁止哨兵值**（'PENDING_MANUAL' / 'UNKNOWN' 之类）。它们破坏列不变量
--      （该列应当是 UUID），且在 deny-by-default 下与 NULL 行为等价，不换来任何信息。
--
-- 本批各项与实测条数（2026-10-07 复核，与 V3 完全吻合）：
--   A  memories.belong_entity_uuid 的字符串 'null' → SQL NULL          24 条
--   A′ black_diamond.belong_entity_uuid 的字符串 'null' → SQL NULL     19 条
--   B  memories 的 142 条 SQL NULL                                      **保持不动**
--   C  vault_log 归属回填（landmark 310 + promote 41 + merge_promote 2）353 条
--   D  vault_log 的 promote_sand(139) / auto_promote(5)                 **保持 NULL**
--
-- 为什么 B 一条都不动：B3（global_uid ↔ conversations.global_uid）实测救回 **0/166**，
--   全表 JOIN 还会 15477 命中（多对多膨胀）。规则 1/2 之下，**没有可用的结构关联**，
--   故保持 NULL 就是正确答案 —— 这不是"没做完"，是"查明了不该做"。
--
-- 为什么 D 一条都不动（V3 要求先查根因）：根因已查明 ——
--   `MemoryAssessor.ts:334` 与 `server.ts:1545` 调用
--   `logVaultOperation(sqlite, 'promote_sand'|'auto_promote', ..., sourceId=undefined, ...)`
--   ⇒ 这两类 operation 是**批次汇总日志**（detail 形如「砂金晋升金库 N 条」），
--   从来就不是逐条记录，`source_id` 从未被写入。**源信息从未被记录 ⇒ 不可恢复。**
--   强行赋值只能编造，违反规则 1/3。
--
-- 🔴 为什么必须停服执行：本库由 sql.js 全量驻内存 + 整库写回。
--   服务运行期间的外部改动会被内存态 flush 静默覆写（见 ServerLock.ts 头注释与经验 #19）。
-- ============================================================================


-- ── A：memories 的「字符串 null」归一为 SQL NULL ─────────────────────────────
-- 病灶来源：历史上的 `String(conv.belong_entity_uuid || conv.entity_uuid || null)` ——
--   两者皆空时 `String(null)` 产生字符串 'null'（真值），绕过判空写入库。
--   该写法已于 2026-09-13 在 MemoryAssessor 一侧修复（改用 deriveBelongUuid），
--   但**已落库的存量仍是字符串**。
-- 为什么必须归一：该行在库层面是「非空值」，`WHERE belong_entity_uuid IS NOT NULL`
--   会把它们当作"已归属"放行；任何只测 NULL 的完整性检查都看不见它们。
--   行为上它们与 NULL 等价（匹配不到任何实体，被 fail-closed 排除），
--   但**表示不统一会持续骗过检查**。本操作是纯格式归一，**不改变任何语义**。
UPDATE memories
   SET belong_entity_uuid = NULL
 WHERE belong_entity_uuid = 'null';


-- ── A′：black_diamond 的同一病灶（2026-10-07 新发现）────────────────────────
-- 与 A 同源。V3 未覆盖此表（当时未查），本次一并归一。
UPDATE black_diamond
   SET belong_entity_uuid = NULL
 WHERE belong_entity_uuid = 'null';


-- ── C：vault_log 归属回填（仅 landmark / promote / merge_promote）──────────
-- 走 `source_id → memories.id`（实测可回填 310/327、41/60、2/2，合计 353）。
-- 🔴 用**关联子查询**而非 `UPDATE ... FROM`：
--   SQLite 3.45.2 虽支持 UPDATE FROM，但子查询形式能天然避免多对多放大
--   （实测 `JOIN conversations ON global_uid` 命中 15477 > memories 总行数 9595）。
-- 外层 EXISTS 与内层 SELECT 的谓词**必须完全一致** —— 否则会出现
--   「EXISTS 判定可回填、但 SELECT 取到 NULL」从而把值写成 NULL 的静默错写。
UPDATE vault_log
   SET belong_entity_uuid = (
         SELECT m.belong_entity_uuid
           FROM memories m
          WHERE m.id = vault_log.source_id
            AND m.belong_entity_uuid IS NOT NULL
            AND m.belong_entity_uuid NOT IN ('', 'null')
          LIMIT 1
       )
 WHERE operation IN ('landmark', 'promote', 'merge_promote')
   AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')
   AND EXISTS (
         SELECT 1
           FROM memories m
          WHERE m.id = vault_log.source_id
            AND m.belong_entity_uuid IS NOT NULL
            AND m.belong_entity_uuid NOT IN ('', 'null')
       );


-- ── B / D：刻意留空 ─────────────────────────────────────────────────────────
-- 见文件头「为什么 B 一条都不动」「为什么 D 一条都不动」。
-- 这两项的"不动作"本身就是结论，不是遗漏 —— 任何后续批次若要改动它们，
-- 必须先推翻上述两条根因结论，否则就是按正文推断/编造数据。


-- ── 幂等性 ──────────────────────────────────────────────────────────────────
-- 三条 UPDATE 均可重复执行：A/A′ 改完后不再有匹配行；C 的回填谓词含
-- `belong_entity_uuid IS NULL OR = ''`，已回填的行不会被二次处理。
-- 复跑的安全网：runner 每次 --apply 前强制备份，且跑完打印前后对比。
