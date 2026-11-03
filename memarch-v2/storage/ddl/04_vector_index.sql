-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 04_vector_index.sql
-- 向量索引（sqlite-vec vec0 虚表）
-- 前置：已加载 vec0 扩展  =>  SELECT load_extension('vec0');
-- I2: 语义向量（memories / episodes 共用）
-- I3: 情感 40D 向量（perception_40d，按设计文档 §1.3）
-- =====================================================================

-- 注意：vec0 必须在扩展加载后才能执行；若扩展未加载，整个文件会报错。
-- 建议在 Node 启动时：db.loadExtension('vec0'); 再执行本脚本。

-- I2: 语义向量表（memories 维度，异步生成；维度以 embedding_dim 配置为准，默认 1024）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem_semantic USING vec0(
  trace_id TEXT PRIMARY KEY,
  embedding float[1024]
);

-- I2b: episodes 语义向量（事件级 gist embedding）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_ep_semantic USING vec0(
  episode_id TEXT PRIMARY KEY,
  embedding float[1024]
);

-- I3: 情感 40D 向量表（perception_40d，设计文档明确 40 维）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem_perception USING vec0(
  trace_id TEXT PRIMARY KEY,
  embedding float[40]
);

-- =====================================================================
-- KNN 检索模板（业务层参考，M4 检索模块使用）
-- =====================================================================
-- 语义 KNN：
--   SELECT trace_id, distance
--   FROM vec_mem_semantic
--   WHERE embedding MATCH ? AND k = 20
--   ORDER BY distance;
--
-- 情感 KNN：
--   SELECT trace_id, distance
--   FROM vec_mem_perception
--   WHERE embedding MATCH ? AND k = 20;
--
-- 注：sqlite-vec 余弦距离默认度量；如需切换 L2，在虚表定义加 `distance_metric='l2'`。
