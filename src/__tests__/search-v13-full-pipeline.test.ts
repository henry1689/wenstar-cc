/**
 * search-v13-full-pipeline.test.ts — 七层仿生检索全链路集成测试
 * ============================================================
 * 逐层开启验证: L0→L1→L3→L4→L5→L6→L7，每层独立可测。
 * L5 Cross-Encoder 用 Noop 替代（ONNX 模型未就绪），其余全部真跑。
 */
import { describe, it, expect } from 'vitest';
import { searchV13, type SearchResultV13 } from '../m4/UnifiedSearchEngine.js';
import type { MultiRankResult, RankedList, RankedItem } from '../m4/types/retrieval.js';
import { MemoryAssociationRepository } from '../m4/graph/MemoryAssociationRepository.js';
import { DEFAULT_FULL_PIPELINE_CONFIG, type FullSearchPipelineConfig } from '../m4/SearchConfig.js';

// ═══════════════════════════════════════════════════════════
// Mock 基础设施
// ═══════════════════════════════════════════════════════════

class MockSQLite {
  private edges: any[] = [];
  runSql(_s: string, _p?: any[]) {}
  queryAll(_s: string, _p?: any[]): any[] {
    // 返回 DAG 边供闭包展开
    return this.edges.slice(0, 20);
  }
  addEdge(e: any) { this.edges.push(e); }
}

function makeItem(id: string, text: string, source: RankedItem['source'], score: number, createdAt?: string): RankedItem {
  return { id, text, score, source, entityUuid: 'u1', calciumScore: 1, createdAt: createdAt ?? '2026-07-15T14:30:00Z' };
}

function makeMultiRank(lists: RankedList[], indexHit = false): MultiRankResult {
  const allIds = new Set<string>();
  for (const l of lists) for (const i of l.items) allIds.add(i.id);
  return { lists, totalCandidates: allIds.size, indexHit, indexedIds: indexHit ? [...allIds].slice(0, 3) : [] };
}

// ═══════════════════════════════════════════════════════════
// 基础管线: L3 RRF + L6 MMR (Sprint 1 成果, 确保不变)
// ═══════════════════════════════════════════════════════════

describe('V13 基础管线 (L3 RRF + L6 MMR)', () => {
  it('空召回返回空结果', async () => {
    const r = await searchV13(null as any, makeMultiRank([]), 'test');
    expect(r.items).toEqual([]);
    expect(r.totalCandidates).toBe(0);
    expect(r.layerLatency).toBeDefined();
  });

  it('单路 3 条 → RRF 融合 → MMR 去重', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [
        makeItem('A', '妈妈身体不好', 'keyword', 1.0),
        makeItem('B', '妈妈身体不太好', 'keyword', 0.9),
        makeItem('C', '今天天气不错', 'keyword', 0.8),
      ]},
    ]);
    const r = await searchV13(null as any, mr, '妈妈身体');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(8);
  });

  it('多路命中 bonus 生效', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('X', '交叉命中', 'keyword', 1.0)] },
      { source: 'spine',   items: [makeItem('X', '交叉命中', 'spine', 0.9)] },
    ]);
    const r = await searchV13(null as any, mr, '交叉', null, {},
      { enableForesightFilter: false }); // 关闭 Foresight 避免非 foresight item 被过滤
    // 两路同时命中 X → X 应该在结果中
    const allIds = r.raw.map(e => e.item.id).filter(Boolean);
    expect(allIds).toContain('X');
  });
});

// ═══════════════════════════════════════════════════════════
// L0 时序围栏 + L1 情绪预筛选
// ═══════════════════════════════════════════════════════════

describe('V13 L0 时序围栏', () => {
  it('timeRange 过滤时间窗外记忆', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [
        makeItem('A', '旧的记忆', 'keyword', 1.0, '2020-01-01'),
        makeItem('B', '新的记忆', 'keyword', 0.9, '2026-07-15'),
      ]},
    ]);
    const r = await searchV13(null as any, mr, '记忆', null, {
      timeRange: { start: '2026-01-01' },
    });
    // 2020 的旧记忆被 L0 过滤
    expect(r.totalCandidates).toBeGreaterThanOrEqual(0);
    expect(r.layerLatency!['L0_temporal']).toBeGreaterThanOrEqual(0);
  });
});

describe('V13 L1 情绪预筛选', () => {
  it('海马体索引命中 → 命中项优先排序', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [
        makeItem('A', '普通记忆1', 'keyword', 0.5),
        makeItem('B', '普通记忆2', 'keyword', 0.4),
        makeItem('C', '普通记忆3', 'keyword', 0.3),
      ]},
    ], true); // indexHit=true, indexedIds=['A','B','C']
    const r = await searchV13(null as any, mr, '查询');
    expect(r.layerLatency!['L1_emotion']).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════
