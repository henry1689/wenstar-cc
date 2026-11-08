/**
 * evidence-layer.test.ts — 证据层 owned 收集器（MEM-UNIFY-V1 批2B）
 * ================================================================
 * 锁定：
 *   - 会晤态：只返回会晤实体自己的档案/作品/记事，无归属与其它实体一律拒绝；
 *   - 户主态：白名单内 + 无归属历史证据可见，白名单外拒绝；
 *   - 户主钥匙（无白名单）：不限制；
 *   - 收集器按 domain:id 去重、按分数排序。
 */
import { describe, it, expect } from 'vitest';
import {
  buildEvidencePolicy,
  collectEvidenceLayer,
  evidenceFragment,
  type EvidenceLayerDeps,
} from '../evidence-layer.js';
import { passes } from '../../../governance/police/UUIDPoliceFilter.js';

const A = 'TXS-000000001';
const B = 'TXS-000000002';

/** 假 sqlite：按 SQL 内容分派 Note / Work 两路 */
function fakeSqlite(notes: any[], works: any[]): EvidenceLayerDeps['sqlite'] {
  return {
    queryAll(sql: string, params?: unknown[]) {
      const q = String(params?.[0] ?? '');
      const kw = q.replace(/%/g, '');
      if (sql.includes("memory_type='note'")) {
        // 夹具说明：真实 NoteAdapter 是整句 LIKE；本用例只验证 owned 隔离，
        // 故用「查询词任一命中」模拟多词查询下的记事匹配。
        const parts = kw.split(/[\s,，]+/).filter(Boolean);
        return notes.filter((n) => parts.some((p) => String(n.raw_input).includes(p)));
      }
      if (sql.includes('FROM works')) {
        // WorkAdapter 对每个关键词给 3 个占位符；任一关键词命中即可
        const kws = (params ?? []).map((p) => String(p).replace(/%/g, '')).filter(Boolean);
        return works.filter((w) => kws.some((k) =>
          String(w.title).includes(k) || String(w.summary).includes(k) || String(w.full_text).includes(k)));
      }
      return [];
    },
  } as any;
}

const NOTES = [
  { id: 'n-a', raw_input: '诗雨的钥匙在门口抽屉', sub_type: 'fact', created_at: '2026-11-01', belong_entity_uuid: A },
  { id: 'n-b', raw_input: '梓铭的药放在书架第二层', sub_type: 'fact', created_at: '2026-11-02', belong_entity_uuid: B },
  { id: 'n-null', raw_input: '雨伞放在玄关', sub_type: 'fact', created_at: '2026-11-03', belong_entity_uuid: null },
];

const WORKS = [
  { work_id: 'w-a', title: '海边的小说', work_type: 'novel', summary: '海边', full_text: '海边', belong_entity_uuid: A, created_at: '2026-11-01' },
  { work_id: 'w-b', title: '书架上的诗', work_type: 'poem', summary: '书架', full_text: '书架', belong_entity_uuid: B, created_at: '2026-11-02' },
];

describe('A. 策略三态', () => {
  it('会晤态：strict，无归属拒', () => {
    const p = buildEvidencePolicy({ meetingUuid: A });
    expect(p.searchScope).toBe('strict');
    expect(passes(A, p)).toBe(true);
    expect(passes(B, p)).toBe(false);
    expect(passes(null, p)).toBe(false);
  });

  it('户主态（有白名单）：白名单 + 无归属可见，他人拒', () => {
    const p = buildEvidencePolicy({ visibleUuids: [A], ownerMode: true });
    expect(p.searchScope).toBe('allow-unowned');
    expect(passes(A, p)).toBe(true);
    expect(passes(null, p)).toBe(true);
    expect(passes(B, p)).toBe(false);
  });

  it('户主钥匙（无白名单）：enforce=false 不限制', () => {
    const p = buildEvidencePolicy({ ownerMode: true });
    expect(p.enforce).toBe(false);
    expect(passes(B, p)).toBe(true);
  });
});

describe('B. 收集器 owned 隔离', () => {
  const deps: EvidenceLayerDeps = { sqlite: fakeSqlite(NOTES, WORKS) };

  it('会晤态只返回会晤实体的记事与作品', async () => {
    const hits = await collectEvidenceLayer('钥匙 书架 雨伞 海边', deps, { meetingUuid: A });
    const ids = hits.map((h) => `${h.domain}:${h.id}`);
    expect(ids).toContain('note:n-a');
    expect(ids).toContain('work:w-a');
    expect(ids).not.toContain('note:n-b');
    expect(ids).not.toContain('work:w-b');
    expect(ids).not.toContain('note:n-null');
  });

  it('户主态白名单：他人证据被拒，无归属历史记事放行', async () => {
    const hits = await collectEvidenceLayer('钥匙 书架 雨伞 海边', deps, {
      visibleUuids: [A], ownerMode: true,
    });
    const ids = hits.map((h) => `${h.domain}:${h.id}`);
    expect(ids).toContain('note:n-a');
    expect(ids).toContain('note:n-null');
    expect(ids).not.toContain('note:n-b');
    expect(ids).not.toContain('work:w-b');
  });

  it('户主钥匙：全部可见', async () => {
    const hits = await collectEvidenceLayer('钥匙 书架 雨伞 海边', deps, { ownerMode: true });
    const ids = hits.map((h) => `${h.domain}:${h.id}`);
    expect(ids).toContain('note:n-b');
    expect(ids).toContain('work:w-b');
  });

  it('同一 domain:id 只保留一条；空查询返回空', async () => {
    const hits = await collectEvidenceLayer('海边', deps, { meetingUuid: A });
    const keys = hits.map((h) => `${h.domain}:${h.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await collectEvidenceLayer('  ', deps, { meetingUuid: A })).toEqual([]);
  });

  it('注入标签统一', () => {
    expect(evidenceFragment({ domain: 'work', text: 'x' } as any)).toBe('【作品】x');
    expect(evidenceFragment({ domain: 'note', text: 'y' } as any)).toBe('【记事】y');
    expect(evidenceFragment({ domain: 'family_graph', text: 'z' } as any)).toBe('【档案】z');
  });
});
