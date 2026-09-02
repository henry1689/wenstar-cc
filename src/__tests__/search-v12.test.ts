/**
 * search-v12.test.ts — V12.0 新检索管线集成测试
 * ============================================
 * 验证 searchV12() 的 RRF+MMR 新管线与旧 search() 的兼容性。
 * 不依赖真实数据库，使用手工构造的 MultiRankResult 做纯逻辑测试。
 */

import { describe, it, expect } from 'vitest';
import { searchV12, type SearchOptions } from '../m4/UnifiedSearchEngine.js';
import type { MultiRankResult, RankedList, RankedItem } from '../m4/types/retrieval.js';

function makeItem(id: string, text: string, source: RankedItem['source'], score: number): RankedItem {
  return { id, text, score, source, entityUuid: null, calciumScore: 1, createdAt: '2026-01-01' };
}

function makeMultiRank(lists: RankedList[]): MultiRankResult {
  const allIds = new Set<string>();
  for (const l of lists) for (const item of l.items) allIds.add(item.id);
  return { lists, totalCandidates: allIds.size, indexHit: false, indexedIds: [] };
}

describe('searchV12 - 新管线核心逻辑', () => {

  it('空召回返回空结果', () => {
    const result = searchV12(null as any, makeMultiRank([]), 'test query');
    expect(result.items).toEqual([]);
    expect(result.totalCandidates).toBe(0);
  });

  it('单路单条正确返回', () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', '今天天气很好', 'keyword', 1.0)] },
    ]);
    const result = searchV12(null as any, mr, '天气');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toContain('今天天气很好');
  });

  it('四路融合后去重', () => {
    const mr = makeMultiRank([
      { source: 'emotion', items: [makeItem('X', '情绪记忆', 'emotion', 0.9)] },
      { source: 'keyword', items: [makeItem('Y', '关键词记忆', 'keyword', 1.0)] },
      { source: 'spine', items: [makeItem('Z', '向量记忆', 'spine', 0.8)] },
      { source: 'locus', items: [makeItem('X', '情绪记忆(重复)', 'locus', 0.7)] },
    ]);
    const result = searchV12(null as any, mr, 'test');
    // X 在 emotion 和 locus 两路出现，应该去重
    const xCount = result.raw.filter(r => r.item.id === 'X').length;
    expect(xCount).toBeLessThanOrEqual(1);
  });

  it('limit 截断生效', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      makeItem(`M${i}`, `文本${i}`, 'keyword', 1.0 - i * 0.03));
    const mr = makeMultiRank([{ source: 'keyword', items }]);
    const result = searchV12(null as any, mr, 'test', null, { limit: 5 });
    expect(result.items.length).toBeLessThanOrEqual(5);
  });

  it('introvert 模式限制更强', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      makeItem(`M${i}`, `文本${i}`, 'keyword', 1.0 - i * 0.03));
    const mr = makeMultiRank([{ source: 'keyword', items }]);
    const fullResult = searchV12(null as any, mr, 'test', null, { mode: 'full', limit: 10 });
    const introResult = searchV12(null as any, mr, 'test', null, { mode: 'introvert', limit: 10 });
    // introvert 模式可有更少的结果（取决于 MMR topK）
    expect(introResult.items.length).toBeLessThanOrEqual(fullResult.items.length);
  });

  it('输出格式兼容旧 SearchResult', () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', '内容A', 'keyword', 1.0)] },
    ]);
    const result = searchV12(null as any, mr, 'query');
    // 验证 SearchResult 接口
    expect(Array.isArray(result.items)).toBe(true);
    expect(Array.isArray(result.raw)).toBe(true);
    expect(typeof result.hitsBySource).toBe('object');
    expect(typeof result.totalCandidates).toBe('number');
    // items 为 string[]
    for (const item of result.items) {
      expect(typeof item).toBe('string');
    }
  });
});

describe('searchV12 - entityUuid 过滤', () => {

  it('按 entityUuid 过滤', () => {
    const items = [
      { ...makeItem('A', '诗韵的记忆', 'keyword', 1.0), entityUuid: 'uuid-shirley' },
      { ...makeItem('B', '梓铭的记忆', 'keyword', 0.9), entityUuid: 'uuid-ziming' },
      { ...makeItem('C', '无归属记忆', 'keyword', 0.8), entityUuid: null },
    ];
    const mr = makeMultiRank([{ source: 'keyword', items }]);
    const result = searchV12(null as any, mr, 'query', null, {
      entityUuids: ['uuid-shirley'],
    });
    // P0-A3: deny-by-default — 无归属记录不通过
    const ids = result.raw.map(r => r.item.id);
    expect(ids).toContain('A');
    expect(ids).not.toContain('B'); // 不在白名单
    expect(ids).not.toContain('C'); // entityUuid=null 被过滤
  });
});

describe('searchV12 - hitsBySource 统计', () => {

  it('正确统计多路来源', () => {
    const mr = makeMultiRank([
      { source: 'emotion', items: [makeItem('E1', 'emotion-1', 'emotion', 1.0)] },
      { source: 'keyword', items: [makeItem('K1', 'keyword-1', 'keyword', 1.0), makeItem('K2', 'keyword-2', 'keyword', 0.9)] },
      { source: 'entity', items: [makeItem('N1', 'entity-1', 'entity', 0.8)] },
    ]);
    const result = searchV12(null as any, mr, 'query');
    // hitsBySource 记录各类来源
    expect(typeof result.hitsBySource).toBe('object');
    const total = Object.values(result.hitsBySource).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(result.raw.length);
  });
});

describe('searchV12 - includeKnowledgeBase', () => {

  it('includeKnowledgeBase=false 时结果仍正常', () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    // includeKnowledgeBase 不影响 V12 管道（V12 管道的知识库过滤在 retrieveMultiRank 阶段处理）
    const result = searchV12(null as any, mr, 'query', null, { includeKnowledgeBase: false });
    expect(result.items.length).toBeGreaterThan(0);
  });
});
