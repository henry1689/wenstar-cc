-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 02_indexes.sql
-- B-tree 复合索引（按任务书 §2.2 I4-I7 + 外键/高频过滤补充）
-- =====================================================================

-- I6: conversations(episode_id, ts_utc) —— 事件内原文查询
CREATE INDEX IF NOT EXISTS idx_conv_episode_ts ON conversations(episode_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_conv_ts_utc    ON conversations(ts_utc);
CREATE INDEX IF NOT EXISTS idx_conv_namespace ON conversations(namespace, lifecycle_state);

-- episodes
CREATE INDEX IF NOT EXISTS idx_episodes_started ON episodes(started_at);
CREATE INDEX IF NOT EXISTS idx_episodes_status   ON episodes(status, namespace);
CREATE INDEX IF NOT EXISTS idx_episodes_consol   ON episodes(consolidation, lifecycle_state);

-- I4: memories(consolidation, lifecycle_state) —— 巩固度+状态过滤
CREATE INDEX IF NOT EXISTS idx_mem_consol_lifecycle ON memories(consolidation, lifecycle_state);

-- I5: memories(last_reinforced_at) —— 激活度计算
CREATE INDEX IF NOT EXISTS idx_mem_last_reinforced  ON memories(last_reinforced_at);
CREATE INDEX IF NOT EXISTS idx_mem_episode_id       ON memories(episode_id);
CREATE INDEX IF NOT EXISTS idx_mem_namespace_state  ON memories(namespace, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_mem_supersedes       ON memories(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_mem_dna_root         ON memories(dna_root_id);

-- I7: semantic_facts(subject_uuid, predicate, valid_to)
CREATE INDEX IF NOT EXISTS idx_fact_subj_pred ON semantic_facts(subject_uuid, predicate, valid_to);
CREATE INDEX IF NOT EXISTS idx_fact_domain     ON semantic_facts(domain, valid_to);

-- entity_edges
CREATE INDEX IF NOT EXISTS idx_edge_src ON entity_edges(src_uuid, rel);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON entity_edges(dst_uuid, rel);

-- trace_entities
CREATE INDEX IF NOT EXISTS idx_te_entity ON trace_entities(entity_uuid);

-- black_diamond_v2
CREATE INDEX IF NOT EXISTS idx_bd_ref  ON black_diamond_v2(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_bd_status ON black_diamond_v2(status);

-- prospective_items
CREATE INDEX IF NOT EXISTS idx_prosp_due   ON prospective_items(due_at, status);
CREATE INDEX IF NOT EXISTS idx_prosp_trigger ON prospective_items(trigger_type, trigger_entity);

-- tombstones
CREATE INDEX IF NOT EXISTS idx_tomb_purge ON tombstones(purge_after);

-- audit_ledger
CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_ledger(ts_utc);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_ledger(target_type, target_id);

-- reinforcement_events
CREATE INDEX IF NOT EXISTS idx_reinf_ts ON reinforcement_events(ts_utc);
