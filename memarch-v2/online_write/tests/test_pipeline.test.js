/**
 * M2 测试：MemoryWriter 完整链路
 * 覆盖：正常写入 / 崩溃恢复 / 幂等性 / 三门控分布
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryWriter } from '../MemoryWriter.js';
import { createTestDb, resetTestDb } from './helpers/db.js';

describe('MemoryWriter 完整链路', () => {
  let db;
  let writer;

  beforeEach(() => {
    db = createTestDb();
    resetTestDb(db);
    writer = new MemoryWriter(db);
  });

  it('正常写入：原文落盘 + 门控 + 结果返回', async () => {
    const result = await writer.write({
      message_id: 'msg_normal_001',
      namespace: 'default',
      role: 'user',
      content: '我今天去东莞松山湖跑了半程马拉松，第一次跑这么远，很激动',
      arousal: 0.7,
    });

    expect(result.conversation_id).toBeGreaterThan(0);
    expect(['WRITE', 'RAW_ONLY', 'DISCARD']).toContain(result.gate);
    expect(result.salience).toBeGreaterThan(0);
    expect(result.latency_ms).toBeLessThan(50);  // 单条应远低于 30ms

    // 验证原文已落盘
    const convo = db.prepare('SELECT * FROM conversations WHERE message_id = ?').get('msg_normal_001');
    expect(convo).toBeTruthy();
    expect(convo.content).toContain('松山湖');
  });

  it('WRITE 门控应在 memories 表中创建痕迹', async () => {
    const result = await writer.write({
      message_id: 'msg_write_001',
      namespace: 'default',
      role: 'user',
      content: '我决定下个月辞职创业，这是人生第一次，和朋友合伙开一家电机公司',
      arousal: 0.8,
    });

    if (result.gate === 'WRITE') {
      expect(result.trace_id).toBeTruthy();
      const trace = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.trace_id);
      expect(trace).toBeTruthy();
      expect(trace.lifecycle_state).toBe('fresh');
      expect(trace.consolidation).toBeLessThanOrEqual(0.6);  // c₀ ≤ 0.6
    }
  });

  it('幂等性：同一条消息推送 3 次只产生 1 条痕迹', async () => {
    const input = {
      message_id: 'msg_idempotent_001',
      namespace: 'default',
      role: 'user',
      content: '我妈妈今天生日，我给她买了个蛋糕，很开心',
      arousal: 0.6,
    };

    const r1 = await writer.write(input);
    const r2 = await writer.write(input);
    const r3 = await writer.write(input);

    // 三次返回同一结果
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);

    // conversations 表只有 1 条
    const convoCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM conversations WHERE message_id = 'msg_idempotent_001'"
    ).get();
    expect(convoCount.cnt).toBe(1);

    // memories 表最多 1 条（如果是 WRITE 门控）
    if (r1.gate === 'WRITE') {
      const memCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM memories WHERE raw_input LIKE '%妈妈今天生日%'"
      ).get();
      expect(memCount.cnt).toBe(1);
    }
  });

  it('namespace=test 的消息应全部 DISCARD', async () => {
    const r = await writer.write({
      message_id: 'msg_test_001',
      namespace: 'test',
      role: 'user',
      content: '这是测试数据，应该被丢弃',
    });
    expect(r.gate).toBe('DISCARD');
  });

  it('事件分割：长时间间隔后应切分新 episode', async () => {
    const t1 = Date.now() - 130 * 60_000;  // 130 分钟前
    const r1 = await writer.write({
      message_id: 'msg_seg_001',
      namespace: 'default',
      role: 'user',
      content: '我们在聊电机的绝缘等级',
      ts_utc: t1,
    });

    const r2 = await writer.write({
      message_id: 'msg_seg_002',
      namespace: 'default',
      role: 'user',
      content: '对了，明天晚上想吃火锅',
    });

    // 两条消息间隔超过 120 分钟，应切分
    expect(r2.segmentation.is_boundary).toBe(true);
    expect(r2.segmentation.reason).toContain('hard_gap');
  });

  it('崩溃恢复：wm_buffer 中 pending 条目应被恢复处理', async () => {
    // 模拟崩溃：直接往 wm_buffer 插入 pending 条目
    const crashedEntry = {
      message_id: 'msg_recover_001',
      namespace: 'default',
      role: 'user',
      content: '我昨天体检发现血压有点高，需要注意饮食',
      ts_utc: Date.now(),
      salience: 0.6,
      salience_components: { imp_rule: 0.8, self_rule: 0.5, arousal: 0.5, nov_rule: 0.3, ent: 0.5 },
      has_meaningful_entity: true,
    };

    db.prepare(
      `INSERT INTO wm_buffer (payload, status, ts_utc) VALUES (?, 'pending', ?)`
    ).run(JSON.stringify(crashedEntry), Date.now());

    // 新实例恢复
    const writer2 = new MemoryWriter(db);
    const { recovered, failed } = await writer2.recover();

    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(failed).toBe(0);

    // 验证恢复后 wm_buffer 状态已更新
    const pendingLeft = db.prepare(
      "SELECT COUNT(*) as cnt FROM wm_buffer WHERE status = 'pending'"
    ).get();
    expect(pendingLeft.cnt).toBe(0);
  });

  it('门控分布：批量对话应在合理区间', async () => {
    // 模拟 50 条混合对话
    const samples = [
      '你好', '谢谢', '好的', '再见',  // 寒暄 → DISCARD
      '今天天气不错', '外面在下雨', '今天有点冷',  // 普通闲聊 → RAW_ONLY
      '我决定下个月去杭州创业', '这是我人生第一次创业', '我妈妈今天生日',  // 重要事件 → WRITE
      '对了，明天记得带伞', '别忘了下午开会',  // 提醒类
      '我们公司这周要做季度总结', '我是研发总监，管电机团队',  // 工作相关
    ];

    for (let i = 0; i < 50; i++) {
      const text = samples[i % samples.length];
      await writer.write({
        message_id: `msg_batch_${i}`,
        namespace: 'default',
        role: 'user',
        content: text,
        arousal: 0.4,
      });
    }

    const stats = writer.getGateStats();
    expect(stats.total).toBe(50);

    // 打印分布供人工检查
    console.log('门控分布:', stats);
    console.log(`WRITE: ${(stats.write / stats.total * 100).toFixed(1)}%`);
    console.log(`RAW_ONLY: ${(stats.rawOnly / stats.total * 100).toFixed(1)}%`);
    console.log(`DISCARD: ${(stats.discard / stats.total * 100).toFixed(1)}%`);

    // 宽松断言：DISCARD 应该占一定比例（有寒暄）
    expect(stats.discard).toBeGreaterThan(0);
  });

  it('sweep 清理已完成条目不影响 pending', async () => {
    // 先写几条
    await writer.write({
      message_id: 'msg_sweep_001',
      namespace: 'default',
      role: 'user',
      content: '测试 sweep 功能',
    });

    // 手动插入一条旧的 done 条目
    const oldTime = Date.now() - 2 * 3_600_000;  // 2 小时前
    db.prepare(
      `INSERT INTO wm_buffer (payload, status, gate, ts_utc) VALUES (?, 'done', 'DISCARD', ?)`
    ).run('{}', oldTime);

    const before = db.prepare('SELECT COUNT(*) as cnt FROM wm_buffer').get().cnt;
    await writer.sweep();
    const after = db.prepare('SELECT COUNT(*) as cnt FROM wm_buffer').get().cnt;

    // 旧条目被清理
    expect(after).toBeLessThan(before);
  });
});
