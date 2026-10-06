import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';

/**
 * [A3 / 2026-10-06] 用户边关系归一迁移（`FamilyGraph._migrateToV6`）
 * ============================================================
 * 业主实测：徐诗雨与用户之间**同时挂着 9 条互斥边**
 *   spouse_of / child_of / sibling_of / grandchild_of / acquaintance_of /
 *   father_of / parent_of / mother_of / grandfather_of
 * 而她与用户的真实关系按业主定音是「同事、情人」—— 库里一条都没有。
 *
 * 批 A2 把**读取侧**收窄为「只认实体↔用户的那条边」，于是那 9 条被并列渲染成
 * 「与鸿艺的关系: 配偶、父母、父亲、母亲、兄弟姐妹、认识的人、祖父、祖辈」。
 * A3 修**数据侧**。
 *
 * 授权范围（业主原话「授权删这 9 条边 + 建 2 条新边」）：**只处理 徐诗雨 ↔ 用户 这一对**。
 * 本测试同时锁住这条边界——别人身上的同类互斥边一根都不许动。
 */

const DB = join('D:/tmp', `__a3_useredge_test_${process.pid}.db`);
const HER = 't-a3-xsy';
const HER_UUID = 'TXS-T-A3-XSY';
const DAD = 't-a3-xdw';

const CONFLICT_RELS = [
  'spouse_of', 'child_of', 'sibling_of', 'grandchild_of', 'acquaintance_of',
  'father_of', 'parent_of', 'mother_of', 'grandfather_of',
];

async function freshFg(): Promise<any> {
  try { if (existsSync(DB)) rmSync(DB); } catch { /* 清理失败不阻塞 */ }
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  return fg;
}