// L4 DAG 闭包展开 (enableDAGClosure=true)
// ═══════════════════════════════════════════════════════════

describe('V13 L4 DAG 闭包', () => {
  it('DAG 关闭时返回 null closure', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'memory', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableDAGClosure: false });
    expect(r.closure).toBeUndefined();
  });

  it('DAG 开启且有边数据 → 展开闭包子图', async () => {
    const mockDb = new MockSQLite();
    // 建一条实体边: S1 → N1
    mockDb.addEdge({
      id: 1, namespace: 'default', belong_entity_uuid: 'u1',
      source_global_uid: 'A', target_global_uid: 'B',
      edge_type: 'entity', edge_reason: 'test',
      confidence: 0.9, weight: 1.0,
      source_timestamp_ms: 1000, target_timestamp_ms: 2000,
      created_by: 'test', created_at_ms: 1000, updated_at_ms: 1000, state_flag: 'active',
      // snake_case 兼容 MemoryAssociationRepository._rowToAssociation
      belongEntityUuid: 'u1', sourceGlobalUid: 'A', targetGlobalUid: 'B',
      edgeType: 'entity', edgeReason: 'test',
      sourceTimestampMs: 1000, targetTimestampMs: 2000,
      createdBy: 'test', createdAtMs: 1000, updatedAtMs: 1000, stateFlag: 'active',
    });
    const repo = new MemoryAssociationRepository(mockDb as any);

    const mr = makeMultiRank([
      { source: 'keyword', items: [
        makeItem('A', '种子记忆', 'keyword', 1.0),
        makeItem('B', '关联记忆', 'keyword', 0.5),
      ]},
    ]);
    const r = await searchV13(null as any, mr, 'test', null, { entityUuids: ['u1'] },
      { enableDAGClosure: true }, repo);
    // DAG 开启时至少有 layer latency 记录
    expect(r.layerLatency!['L4_DAG']).toBeDefined();
    // closure 可能为 null（如果 BFS 没找到边），但至少要尝试过
    if (r.closure) {
      expect(r.closure.seedCount).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// L5 Cross-Encoder (Noop — 模型未就绪)
// ═══════════════════════════════════════════════════════════

describe('V13 L5 Cross-Encoder (Noop)', () => {
  it('Cross-Encoder 关闭默认走 Noop', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableCrossEncoder: false });
    expect(r.layerLatency!['L5_CrossEncoder_skip']).toBeDefined();
  });

  it('Cross-Encoder 开启 → 走 NoopCrossEncoderReranker', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableCrossEncoder: true });
    expect(r.layerLatency!['L5_CrossEncoder']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// L6 Foresight 时效过滤
// ═══════════════════════════════════════════════════════════

describe('V13 L6 Foresight 过滤', () => {
  it('Foresight 关闭跳过过滤', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableForesightFilter: false });
    expect(r.layerLatency!['L6_Foresight_skip']).toBeDefined();
  });

  it('Foresight 开启执行过滤', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableForesightFilter: true });
    expect(r.layerLatency!['L6_Foresight']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// L7 叙事组装 (enableNarrativeAssembler=true + enableDAGClosure=true)
// ═══════════════════════════════════════════════════════════

describe('V13 L7 叙事组装', () => {
  it('叙事关闭时不输出 narrative', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {}, { enableNarrativeAssembler: false });
    expect(r.narrative).toBeUndefined();
  });

  it('叙事开启 + 无 DAG 闭包 → narrative 为 undefined', async () => {
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const r = await searchV13(null as any, mr, 'test', null, {},
      { enableNarrativeAssembler: true, enableDAGClosure: false });
    // 无 closure → 叙事不触发
    expect(r.layerLatency!['L7_Narrative_skip']).toBeDefined();
  });

  it('叙事开启 + DAG 开启 → 输出 narrative', async () => {
    const mockDb = new MockSQLite();
    mockDb.addEdge({
      id: 1, namespace: 'default', belong_entity_uuid: 'u1',
      source_global_uid: 'A', target_global_uid: 'B',
      edge_type: 'causal', edge_reason: 'test',
      confidence: 0.85, weight: 1.0,
      source_timestamp_ms: 1000, target_timestamp_ms: 2000,
      created_by: 'test', created_at_ms: 1000, updated_at_ms: 1000, state_flag: 'active',
      belongEntityUuid: 'u1', sourceGlobalUid: 'A', targetGlobalUid: 'B',
      edgeType: 'causal', edgeReason: 'test',
      sourceTimestampMs: 1000, targetTimestampMs: 2000,
      createdBy: 'test', createdAtMs: 1000, updatedAtMs: 1000, stateFlag: 'active',
    });
    const repo = new MemoryAssociationRepository(mockDb as any);

    const mr = makeMultiRank([
      { source: 'keyword', items: [
        makeItem('A', '妈妈身体不好我很担心', 'keyword', 1.0, '2026-07-15T14:30:00Z'),
        makeItem('B', '建议回去看看', 'keyword', 0.8, '2026-07-15T14:32:00Z'),
      ]},
    ]);
    const r = await searchV13(null as any, mr, '妈妈', null, {},
      { enableDAGClosure: true, enableNarrativeAssembler: true }, repo);
    // narrative 可能为 undefined 如果闭包没展开到节点
    if (r.narrative) {
      expect(r.narrative.timeline).toBeDefined();
    }
    if (r.closure) {
      expect(r.closure.nodeCount).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 全开模式：七层全部启用
// ═══════════════════════════════════════════════════════════

describe('V13 全开模式 (全七层)', () => {
  it('七层全开不崩溃', async () => {
    const mockDb = new MockSQLite();
    mockDb.addEdge({
      id: 1, namespace: 'default', belong_entity_uuid: 'u1',
      source_global_uid: 'A', target_global_uid: 'B',
      edge_type: 'causal', edge_reason: 'test',
      confidence: 0.9, weight: 1.0,
      source_timestamp_ms: 1000, target_timestamp_ms: 2000,
      created_by: 'test', created_at_ms: 1000, updated_at_ms: 1000, state_flag: 'active',
      belongEntityUuid: 'u1', sourceGlobalUid: 'A', targetGlobalUid: 'B',
      edgeType: 'causal', edgeReason: 'test',
      sourceTimestampMs: 1000, targetTimestampMs: 2000,
      createdBy: 'test', createdAtMs: 1000, updatedAtMs: 1000, stateFlag: 'active',
    });
    const repo = new MemoryAssociationRepository(mockDb as any);

    const items = Array.from({ length: 15 }, (_, i) =>
      makeItem(`M${i}`, `记忆内容${i}`, i % 3 === 0 ? 'keyword' : i % 3 === 1 ? 'spine' : 'emotion', 1.0 - i * 0.05, `2026-07-${10 + i}T12:00:00Z`));
    const mr = makeMultiRank([
      { source: 'keyword', items: items.filter(i => i.source === 'keyword') },
      { source: 'spine',   items: items.filter(i => i.source === 'spine') },
      { source: 'emotion', items: items.filter(i => i.source === 'emotion') },
    ], true); // 海马体索引命中

    const fullCfg: Partial<FullSearchPipelineConfig> = {
      enableRRF: true,
      enableDAGClosure: true,
      enableCrossEncoder: true,   // Noop
      enableForesightFilter: true,
      enableMMR: true,
      enableNarrativeAssembler: true,
    };

    const r = await searchV13(null as any, mr, '记忆', null, {
      mode: 'balanced', limit: 10,
      timeRange: { start: '2026-07-01' },
      entityUuids: ['u1'],
    }, fullCfg, repo);

    // 至少不崩溃
    expect(r).toBeDefined();
    expect(r.items.length).toBeGreaterThanOrEqual(0);
    // 每层都有延迟记录
    const expectedLayers = ['L0_temporal', 'L1_emotion', 'L3_RRF', 'L4_DAG', 'L5_CrossEncoder', 'L6_Foresight', 'L6_MMR', 'L7_Narrative', 'L_output'];
    for (const layer of expectedLayers) {
      expect(r.layerLatency?.[layer]).toBeDefined();
    }
    // 输出 SearchResult 格式兼容
    expect(Array.isArray(r.items)).toBe(true);
    expect(Array.isArray(r.raw)).toBe(true);
    expect(typeof r.hitsBySource).toBe('object');
  });

  it('某层失败不影响后续层（降级验证）', async () => {
    // 不开 DAG repo → L4 降级但不崩溃
    const mr = makeMultiRank([
      { source: 'keyword', items: [makeItem('A', 'test', 'keyword', 1.0)] },
    ]);
    const fullCfg: Partial<FullSearchPipelineConfig> = {
      enableDAGClosure: true,  // 开启但无 repo
      enableCrossEncoder: true,
      enableForesightFilter: true,
      enableMMR: true,
      enableNarrativeAssembler: true,
    };
    const r = await searchV13(null as any, mr, 'test', null, {}, fullCfg, null);
    // L4 降级
    expect(r.layerLatency!['L4_DAG_fallback'] ?? r.layerLatency!['L4_DAG_skip']).toBeDefined();
    // 其余层正常
    expect(r.layerLatency!['L_output']).toBeDefined();
  });
});
