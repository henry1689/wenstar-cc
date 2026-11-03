import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { migrateSchema } from '../../../m2/MigrationManager.js';
import { DialogGroupAdapter } from '../adapters/DialogGroupAdapter.js';
import { ADR_010_BLOCK_SCHEME, scoreAndRank, type EnclosureHit } from '../StructuredRecall.js';
import { ADR_010_BLOCK_WEIGHTS, ADR_010_CALCIUM_NORM_DENOM, RETRIEVAL_V11_WEIGHTS } from '../Flags.js';
import type { RetrievalContext } from '../types.js';
import type { PolicePolicy } from '../../../governance/police/UUIDPoliceFilter.js';

/**
 * [ADR-010 §12.2.3] 对话块双通道排序 —— 法典公式的守卫
 *
 * 🔴 背景：该条款由业主 2026-10-18 确认，但**自落库以来从未实现** ——
 *    `DialogGroupAdapter` 一直调通用四权重 `scoreAndRank`，原文与摘要的命中量被
 *    相加塞进同一个 `hit` 分量，法典的 convDensity / summaryDensity / bothChannels
 *    三个分量全部缺失。本文件把公式锁死，防止再次漂移。
 *
 * 锁住五件事：
 *   ① 四分量公式与权重逐项等于法典（0.40 / 0.30 / 0.15 / 0.15）
 *   ② 法典明写的两个上限：纯原文 0.55、纯摘要 0.45
 *   ③ 分量在本池不可用时按 §4.4 重归一（不是按 0 分拉低全池）
 *   ④ 引擎仍单源：不传 `scheme` 时默认方案行为不变（不变量 #7）
 *   ⑤ 适配器真的把双通道计数与 `turn_count` 接进了方案
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, '..', '..', '..', 'm2', 'schema.sql');

const UUID_A = 'TXS-000000101';
const UUID_B = 'TXS-000000102';
const NOW = Date.parse('2026-11-02T00:00:00.000Z');

const q = (db: any, sql: string, p: any[] = []): any[] => {
  const st = db.prepare(sql); st.bind(p);
  const o: any[] = []; while (st.step()) o.push(st.getAsObject()); st.free();
  return o;
};

async function buildDb(): Promise<any> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(readFileSync(SCHEMA_SQL, 'utf-8'));
  migrateSchema(db);
  return db;
}

function srcOf(db: any) {
  return {
    queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] {
      return q(db, sql, params as any[]) as T[];
    },
  };
}

function policy(visible: string[]): PolicePolicy {
  return { visibleUuids: new Set(visible), searchScope: 'strict' };
}

const ctxOf = (over: Partial<RetrievalContext> = {}): RetrievalContext => ({
  query: '杭州 机票',
  policy: policy([UUID_A]),
  entityUuids: [UUID_A],
  mode: 'standard' as any,
  limit: 3,
  ...over,
});

/** 造一条候选：默认「只有原文」，按需补摘要与钙分 */
function hit(over: Partial<EnclosureHit> = {}): EnclosureHit {
  return {
    id: 'x',
    domain: 'dialog_group',
    text: '',
    calciumScore: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    hitShards: 0,
    semanticSource: 'none',
    ...over,
  } as EnclosureHit;
}

/** 池内必须同时有三类候选，四个分量才全部可用（否则会被 §4.4 重归一打乱上限断言） */
function pool(): EnclosureHit[] {
  return [
    // 纯原文：密度拉满、无摘要
    hit({ id: 'pure-content', calciumScore: 10, channels: { summary: 0, content: 2, turnCount: 2 } }),
    // 纯摘要：摘要拉满、无原文
    hit({ id: 'pure-summary', calciumScore: 10, channels: { summary: 10, content: 0, turnCount: 2 } }),
    // 双通道：让 bothChannels 分量在本池可用
    hit({ id: 'both', calciumScore: 0, channels: { summary: 10, content: 2, turnCount: 2 } }),
  ];
}