function seedPerson(fg: any, id: string, name: string, uuid: string, props: Record<string, unknown>): void {
  fg.run(
    'INSERT INTO nodes (id, type, name, aliases, properties, created_at, updated_at, uuid) VALUES (?,?,?,?,?,?,?,?)',
    [id, 'person', name, '[]', JSON.stringify(props), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', uuid],
  );
}

let _edgeSeq = 0;
function addEdge(fg: any, source: string, target: string, relation: string, props: Record<string, unknown> = {}): string {
  const id = `a3e-${++_edgeSeq}`;
  fg.run(
    'INSERT INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, source, target, relation, JSON.stringify(props), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  );
  return id;
}

/** 落盘并重开一个实例 —— `initialize()` 会跑迁移链，这就是迁移的触发路径 */
async function reopen(fg: any): Promise<any> {
  await fg.flushAll();
  fg.close();
  const fg2: any = new FamilyGraph(DB);
  await fg2.initialize();
  return fg2;
}

const SELF = 'SELF-00001';

/** 在她与用户之间铺满业主实测的那 9 条互斥边 */
function seedConflictEdges(fg: any, entityId: string, selfId: string): void {
  for (const rel of CONFLICT_RELS) addEdge(fg, entityId, selfId, rel);
}

function relationsBetween(fg: any, a: string, b: string): string[] {
  return (
    fg.query(
      'SELECT relation FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
      [a, b, b, a],
    ) as Array<{ relation: string }>
  ).map((r) => String(r.relation));
}

describe('[A3] 用户边关系归一迁移', () => {
  beforeEach(() => { _edgeSeq = 0; try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });
  afterEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });

  it('🔴 核心：9 条互斥边被清掉，只留下 colleague_of + lover_of', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨', relation_to_user: '爸爸' });
    seedConflictEdges(fg, HER, SELF);

    const fg2 = await reopen(fg);
    const rels = relationsBetween(fg2, HER, SELF);

    for (const bad of CONFLICT_RELS) {
      expect(rels, `🔴 互斥边 ${bad} 仍在 —— 「与鸿艺的关系」会继续被并列渲染`).not.toContain(bad);
    }
    expect(rels).toContain('colleague_of');
    expect(rels).toContain('lover_of');
  });

  it('✅ 幂等：再启动一次不再新建/不再删（迁移与后台例程不对打）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨' });
    seedConflictEdges(fg, HER, SELF);
    const fg2 = await reopen(fg);
    const after1 = relationsBetween(fg2, HER, SELF).sort();

    const fg3 = await reopen(fg2);
    const after2 = relationsBetween(fg3, HER, SELF).sort();

    expect(after2).toEqual(after1);
  });

  it('🔴 授权边界：别人的同类互斥边一根都不许动', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨' });
    seedConflictEdges(fg, HER, SELF);
    seedPerson(fg, 't-a3-other', '另一位测试实体', 'TXS-T-A3-OTH', { name: '另一位测试实体' });
    for (const rel of ['child_of', 'spouse_of', 'sibling_of']) addEdge(fg, 't-a3-other', SELF, rel);

    const fg2 = await reopen(fg);
    const other = relationsBetween(fg2, 't-a3-other', SELF);

    expect(other.sort(), '🔴 越界清理 —— 授权只覆盖徐诗雨这一对节点').toEqual(['child_of', 'sibling_of', 'spouse_of']);
  });

  it('✅ 她与家人的边不受影响（只动「她↔用户」）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨' });
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-A3-XDW', { name: '徐东伟' });
    addEdge(fg, HER, DAD, 'child_of');
    seedConflictEdges(fg, HER, SELF);

    const fg2 = await reopen(fg);
    expect(relationsBetween(fg2, HER, DAD), '🔴 父女边被误删').toContain('child_of');
  });

  it('🔴 热力互动是复制不是搬运：原边数据保留，用户边得到一份', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨' });
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-A3-XDW', { name: '徐东伟' });
    const ix = Array.from({ length: 5 }, (_, i) => ({ timestamp: `2026-10-05T0${i}:00:00.000Z`, intimacy: 0.5 }));
    const dadEdge = addEdge(fg, HER, DAD, 'child_of', {
      _heat_score: 1.066, _relation_warmth: 'soulmate', _interactions: ix,
    });
    seedConflictEdges(fg, HER, SELF);

    const fg2 = await reopen(fg);

    const dadProps = JSON.parse(
      (fg2.query('SELECT properties FROM edges WHERE id = ?', [dadEdge]) as any[])[0].properties || '{}',
    );
    expect(dadProps._interactions?.length, '🔴 原边互动被删了 —— 里面可能混有徐东伟本人的记录，删了找不回').toBe(5);

    const userEdge = (fg2.query(
      "SELECT properties FROM edges WHERE source_id = ? AND relation = 'lover_of'",
      [SELF],
    ) as any[])[0];
    const up = JSON.parse(userEdge?.properties || '{}');
    expect(up._interactions?.length, '用户边应得到一份复制的互动，否则 computeHeat 会归零').toBe(5);
    expect(up._heat_score).toBe(1.066);
    expect(up._relation_warmth).toBe('soulmate');
  });

  it('✅ 关系展示缓存归一：情趣语境下的称谓被改写', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨', relation_to_user: '爸爸' });
    seedConflictEdges(fg, HER, SELF);

    const fg2 = await reopen(fg);
    const props = JSON.parse(
      (fg2.query('SELECT properties FROM nodes WHERE id = ?', [HER]) as any[])[0].properties || '{}',
    );
    expect(props.relation_to_user).toBe('同事、情人');
  });

  it('✅ 正常的关系描述不被改写（收窄不得误伤）', async () => {
    const fg = await freshFg();
    const normal = '同事——熊勇的下属（高峰电业）';
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨', relation_to_user: normal });
    seedConflictEdges(fg, HER, SELF);

    const fg2 = await reopen(fg);
    const props = JSON.parse(
      (fg2.query('SELECT properties FROM nodes WHERE id = ?', [HER]) as any[])[0].properties || '{}',
    );
    expect(props.relation_to_user).toBe(normal);
  });

  it('✅ 只有 1 条授权边时不触发（避免与后台补边例程互刷）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, { name: '徐诗雨' });
    addEdge(fg, HER, SELF, 'acquaintance_of');

    const fg2 = await reopen(fg);
    expect(relationsBetween(fg2, HER, SELF)).toContain('acquaintance_of');
  });
});
