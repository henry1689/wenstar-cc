/**
 * BArchiveReader 单元测试（P145 批 B）
 * ====================================
 * 覆盖三件事：
 *   ① 单点读取：原文 / 摘要 / 快照 / 日志 / 完整性校验
 *   ② 会晤安全：audienceUuid 过滤耳语轮（归属=他人）
 *   ③ 消费计数：USER_CONSUME 加 δ、节流、封顶；OPS_BACKFILL 只记日志
 *
 * 用内存假数据源，不碰真库 —— 真库是 sql.js 整库载入，单测里另起实例有覆盖磁盘的风险。
 */

import { describe, it, expect } from 'vitest';
import {
  BArchiveReader,
  assertAnchoredRead,
  CONSUME_DELTA,
  CONSUME_MAX_COUNTED,
  CALCIUM_SCORE_MAX,
} from '../BArchiveReader.js';
import { computeContentHash, computeSummaryHash } from '../bArchiveHash.js';

const YUYAO = 'uuid-yuyao-0001';
const AZHEN = 'uuid-azhen-0001';
const OTHER = 'uuid-other-0001';

interface GroupRow {
  dialog_group_id: string;
  belong_entity_uuid: string | null;
  narrative_tag: string | null;
  primary_emotion: string | null;
  lifecycle_state: string | null;
  block_calcium_score: number;
  consume_count: number;
  last_consumed_at: string | null;
  turn_count: number;
  first_ts: string | null;
  last_ts: string | null;
  block_close_reason: string | null;
  summary_state: string | null;
  block_summary: string | null;
  content_hash: string | null;
  summary_hash: string | null;
  perception_40d_snapshot: string | null;
  append_log: string | null;
}

class FakeSql {
  groups = new Map<string, GroupRow>();
  convs: Array<{
    id: number; role: string; content: string; timestamp: string;
    seq_pos: number | null; belong_entity_uuid: string | null; dialog_group_id: string;
  }> = [];
  nodes: Array<{ uuid: string; name: string }> = [];
  /** 记录所有被下发的 SQL，供守卫断言用 */
  issued: string[] = [];

  queryAll(sql: string, params?: unknown[]): any[] {
    const q = sql.replace(/\s+/g, ' ');
    this.issued.push(q);
    const args = (params || []) as any[];
    if (q.includes('FROM nodes')) {
      const set = new Set(args.map((x) => String(x)));
      return this.nodes.filter((n) => set.has(n.uuid));
    }
    if (q.includes('FROM conversations')) {
      return this.convs.filter((c) => c.dialog_group_id === args[0]);
    }
    if (q.includes('SELECT consume_count')) {
      const g = this.groups.get(String(args[0]));
      if (!g) return [];
      return [{ consume_count: g.consume_count, last_consumed_at: g.last_consumed_at, block_calcium_score: g.block_calcium_score }];
    }
    if (q.includes('SELECT append_log')) {
      const g = this.groups.get(String(args[0]));
      return g ? [{ append_log: g.append_log }] : [];
    }
    if (q.includes('FROM dialog_groups')) {
      const g = this.groups.get(String(args[0]));
      return g ? [g] : [];
    }
    return [];
  }

  writeRaw(sql: string, ...params: any[]): void {
    const q = sql.replace(/\s+/g, ' ');
    this.issued.push(q);
    const p: any[] = Array.isArray(params[0]) ? params[0] : params;
    if (q.includes('SET append_log')) {
      const g = this.groups.get(String(p[2]));
      if (g) g.append_log = String(p[0]);
      return;
    }
    if (q.includes('SET consume_count')) {
      const g = this.groups.get(String(p[3]));
      if (g) { g.consume_count = Number(p[0]); g.last_consumed_at = p[1] ?? null; g.block_calcium_score = Number(p[2]); }
      return;
    }
    if (q.includes('SET block_summary')) {
      const g = this.groups.get(String(p[4]));
      if (g) { g.block_summary = p[0]; g.summary_state = p[1]; g.summary_hash = p[2]; }
      return;
    }
  }
}

