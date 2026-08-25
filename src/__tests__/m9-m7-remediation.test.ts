import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWriteBuffer } from '../m9/WorkingMemory.js';
import { PerceptionAnalyzer } from '../m3/PerceptionAnalyzer.js';
import { M7Orchestrator } from '../m7/M7Orchestrator.js';
import { M3_CONFIG } from '../config/M3Config.js';
import type { DNA } from '../m1/types/dna.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { M8Engine } from '../m8/M8Engine.js';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';

vi.mock('../m7/DreamQueue.js', () => ({
  DreamQueue: class {
    add = vi.fn((dream: Record<string, unknown>) => ({
      id: 'dream-test', created_at: '', status: 'pending', ...dream,
    }));
    shouldProcess(): boolean { return false; }
    getPending(): never[] { return []; }
    getCount(): number { return 0; }
    cleanResolved(): void {}
    getByStatus(): never[] { return []; }
  },
}));

const dna: DNA = {
  locus_path: 'user.misc.default', taxonomy_version: 'test',
  branch_id: 'evt-test', seq_pos: 0,
  leaf_zone: 'language_semantic_zone', ref: 'tmp-test',
  entity_genes: [{
    name: '测试实体', type: 'person', allele: '测试实体',
    phenotype: 'neutral', knowledge_type: 'private',
  }],
  raw_input: '需要跨轮保留的低钙记忆', created_at: new Date().toISOString(),
};

const perception: Perception24D = {
  pleasure: 0, arousal: 0, dominance: 0, aggression: 0, sincerity: 0,
  humor: 0, factual: 0, logical: 0, certainty: 0, abstract: 0,
  temporal_focus: 0, self_ref: 0, intimacy: 0, power_diff: 0,
  dependency: 0, moral_judgment: 0, etiquette: 0, belonging: 0,
  sexual_attraction: 0, sensory_craving: 0, energy_merge: 0,
  possessiveness: 0, ecstasy: 0, safety: 0,
};

describe('P1-M9-01 工作记忆跨轮状态机', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(PerceptionAnalyzer, 'recalculateCalcium').mockReturnValue({
      score: 0.1, level: 0,
      breakdown: { base_core: 0, emotional_boost: 0, threat_bonus: 0 },
    });
  });

  it('第1至5轮保留低钙条目，第6轮强制毕业且只写一次', async () => {
    const write = vi.fn().mockResolvedValue({ success: true, real_ref: 'seq_1', seq_pos: 1 });
    const storage = { write } as unknown as FusionStorageAdapter;
    const buffer = new MemoryWriteBuffer(storage);
    buffer.push({ ...dna, entity_genes: [...dna.entity_genes] }, perception, 1);

    for (let cycle = 1; cycle <= 5; cycle++) {
      expect(await buffer.consolidate()).toEqual([]);
      expect(buffer.getStatus().size).toBe(1);
      expect(write).not.toHaveBeenCalled();
    }

    expect(await buffer.consolidate()).toHaveLength(1);
    expect(buffer.getStatus().size).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('flushAll 明确排空未达到毕业条件的条目', async () => {
    const write = vi.fn().mockResolvedValue({ success: true, real_ref: 'seq_2', seq_pos: 2 });
    const storage = { write } as unknown as FusionStorageAdapter;
    const buffer = new MemoryWriteBuffer(storage);
    buffer.push({ ...dna, entity_genes: [...dna.entity_genes] }, perception, 2);

    expect(await buffer.flushAll()).toEqual([]);
    expect(buffer.getStatus().size).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('P1-M7-01 高钙梦境归纳阈值', () => {
  it.each([
    [M3_CONFIG.calcium.level3Threshold - 0.01, 0],
    [M3_CONFIG.calcium.level3Threshold, 1],
    [M3_CONFIG.calcium.level3Threshold + 0.01, 1],
  ])('calcium_score=%s 时入队次数为 %s', async (calciumScore, expected) => {
    const m7 = new M7Orchestrator({} as M8Engine);
    const add = vi.mocked(m7.queue.add);

    await m7.triggerInduction(
      { raw_input: '达到配置阈值才进入梦境队列', branch_id: 'evt-test' },
      { enhanced: { calcium_score: calciumScore } },
    );

    expect(add).toHaveBeenCalledTimes(expected);
  });
});
