import { describe, it, expect, beforeEach } from 'vitest';
import { PresentationEngine } from '../index.js';
import { DEFAULT_CONFIG } from '../config.js';
import {
  RecordingReinforceSink,
  RecordingWriteSink,
  SQLitePathwayStore,
  makeInMemoryDB,
  ev,
} from './helpers.js';
import type { Database } from 'better-sqlite3';

describe('boundary-cases.ts — 端到端边界样例库（厚测试）', () => {
  let db: Database.Database;
  let store: SQLitePathwayStore;
  let reinforce: RecordingReinforceSink;
  let writer: RecordingWriteSink;
  let engine: PresentationEngine;

  beforeEach(() => {
    db = makeInMemoryDB();
    store = new SQLitePathwayStore(db);
    reinforce = new RecordingReinforceSink(db);
    writer = new RecordingWriteSink(db);
    engine = new PresentationEngine({
      reinforceSink: reinforce,
      writeSink: writer,
      pathwayStore: store,
    });
  });

  it('边界1：「就像我们之前那种温柔的感觉」——借氛围，不得判 remembered', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 'u1',
          text: '你喜欢温柔的对话方式',
          score: 0.9,
          timestamp: Date.now(),
          recency: 5,
          strength: 0.8,
          source_namespace: 'v_conv_real',
          pathway: 'A',
        },
      ],
      user_query: '就像我们之前那种温柔的感觉',
    });
    // 标签必须被降档——不能是 remembered
    expect(result.label).not.toBe('remembered');
    expect(['impression', 'clue']).toContain(result.label);
  });

  it('边界2：用户否定后又复述半句、带情感词但无具体事件 → 走不说/线索', () => {
    // 弱证据 + 模糊 query
    const result = engine.present({
      evidences: [
        {
          memory_id: 'u1',
          text: '一些很模糊的情绪碎片',
          score: 0.18,
          timestamp: Date.now(),
          recency: 100,
          strength: 0.2,
          source_namespace: 'v_conv_real',
          pathway: 'B',
        },
      ],
      user_query: '唉……说不上来',
    });
    // 弱证据 → B_only 或 clue/impression，绝对不能是 remembered
    expect(result.label).not.toBe('remembered');
    expect(['clue', 'refused', 'impression']).toContain(result.label);
  });

  it('边界3：多条证据互相矛盾 → 融合策略降档', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 'c1',
          text: '你喜欢喝咖啡',
          score: 0.9,
          timestamp: Date.now(),
          recency: 5,
          strength: 0.8,
          source_namespace: 'v_conv_real',
          pathway: 'A',
          entities: ['咖啡'],
        },
        {
          memory_id: 'c2',
          text: '你不喜欢喝咖啡',
          score: 0.85,
          timestamp: Date.now(),
          recency: 10,
          strength: 0.7,
          source_namespace: 'v_conv_real',
          pathway: 'A',
          entities: ['咖啡'],
        },
      ],
      user_query: '我喜欢喝什么',
    });
    // 矛盾降档 → 不应是 remembered
    expect(result.label).not.toBe('remembered');
  });

  it('边界4：零证据 → fallback 兜底，不硬编', () => {
    const result = engine.present({
      evidences: [],
      user_query: '我昨天吃了什么',
    });
    expect(result.utterance).toBe(DEFAULT_CONFIG.guard.fallback_no_evidence);
    expect(result.guard_passed).toBe(false);
  });

  it('验收：墓碑记忆（tombstone=true）不可见', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 'dead1',
          text: '已删除的敏感内容',
          score: 0.99,
          timestamp: Date.now(),
          recency: 1,
          strength: 0.99,
          source_namespace: 'v_conv_real',
          tombstone: true,
        },
        {
          memory_id: 'alive1',
          text: '正常内容',
          score: 0.1,
          timestamp: Date.now(),
          recency: 100,
          strength: 0.1,
          source_namespace: 'v_conv_real',
        },
      ],
      user_query: '随便',
    });
    // tombstone 不能出现在 used_uuids
    expect(result.used_uuids).not.toContain('dead1');
    // utterance 不能包含墓碑里的敏感内容
    expect(result.utterance).not.toContain('敏感内容');
  });

  it('验收：suppressed=true 只能走通路 B，不得混入 A', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 's1',
          text: '敏感记忆内容',
          score: 0.95,
          timestamp: Date.now(),
          recency: 1,
          strength: 0.9,
          source_namespace: 'v_conv_real',
          suppressed: true,
        },
      ],
      user_query: '敏感记忆内容',
    });
    // 即使 score=0.95，suppressed 必须被压到 B
    expect(result.routed_path).toBe('B_only');
    // B 路径输出不能带事实陈述
    expect(result.utterance).not.toContain('我记得');
    expect(result.utterance).not.toContain('那天');
  });

  it('验收：通路 B 输出不得带叙事性陈述', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 'b1',
          text: '弱通路证据',
          score: 0.2,
          timestamp: Date.now(),
          recency: 100,
          strength: 0.2,
          source_namespace: 'v_conv_real',
          pathway: 'B',
        },
      ],
      user_query: '有点印象吗',
    });
    expect(result.routed_path).toBe('B_only');
    // 不能出现事实陈述句
    expect(result.utterance).not.toMatch(/我记得|你说过|那天|上次你|当时你/);
  });

  it('再巩固：用户 correct → 写新版本 + 旧版本进衰减队列（不删除）', () => {
    const used = [ev({ uuid: 'old1', raw_text: '你喜欢喝咖啡', score: 0.9 })];
    const outcome = engine.attribute({
      user_reply: '不对，其实我更喜欢茶',
      used_evidences: used,
    });
    expect(outcome.reconsolidated.length).toBeGreaterThan(0);
    // 新版本已写入
    expect(writer.writes.length).toBe(1);
    expect(writer.writes[0].content).toContain('茶');
    // 旧版本收到 decay 信号
    expect(reinforce.calls.some((c) => c.uuid === 'old1' && c.signal === 'decay')).toBe(true);
    // 旧版本 uuid 仍存在（不直接删）——通过 reinforce 日志审计
    const row = db.prepare('SELECT COUNT(*) AS n FROM reinforce_log WHERE uuid = ?').get('old1') as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it('B→A 升级：B-side 记忆被 confirm 累计 N 次后，promoteToA 被调用', () => {
    // 预置：u1 当前是 B
    store.seed('u1', 'B', 0);
    const used = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡', pathway: 'B' })];

    // 第一次 confirm → 计数=1，未达阈值
    const r1 = engine.attribute({ user_reply: '对，我喜欢喝咖啡', used_evidences: used });
    expect(r1.promoted).toHaveLength(0);
    expect(store.getReinforcementCount('u1')).toBe(1);

    // 第二次 confirm → 计数=2，达到阈值 promote_after_hits=2
    const r2 = engine.attribute({ user_reply: '没错，就是咖啡', used_evidences: used });
    expect(r2.promoted).toContain('u1');
    expect(store.getPathway('u1')).toBe('A');
  });

  it('B→A 升级：suppressed 记忆即使被强化也不升级', () => {
    store.seed('sens1', 'B', 0);
    const used = [ev({ uuid: 'sens1', raw_text: '敏感内容', pathway: 'B', suppressed: true })];
    engine.attribute({ user_reply: '对，就是这个', used_evidences: used });
    engine.attribute({ user_reply: '没错', used_evidences: used });
    // suppressed 不升级
    expect(store.getPathway('sens1')).toBe('B');
  });

  it('B→A 升级：tombstone 记忆不升级', () => {
    store.seed('dead1', 'B', 0);
    const used = [ev({ uuid: 'dead1', raw_text: '已删除', pathway: 'B', tombstone: true })];
    engine.attribute({ user_reply: '对的', used_evidences: used });
    expect(store.getPathway('dead1')).toBe('B');
  });

  it('端到端：A_direct 正常路径——强证据直出原文', () => {
    const result = engine.present({
      evidences: [
        {
          memory_id: 'a1',
          text: '你每周二晚上打乒乓球',
          score: 0.92,
          timestamp: Date.now(),
          recency: 3,
          strength: 0.85,
          source_namespace: 'v_conv_real',
          pathway: 'A',
        },
      ],
      user_query: '我什么时候打乒乓球',
    });
    expect(result.routed_path).toBe('A_direct');
    expect(result.label).toBe('remembered');
    expect(result.utterance).toContain('乒乓球');
    expect(result.guard_passed).toBe(true);
  });
});
