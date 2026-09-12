import { describe, it, expect } from 'vitest';
import { MemoryRetriever } from '../MemoryRetriever.js';

// 实体召回窗口行为回归测试（2026-09-12）
// 现象：会晤中"一天多前聊过的就不记得" —— 记忆库里有（实测徐诗雨 570 条）却召不回。
// 根因：实体 UUID 通道为「按 seq_pos 倒序取最新 10 条」单窗口，早期高钙化/地标记忆
//       永远进不了上下文。
// 修复：分层召回（最新层 + 重要层：地标/高钙化/高召回），窗口随调用方 limit 抬升；
//       归属过滤统一走 UUIDPoliceFilter.buildSqlClause，异常时回退存储公共 API。
// 样例为日常语境，不涉亲密内容。

const UUID = 'TXS-000000007';

/** 早期地标记忆（一天多前，seq_pos 小）—— 修复后必须能被召回 */
const OLD_LANDMARK = {
  id: 'mem_old_landmark', seq_pos: 12,
  raw_input: '中秋之约：今年中秋一起过', created_at: '2026-09-05T10:00:00.000Z',
  calcium_score: 6.2, calcium_level: 4, is_landmark: 1, locus_path: 'life.festival',
  memory_kind: 'dialog', memory_type: 'dialog',
};
const RECENT = Array.from({ length: 6 }, (_, i) => ({
  id: 'mem_recent_' + i, seq_pos: 900 + i,
  raw_input: '最近的一次闲聊 ' + i, created_at: '2026-09-12T06:0' + i + ':00.000Z',
  calcium_score: 0.4, calcium_level: 1, is_landmark: 0, locus_path: 'life.daily',
  memory_kind: 'dialog', memory_type: 'dialog',
}));

function mkStorage() {
  const calls: string[] = [];
  return {
    calls,
    findByLocus: async () => { calls.push('findByLocus'); return []; },
    findBySeqPosRange: async () => { calls.push('findBySeqPosRange'); return []; },
    findByEmotionalSimilarity: () => { calls.push('findByEmotionalSimilarity'); return []; },
    // 分层召回经 getSQLite() 直查 — 按 SQL 语义分流：
    //   重要层（ORDER BY is_landmark DESC）含早期地标；最新层（ORDER BY seq_pos DESC）只有近期。
    getSQLite: () => ({
      queryAll: (sql: string, params: any[]) => {
        const lim = Number(params?.[params.length - 1]) || 0;
        if (/is_landmark DESC/.test(sql)) {
          calls.push('queryAll:important:' + lim);
          return [OLD_LANDMARK, ...RECENT].slice(0, lim);
        }
        calls.push('queryAll:recent:' + lim);
        return RECENT.slice(0, lim);
      },
    }),
    // 回退路径：仅当分层查询为空时才被调用（本组用例不应走到）
    findByEntityUuid: (uuid: string, limit: number) => {
      calls.push('findByEntityUuid:' + limit);
      return [];
    },
  } as any;
}

describe('[m4] 实体召回窗口：按 UUID 分层召回，早期记忆可达', () => {
  it('早期高钙化地标记忆能被召回（旧单窗口实现 → 红）', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], { entityUuids: [UUID], limit: 20 });
    const ids = out.map((d: any) => d.branch_id);
    expect(ids).toContain('mem_old_landmark');
  });

  it('分层召回的「重要层」被调用（分层接线到位）', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    await r.retrieveMemories('life.daily', [], { entityUuids: [UUID], limit: 20 });
    expect(storage.calls.some((c: string) => c.startsWith('queryAll:important'))).toBe(true);
  });

  it('召回窗口随 limit 抬升，不再固定 10 条', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], { entityUuids: [UUID], limit: 20 });
    // limit=20 → 实体窗口 = max(20, 20*2) = 40（旧实现硬编码 10 条）
    expect(storage.calls.some((c: string) => /:40$/.test(c))).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(7);
  });
});
