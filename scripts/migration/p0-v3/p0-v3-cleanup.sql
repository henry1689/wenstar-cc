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
-- P0-3c（2026-10-07 追加）：
--   E  还原 24 条「被文本推断认领」的归属 → SQL NULL                    22 条（另 2 条已 NULL）
-- 🔴 实际执行顺序为 A → A′ → **E → C**（E 必须排在 C 前，原因见 C 段开头）。
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


-- ── E：还原 24 条「被文本推断认领」的归属（P0-3c，2026-10-07 追加）──────────
-- 🔴 执行顺序：E 在 C **之前**（原因见 C 段开头的说明）。
-- 这一条不是新病灶，而是 **A 步的补完** —— 让 A 的结果第一次真正落地。
--
-- 因果链：
--   ① A 步把 24 条字符串 'null' 归一为 SQL NULL（已完成）。
--   ② 服务重启后，V10.5 启动回填（按正文提及的人名推断归属）把那 24 条里的 22 条
--      **重新认领**，赋了真实 UUID ⇒ 只有 2 条留在 NULL。
--   ③ P0-3b（commit ea1f9cb）删除了**其中一处**回填的四处文本判据。
--      🔴 更正：P0-3b 当时说「重新认领的通道已断」—— **这句是错的**。它只摘了三条通道里的一条。
--      实测：本步（E）第一次执行、复核通过之后，**服务重启 60 秒内 22 条被重新认领**。
--      另两条（`MigrationManager.repairDataIntegrity` 的 2a/2b/2c、`EntityUUIDBackfill` 的两处 LIKE）
--      由 **P0-3d** 根除。详见 README §三之三 / §四。
--   ④ 本步 = 把这 24 条**还原为 NULL**。
--
-- 🔴 为什么是「还原」而不是「改对」：我们**没有**结构性归属真值。
--   曾用 entity_genes / fg_entity_names 作为参照，但全表实测（9453 条已归属）：
--   结构列**不含**该归属的有 1331 条（14.1%）、为空 2399 条（25.4%），
--   而不一致的样例里混着大量**非人名 token**（句子片段与关系词，如 [干脆] [妹妹] [那篇小] [尤其] [出差]）。
--   ⇒ 结构列与归属不一致**只说明"不一致"，不能证明"错"**；拿它当判据去"改对"是重复被删掉的那种猜测。
--   故唯一不依赖新猜测、且完全可逆的动作就是**全部还原为 NULL**（业主 2026-10-07 在三个选项中选定 A）。
--
-- 🔴 为什么必须用**显式 id 清单**：这 24 条在线上已是真实 UUID，无法再从线上反推"哪 24 条"。
--   清单取自 A 步执行前的备份（belong_entity_uuid = 'null' 的 24 行），已逐条打印核对：
--   备份 24/24 命中、无缺失、无非字符串'null'；live 侧 22 条已归属 + 2 条已 NULL。
--   还原后全表回到 `已归属 9431 · SQL NULL 166` —— 即 V3 §3.3 的原始判据。
--
-- 🔴 本步同时是对 P0-3b 提交信息的一处**更正（如实记录）**：
--   P0-3b 的 commit 信息写着「2 条认错：熊勇 vs 同事/玉瑶、徐诗雨 vs 徐诗韵」，
--   其判据是「结构列指向别的实体」。**该判据经复核后不成立**（见上，结构列含非人名噪声）。
--   正确表述是「那 24 条由**已被删除的文本推断方法**给出，来源不可靠」，
--   **而不是**「已证明其中 2 条错」。提交信息无法追改，故在此留下更正。
--
-- 可逆性：被还原前的 22 个值记录在本步的 JSON 报告（revertedFrom）与 A 步前的备份中。
-- 幂等：复跑时这 24 条已是 NULL，本步影响 0 行。
UPDATE memories
   SET belong_entity_uuid = NULL
 WHERE belong_entity_uuid IS NOT NULL
   AND id IN (
     'mem_00003520260720005916M01EMON_15156',
     'mem_00011320260814103319M01EMOP_31575',
     'mem_00012920260814105055M01FAMF_31583',
     'mem_00015120260814111114M01EMOP_31597',
     'mem_00015920260810031954M01EMOP_29015',
     'mem_00019320260807141028M01FAMC_27857',
     'mem_00024720260719155954M01FAMC_14210',
     'mem_00024920260730125633M01EMOP_23637',
     'mem_00032720260719192904M01WRKS_14586',
     'mem_00033320260812141952M01FAMC_30451',
     'mem_00035720260810100746M01FAMC_29049',
     'mem_00036120260810101214M01FAMC_29051',
     'mem_00038120260810103413M01FAMC_29063',
     'mem_00039920260816191205M01EMOP_32391',
     'mem_00054320260810143824M01EMOP_29169',
     'mem_00055520260810145223M01EMON_29175',
     'mem_00056920260810152319M01EMOP_29177',
     'mem_00081120260727145621M01EMOP_21998',
     'mem_00081320260727145839M01EMOP_22000',
     'mem_00090120260727154928M01EMRO_22068',
     'mem_00094720260727164707M01FAMC_22090',
     'mem_00095120260727165150M01WRKP_22092',
     'mem_00110320260716190732M01EMOP_11894',
     'mem_sand_fallback_32654_32654'
   );


-- ── C：vault_log 归属回填（仅 landmark / promote / merge_promote）──────────
-- 🔴 **必须排在 E 之后**（2026-10-07 实测调整，原为 C 在前）。
--   原因：E 还原的那 24 条在重启回填拿到真 UUID 之后，连带让 **17 条** 09-22 / 09-23 的
--   `promote` 记录（`source_id` 逐条命中 E 清单）变成了本步的候选
--   —— 它们在 P0-3 首跑时是被 `NOT IN ('', 'null')` 排除的，故当时不出现。
--   若本步先跑，它会用**马上要被 E 还原掉的**归属值去回填那 17 条
--   ⇒ vault_log 里留着一份源记忆已不再承认的归属。
--   先 E 后 C，本步的 EXISTS 对那 24 条自然不成立 ⇒ 本步影响 0 条。
--   （对照：P0-3 首跑本步影响 353 条，跑完复核 0；本次重跑若在 E 之前会显示 17 条。）
--
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
-- 🔴 执行顺序：A → A′ → **E → C**（E 必须在 C 前，原因见 C 段开头）。
-- 四条 UPDATE 均可重复执行：A/A′ 改完后不再有匹配行；E 改完后那 24 条已非 NULL 不达标；
-- C 的回填谓词含
-- `belong_entity_uuid IS NULL OR = ''`，已回填的行不会被二次处理。
-- 复跑的安全网：runner 每次 --apply 前强制备份，且跑完打印前后对比。
