-- =====================================================================
-- 测试夹具：namespace='test' 隔离数据
-- 严禁在生产视图（v_conv_real / v_mem_real）中出现
-- =====================================================================

-- conversations: default 命名空间（应在 v_conv_real 可见）
INSERT INTO conversations(message_id, namespace, role, content, ts_utc, created_at)
VALUES
  ('test-msg-001', 'default', 'user',     '我记得昨天去了深圳湾', 1730000001000, 1730000001000),
  ('test-msg-002', 'default', 'assistant', '好的，已记下',         1730000002000, 1730000002000),
  ('test-msg-003', 'default', 'user',     '另一个默认命名空间消息', 1730000003000, 1730000003000);

-- conversations: test 命名空间（v_conv_real 应不可见）
INSERT INTO conversations(message_id, namespace, role, content, ts_utc, created_at)
VALUES
  ('test-msg-t1', 'test', 'user', '测试数据-不应出现在生产视图', 1730000010000, 1730000010000),
  ('test-msg-t2', 'test', 'user', '另一条测试数据',              1730000011000, 1730000011000);

-- conversations: roleplay 命名空间（v_conv_real 应不可见）
INSERT INTO conversations(message_id, namespace, roleplay_char, role, content, ts_utc, created_at)
VALUES
  ('test-msg-r1', 'default', '王全芬', 'user', '角色扮演数据', 1730000020000, 1730000020000);

-- conversations: tombstone 状态（v_conv_real 应不可见）
INSERT INTO conversations(message_id, namespace, role, content, ts_utc, lifecycle_state, created_at)
VALUES
  ('test-msg-x1', 'default', 'user', '已遗忘的原文', 1730000030000, 'tombstone', 1730000030000);

-- episodes
INSERT INTO episodes(id, namespace, started_at, status, gist)
VALUES
  ('ep-test-001', 'default', 1730000000000, 'sealed', '深圳湾散步事件'),
  ('ep-test-t1',  'test',    1730000010000, 'open',   '测试事件-不应出现在生产视图');

-- memories: default 命名空间
INSERT INTO memories(id, namespace, summary, consolidation, lifecycle_state, created_at)
VALUES
  ('mem-test-001', 'default', '用户昨天去了深圳湾', 0.5, 'fresh', 1730000001000),
  ('mem-test-002', 'default', '用户喜欢喝咖啡',     0.7, 'consolidated', 1730000002000);

-- memories: test 命名空间
INSERT INTO memories(id, namespace, summary, lifecycle_state, created_at)
VALUES
  ('mem-test-t1', 'test', '测试记忆-不应出现在生产视图', 'fresh', 1730000010000);

-- memories: tombstone 状态
INSERT INTO memories(id, namespace, summary, lifecycle_state, created_at)
VALUES
  ('mem-test-x1', 'default', '已遗忘记忆', 'tombstone', 1730000030000);
