import { describe, it, expect } from 'vitest';
import { SQLiteAdapter } from '../SQLiteAdapter.js';
import { createEmptyPerceptionV40, PERCEPTION_40D_KEYS } from '../types/perception-40d.js';
import {
  cosineSimilarity40D,
  toNormalizedVector40D,
  computeL2Norm40D,
  encodeEmptyPerceptionV40,
} from '../PerceptionVector40DCodec.js';

/**
 * P0-4 回归（2026-10-07）：全零向量不得产生「伪中性签名」。
 *
 * 缺陷：memories 表 1540 条（16.05%）的 perception_40d 是全零向量（锚点 1320 / 记事 220，
 *      由 `encodeEmptyPerceptionV40()` 按设计写入，三处注释都声明它们「不参与情感余弦」）。
 *      但这条契约**从未生效**，两条断裂链叠加：
 *        ① `toNormalizedVector40D` 对双极性维度 D36/D37 走 `(v+1)/2` —— 0 被映射成 0.5
 *           ⇒ 全零向量归一化后范数 = 0.707 ≠ 0
 *           ⇒ `cosineSimilarity40D` 里 `normA === 0 → return 0` 那道防线永不触发；
 *        ② `rowToRecord` 写 `?? createEmptyPerceptionV40()` ⇒ r40 永不为 null
 *           ⇒ 调用点的 `r40 ? cosine(...) : 0` 守卫恒为真。
 *      实测后果：全零行对含 D36/D37 能量的查询 cos 可达 1.000000。
 *
 * 断言策略：前三条是**红用例**，锁住"防线失效"这个事实本身——若有人日后"顺手修正"
 * 了 normalize40D 或 rowToRecord 的兜底，这些用例会失败，提醒他 P0-4 的读取侧判据可以退役。
 * 后两条锁住修复后的对外契约。
 */

/** 最小 SQLiteAdapter（只需能调私有方法；本测试不读写任何库文件） */
const makeAdapter = () => new SQLiteAdapter('D:/tmp/__unused_p04_test.db') as never as {
  _hasPerception: (r: unknown) => boolean;
  _scoreMemory40D: (rec: unknown, q40: unknown) => { scores: { emotional: number }; composite: number } | null;
};

/** 造一个查询向量：只有 D36 支配 / D37 道德两维有能量 —— 全零行的"最坏情况" */
function queryOnBipolarDims(): Record<string, number> {
  const p: Record<string, number> = {};
  for (const k of PERCEPTION_40D_KEYS) p[k] = 0;
  p['d36_dominance'] = 1;
  p['d37_moral_judgment'] = 1;
  return p as never;
}

/** 造一条记忆记录（_scoreMemory40D 只读这几个字段，其余原样透传） */
function mkRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mem_p04',
    perceptionV40: createEmptyPerceptionV40(),
    calcium_score: 0.5,
    effective_strength: 0.45,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe('P0-4 · 红用例：锁住「防线失效」这个事实', () => {
  it('🔴 全零向量归一化后**不是**全零 —— 双极性维 D36/D37 被映射成 0.5', () => {
    const nz = toNormalizedVector40D(createEmptyPerceptionV40());
    const nonZero: number[] = [];
    for (let i = 0; i < 40; i++) if (nz[i] !== 0) nonZero.push(i + 1);
    expect(nonZero).toEqual([36, 37]);                       // 只有这两维非零
    expect(nz[35]).toBeCloseTo(0.5, 10);
    expect(nz[36]).toBeCloseTo(0.5, 10);
  });

  it('🔴 归一化后范数 = 0.707 ≠ 0 ⇒ cosine 的 norm===0 防线永不触发', () => {
    const nz = toNormalizedVector40D(createEmptyPerceptionV40());
    let norm2 = 0;
    for (let i = 0; i < 40; i++) norm2 += nz[i] * nz[i];
    expect(Math.sqrt(norm2)).toBeGreaterThan(0.5);           // 非零 ⇒ 防线失效
    // 而**原始**向量的范数确实是 0 —— 这正是 _hasPerception 判据能成立的原因
    expect(computeL2Norm40D(createEmptyPerceptionV40())).toBe(0);
  });

  it('🔴 全零向量对含 D36/D37 能量的查询拿到满分 cos（伪中性签名）', () => {
    const q = queryOnBipolarDims() as never;
    const cos = cosineSimilarity40D(q, createEmptyPerceptionV40());
    expect(cos).toBeGreaterThan(0.9);                        // 实测 1.000000
  });
});

describe('P0-4 · 修复后的对外契约', () => {
  it('_hasPerception：全零 / 缺失 ⇒ false；真向量 ⇒ true', () => {
    const a = makeAdapter();
    expect(a._hasPerception(createEmptyPerceptionV40())).toBe(false);   // 全零 = 无向量
    expect(a._hasPerception(null)).toBe(false);
    expect(a._hasPerception(undefined)).toBe(false);
    // 真向量（只把双极性维拉到 -1 —— 只要原始范数非零即算"有向量"）
    const real = createEmptyPerceptionV40() as unknown as Record<string, number>;
    real['d36_dominance'] = -1;
    expect(a._hasPerception(real as never)).toBe(true);
  });

  it('🔴 全零向量的记录：emotional 必须为 0（而不是 1.0）', () => {
    const a = makeAdapter();
    const scored = a._scoreMemory40D(mkRecord(), queryOnBipolarDims());
    expect(scored).not.toBeNull();
    expect(scored!.scores.emotional).toBe(0);
  });

  it('真向量的记录：emotional 仍照常计算（修复不得误伤）', () => {
    const a = makeAdapter();
    const real = queryOnBipolarDims() as unknown as Record<string, number>;
    real['d36_dominance'] = 1;
    const scored = a._scoreMemory40D(mkRecord({ perceptionV40: real }), queryOnBipolarDims());
    expect(scored).not.toBeNull();
    expect(scored!.scores.emotional).toBeCloseTo(1, 5);
  });

  it('🔴 老旧全零行 composite 落到 0.05 阈值之下 ⇒ 被过滤（V3 §4.3 验收判据）', () => {
    const a = makeAdapter();
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();   // 60 天前
    const scored = a._scoreMemory40D(mkRecord({ created_at: old, effective_strength: 0.2 }), queryOnBipolarDims());
    expect(scored).toBeNull();          // 修复前会因伪 emotional 入选
  });

  it('近期全零行仍可召回（只在钙化/近因上排序，不被硬排除）', () => {
    const a = makeAdapter();
    const scored = a._scoreMemory40D(mkRecord(), queryOnBipolarDims());
    expect(scored).not.toBeNull();      // recency=1 撑起 composite
    expect(scored!.composite).toBeGreaterThan(0.05);
  });
});

describe('P0-4 · 判据本身', () => {
  it('空向量序列化形态为 98 字符（与库中存量一致）', () => {
    expect(encodeEmptyPerceptionV40().length).toBe(98);
  });
});
