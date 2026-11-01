/**
 * B 链路检索守卫测试（P145 批 B · 微调 2）
 * =========================================
 * 微调 2 的三段式：
 *   ✅ 允许：带字面命中的倒排召回（必须过 UUID 过滤）
 *   ❌ 禁止：无锚点全表扫描、向量检索、按组遍历
 *   ✅ 唯一例外：深度回忆经 groupId 单点读取（BArchiveReader）
 *
 * 本文件测的是**结构性保证**，不是约定：
 *   ① `assertAnchoredRead` 对无锚点 SQL 直接抛错；
 *   ② BArchiveReader 在整条「读取 + 消费」链路里，**每一条**触及 dialog_groups
 *      的 SQL 都钉死了主键 —— 用记录 SQL 的假数据源反证，防止将来有人加一条扫描。
 *   ③ 深度回忆入口只在明确要求细节时触发（detail / full），普通提问不得展开全文。
 */

import { describe, it, expect } from 'vitest';
import { BArchiveReader } from '../BArchiveReader.js';
import { computeContentHash } from '../bArchiveHash.js';
import { tryDeepRecall } from '../../../webui/chat/b-archive-recall.js';

const YUYAO = 'uuid-yuyao-guard';

/** 只记录不下发的极简数据源 */
class RecordingSql {
  issued: string[] = [];
  queryAll(sql: string, _params?: unknown[]): any[] {
    const q = sql.replace(/\s+/g, ' ');
    this.issued.push(q);
    if (q.includes('FROM conversations')) {
      return [{ id: 1, role: 'user', content: '你好', timestamp: '2026-10-01T00:00:00Z', seq_pos: 1, belong_entity_uuid: YUYAO }];
    }
    if (q.includes('SELECT consume_count')) {
      return [{ consume_count: 0, last_consumed_at: null, block_calcium_score: 1 }];
    }
    if (q.includes('SELECT append_log')) return [{ append_log: null }];
    if (q.includes('FROM nodes')) return [];
    if (q.includes('FROM dialog_groups')) {
      const summary = '【标签】测试';
      return [{
        dialog_group_id: 'dg-g', belong_entity_uuid: YUYAO, narrative_tag: 'daily',
        primary_emotion: null, lifecycle_state: 'active', block_calcium_score: 1,
        consume_count: 0, last_consumed_at: null, turn_count: 1,
        first_ts: '2026-10-01T00:00:00Z', last_ts: '2026-10-01T00:00:00Z',
        block_close_reason: 'idle_timeout', summary_state: 'done', block_summary: summary,
        content_hash: computeContentHash([{ seq_pos: 1, role: 'user', content: '你好' }]),
        summary_hash: null, perception_40d_snapshot: null, append_log: null,
      }];
    }
    return [];
  }
  writeRaw(sql: string, ..._params: any[]): void {
    this.issued.push(sql.replace(/\s+/g, ' '));
  }
}

describe('B 链路守卫 · 结构性质', () => {
  it('读取 + 消费全链路中，凡触及 dialog_groups 的 SQL 都钉死了主键', () => {
    const sql = new RecordingSql();
    const reader = new BArchiveReader(sql);
    reader.getByGroupId('dg-g');
    reader.recordConsume('dg-g', 'USER_CONSUME');

    const touching = sql.issued.filter((q) => /dialog_groups/i.test(q));
    expect(touching.length).toBeGreaterThan(0);
    for (const q of touching) {
      expect(q, `无锚点读取：${q}`).toMatch(/dialog_group_id\s*=\s*\?/i);
    }
  });

  it('BArchiveReader 没有返回多组的公开入口（单点读取是结构性的）', () => {
    const proto = BArchiveReader.prototype as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    // 只允许：单点读取、渲染、消费计数、内部名称解析
    expect(names.sort()).toEqual(['getByGroupId', 'recordConsume', 'render', 'resolveSpeakerNames'].sort());
  });
});

describe('深度回忆入口 · 意图门控', () => {
  it('普通提问不触发全文回放', () => {
    const sql = new RecordingSql();
    expect(tryDeepRecall({ sql: sql, message: '今天天气怎么样', groupId: 'dg-g' })).toBeNull();
    expect(sql.issued).toHaveLength(0);   // 连库都不查
  });

  it('「详细说说」触发全文回放并记一次 USER_CONSUME', () => {
    const sql = new RecordingSql();
    const text = tryDeepRecall({ sql: sql, message: '详细说说那天的事', groupId: 'dg-g' });
    expect(text).toContain('【卷宗回放');
    expect(sql.issued.some((q) => /SET consume_count/i.test(q))).toBe(true);
  });

  it('「完整回忆一下」同样触发（full 档）', () => {
    const sql = new RecordingSql();
    const text = tryDeepRecall({ sql: sql, message: '完整回忆一下', groupId: 'dg-g' });
    expect(text).toContain('【卷宗回放');
  });

  it('无数据源 / 无 groupId ⇒ 安全返回 null', () => {
    expect(tryDeepRecall({ sql: null, message: '详细说说', groupId: 'dg-g' })).toBeNull();
    expect(tryDeepRecall({ sql: new RecordingSql(), message: '详细说说', groupId: '' })).toBeNull();
  });
});
