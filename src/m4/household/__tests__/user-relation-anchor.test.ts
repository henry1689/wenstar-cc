import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';
import { buildEntityContext } from '../EntityContextBuilder.js';
import { RelationHeatTracker } from '../RelationHeatTracker.js';

/**
 * [A2 / 2026-10-06] 「与用户的关系」必须锚定在**用户那一条边**上
 * ============================================================
 * 业主实测：「关于徐诗雨的身份问题还是没有得到解决」——批 A（2bf0926）修了写入源，
 * 但她的正式身份仍渲染成「鸿艺的孩子——亲密互动（热力追踪已确认）」。
 *
 * 🔴 S1 只读诊断（真实库副本）定位到**读取侧挑错了边**：
 *   真实结构里 `我 -[spouse_of]-> 徐诗雨` 一直存在，但
 *   ① `_getRelatedEdges` = getRelatedPersons = **出边+入边、不分方向、不限对方**，
 *      循环命中第一个 `child_of`（她与**父亲**徐东伟的边）就写「鸿艺的孩子」并 break；
 *   ② `RelationHeatTracker.updateHeat` 盲取 `edges[0]`（无 ORDER BY、无锚定），
 *      把 100 条亲密互动记录写到了**父女边**上。
 *
 * 本测试锁住三件事：
 *   · 与用户的**无关边**（如父女边）绝不参与「与鸿艺的关系」
 *   · 方向必须正确（我 child_of 她 ⇒ 她是我的父母；她 child_of 我 ⇒ 她是我的子女）
 *   · 热力只落用户边；没有用户边就不写
 */

const DB = join('D:/tmp', `__a2_useranchor_test_${process.pid}.db`);

const SELF = 'SELF-00001';
const HER = 't-xsy';
const HER_UUID = 'TXS-T-XSY';
const DAD = 't-xdw';

async function freshFg(): Promise<any> {
  try { if (existsSync(DB)) rmSync(DB); } catch { /* 清理失败不阻塞 */ }
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  // 用户锚点节点（正常路径由 _ensureSelfNode 建；测试里兜底建一次，保证锚点确定存在）
  if (!fg.getUserNodeId()) {
    fg.run(
      "INSERT INTO nodes (id, type, name, properties, uuid, category, created_at, updated_at) VALUES (?, 'person', '我', ?, 'U-00001', 'U', '2026-01-01', '2026-01-01')",
      [SELF, JSON.stringify({ name: '我', type: 'self', relation_to_user: '自己' })],
    );
  }
  return fg;
}

/** 直接落一个节点，properties 由测试完全掌控 */
function seedPerson(fg: any, id: string, name: string, uuid: string, props: Record<string, unknown>): void {
  fg.run(
    'INSERT INTO nodes (id, type, name, aliases, properties, created_at, updated_at, uuid) VALUES (?,?,?,?,?,?,?,?)',
    [id, 'person', name, '[]', JSON.stringify(props), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', uuid],
  );
}

function addEdge(fg: any, id: string, source: string, target: string, relation: string, props: Record<string, unknown> = {}): void {
  fg.run(
    'INSERT INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, source, target, relation, JSON.stringify(props), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  );
}

function edgeProps(fg: any, id: string): Record<string, any> {
  const rows = fg.query('SELECT properties FROM edges WHERE id = ?', [id]);
  return rows.length ? JSON.parse(rows[0].properties || '{}') : {};
}

const ctxOf = (fg: any, name: string): string => String(buildEntityContext(fg, { entityName: name } as any).systemText ?? '');

/** 她的档案：含一个情趣称呼（用于验证「正式身份」与「情趣」两栏必须分开） */
const HER_PROPS = {
  name: '徐诗雨',
  relation_to_user: '爸爸',
  dossier: {
    basicInfo: { gender: '女', birthYear: 2008 },
    socialIdentity: { currentOccupation: '跟单员', currentWorkplace: '高峰电业' },
    roleplayProfile: { names: ['哥哥'] },
  },
};

describe('[A2] 「与用户的关系」只认用户那一条边', () => {
  beforeEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });
  afterEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });

  it('🔴 核心回归：与父亲的 child_of 边不得被渲染成「与鸿艺的关系」', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-XDW', { name: '徐东伟' });
    // 她与父亲：她 child_of 徐东伟（真·父女边，与用户无关）
    addEdge(fg, 'e-dad', HER, DAD, 'child_of');
    addEdge(fg, 'e-me', SELF, HER, 'lover_of');
    addEdge(fg, 'e-me2', SELF, HER, 'colleague_of');

    const text = ctxOf(fg, '徐诗雨');
    expect(text, '🔴 与父亲的边被当成了与用户的关系 —— 这正是「鸿艺的孩子」的来源')
      .not.toContain('与鸿艺的关系: 子女');
    expect(text).toContain('与鸿艺的关系: 情人、同事');
  });

  it('✅ 用户边存在 ⇒ 正式身份来自用户边（业主口径：同事、情人）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    addEdge(fg, 'e-c', SELF, HER, 'colleague_of');
    addEdge(fg, 'e-l', SELF, HER, 'lover_of');

    const text = ctxOf(fg, '徐诗雨');
    expect(text).toContain('与鸿艺的关系: 情人、同事');
    expect(text, '旧的硬编码覆盖表 RELATION_FIXES 不得再抢走用户边推导出的身份')
      .not.toContain('与鸿艺的关系: 同事——熊勇的下属（高峰电业）');
  });

  it('✅ 方向必须正确：她 child_of 我 ⇒ 子女；我 child_of 她 ⇒ 父母', async () => {
    const fgA = await freshFg();
    seedPerson(fgA, HER, '徐诗雨', HER_UUID, HER_PROPS);
    addEdge(fgA, 'e1', HER, SELF, 'child_of');
    expect(ctxOf(fgA, '徐诗雨')).toContain('与鸿艺的关系: 子女');

    const fgB = await freshFg();
    seedPerson(fgB, HER, '徐诗雨', HER_UUID, HER_PROPS);
    addEdge(fgB, 'e2', SELF, HER, 'child_of');
    expect(ctxOf(fgB, '徐诗雨'), '🔴 方向反了 —— 用户是她的孩子，不是她是用户的孩子')
      .toContain('与鸿艺的关系: 父母');
  });

  it('🔴 正式身份里不得再拼「——亲密互动（热力追踪已确认）」', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    addEdge(fg, 'e-l', SELF, HER, 'lover_of', { _relation_warmth: 'soulmate', _heat_score: 1.066 });

    const text = ctxOf(fg, '徐诗雨');
    expect(text, '业主定音：不要把亲密情趣互动的东西作为正式档案记录').not.toContain('——亲密互动');
    expect(text).not.toContain('——亲密关系');
    expect(text, '亲密状态应改为独立一行，不污染「与 X 的关系」').toContain('互动亲密度');
  });

  it('✅ 情趣称呼仍留在情趣区块（收窄不得误伤既有能力）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    addEdge(fg, 'e-l', SELF, HER, 'lover_of');

    const text = ctxOf(fg, '徐诗雨');
    expect(text).toContain('角色扮演（仅限情趣互动场景）');
    expect(text).toContain('哥哥');
    expect(text).toContain('你的正式身份：情人');
  });
});

