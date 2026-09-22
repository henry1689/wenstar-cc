import { describe, expect, it } from 'vitest';
import {
  addBlackDiamond,
  autoPromoteCandidatesV2,
  deleteBlackDiamond,
  evaluateDiamondPromotion,
  promoteToBlackDiamond,
} from '../VaultManager.js';

type MemoryRow = {
  id: string;
  raw_input: string;
  calcium_score: number;
  calcium_level: number;
  recall_count: number;
  is_landmark?: number;
  scar_type?: string | null;
  narrative_tag?: string | null;
  perception_40d?: string | null;  // V12.4 根除24D: perception_json → perception_40d
  lifecycle_state?: string;
  promoted_to_diamond?: number;
  promotion_reason?: string | null;
  last_verified_at?: string | null;
  effective_strength?: number;
  primary_emotion?: string | null;
  namespace?: string;
};

type DiamondRow = {
  id: string;
  summary: string;
  emotion_tag: string | null;
  source_id: string | null;
  calcium_level: number;
  recall_count: number;
  tags: string;
  notes: string;
  created_at: string;
  updated_at: string;
  namespace?: string;
};

class MockSQLite {
  memories = new Map<string, MemoryRow>();
  diamonds = new Map<string, DiamondRow>();

  queryAll(sql: string, params?: any[]): any[] {
    if (sql.includes('SELECT COUNT(*) as cnt FROM black_diamond')) {
      return [{ cnt: this.diamonds.size }];
    }
    if (sql.includes('SELECT id, calcium_level FROM black_diamond ORDER BY')) {
      const rows = Array.from(this.diamonds.values())
        .sort((a, b) => a.calcium_level - b.calcium_level || a.created_at.localeCompare(b.created_at));
      return rows.length ? [{ id: rows[0].id, calcium_level: rows[0].calcium_level }] : [];
    }
    if (sql.includes('SELECT * FROM black_diamond WHERE id = ? LIMIT 1')) {
      const row = this.diamonds.get(String(params?.[0]));
      return row ? [row] : [];
    }
    if (sql.includes('SELECT id, summary, emotion_tag, tags, notes, calcium_level') && sql.includes('FROM black_diamond')) {
      return Array.from(this.diamonds.values());
    }
    if (sql.includes('SELECT id FROM black_diamond WHERE source_id = ? LIMIT 1')) {
      const sourceId = String(params?.[0]);
      const row = Array.from(this.diamonds.values()).find((entry) => entry.source_id === sourceId);
      return row ? [{ id: row.id }] : [];
    }
    if (sql.includes('FROM memories') && sql.includes('COALESCE(promoted_to_diamond, 0) = 0')) {
      return Array.from(this.memories.values())
        .filter((row) =>
          Number(row.promoted_to_diamond ?? 0) === 0 &&
          ['candidate', 'active', 'healed'].includes(row.lifecycle_state ?? 'candidate') &&
          (
            Number(row.calcium_score ?? 0) >= 3.5 ||
            Number(row.recall_count ?? 0) >= 3 ||
            Number(row.is_landmark ?? 0) === 1
          )
        )
        .sort((a, b) =>
          Number(b.calcium_score ?? 0) - Number(a.calcium_score ?? 0) ||
          Number(b.recall_count ?? 0) - Number(a.recall_count ?? 0) ||
          Number(b.is_landmark ?? 0) - Number(a.is_landmark ?? 0)
        )
        .slice(0, Number(params?.[0] ?? 5));
    }
    if (sql.includes('SELECT id, raw_input, calcium_score')) {
      const row = this.memories.get(String(params?.[0]));
      return row ? [row] : [];
    }
    return [];
  }

