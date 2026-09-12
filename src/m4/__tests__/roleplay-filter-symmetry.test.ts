import { describe, it, expect } from 'vitest';
import { MemoryRetriever } from '../MemoryRetriever.js';

// [P0-②] roleplay 过滤对称化（2026-09-12）
//
// 原实现三处同一个条件：
//   `if (options?.isBackgroundTask && dna.memory_kind === 'roleplay') return false;`
//   —— 只在「后台任务」时过滤。于是**非会晤场景（和玉瑶聊天）完全不过滤**，
//   byLocus / byEmotion / byKeyword 三路会把徐诗雨的会晤记忆注入玉瑶的上下文。
//   实测症状：玉瑶频道里出现「玉瑶：（我弯了弯眼睛）……诗雨都收下了」——人格污染。
//
// 修复：判定对称化 ——
//   · 会晤场景（entityUuids 非空）→ roleplay 记忆是本实体自己的会晤记忆，**保留**
//   · 非会晤场景（entityUuids 为空）→ roleplay 记忆属于他人，**排除**
//   · 后台任务 → 维持原行为，**排除**
//
// 样例为日常语境，不涉亲密内容。

const UUID_XSY = 'TXS-000000007';

const ROLEPLAY_MEM = {
  id: 'mem_rp', branch_id: 'mem_rp', seq_pos: 10, raw_input: '（我应了一声）诗雨在呢',
  created_at: '2026-09-05T10:00:00.000Z', calcium_score: 6.0, calcium_level: 4,
  is_landmark: 1, locus_path: 'life.daily', memory_kind: 'roleplay',
  memory_type: 'dialog', belong_entity_uuid: UUID_XSY,
};
const PLAIN_MEM = {
  ...ROLEPLAY_MEM, id: 'mem_plain', branch_id: 'mem_plain',
  memory_kind: 'episodic', raw_input: '今天的日常闲聊',
};

function mkStorage() {
  const calls: string[] = [];
  return {
    calls,
    findByLocus: async () => { calls.push('findByLocus'); return [ROLEPLAY_MEM, PLAIN_MEM]; },
    findBySeqPosRange: async () => [],
    findByEmotionalSimilarity: () => [],
    getSQLite: () => ({ queryAll: () => [] }),
    findByEntityUuid: () => [],
  } as any;
}

describe('[P0-②] roleplay 过滤对称化 —— 非会晤场景不得注入他人会晤记忆', () => {
  it('非会晤场景（无 entityUuids）→ 会晤记忆被排除', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], { limit: 20 });
    const ids = out.map((d: any) => d.branch_id);
    expect(ids).not.toContain('mem_rp');
    expect(ids).toContain('mem_plain');
  });

  it('会晤场景（有 entityUuids）→ 本实体的会晤记忆保留', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], { limit: 20, entityUuids: [UUID_XSY] });
    const ids = out.map((d: any) => d.branch_id);
    expect(ids).toContain('mem_rp');
  });

  it('后台任务 → 会晤记忆仍被排除（原行为保持）', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], { limit: 20, isBackgroundTask: true });
    const ids = out.map((d: any) => d.branch_id);
    expect(ids).not.toContain('mem_rp');
  });
});