function seed(): FakeSql {
  const sql = new FakeSql();
  sql.nodes = [
    { uuid: YUYAO, name: '玉瑶' },
    { uuid: AZHEN, name: '阿珍' },
    { uuid: OTHER, name: '诗雨' },
  ];
  sql.convs = [
    { id: 1, role: 'user', content: '今天去哪玩', timestamp: '2026-10-01T10:00:00Z', seq_pos: 1, belong_entity_uuid: YUYAO, dialog_group_id: 'dg-1' },
    { id: 2, role: 'assistant', content: '去湖边走走', timestamp: '2026-10-01T10:00:05Z', seq_pos: 2, belong_entity_uuid: YUYAO, dialog_group_id: 'dg-1' },
    { id: 3, role: 'user', content: '悄悄话给你', timestamp: '2026-10-01T10:00:09Z', seq_pos: 3, belong_entity_uuid: OTHER, dialog_group_id: 'dg-1' },
  ];
  const summary = '【标签】湖边\n【叙事】两人决定去湖边。\n【情感】愉快';
  sql.groups.set('dg-1', {
    dialog_group_id: 'dg-1',
    belong_entity_uuid: YUYAO,
    narrative_tag: 'daily',
    primary_emotion: '愉快',
    lifecycle_state: 'active',
    block_calcium_score: 4,
    consume_count: 0,
    last_consumed_at: null,
    turn_count: 3,
    first_ts: '2026-10-01T10:00:00Z',
    last_ts: '2026-10-01T10:00:09Z',
    block_close_reason: 'idle_timeout',
    summary_state: 'done',
    block_summary: summary,
    content_hash: computeContentHash(sql.convs as any),
    summary_hash: computeSummaryHash(summary),
    perception_40d_snapshot: JSON.stringify({ dims: 40, agg: 'mean', dim_version: 'v1', vector: [] }),
    append_log: JSON.stringify([{ ts: '2026-10-01T10:00:10Z', type: 'content_hashed', actor: 'test', detail: {} }]),
  });
  return sql;
}

describe('BArchiveReader · 单点读取', () => {
  it('返回原文 / 摘要 / 快照 / 日志，且完整性校验通过', () => {
    const sql = seed();
    const rec = new BArchiveReader(sql).getByGroupId('dg-1');
    expect(rec).not.toBeNull();
    expect(rec!.conversations).toHaveLength(3);
    expect(rec!.summary).toContain('湖边');
    expect(rec!.snapshot?.agg).toBe('mean');
    expect(rec!.appendLog).toHaveLength(1);
    expect(rec!.integrity.contentHashMatches).toBe(true);
    expect(rec!.integrity.summaryHashMatches).toBe(true);
  });

  it('组不存在 ⇒ null（不抛）', () => {
    const sql = seed();
    expect(new BArchiveReader(sql).getByGroupId('dg-not-exist')).toBeNull();
    expect(new BArchiveReader(sql).getByGroupId('')).toBeNull();
  });

  it('audienceUuid 过滤掉归属他人的耳语轮', () => {
    const sql = seed();
    const rec = new BArchiveReader(sql).getByGroupId('dg-1', { audienceUuid: YUYAO });
    expect(rec!.conversations).toHaveLength(2);
    expect(rec!.conversations.some((c) => c.belongEntityUuid === OTHER)).toBe(false);
    // 🔴 完整性校验必须仍按**全量行**算 —— 过滤后仍应为 true，否则会误报「被篡改」
    expect(rec!.integrity.contentHashMatches).toBe(true);
  });

  it('render 使用真实说话人名，不含「玉瑶：」占位错误', () => {
    const sql = seed();
    const rec = new BArchiveReader(sql).getByGroupId('dg-1')!;
    const text = new BArchiveReader(sql).render(rec);
    expect(text).toContain('【卷宗回放');
    expect(text).toContain('用户：今天去哪玩');
    expect(text).toContain('玉瑶：去湖边走走');
    // 🔴 role='user' 的行一律显示「用户」—— 用户轮次不按 belong_entity_uuid 改标签：
    //   会晤下用户消息的归属记的是会晤实体（persistence-stage），若按归属取名会把
    //   「用户说的话」误标成角色说的。耳语轮的正文同理仍属用户本人。
    expect(text).toContain('用户：悄悄话给你');
  });

  it('render 超限时截断并显式告知未展开轮数', () => {
    const sql = seed();
    const rec = new BArchiveReader(sql).getByGroupId('dg-1')!;
    const text = new BArchiveReader(sql).render(rec, { maxChars: 80 });
    expect(text).toContain('未展开');
  });
});