  writeRaw(sql: string, ...params: any[]): void {
    if (sql.includes('UPDATE memories') && sql.includes('WHERE id = (SELECT source_id FROM black_diamond WHERE id = ?)')) {
      const diamond = this.diamonds.get(String(params[0]));
      if (!diamond?.source_id) return;
      const row = this.memories.get(diamond.source_id);
      if (!row) return;
      row.promoted_to_diamond = 0;
      row.lifecycle_state = 'active';
      row.promotion_reason = null;
      return;
    }
    if (sql.includes('UPDATE memories') && sql.includes('SET promoted_to_diamond = 1')) {
      const row = this.memories.get(String(params[2]));
      if (!row) return;
      row.promoted_to_diamond = 1;
      row.lifecycle_state = 'promoted';
      row.promotion_reason = String(params[0]);
      row.last_verified_at = String(params[1]);
      return;
    }
    if (sql.includes('UPDATE black_diamond') && sql.includes('SET calcium_level = ?')) {
      const row = this.diamonds.get(String(params[4]));
      if (!row) return;
      row.calcium_level = Number(params[0]);
      row.tags = String(params[1]);
      row.notes = String(params[2]);
      row.updated_at = String(params[3]);
      return;
    }
    if (sql.includes('UPDATE memories') && sql.includes('SET promoted_to_diamond = 0')) {
      const row = this.memories.get(String(params[0]));
      if (!row) return;
      row.promoted_to_diamond = 0;
      row.lifecycle_state = 'active';
      row.promotion_reason = null;
      return;
    }
    if (sql.includes('INSERT INTO black_diamond')) {
      this.diamonds.set(String(params[0]), {
        id: String(params[0]),
        summary: String(params[1]),
        emotion_tag: params[2] == null ? null : String(params[2]),
        source_id: params[3] == null ? null : String(params[3]),
        calcium_level: Number(params[4]),
        recall_count: 0,
        tags: String(params[5]),
        notes: String(params[6]),
        created_at: String(params[7]),
        updated_at: String(params[8]),
        namespace: String(params[10] ?? 'default'),
      });
      return;
    }
    if (sql.includes('DELETE FROM black_diamond WHERE id = ?')) {
      this.diamonds.delete(String(params[0]));
    }
  }
}

