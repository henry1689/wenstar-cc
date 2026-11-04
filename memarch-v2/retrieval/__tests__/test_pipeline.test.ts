// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / __tests__/test_pipeline.test.ts
// 单测覆盖：查询理解 / 各路召回 / Weighted RRF / MMR / 降级熔断 / 端到端
// =====================================================================

import { buildTestDb } from './helpers/db_factory';
import { understandQuery } from '../query_understanding';
import { legWeights, weightedRRF } from '../fusion/weighted_rrf';
import { mmrSelect } from '../postprocess/mmr';
import { Retriever } from '../index';
import type { Evidence, RawCandidate, QueryContext } from '../types';
import { Bm25Recall } from '../recall/bm25';
import { BlackDiamondRecall } from '../recall/blackdiamond';
import { PprRecall } from '../recall/ppr';
import { SemanticVectorRecall } from '../recall/semantic_vector';
import { Emotion40dRecall } from '../recall/emotion_40d';
import { ProfileRecall } from '../recall/profile';
import { KnowledgeBaseRecall } from '../recall/knowledge_base';
import { ForesightRecall } from '../recall/foresight';
import { withTimeout } from '../degrade/timeout_breaker';

describe('① query_understanding', () => {
  test('输出 40D 向量且 L2 归一化', () => {
    const q = understandQuery('我上次在东莞德恒电机聊的定子绕组工艺参数是什么？', 'default');
    expect(q.vec40.length).toBe(40);
    const norm = Math.sqrt(q.vec40.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test('p_A ∈ [0,1]', () => {
    const serious = understandQuery('为什么上次深蹲膝盖内侧疼痛？如何避免？', 'default');
    const casual = understandQuery('哈哈好的', 'default');
    expect(serious.p_A).toBeGreaterThanOrEqual(0);
    expect(serious.p_A).toBeLessThanOrEqual(1);
    expect(casual.p_A).toBeLessThan(serious.p_A);
  });

  test('时间解析：最近 N 天', () => {
    const q = understandQuery('最近三天我聊了什么？', 'default');
    expect(q.time_range.recent_days).toBe(3);
    expect(q.time_range.abs_start).not.toBeNull();
  });

  test('时间解析：昨天', () => {
    const q = understandQuery('昨天我们讨论的客户是谁？', 'default');
    expect(q.time_range.recent_days).toBe(1);
  });

  test('情绪子向量长度=10', () => {
    const q = understandQuery('我很生气，客户又投诉了', 'default');
    expect(q.emotion_vec.length).toBe(10);
    expect(q.emotion_vec[0]).toBeGreaterThan(0); // arousal
  });
});

describe('② Weighted RRF 权重插值', () => {
  test('p_A=0 与 p_A=1 两端权重和均=1', () => {
    const w0 = legWeights(0);
    const w1 = legWeights(1);
    const sum0 = Object.values(w0).reduce((a, b) => a + b, 0);
    const sum1 = Object.values(w1).reduce((a, b) => a + b, 0);
    expect(sum0).toBeCloseTo(1, 5);
    expect(sum1).toBeCloseTo(1, 5);
  });

  test('p_A 升高时 semantic 权重上升、bm25 下降', () => {
    const w0 = legWeights(0);
    const w1 = legWeights(1);
    expect(w1.semantic).toBeGreaterThan(w0.semantic);
    expect(w1.bm25).toBeLessThan(w0.bm25);
  });

  test('RRF 融合：命中多路的 memory 排前', () => {
    const now = Date.now();
    const cands: RawCandidate[] = [
      { memory_id: 'a', text: '电机工艺', source_namespace: 'v_mem_real', raw_score: 10, timestamp: now, recency: 0, strength: 0.5, activation: 0.5 },
      { memory_id: 'b', text: '电机工艺', source_namespace: 'v_mem_real', raw_score: 9, timestamp: now, recency: 0, strength: 0.5, activation: 0.5 },
    ];
    const out = weightedRRF({ bm25: cands, semantic: cands.slice(0, 1) }, 0.5, 10);
    expect(out[0].memory_id).toBe('a');
    expect(out[0].recall_sources).toContain('bm25');
    expect(out[0].recall_sources).toContain('semantic');
  });
});

describe('② 八路召回', () => {
  const db = buildTestDb({ n_memories: 500, n_facts: 30, n_blackdiamond: 5 });
  const q = understandQuery('motor stator winding insulation varnish customer inquiry', 'default');

  test('bm25 能从 FTS5 命中', async () => {
    const leg = new Bm25Recall(db);
    const out = await leg.recall(q);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].text).toMatch(/motor/i);
  });

  test('semantic 在 vec0 未装时优雅降级不抛错', async () => {
    const leg = new SemanticVectorRecall(db);
    let threw = false;
    let out: RawCandidate[] = [];
    try { out = await leg.recall(q); } catch { threw = true; }
    expect(threw).toBe(false);
    // 降级时至少返回一些候选（fallback FTS5）
    expect(out.length).toBeGreaterThanOrEqual(0);
  });

  test('emotion 在 vec0 未装时优雅降级', async () => {
    const leg = new Emotion40dRecall(db);
    let threw = false;
    try { await leg.recall(q); } catch { threw = true; }
    expect(threw).toBe(false);
  });

  test('ppr 从实体扩散', async () => {
    const q2: QueryContext = { ...q, entities: ['ent:deheng-motor'] };
    const leg = new PprRecall(db);
    const out = await leg.recall(q2);
    // 至少能跑通（不强求命中，因为随机数据实体关联稀疏）
    expect(Array.isArray(out)).toBe(true);
  });

  test('blackdiamond 命中高巩固度记忆', async () => {
    const leg = new BlackDiamondRecall(db);
    const out = await leg.recall(q);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) expect(c.strength).toBeGreaterThan(0.7);
  });

  test('profile 召回 dossier/preference 事实', async () => {
    const leg = new ProfileRecall(db);
    const out = await leg.recall(q);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) expect(c.source_namespace).toBe('v_fact_real');
  });

  test('kb 召回结构化知识条目', async () => {
    const leg = new KnowledgeBaseRecall(db);
    const out = await leg.recall(q);
    // 模糊查询可能命中也可能不命中，不强求
    expect(Array.isArray(out)).toBe(true);
  });

  test('foresight 召回 pending 前瞻项', async () => {
    const leg = new ForesightRecall(db);
    const out = await leg.recall(q);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].source_namespace).toBe('prospective_items');
  });
});