describe('[ADR-010 §12.2.3] 四分量公式与权重', () => {
  it('权重逐项等于法典：0.40 / 0.30 / 0.15 / 0.15（且落在 Flags 单一产出点）', () => {
    expect(ADR_010_BLOCK_WEIGHTS).toEqual({
      convDensity: 0.40, summaryDensity: 0.30, bothChannels: 0.15, calcium: 0.15,
    });
    const keys = ADR_010_BLOCK_SCHEME.components.map((c) => c.key);
    expect(keys).toEqual(['convDensity', 'summaryDensity', 'bothChannels', 'calcium']);
    expect(ADR_010_BLOCK_SCHEME.components.map((c) => c.weight)).toEqual([0.40, 0.30, 0.15, 0.15]);
  });

  it('🔴 纯原文候选最高 0.55 —— 法典明写的上限', () => {
    const out = scoreAndRank(pool(), NOW, undefined, ADR_010_BLOCK_SCHEME);
    const pure = out.find((h) => h.id === 'pure-content')!;
    // convDensity 1×0.40 + summaryDensity 0 + bothChannels 0 + calcium 1×0.15
    expect(pure.score).toBeCloseTo(0.55, 9);
    expect(pure.breakdown.convDensity).toBeCloseTo(0.40, 9);
    expect(pure.breakdown.summaryDensity).toBeCloseTo(0, 9);
    expect(pure.breakdown.bothChannels).toBeCloseTo(0, 9);
    expect(pure.breakdown.calcium).toBeCloseTo(0.15, 9);
  });

  it('🔴 纯摘要候选最高 0.45 —— 摘要命中略低于原文，但足以进候选集', () => {
    const out = scoreAndRank(pool(), NOW, undefined, ADR_010_BLOCK_SCHEME);
    const pure = out.find((h) => h.id === 'pure-summary')!;
    expect(pure.score).toBeCloseTo(0.45, 9);
    expect(pure.breakdown.summaryDensity).toBeCloseTo(0.30, 9);
    // 法典排序意图：同钙分下纯原文仍排在纯摘要之前
    const content = out.find((h) => h.id === 'pure-content')!;
    expect(content.score).toBeGreaterThan(pure.score);
  });

  it('四分量同时拉满 = 1.00，且 breakdown 之和恒等于 score', () => {
    const full = hit({ id: 'full', calciumScore: 10, channels: { summary: 10, content: 5, turnCount: 5 } });
    const out = scoreAndRank([full], NOW, undefined, ADR_010_BLOCK_SCHEME);
    const sum = Object.values(out[0].breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(out[0].score, 9);
    expect(out[0].score).toBeCloseTo(1.00, 9);
  });

  it('convDensity = min(1, 命中轮数 / turn_count)，线性且封顶', () => {
    const at = (content: number, turnCount: number) => {
      const hs = [
        hit({ id: 'a', channels: { summary: 10, content, turnCount } }),
        hit({ id: 'b', channels: { summary: 10, content: 0, turnCount } }),
      ];
      return scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME).find((h) => h.id === 'a')!;
    };
    expect(at(1, 4).breakdown.convDensity).toBeCloseTo(0.40 * 0.25, 9);
    expect(at(4, 4).breakdown.convDensity).toBeCloseTo(0.40, 9);
    // 命中轮数 > turn_count（半轮/角色不齐时可能出现）⇒ 封顶，不得溢出
    expect(at(99, 4).breakdown.convDensity).toBeCloseTo(0.40, 9);
    // turn_count 拿不到 ⇒ 该分量返回 0，不除以零
    expect(at(3, 0).breakdown.convDensity).toBeCloseTo(0, 9);
  });

  it('summaryDensity = min(1, 摘要命中分片数 / 10)，分母 10 来自法典常量', () => {
    const at = (summary: number) => {
      const hs = [
        hit({ id: 'a', channels: { summary, content: 2, turnCount: 2 } }),
        hit({ id: 'b', channels: { summary: 0, content: 2, turnCount: 2 } }),
      ];
      return scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME).find((h) => h.id === 'a')!;
    };
    expect(at(5).breakdown.summaryDensity).toBeCloseTo(0.30 * 0.5, 9);
    expect(at(10).breakdown.summaryDensity).toBeCloseTo(0.30, 9);
    expect(at(100).breakdown.summaryDensity).toBeCloseTo(0.30, 9); // 封顶
  });

  it('bothChannels 只在两路同时命中时给 0.15', () => {
    const out = scoreAndRank(pool(), NOW, undefined, ADR_010_BLOCK_SCHEME);
    expect(out.find((h) => h.id === 'both')!.breakdown.bothChannels).toBeCloseTo(0.15, 9);
    expect(out.find((h) => h.id === 'pure-content')!.breakdown.bothChannels).toBeCloseTo(0, 9);
    expect(out.find((h) => h.id === 'pure-summary')!.breakdown.bothChannels).toBeCloseTo(0, 9);
  });

  it('🔴 钙分归一基准是 5（ADR-010 §13.1「/10 → /5，高钙阈值即满分」），不是通用方案的 10', () => {
    expect(ADR_010_CALCIUM_NORM_DENOM).toBe(5);
    const at = (calciumScore: number) => {
      const hs = [
        hit({ id: 'a', calciumScore, channels: { summary: 10, content: 2, turnCount: 2 } }),
        hit({ id: 'b', calciumScore: 0, channels: { summary: 10, content: 2, turnCount: 2 } }),
      ];
      return scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME).find((h) => h.id === 'a')!;
    };
    // 4 分是**唯一**能区分 /5 与 /10 的点：/5 → 0.8 → 0.12；/10 → 0.4 → 0.06。
    // （10 与 100 在两个基准下都饱和为 1，拿它们断言判别不出基准 —— 首版就是这么写的。）
    expect(at(4).breakdown.calcium).toBeCloseTo(0.15 * 0.8, 9);
    // 5 分即满分；生产实测 max 7.72 早已饱和（§13.1 要解决的正是 /10 下的区分度不足）
    expect(at(5).breakdown.calcium).toBeCloseTo(0.15, 9);
    expect(at(7.72).breakdown.calcium).toBeCloseTo(0.15, 9);
    expect(at(100).breakdown.calcium).toBeCloseTo(0.15, 9); // 超阈值封顶
    // 与通用方案对照：memory/conversation/work 三域仍用 CALCIUM_SCORE_MAX=10，量纲不变
    expect(at(4).breakdown.calcium).not.toBeCloseTo(0.15 * 0.4, 9);
  });

  it('🔴 摘要通道整体为 0（业主 2026-11-02：摘要通道是临时的、将被拆除）⇒ 自动退化为 convDensity + calcium', () => {
    // 拆除摘要通道后，所有候选的 channels.summary 恒为 0 ——
    // 方案必须靠**可用性判定**把两个摘要相关分量的权重置 0 并重归一，
    // 引擎与 convDensity/calcium 分量一行都不用改（否则拆摘要就得改排序判据）。
    const hs = [
      hit({ id: 'dense', calciumScore: 5, channels: { summary: 0, content: 4, turnCount: 4 } }),
      hit({ id: 'sparse', calciumScore: 5, channels: { summary: 0, content: 1, turnCount: 4 } }),
    ];
    const out = scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME);
    const w = out[0].activeWeights;
    expect(w.summaryDensity, '摘要分量应整体失效').toBe(0);
    expect(w.bothChannels, '无摘要则不可能共振').toBe(0);
    expect(w.convDensity).toBeCloseTo(0.40 / 0.55, 9);
    expect(w.calcium).toBeCloseTo(0.15 / 0.55, 9);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // 排序仍由原文密度主导
    expect(out.map((h) => h.id)).toEqual(['dense', 'sparse']);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('🔴 本方案不带 recency —— 法典只列四项，不得擅自补时间近因', () => {
    expect(ADR_010_BLOCK_SCHEME.components.map((c) => c.key)).not.toContain('recency');
  });
});