describe('BArchiveReader · 消费计数', () => {
  it('USER_CONSUME 首计：consume_count+1、钙分+0.3、awakened 与 consumer_counted 双记', () => {
    const sql = seed();
    const reader = new BArchiveReader(sql);
    const r = reader.recordConsume('dg-1', 'USER_CONSUME');
    expect(r.counted).toBe(true);
    expect(r.consumeCount).toBe(1);
    expect(r.calciumScore).toBeCloseTo(4 + CONSUME_DELTA, 5);

    const g = sql.groups.get('dg-1')!;
    const log = JSON.parse(g.append_log || '[]');
    // 🔴 awakened 与 consumer_counted 是两个独立事件（微调 5）：
    //   前者 = 卷宗被唤醒（每次回放都记），后者 = 消费计数与钙分回写（实际计数时才记）
    expect(log.some((e: any) => e.type === 'awakened' && e.detail.kind === 'USER_CONSUME')).toBe(true);
    expect(log.some((e: any) => e.type === 'consumer_counted' && e.detail.kind === 'USER_CONSUME')).toBe(true);
  });

  it('30 分钟内同组再次 USER_CONSUME ⇒ 节流，不加分', () => {
    const sql = seed();
    const reader = new BArchiveReader(sql);
    reader.recordConsume('dg-1', 'USER_CONSUME');
    const second = reader.recordConsume('dg-1', 'USER_CONSUME');
    expect(second.counted).toBe(false);
    expect(second.reason).toBe('throttled');
    expect(sql.groups.get('dg-1')!.consume_count).toBe(1);
  });

  it('🔴 节流期回放仍写 awakened，但不写 consumer_counted（唤醒留痕不可丢）', () => {
    const sql = seed();
    const reader = new BArchiveReader(sql);
    reader.recordConsume('dg-1', 'USER_CONSUME');

    const before = JSON.parse(sql.groups.get('dg-1')!.append_log || '[]').length;
    const second = reader.recordConsume('dg-1', 'USER_CONSUME');
    expect(second.reason).toBe('throttled');

    const log = JSON.parse(sql.groups.get('dg-1')!.append_log || '[]');
    expect(log.length).toBe(before + 1);                 // 只多一条
    const added = log[log.length - 1];
    expect(added.type).toBe('awakened');                 // 且必须是 awakened
    expect(added.detail.throttled).toBe(true);           // 如实标注本次被节流
    // 节流期没有真正计数 ⇒ consumer_counted 仍只有首计那一条
    expect(log.filter((e: any) => e.type === 'consumer_counted').length).toBe(1);
  });

  it('OPS_BACKFILL 只计数记日志，**不改钙分**', () => {
    const sql = seed();
    const reader = new BArchiveReader(sql);
    const r = reader.recordConsume('dg-1', 'OPS_BACKFILL');
    expect(r.counted).toBe(false);
    expect(r.calciumScore).toBe(4);
    expect(sql.groups.get('dg-1')!.consume_count).toBe(1);
    const log = JSON.parse(sql.groups.get('dg-1')!.append_log || '[]');
    expect(log.some((e: any) => e.type === 'consumer_counted' && e.detail.kind === 'OPS_BACKFILL')).toBe(true);
  });

  it('USER_CONSUME 累计到上限后不再加分（封顶逻辑）', () => {
    const sql = seed();
    const g = sql.groups.get('dg-1')!;
    g.consume_count = CONSUME_MAX_COUNTED;
    g.last_consumed_at = '2020-01-01T00:00:00Z';   // 绕过节流
    const r = new BArchiveReader(sql).recordConsume('dg-1', 'USER_CONSUME');
    expect(r.counted).toBe(false);                  // 已达上限 ⇒ 不计
    expect(r.calciumScore).toBe(4);                 // 钙分不变
    expect(r.consumeCount).toBe(CONSUME_MAX_COUNTED + 1);
  });

  it('钙分不会超过上限', () => {
    const sql = seed();
    const g = sql.groups.get('dg-1')!;
    g.block_calcium_score = CALCIUM_SCORE_MAX - 0.1;
    g.last_consumed_at = '2020-01-01T00:00:00Z';
    const r = new BArchiveReader(sql).recordConsume('dg-1', 'USER_CONSUME');
    expect(r.calciumScore).toBe(CALCIUM_SCORE_MAX);
  });

  it('组不存在 ⇒ 不计数、不抛', () => {
    const sql = seed();
    const r = new BArchiveReader(sql).recordConsume('nope', 'USER_CONSUME');
    expect(r.counted).toBe(false);
    expect(r.reason).toBe('group_not_found');
  });
});

describe('BArchiveReader · 守卫', () => {
  it('assertAnchoredRead 放行带主键锚点的读取', () => {
    expect(() => assertAnchoredRead('SELECT 1 FROM dialog_groups WHERE dialog_group_id = ?')).not.toThrow();
  });

  it('assertAnchoredRead 拦截无锚点全表扫描', () => {
    expect(() => assertAnchoredRead('SELECT * FROM dialog_groups')).toThrow(/BArchiveGuard/);
    expect(() => assertAnchoredRead('SELECT * FROM dialog_groups WHERE lifecycle_state = ?')).toThrow(/BArchiveGuard/);
  });

  it('不查 dialog_groups 的语句直接放行', () => {
    expect(() => assertAnchoredRead('SELECT 1 FROM conversations WHERE dialog_group_id = ?')).not.toThrow();
  });
});