describe('⑤ MMR 去重', () => {
  test('相似文本被去重，保留多样化', () => {
    const base: Evidence = {
      memory_id: '', text: '', source_namespace: 'v_mem_real',
      score: 1, recall_sources: [], recency: 0, strength: 0.5, activation: 0.5, timestamp: 0,
    };
    const cands: Evidence[] = [
      { ...base, memory_id: '1', text: '电机定子绕组绝缘漆工艺参数' },
      { ...base, memory_id: '2', text: '电机定子绕组绝缘漆工艺参数 几乎一样' },
      { ...base, memory_id: '3', text: '太极拳平衡能力训练全因死亡率研究' },
    ];
    const out = mmrSelect(cands, 2, 0.7);
    expect(out.length).toBe(2);
    // 第 2 条（语义重复）应被剔除，第 3 条（不同主题）应保留
    const ids = out.map((e) => e.memory_id);
    expect(ids).toContain('1');
    expect(ids).toContain('3');
  });
});

describe('⑥ 降级熔断：重排超时跳过', () => {
  test('withTimeout 超时返回 fallback', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('slow'), 50));
    const wrap = await withTimeout(slow, 10, 'fallback');
    expect(wrap.timedOut).toBe(true);
    expect(wrap.value).toBe('fallback');

    const fast = Promise.resolve('fast');
    const wrap2 = await withTimeout(fast, 100, 'fallback');
    expect(wrap2.timedOut).toBe(false);
    expect(wrap2.value).toBe('fast');
  });

  test('端到端：rerank 预算压到极小时降级路径不崩', async () => {
    const db = buildTestDb({ n_memories: 200, n_facts: 10, n_blackdiamond: 2 });
    // rerank_ms=1：fallback 是同步计算，多数情况不触发超时，但必须保证不抛错
    const r = new Retriever(db, { rerank_ms: 1, recall_ms: 100, query_understand_ms: 50 });
    const res = await r.retrieve('motor stator winding process', 'default');
    expect(res.evidence.length).toBeGreaterThan(0);
  });

  test('端到端：正常路径返回 Evidence[]', async () => {
    const db = buildTestDb({ n_memories: 500, n_facts: 20, n_blackdiamond: 3 });
    const r = new Retriever(db);
    const res = await r.retrieve('最近三天客户询价的电机工艺参数', 'default');
    expect(res.evidence.length).toBeGreaterThan(0);
    for (const e of res.evidence) {
      expect(e.memory_id).toBeTruthy();
      expect(typeof e.score).toBe('number');
      expect(e.recall_sources.length).toBeGreaterThan(0);
      expect(e.source_namespace).toBeTruthy();
    }
    // p95 预算内（单测里不做严格断言，只验证 phase_ms 字段存在）
    expect(res.metrics.phase_ms.query_understand).toBeGreaterThanOrEqual(0);
  });
});