describe('[A2] 热力只写「实体 ↔ 用户」的关系边', () => {
  beforeEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });
  afterEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });

  it('🔴 核心回归：互动不得被写到父女边上（原 edges[0] 盲取）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-XDW', { name: '徐东伟' });
    addEdge(fg, 'e-dad', HER, DAD, 'child_of'); // ← 排在最前，正是原实现盲取的那条
    addEdge(fg, 'e-me', SELF, HER, 'lover_of');

    await new RelationHeatTracker(fg).updateHeat(HER_UUID, { intimacy: 1, pleasure: 1, arousal: 0 });

    expect(JSON.stringify(edgeProps(fg, 'e-dad')), '🔴 亲密数据被写到了她与父亲的边上')
      .not.toContain('_interactions');
    expect(edgeProps(fg, 'e-dad')._relation_warmth).toBeUndefined();
    expect(edgeProps(fg, 'e-me')._relation_warmth, '热力应落在用户边上').toBeDefined();
    expect(JSON.stringify(edgeProps(fg, 'e-me'))).toContain('_interactions');
  });

  it('✅ 没有用户边 ⇒ 不写（宁缺勿滥）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-XDW', { name: '徐东伟' });
    addEdge(fg, 'e-dad', HER, DAD, 'child_of');

    await new RelationHeatTracker(fg).updateHeat(HER_UUID, { intimacy: 1 });

    expect(JSON.stringify(edgeProps(fg, 'e-dad'))).not.toContain('_interactions');
  });

  it('🔴 存量写在错误边上的互动不再被计入（computeHeat 只读用户边）', async () => {
    const fg = await freshFg();
    seedPerson(fg, HER, '徐诗雨', HER_UUID, HER_PROPS);
    seedPerson(fg, DAD, '徐东伟', 'TXS-T-XDW', { name: '徐东伟' });
    // 模拟存量脏数据：100 条互动 + soulmate 写在父女边上
    addEdge(fg, 'e-dad', HER, DAD, 'child_of', {
      _heat_score: 1.066, _relation_warmth: 'soulmate',
      _interactions: Array.from({ length: 100 }, (_, i) => ({ timestamp: new Date(Date.now() - i * 3600_000).toISOString(), intimacy: 1 })),
    });
    addEdge(fg, 'e-me', SELF, HER, 'lover_of');

    const state = await new RelationHeatTracker(fg).computeHeat(HER_UUID);
    expect(state.heatScore, '父女边上的存量互动仍被计入 ⇒ 热力来源没锚定').toBe(0);
    expect(state.warmth).toBe('distant');
  });
});
