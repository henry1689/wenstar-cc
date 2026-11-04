-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 03_fts5.sql
-- FTS5 全文索引（trigram 中文分词，零依赖，SQLite 3.34+ 内置）
--
-- 设计说明：
--   - fts_conversations：外部内容表（conversations.id 是 INTEGER PRIMARY KEY，
--     天然匹配 FTS5 content_rowid 的 INTEGER 要求，节省倒排索引外的存储）
--   - fts_episodes / fts_memories：独立 FTS 表（episodes.id / memories.id 都是
--     TEXT 业务主键，无法做 FTS5 的 content_rowid（必须 INTEGER），因此改用
--     UNINDEXED 关联列 + 触发器同步的独立表模式）
--   - 生产环境可切换 simple 分词（jieba 扩展），见 §03b_tokenizer_simple.sql.example
-- =====================================================================

-- =====================================================================
-- I1-1: conversations 全文索引（外部内容表）
-- =====================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversations USING fts5(
  content,
  content='conversations',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS fts_conv_ai AFTER INSERT ON conversations BEGIN
  INSERT INTO fts_conversations(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS fts_conv_ad AFTER DELETE ON conversations BEGIN
  INSERT INTO fts_conversations(fts_conversations, rowid, content)
  VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS fts_conv_au AFTER UPDATE ON conversations BEGIN
  INSERT INTO fts_conversations(fts_conversations, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO fts_conversations(rowid, content) VALUES (new.id, new.content);
END;

-- =====================================================================
-- I1-2: episodes 全文索引（独立表模式，episode.id 是 TEXT 主键）
-- =====================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
  episode_id UNINDEXED,
  gist,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS fts_ep_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO fts_episodes(episode_id, gist)
  VALUES (new.id, COALESCE(new.gist, ''));
END;
CREATE TRIGGER IF NOT EXISTS fts_ep_ad AFTER DELETE ON episodes BEGIN
  DELETE FROM fts_episodes WHERE episode_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS fts_ep_au AFTER UPDATE ON episodes BEGIN
  DELETE FROM fts_episodes WHERE episode_id = old.id;
  INSERT INTO fts_episodes(episode_id, gist)
  VALUES (new.id, COALESCE(new.gist, ''));
END;

-- =====================================================================
-- I1-3: memories 全文索引（独立表模式，memories.id 是 TEXT 主键）
--       M4 Bm25Recall 依赖 JOIN v_mem_real m ON m.id = fts_memories.trace_id
-- =====================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
  trace_id UNINDEXED,
  summary,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS fts_mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO fts_memories(trace_id, summary)
  VALUES (new.id, COALESCE(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS fts_mem_ad AFTER DELETE ON memories BEGIN
  DELETE FROM fts_memories WHERE trace_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS fts_mem_au AFTER UPDATE ON memories BEGIN
  DELETE FROM fts_memories WHERE trace_id = old.id;
  INSERT INTO fts_memories(trace_id, summary)
  VALUES (new.id, COALESCE(new.summary, ''));
END;

-- =====================================================================
-- 常用查询模板（业务层参考，不强制）：
--   conversations:
--     SELECT c.*, bm25(fts_conversations) AS score
--     FROM fts_conversations JOIN conversations c ON c.id = fts_conversations.rowid
--     WHERE fts_conversations MATCH ? ORDER BY score LIMIT 20;
--
--   episodes:
--     SELECT e.*, bm25(fts_episodes) AS score
--     FROM fts_episodes JOIN episodes e ON e.id = fts_episodes.episode_id
--     WHERE fts_episodes MATCH ? ORDER BY score LIMIT 20;
--
--   memories:
--     SELECT m.*, bm25(fts_memories) AS score
--     FROM fts_memories JOIN memories m ON m.id = fts_memories.trace_id
--     WHERE fts_memories MATCH ? ORDER BY score LIMIT 20;
-- =====================================================================
