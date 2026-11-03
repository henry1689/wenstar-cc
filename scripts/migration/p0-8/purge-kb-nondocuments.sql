-- ============================================================================
-- P0-8a 知识库只留「文档 + 微信临时」—— 清掉既非文档、非微信、非梦境的碎片
-- ============================================================================
-- 业主指令（2026-10-07）：「知识库里不应该有什么碎片信息，也不能有这些，因为这里只存文档和
--   微信临时信息，再加上微信信息每天晚上还要彻底清除避免污染」。
--   逐项拍板：梦境（dream_behavior）**不删、改为隔离出检索**；1 字的空条目 **删**。
-- 执行：由 purge-kb-nondocuments.cjs 在**停服窗口内**调用；本文件仅作存档与审阅。
--
-- 🔴 只删**明确列举的 9 个 id**（写死在 runner 的 TARGET_IDS 里）。
--   不做 `WHERE source_type = …` 这类**按类别扫**的谓词 —— 那正是本项目两次数据损失
--   （68→3 条、4 份 FG档案范式）的共同形态。见 docs/P0-6-知识库人物档案丢失调查报告.md。


-- ── 一、删除集的**推导规则**（可复算，用于核对白名单是否完整/是否漂移）────────
--   删除 = 非微信 ∧ 非文档 ∧ 非梦境
--
--     非微信：COALESCE(source_name,'') NOT LIKE 'wechat_relay/%'
--             🔴 必须 COALESCE —— source_name 为 NULL 时 `NOT LIKE` 的结果是 NULL 而非 true，
--                会把这行整个滤掉（本次推导时踩过一次，返回了 0 条）。
--     非文档：NOT ( source_type IN ('md','text','person','research','architecture')
--                   AND LENGTH(COALESCE(content,'')) >= 100 )
--             AND NOT ( source_type = 'txt' AND LENGTH(COALESCE(content,'')) >= 100 )
--             （100 字下限用于把"1 字的空条目"排除出文档集）
--     非梦境：COALESCE(source_type,'') <> 'dream_behavior'
--
--   实测命中 **9 条**（与白名单逐条一致）：
--     · systems_consolidation × 4 —— SleepTimeConsolidator 写的「巩固记忆」(22/22/71/90 字)
--         sysc_muutiknp_wsfx / sysc_muutiknq_d0rd / sysc_muutiknr_fyq9 / sysc_muutikns_iffv
--         其中 3 条正是业主实测时被熊梓铭当成"档案"看到的那几条
--     · monthly_topic × 2 —— DailyMaintenanceScheduler 写的「对话主题月报」(131/133 字)
--         topic_202608 / topic_202609
--     · conversation_induct × 2 —— 旧数据「[对话事实·家人]」(7/13 字)，已无写入点
--         induct_mts6ze15_7p4s / induct_mtswnqpt_nt3i
--     · text × 1 —— 标题「非法来源探针」、正文 1 字（探针残留）
--         WK3993000084E0C0EA4CB88E


-- ── 二、明确**不动**的三类（供对照，runner 每次执行都会打印计数）──────────────
--   ✅ 微信临时信息 910 条（source_name LIKE 'wechat_relay/%'）
--        —— 不是"豁免不删"，而是由**每晚例行清理**回收（见 DailyMaintenanceScheduler 的
--           「⓪-b 每晚彻底清微信临时信息」）。⚠️ 该机制此前**根本不存在**：全仓 grep
--           wechat_relay，src/ 与 scripts/ 零引用，910 条全部来自 2026-09-23/24 的一次性导入。
--   ✅ 梦境 141 条（source_type='dream_behavior'）
--        —— 业主：不删。改为在 SourceTypePolicy 里移入检索隔离区（GARBAGE_SOURCE_TYPES），
--           行仍在库里、只是不再被注入对话上下文。
--   ✅ 真文档 65 条（md/text/person/research/architecture 且 ≥100 字）+ txt 文档 7 条
--        —— 这是 P0-7a 找回的那批 + 原有；本批一条不动。


-- ── 三、等价删除语句（runner 实际按显式 id 逐条执行）────────────────────────
--   DELETE FROM knowledge_base WHERE id = ?     （? 取自 TARGET_IDS，共 9 个）
-- 事务包裹；失败即 ROLLBACK；执行前强制备份并校验大小；治理闸门 HIGH/delete/有界 scope。
-- 报告里保存**被删行的整行快照** ⇒ 可精确还原（不需要恢复整库）。


-- ── 四、幂等与可逆性 ────────────────────────────────────────────────────────
-- 幂等：按 id 判存，已不存在即跳过（runner 会列出"已不存在"的 id）⇒ 可复跑。
-- 可逆：备份 data/backups/p0-8/p0-8-preapply-*.db + 报告里的 deletedRows 整行快照。
-- 🔴 但不建议"图省事直接删备份" —— 按业主原则，任何清理都要先确认。
