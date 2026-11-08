/**
 * casual-floor 轻档检索（ADR-019）回归测试
 *
 * 锁定四件事（缺一即视为档位契约被破坏）：
 *   ① 阈值过滤：emotional / calcium 双双低于阈值的不注入；
 *   ② limit：默认 3、硬上限 5；
 *   ③ 排除当前分支（否则会把「刚说的这句」当成过去的记忆）；
 *   ④ 永不抛出：存储异常 → 零记忆。
 */
import { describe, it, expect } from 'vitest';
import {
  collectCasualFloorMemories,
  CASUAL_FLOOR_DEFAULT_LIMIT,
  CASUAL_FLOOR_EMOTIONAL,
  CASUAL_FLOOR_CALCIUM,
} from '../casual-floor.js';

const PERCEPTION = { pleasure: 0, arousal: 0, intimacy: 0 } as any;

function scored(id: string, emotional: number, calcium = 0) {
  return {
    record: { id, raw_input: 'm-' + id },
    scores: { emotional, topic: 0, entity: 0, calcium },
    composite: emotional,
  } as any;
}

function fakeStorage(rows: any[], capture?: (q: any) => void) {
  return {
    findByEmotionalSimilarity(q: any) {
      capture?.(q);
      return rows;
    },
  } as any;
}

describe('casual-floor · 轻档检索', () => {
  it('阈值过滤：情感与钙化都低于阈值 → 不注入', () => {
    const below = CASUAL_FLOOR_EMOTIONAL - 0.05;
    const belowC = CASUAL_FLOOR_CALCIUM - 0.05;
    const { memories } = collectCasualFloorMemories({
      storage: fakeStorage([scored('low', below, belowC)]),
      perception: PERCEPTION,
    });
    expect(memories).toHaveLength(0);
  });

  it('阈值过滤：情感分达标 / 钙化分达标 任一成立即保留', () => {
    const high = CASUAL_FLOOR_EMOTIONAL + 0.05;
    const highC = CASUAL_FLOOR_CALCIUM + 0.05;
    const { memories } = collectCasualFloorMemories({
      storage: fakeStorage([scored('byEmo', high, 0), scored('byCal', 0, highC)]),
      perception: PERCEPTION,
    });
    expect(memories.map(m => m.record.id)).toEqual(['byEmo', 'byCal']);
  });

  it('limit：默认条数生效，且硬上限 5', () => {
    const rows = Array.from({ length: 10 }, (_, i) => scored('m' + i, 0.9));
    const def = collectCasualFloorMemories({ storage: fakeStorage(rows), perception: PERCEPTION });
    expect(def.memories).toHaveLength(CASUAL_FLOOR_DEFAULT_LIMIT);
    const capped = collectCasualFloorMemories({ storage: fakeStorage(rows), perception: PERCEPTION, limit: 99 });
    expect(capped.memories).toHaveLength(5);
  });

  it('排除当前分支：branchId 对应的记忆不得注入', () => {
    const { memories } = collectCasualFloorMemories({
      storage: fakeStorage([scored('current', 0.99), scored('past', 0.99)]),
      perception: PERCEPTION,
      branchId: 'current',
    });
    expect(memories.map(m => m.record.id)).toEqual(['past']);
  });

  it('entityUuids：非空透传，空数组按未指定处理', () => {
    let captured: any = null;
    collectCasualFloorMemories({
      storage: fakeStorage([], q => { captured = q; }),
      perception: PERCEPTION,
      entityUuids: ['TXS-000000001'],
    });
    expect(captured.entityUuids).toEqual(['TXS-000000001']);
    expect(captured.similarity_mode).toBe('balanced');

    collectCasualFloorMemories({
      storage: fakeStorage([], q => { captured = q; }),
      perception: PERCEPTION,
      entityUuids: [],
    });
    expect(captured.entityUuids).toBeUndefined();
  });

  it('永不抛出：存储异常 → 零记忆', () => {
    const storage = { findByEmotionalSimilarity() { throw new Error('db down'); } } as any;
    const r = collectCasualFloorMemories({ storage, perception: PERCEPTION });
    expect(r.memories).toEqual([]);
    expect(typeof r.ms).toBe('number');
  });
});
