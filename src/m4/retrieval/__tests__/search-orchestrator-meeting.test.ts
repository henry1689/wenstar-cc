/**
 * search-orchestrator-meeting.test.ts — 统一检索中枢（会晤场景）测试
 * ============================================================
 * 验证：
 *   1. SearchOrchestrator 多路并行 + 融合
 *   2. MeetingWallAdapter 三槽位检索（近期/历史/回忆问句）
 *   3. 会晤隐私隔离（只查 belong_entity_uuid=当前实体）
 *   4. 编造特征过滤
 *   5. 多路融合去重
 */

import { describe, it, expect, vi } from 'vitest';
import { SearchOrchestrator } from '../SearchOrchestrator.js';
import { AdapterRegistry } from '../adapter.js';
import { MeetingWallAdapter } from '../adapters/MeetingWallAdapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';

/** 假 SQLite 数据源 */
function makeSource(rows: any[]) {
  return {
    queryAll: vi.fn((sql: string, params?: any[]) => {
      if (sql.includes('julianday') && sql.includes('< 1')) return rows.filter(r => r.recent);
      if (sql.includes('julianday') && sql.includes('>= 1')) return rows.filter(r => !r.recent);
      if (sql.includes('ORDER BY seq_pos')) return rows.slice(0, 6);
      return [];
    }),
  };
}

function makeCtx(overrides: Partial<RetrievalContext> = {}): RetrievalContext {
  return {
    query: '阿芬最近怎么样',
    entityUuids: ['TXS-000000005'],
    policy: { enforce: false } as any,
    mode: 'balanced',
    ...overrides,
  } as RetrievalContext;
}

/** 假适配器（模拟另一路，验证并行融合） */
function makeFakeAdapter(domain: string, route: string, hits: SearchHit[]) {
  return {
    domain,
    routes: [route],
    filterMode: 'deny' as const,
    search: vi.fn(async () => hits),
  } as any;
}

describe('MeetingWallAdapter — 会晤隔离墙三槽位', () => {
  it('会晤场景应检索实体自有记忆（近期+历史槽）', async () => {
    const rows = [
      { id: 'm1', raw_input: '阿芬今天很开心', calcium_score: 0.8, created_at: new Date().toISOString(), recent: true },
      { id: 'm2', raw_input: '上次和阿芬聊过树林', calcium_score: 0.9, created_at: '2026-08-28T03:25:00Z', recent: false },
    ];
    const adapter = new MeetingWallAdapter(makeSource(rows));
    const ctx = makeCtx({ query: '阿芬最近怎么样' });

    const hits = await adapter.search(ctx);
    expect(hits.length).toBe(2);
    // 隐私隔离：entityUuid 必须是当前会晤实体
    for (const h of hits) expect(h.entityUuid).toBe('TXS-000000005');
    // 路由标记
    for (const h of hits) expect(h.route).toBe('meeting');
  });

  it('无会晤实体（entityUuids 空）应返回空', async () => {
    const adapter = new MeetingWallAdapter(makeSource([]));
    const hits = await adapter.search(makeCtx({ entityUuids: [] }));
    expect(hits).toEqual([]);
  });

  it('回忆问句应追加最早槽', async () => {
    const rows = [
      { id: 'm1', raw_input: '今天的事', calcium_score: 0.8, created_at: new Date().toISOString(), recent: true },
      { id: 'm2', raw_input: '最早的事', calcium_score: 0.5, created_at: '2026-08-20T00:00:00Z', recent: false },
    ];
    const source = makeSource(rows);
    const adapter = new MeetingWallAdapter(source);
    // 回忆问句
    const ctx = makeCtx({ query: '你还记得上次我们聊过什么吗' });
    const hits = await adapter.search(ctx);
    // 最早槽查询应被调用（ORDER BY seq_pos）
    expect(source.queryAll.mock.calls.some(c => String(c[0]).includes('ORDER BY seq_pos'))).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('编造特征记忆应被过滤', async () => {
    const rows = [
      { id: 'm1', raw_input: '我去海边穿了比基尼', calcium_score: 0.9, created_at: new Date().toISOString(), recent: true },
      { id: 'm2', raw_input: '阿芬的日常聊天', calcium_score: 0.7, created_at: new Date().toISOString(), recent: true },
    ];
    const adapter = new MeetingWallAdapter(makeSource(rows));
    const hits = await adapter.search(makeCtx());
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('m2');
  });
});

describe('SearchOrchestrator — 统一调度中枢', () => {
  it('多路并行检索 + 融合去重', async () => {
    const registry = new AdapterRegistry();
    // 会晤隔离墙路
    const wallAdapter = new MeetingWallAdapter(makeSource([
      { id: 'm1', raw_input: '阿芬的近期记忆', calcium_score: 0.8, created_at: new Date().toISOString(), recent: true },
    ]));
    registry.register(wallAdapter as any);
    // 假额外域路（黑钻）
    registry.register(makeFakeAdapter('black_diamond', 'diamond', [{
      id: 'bd1', domain: 'black_diamond' as const, text: '黑钻记忆', score: 0.9,
      route: 'diamond' as const, entityUuid: 'TXS-000000005', createdAt: new Date().toISOString(),
    }]));

    const orchestrator = new SearchOrchestrator();
    const result = await orchestrator.runSearch(registry, makeCtx());

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.routeStats.meeting).toBe(1);
    expect(result.routeStats.diamond).toBe(1);
  });

  it('单路失败不阻塞其他路', async () => {
    const registry = new AdapterRegistry();
    registry.register(makeFakeAdapter('fail', 'default', []));
    registry.register(makeFakeAdapter('fail2', 'default', []));
    // 注册一个会抛异常的适配器
    registry.register({
      domain: 'boom', routes: ['default'], filterMode: 'deny',
      search: vi.fn(async () => { throw new Error('boom'); }),
    } as any);

    const orchestrator = new SearchOrchestrator();
    // 不应抛异常（runAdapter 已隔离）
    const result = await orchestrator.runSearch(registry, makeCtx());
    expect(result).toBeDefined();
  });

  it('无适配器时返回空结果', async () => {
    const orchestrator = new SearchOrchestrator();
    const result = await orchestrator.runSearch(new AdapterRegistry(), makeCtx());
    expect(result.hits).toEqual([]);
    expect(result.routeStats).toEqual({});
  });
});