describe('[ADR-010 §12.2.3] 分量失效按 §4.4 重归一（不是按 0 分拉低全池）', () => {
  it('全池没有摘要命中 ⇒ summaryDensity 权重归零，其余重归一且总和为 1', () => {
    const hs = [
      hit({ id: 'a', calciumScore: 10, channels: { summary: 0, content: 2, turnCount: 2 } }),
      hit({ id: 'b', calciumScore: 0, channels: { summary: 0, content: 1, turnCount: 2 } }),
    ];
    const out = scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME);
    const w = out[0].activeWeights;
    expect(w.summaryDensity).toBe(0);
    expect(w.bothChannels).toBe(0); // 同样不可能有双通道
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(w.convDensity).toBeCloseTo(0.40 / 0.55, 9);
    expect(w.calcium).toBeCloseTo(0.15 / 0.55, 9);
  });

  it('全池都拿不到 turn_count ⇒ convDensity 归零，不产生 NaN', () => {
    const hs = [
      hit({ id: 'a', calciumScore: 5, channels: { summary: 10, content: 0, turnCount: 0 } }),
      hit({ id: 'b', calciumScore: 5, channels: { summary: 10, content: 0, turnCount: 0 } }),
    ];
    const out = scoreAndRank(hs, NOW, undefined, ADR_010_BLOCK_SCHEME);
    expect(out[0].activeWeights.convDensity).toBe(0);
    expect(Number.isFinite(out[0].score)).toBe(true);
  });

  it('完全没有 channels 的命中（其它域误传本方案）⇒ 退化为钙分排序，不崩', () => {
    const out = scoreAndRank(
      [hit({ id: 'a', calciumScore: 9 }), hit({ id: 'b', calciumScore: 1 })],
      NOW, undefined, ADR_010_BLOCK_SCHEME,
    );
    expect(out[0].id).toBe('a');
    expect(Number.isFinite(out[0].score)).toBe(true);
    expect(Object.values(out[0].activeWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('空数组 ⇒ 空（不抛出）', () => {
    expect(scoreAndRank([], NOW, undefined, ADR_010_BLOCK_SCHEME)).toEqual([]);
  });
});

describe('[不变量 #7] 引擎单源：不传 scheme 时默认方案行为不变', () => {
  it('🔴 不传 scheme ⇒ 仍是 v11 四分量，权重来自 RETRIEVAL_V11_WEIGHTS', () => {
    // 语义开关必须显式打开：否则 `Flags.semantic()` 为假 ⇒ 语义权重按 0 重归一，
    // hit 会被抬到 0.45/0.9，那就断言不到法典原权重了。
    const prev = process.env.RETRIEVAL_V11_SEMANTIC;
    process.env.RETRIEVAL_V11_SEMANTIC = 'true';
    try {
      const hs = [
        hit({ id: 'a', hitShards: 2, calciumScore: 10, cosine: 1 }),
        hit({ id: 'b', hitShards: 1, calciumScore: 5 }),
      ];
      const out = scoreAndRank(hs, NOW);
      expect(Object.keys(out[0].breakdown)).toEqual(['hit', 'calcium', 'recency', 'semantic']);
      expect(out[0].activeWeights.hit).toBeCloseTo(RETRIEVAL_V11_WEIGHTS.hit, 9);
      expect(out[0].activeWeights.calcium).toBeCloseTo(RETRIEVAL_V11_WEIGHTS.calcium, 9);
      expect(out[0].breakdown.hit + out[0].breakdown.calcium
        + out[0].breakdown.recency + out[0].breakdown.semantic)
        .toBeCloseTo(out[0].score, 9);
    } finally {
      if (prev === undefined) delete process.env.RETRIEVAL_V11_SEMANTIC;
      else process.env.RETRIEVAL_V11_SEMANTIC = prev;
    }
  });

  it('默认方案无余弦时语义权重归零并重归一（§4.4 原语义保持）', () => {
    const out = scoreAndRank(
      [hit({ id: 'a', hitShards: 2, calciumScore: 10 }), hit({ id: 'b', hitShards: 1, calciumScore: 0 })],
      NOW,
    );
    const w = out[0].activeWeights;
    expect(w.semantic).toBe(0);
    expect(w.hit + w.calcium + w.recency).toBeCloseTo(1, 9);
  });

  it('同分按 id 升序，重复执行结果确定', () => {
    const inputs = [hit({ id: 'b' }), hit({ id: 'a' }), hit({ id: 'c' })];
    const r1 = scoreAndRank(inputs, NOW, undefined, ADR_010_BLOCK_SCHEME).map((x) => x.id);
    const r2 = scoreAndRank([...inputs].reverse(), NOW, undefined, ADR_010_BLOCK_SCHEME).map((x) => x.id);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(['a', 'b', 'c']);
  });
});

// ══════════════════════════════════════════════════════════════════
// 适配器接线：双通道计数与 turn_count 必须真的进到方案里
// ══════════════════════════════════════════════════════════════════

/** 播一个块：contents 决定原文与摘要，meta.turns 决定 convDensity 分母 */
function seedBlock(
  db: any,
  dgId: string,
  contents: Array<[string, string]>,
  meta?: { calcium?: number; turns?: number; summary?: string; uuid?: string },
): void {
  const uuid = meta?.uuid ?? UUID_A;
  let seq = Math.floor(Date.now() % 1e6);
  for (const [role, content] of contents) {
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,belong_entity_uuid) VALUES (?,?,?,?,?,0,?)",
      [role, content, '2026-10-06T00:00:00.000Z', ++seq, dgId, uuid],
    );
  }
  const tags = contents.map(([, c]) => c.slice(0, 6)).join('、');
  const summary = meta?.summary
    ?? `【标签】${tags}\n【叙事】${contents.map(([, c]) => c).join('；')}\n【情感】平静`;
  db.run(
    "INSERT OR REPLACE INTO dialog_groups (dialog_group_id,belong_entity_uuid,narrative_tag,block_calcium_score,scene_anchor_hash,turn_count,block_close_reason,lifecycle_state,is_landmark,created_at,block_summary) " +
    "VALUES (?,?,?,?,?,?,?,'active',0,?,?)",
    [dgId, uuid, 'neutral', meta?.calcium ?? 5, 'h-' + dgId,
     meta?.turns ?? contents.length, 'topic_switch', '2026-10-06T00:00:00.000Z', summary],
  );
}

describe('[ADR-010 §12.2.3] 适配器把双通道接进了方案', () => {
  it('🔴 命中更密的组排在前面 —— convDensity 的分母是 turn_count，不是恒 1', async () => {
    const db = await buildDb();
    // 两块摘要与钙分完全相同、原文命中行数也相同，唯一差别是 turn_count：
    // DG_A_SPARSE 分母 20 ⇒ 密度 0.05；DG_B_DENSE 分母 2 ⇒ 密度 0.5
    // id 取名让「旧的通用四权重」在同分时按 id 升序先返回 SPARSE —— 本断言据此判别真伪。
    seedBlock(db, 'DG_A_SPARSE', [['user', '杭州机票订了吗']], { calcium: 5, turns: 20 });
    seedBlock(db, 'DG_B_DENSE', [['user', '杭州机票订了吗']], { calcium: 5, turns: 2 });

    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    expect(hits.length).toBe(2);
    expect(
      hits[0].id,
      '🔴 密度更高的组必须排前 —— 若返回 DG_A_SPARSE，说明 convDensity 分母没生效',
    ).toBe('DG_B_DENSE');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    db.close();
  });

  it('🔴 摘要行（is_summary=1）只参与召回、不参与密度计数', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_NO_SUMROW', [['user', '杭州机票订了吗'], ['assistant', '杭州机票我看过了']],
      { calcium: 5, turns: 4 });
    const before = await new DialogGroupAdapter(srcOf(db)).search(ctxOf({ limit: 5 }));
    const beforeScore = before.find((h) => h.id === 'DG_NO_SUMROW')!.score;

    // 插一行 is_summary=1、**内容不含查询词**的摘要行：
    //  · 若密度计数不排除它 ⇒ a_hit 1→2 ⇒ convDensity 0.25→0.5 ⇒ 分数变
    //  · 内容不含查询词 ⇒ channels.summary 仍为 0 ⇒ 摘要分量不变
    // 两条都不变才能证明「只参与召回、不参与计数」。
    // （若摘要内容含查询词，它会合法地抬高 summaryDensity 分量 —— 那是双通道的本意，不是泄漏。）
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,is_summary,belong_entity_uuid) " +
      "VALUES (?,?,?,?,?,0,1,?)",
      ['assistant', '【标签】无关\n【叙事】不含任何查询词的三层摘要\n【情感】平静', '2026-10-06T00:02:00.000Z', 999999,
       'DG_NO_SUMROW', UUID_A],
    );
    const after = await new DialogGroupAdapter(srcOf(db)).search(ctxOf({ limit: 5 }));
    const afterHit = after.find((h) => h.id === 'DG_NO_SUMROW');
    expect(afterHit, '摘要行必须仍能让该组被召回').toBeTruthy();
    expect(
      afterHit!.score,
      '🔴 摘要行若被计入密度，这里会变大 —— 说明 is_summary 排除没生效',
    ).toBeCloseTo(beforeScore, 9);
    db.close();
  });

  it('🔴 convDensity 分子是「轮数」不是「行数」—— max(u_hit, a_hit) 口径守卫', async () => {
    const db = await buildDb();
    // 两块摘要、钙分、turn_count 全同，唯一差别是**命中行数**：
    //   DG_ONE_ROW   1 行命中（user）        → max(1,0) = 1 轮
    //   DG_TWO_ROWS  2 行命中（user+assistant）→ max(1,1) = 1 轮（同一轮的两侧）
    // 若有人把分子改回 COUNT(*)，行数口径会给出 1/4 与 2/4 ⇒ 两块分数不等 ⇒ 本断言红。
    const SAME_SUMMARY = '【标签】杭州机票\n【叙事】杭州机票订了吗\n【情感】平静';
    seedBlock(db, 'DG_ONE_ROW', [['user', '杭州机票订了吗']],
      { calcium: 5, turns: 4, summary: SAME_SUMMARY });
    seedBlock(db, 'DG_TWO_ROWS', [['user', '杭州机票订了吗'], ['assistant', '杭州机票我看过了']],
      { calcium: 5, turns: 4, summary: SAME_SUMMARY });

    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf({ limit: 5 }));
    expect(hits.length).toBe(2);
    const one = hits.find((h) => h.id === 'DG_ONE_ROW')!;
    const two = hits.find((h) => h.id === 'DG_TWO_ROWS')!;
    expect(
      one.score,
      '🔴 同轮两侧都命中 ≠ 命中更多轮：行数口径会把 DG_TWO_ROWS 抬高，轮数口径两者同分',
    ).toBeCloseTo(two.score, 9);
    db.close();
  });

  it('原文命中、摘要另写的组 —— 【摘要】前置来自 conversations 的摘要行（ADR-010 §12.2.4）', async () => {
    const db = await buildDb();
    // 批4a 后摘要内容不再读 dialog_groups.block_summary，而是读 conversations 的
    // is_summary=1 行（批2 迁移的落点）。本用例按**迁移后的真实形态**造数据。
    seedBlock(db, 'DG_SEG', [['user', '无关内容打个招呼']], { summary: '' });
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,is_summary,belong_entity_uuid) VALUES (?,?,?,?,?,0,?,?)",
      ['assistant', '杭州机票我看过了，周三出票', '2026-10-06T00:01:00.000Z', 98, 'DG_SEG', 0, UUID_A],
    );
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,is_summary,belong_entity_uuid) VALUES (?,?,?,?,?,0,?,?)",
      ['assistant', '【标签】旅行\n【叙事】只写了这一段的三层摘要\n【情感】平静', '2026-10-06T00:02:00.000Z', 99, 'DG_SEG', 1, UUID_A],
    );

    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    const seg = hits.find((h) => h.id === 'DG_SEG');
    expect(seg, '原文通道必须把它召回').toBeTruthy();
    expect(seg!.text, '有摘要的组应带【摘要】前缀（来源 = conversations 摘要行）').toContain('【摘要】');
    expect(seg!.payload?.summary, 'payload.summary 同时暴露结构化字段').toContain('三层摘要');
    db.close();
  });

  it('无摘要的组不出现空的【摘要】标签，且仍能靠原文召回', async () => {
    const db = await buildDb();
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,belong_entity_uuid) VALUES (?,?,?,?,?,0,?)",
      ['user', '杭州的机票订了吗', '2026-10-06T00:00:00.000Z', 1, 'DG_NOSUM', UUID_A],
    );
    db.run(
      "INSERT INTO dialog_groups (dialog_group_id,belong_entity_uuid,narrative_tag,block_calcium_score,scene_anchor_hash,turn_count,block_close_reason,lifecycle_state,is_landmark,created_at,block_summary) " +
      "VALUES (?,?,?,?,?,?,?,'active',0,?,NULL)",
      ['DG_NOSUM', UUID_A, 'neutral', 6, 'h-nosum', 1, 'topic_switch', '2026-10-06T00:00:00.000Z'],
    );

    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    const g = hits.find((h) => h.id === 'DG_NOSUM');
    expect(g, '🔴 无摘要的组必须能靠原文召回').toBeTruthy();
    expect(g!.text).not.toContain('【摘要】');
    expect(g!.payload?.turnCount, 'turn_count 进 payload 供上层分层注入').toBe(1);
    db.close();
  });

  it('双通道同时命中 ⇒ 只产出一个 hit，且观测用 hitShards 仍被累加', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_BOTH', [['user', '杭州机票订了吗']], { turns: 4 });
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    const dup = hits.filter((h) => h.id === 'DG_BOTH');
    expect(dup.length).toBe(1);
    expect(Number(dup[0].payload?.hitShards ?? 0)).toBeGreaterThan(0);
    db.close();
  });

  it('🔴 户籍 fail-closed 与异常隔离在新路径下不回退', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_A', [['user', '杭州机票订了吗']], { uuid: UUID_A });
    seedBlock(db, 'DG_B', [['user', '杭州机票订了吗']], { uuid: UUID_B });
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf({
      policy: { visibleUuids: new Set([UUID_A]), searchScope: 'strict' } as PolicePolicy,
      entityUuids: [UUID_A],
    }));
    expect(hits.map((h) => h.id), '🔴 白名单外的块不得泄漏').toEqual(['DG_A']);

    const broken = { queryAll(): never { throw new Error('disk I/O error'); } };
    expect(await new DialogGroupAdapter(broken as any).search(ctxOf())).toEqual([]);
    db.close();
  });
});
