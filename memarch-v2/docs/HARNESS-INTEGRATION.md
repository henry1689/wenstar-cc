# Harness 监管接入说明 / M1-Storage

> 对接 Agent CNC Harness 三时段巡检（10:30 / 17:00 / 23:00）

## 钩子清单

| ID | 名称 | 调度 | 失败动作 |
|---|---|---|---|
| H-CK-01 | schema 一致性 | 三时段 | 告警 + 冻结写入 |
| H-CK-02 | 命名空间泄漏 | 每小时 | 告警 |
| H-CK-03 | 哈希链完整性 | 每小时 | 告警 + 冻结写入 |
| H-CK-04 | 迁移进度上报 | on_change | 告警 |

## 指标上报字段

```json
{
  "module": "M1-Storage",
  "table_count": 14,
  "row_count": { "conversations": 12345, "memories": 6789, "audit_ledger": 234 },
  "fts_index": "ok",
  "vec_index": { "semantic_dim": 1024, "perception_dim": 40 },
  "migration_pending": ["M03", "M04"],
  "queue_depth": 3,
  "wal_size_kb": 128
}
```

## 冻结写入条件（触发后 WriteQueue 拒绝所有写）

- `audit_ledger` 哈希链断裂（prev_hash 不连续）
- 14 张表中任意一张缺失
- `v_conv_real` / `v_mem_real` 中出现 namespace='test' 数据（说明视图被篡改）

## 恢复流程

1. Harness 告警邮件 → 业主确认
2. 用 M00 快照恢复最近一次健康状态
3. 重跑 H-CK-01 通过后，解除冻结（手动调用 `WriteQueue.unfreeze()`）
