import { beforeEach, describe, expect, it, vi } from 'vitest';
import { M4Orchestrator } from '../M4Orchestrator.js';

const allowedMemory = {
  branch_id: 'allowed', seq_pos: 1, created_at: '', raw_input: '当前实体记忆',
  calcium_score: 0.5, calcium_level: 1, belong_entity_uuid: 'uuid-current',
  entity_genes: [], locus_path: 'misc.default', taxonomy_version: 'test',
  leaf_zone: 'language_semantic_zone', ref: 'allowed',
};

const blockedMemory = {
  ...allowedMemory,
  branch_id: 'blocked', ref: 'blocked', raw_input: '其他实体私密记忆',
  belong_entity_uuid: 'uuid-other',
};

function createSubject() {
  const familyGraph = {
    getUUIDByName: vi.fn(() => null),
    integrateFromEntity: vi.fn().mockResolvedValue(undefined),
    getFamilySummary: vi.fn().mockResolvedValue({ members: [] }),
    getSocialSummary: vi.fn().mockResolvedValue({ connections: [] }),
  };
  const subject = new M4Orchestrator({} as any, familyGraph as any);
  const compressMemories = vi.fn((memories: any[]) => ({
    timeline: memories.map(memory => ({
      time: memory.created_at,
      summary: memory.raw_input,
      calcium_level: memory.calcium_level,
    })),
    key_events: [],
    emotional_arc: '',
    recurring_patterns: [],
  }));
  (subject as any).memoryRetriever = {
    retrieveMemories: vi.fn().mockResolvedValue([allowedMemory, blockedMemory]),
    compressMemories,
    storage: { getSQLite: () => null },
  };
  return { subject, compressMemories };
}

const decision = {
  enhanced: {
    entity_genes: [], locus_path: 'misc.default', raw_input: '测试',
    perception: {}, calcium_level: 1,
  },
  actions: [],
} as any;

describe('M4Orchestrator privacy gate', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('在压缩、回调和 SceneSnapshot 缓存前先过滤跨实体记忆', async () => {
    const { subject, compressMemories } = createSubject();
    const onRetrieved = vi.fn();
    subject._onMemoriesRetrieved = onRetrieved;
    subject.setGatekeeper({
      isActive: () => true,
      filterMemories: (memories: any[]) => memories.filter(memory => memory.belong_entity_uuid === 'uuid-current'),
      filterFGMembers: (members: any[]) => members,
    });

    const result = await subject.orchestrate(decision);

    expect(compressMemories).toHaveBeenCalledWith([allowedMemory]);
    expect(onRetrieved).toHaveBeenCalledTimes(1);
    expect(onRetrieved.mock.calls[0][0]).toHaveLength(1);
    expect((subject as any)._lastRetrieveMemories).toEqual([allowedMemory]);
    expect(result.meta.has_history).toBe(true);
    expect(result.memory_summary.timeline).toHaveLength(1);
  });

  it('门阀异常时阻断全部记忆且不回填原始结果', async () => {
    const { subject, compressMemories } = createSubject();
    const onRetrieved = vi.fn();
    subject._onMemoriesRetrieved = onRetrieved;
    subject.setGatekeeper({
      isActive: () => true,
      filterMemories: () => { throw new Error('gate unavailable'); },
      filterFGMembers: (members: any[]) => members,
    });

    const result = await subject.orchestrate(decision);

    expect(compressMemories).toHaveBeenCalledWith([]);
    expect(onRetrieved).not.toHaveBeenCalled();
    expect((subject as any)._lastRetrieveMemories).toEqual([]);
    expect(result.meta.has_history).toBe(false);
    expect(result.memory_summary.timeline).toEqual([]);
  });
});
