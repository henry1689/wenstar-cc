-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 03_fts5.sql
-- FTS5 全文索引（外部内容表，绑定 conversations.content + episodes.gist）
-- 中文分词：trigram（SQLite 3.34+ 内置，零依赖；查询词 >= 3 字）
-- 推荐生产环境切换 simple 扩展（jieba），见 §03b_tokenizer_simple.sql.example
-- =====================================================================

-- I1: 全文检索（BM25）
-- 外部内容表：content 存在原表，FTS 只存倒排索引，节省空间
CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversations USING fts5(
  content,
  content='conversations',
  content_rowid='id',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
  gist,
  content='episodes',
  content_rowid='id',          -- 注意：episodes.id 是 TEXT，外部内容表需用 rowid
  tokenize='trigram'
);

-- 触发器：保持 FTS 与原表同步（INSERT/UPDATE/DELETE）
-- conversations
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

-- episodes（gist 在睡眠期更新，用 rowid 关联）
CREATE TRIGGER IF NOT EXISTS fts_ep_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO fts_episodes(rowid, gist) VALUES (new.rowid, new.gist);
END;
CREATE TRIGGER IF NOT EXISTS fts_ep_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, gist)
  VALUES ('delete', old.rowid, old.gist);
END;
CREATE TRIGGER IF NOT EXISTS fts_ep_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, gist)
  VALUES ('delete', old.rowid, old.gist);
  INSERT INTO fts_episodes(rowid, gist) VALUES (new.rowid, new.gist);
END;

-- 常用查询模板（业务层参考，不强制）：
--   SELECT c.*, bm25(fts_conversations) AS score
--   FROM fts_conversations JOIN conversations c ON c.id = fts_conversations.rowid
--   WHERE fts_conversations MATCH ? ORDER BY score LIMIT 20;