describe('VaultManager promotion state machine', () => {
  it('evaluates lifecycle-aware promotion eligibility', () => {
    expect(evaluateDiamondPromotion({
      calcium_score: 4.8,
      lifecycle_state: 'suppressed',
      scar_type: 'rupture',
    })).toEqual({ eligible: false, reason: null, targetState: 'candidate' });

    expect(evaluateDiamondPromotion({
      is_landmark: 1,
      calcium_score: 3.8,
      lifecycle_state: 'active',
    })).toEqual({ eligible: true, reason: 'landmark+high-calcium', targetState: 'promoted' });

    expect(evaluateDiamondPromotion({
      recall_count: 5,
      lifecycle_state: 'candidate',
    })).toEqual({ eligible: true, reason: 'recall>=5', targetState: 'promoted' });

    expect(evaluateDiamondPromotion({
      calcium_score: 4.1,
      recall_count: 3,
      effective_strength: 0.74,
      narrative_tag: '重要节点',
      lifecycle_state: 'active',
    })).toEqual({
      eligible: true,
      reason: 'multi-factor:high-calcium+recall>=3+strong-trace+narrative-tag',
      targetState: 'promoted',
    });
  });

  it('promotes a gold memory and writes back lifecycle metadata', () => {
    const sqlite = new MockSQLite();
    sqlite.memories.set('mem_1', {
      id: 'mem_1',
      raw_input: '这是一次需要被珍藏的重要对话',
      calcium_score: 4.8,
      calcium_level: 4,
      recall_count: 2,
      is_landmark: 0,
      scar_type: null,
      narrative_tag: '重要',
      perception_40d: '{"__v":2,"dims":' + JSON.stringify((() => { const a = new Array(40).fill(0); a[11] = 0.8; return a; })()) + '}',
      lifecycle_state: 'active',
      promoted_to_diamond: 0,
      effective_strength: 0.7,
      primary_emotion: '快乐',
      namespace: 'default',
    });

    const entry = promoteToBlackDiamond(sqlite as any, 'mem_1');

    expect(entry?.source_id).toBe('mem_1');
    expect(sqlite.memories.get('mem_1')?.promoted_to_diamond).toBe(1);
    expect(sqlite.memories.get('mem_1')?.lifecycle_state).toBe('promoted');
    // 2026-09-22 量纲归一：reason 文案标明两种量纲（行为不变——fixture 4.8 属 0–5 量纲，归一为 0.96 仍达线）
    // 2026-09-22 量纲归一（0–1 ⇒ ×5 归到 0–5；>1 原值）：fixture 4.8 属 0–5 ⇒ 原值比较仍达线
    expect(sqlite.memories.get('mem_1')?.promotion_reason).toBe('native-calcium>=4.5(归一至0–5)');
  });

  it('demotes source memory metadata when a black diamond is deleted', () => {
    const sqlite = new MockSQLite();
    sqlite.memories.set('mem_2', {
      id: 'mem_2',
      raw_input: '一段已经晋升的记忆',
      calcium_score: 4.6,
      calcium_level: 4,
      recall_count: 6,
      lifecycle_state: 'promoted',
      promoted_to_diamond: 1,
      promotion_reason: 'recall>=5',
      namespace: 'default',
    });

    const entry = addBlackDiamond(sqlite as any, {
      summary: '一段已经晋升的记忆',
      source_id: 'mem_2',
      calcium_level: 4,
      promotion_reason: 'recall>=5',
    });

    expect(sqlite.memories.get('mem_2')?.lifecycle_state).toBe('promoted');
    expect(deleteBlackDiamond(sqlite as any, entry.id)).toBe(true);
    expect(sqlite.memories.get('mem_2')?.promoted_to_diamond).toBe(0);
    expect(sqlite.memories.get('mem_2')?.lifecycle_state).toBe('active');
    expect(sqlite.memories.get('mem_2')?.promotion_reason).toBeNull();
  });

  it('merges duplicate promotions into existing diamonds instead of creating another entry', () => {
    const sqlite = new MockSQLite();
    sqlite.diamonds.set('bd_existing', {
      id: 'bd_existing',
      summary: '今天和客户开会，把项目报价重新梳理了一遍。',
      emotion_tag: '工作复盘',
      source_id: 'mem_old',
      calcium_level: 3,
      recall_count: 0,
      tags: JSON.stringify(['gold_提炼']),
      notes: '已有珍藏',
      created_at: '2026-07-07T07:00:00.000Z',
      updated_at: '2026-07-07T07:00:00.000Z',
      namespace: 'ops',
    });
    sqlite.memories.set('mem_new', {
      id: 'mem_new',
      raw_input: '今天和客户开会，把项目报价重新梳理了一遍。',
      calcium_score: 4.7,
      calcium_level: 4,
      recall_count: 2,
      narrative_tag: '工作复盘',
      lifecycle_state: 'active',
      promoted_to_diamond: 0,
      effective_strength: 0.82,
      namespace: 'ops',
    });

    const entry = promoteToBlackDiamond(sqlite as any, 'mem_new');

    expect(entry?.id).toBe('bd_existing');
    expect(sqlite.diamonds.size).toBe(1);
    expect(sqlite.memories.get('mem_new')?.promoted_to_diamond).toBe(1);
    expect(sqlite.memories.get('mem_new')?.promotion_reason).toBe('merged-into:bd_existing');
    expect(sqlite.diamonds.get('bd_existing')?.notes).toContain('合并来源 mem_new');
  });

  it('autoPromoteCandidatesV2 promotes strong multi-factor memories', () => {
    const sqlite = new MockSQLite();
    sqlite.memories.set('mem_3', {
      id: 'mem_3',
      raw_input: '那次决定把项目重新立项，对我们后面的合作影响很大。',
      calcium_score: 4.1,
      calcium_level: 4,
      recall_count: 3,
      effective_strength: 0.78,
      narrative_tag: '合作转折',
      lifecycle_state: 'active',
      promoted_to_diamond: 0,
      namespace: 'default',
    });

    const entries = autoPromoteCandidatesV2(sqlite as any, 5);

    expect(entries).toHaveLength(1);
    expect(sqlite.memories.get('mem_3')?.promotion_reason).toBe('multi-factor:high-calcium+recall>=3+strong-trace+narrative-tag');
  });
});
