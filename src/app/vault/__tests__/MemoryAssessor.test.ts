import { describe, expect, it } from 'vitest';
import { MemoryAssessor } from '../MemoryAssessor.js';

type FakeConversation = {
  id: number;
  role: string;
  content: string;
  calcium_score: number;
  entity_names?: string;
  dna_root_id?: string;
  timestamp?: string;
  perception_summary?: string;
  topic?: string;
  seq_pos?: number;
  dialog_group_id?: string;
  namespace?: string;
  is_promoted?: number;
};

class FakeSQLite {
  conversations: FakeConversation[];
  memories = new Map<string, any>();
  vaultLogs: Array<{ operation: string; detail: string | null }> = [];

  constructor(conversations: FakeConversation[]) {
    this.conversations = conversations;
  }

  queryAll(sql: string, params?: any[]): any[] {
    if (sql.includes('FROM conversations') && sql.includes('WHERE is_promoted = 0')) {
      const minCalcium = Number(params?.[0] ?? 0);
      return this.conversations
        .filter((conv) => Number(conv.is_promoted ?? 0) === 0 && Number(conv.calcium_score ?? 0) >= minCalcium)
        .sort((a, b) => Number(b.calcium_score ?? 0) - Number(a.calcium_score ?? 0));
    }

    if (sql.includes('SELECT COALESCE(MAX(seq_pos), 0) as max_seq FROM memories')) {
      let maxSeq = 0;
      for (const record of this.memories.values()) {
        maxSeq = Math.max(maxSeq, Number(record.seq_pos ?? 0));
      }
      return [{ max_seq: maxSeq }];
    }

    if (sql.includes('SELECT id FROM memories WHERE id = ? LIMIT 1')) {
      const id = String(params?.[0] ?? '');
      return this.memories.has(id) ? [{ id }] : [];
    }

    if (sql.includes('SELECT COUNT(*) as c FROM memories')) {
      return [{ c: this.memories.size }];
    }

    if (sql.includes('SELECT COUNT(*) as c FROM black_diamond')) {
      return [{ c: 0 }];
    }

    return [];
  }

  write(record: any): void {
    this.memories.set(record.id, record);
  }

  writeRaw(sql: string, ...params: any[]): void {
    if (sql.startsWith('UPDATE conversations SET is_promoted = 1 WHERE id = ?')) {
      const targetId = Number(params[0]);
      const target = this.conversations.find((conv) => conv.id === targetId);
      if (target) target.is_promoted = 1;
      return;
    }

    if (sql.startsWith('INSERT INTO vault_log')) {
      this.vaultLogs.push({
        operation: String(params[1] ?? ''),
        detail: params[5] == null ? null : String(params[5]),
      });
    }
  }
}

describe('MemoryAssessor', () => {
  // 🔴 MEM-UNIFY-V1 批3（D2）：砂金→金库的 1:1 复制晋升已删除 ——
  //   对话语义块已由 persistence-stage 每轮写一次，此处不得再复制，也不得标记 is_promoted。
  it('不再把 conversations 复制成 memories（D2 写入一次）', async () => {
    const sqlite = new FakeSQLite([
      {
        id: 11,
        role: 'user',
        content: '今天和客户开会，把项目报价重新梳理了一遍。',
        calcium_score: 2.6,
        entity_names: JSON.stringify(['客户', '项目']),
        dna_root_id: 'dna_root_a',
        timestamp: '2026-07-07T07:00:00.000Z',
        perception_summary: JSON.stringify({ pleasure: -0.1, arousal: 0.7, intimacy: 0.1 }),
        topic: '工作复盘',
        dialog_group_id: 'dg_work_1',
        namespace: 'ops',
        is_promoted: 0,
      },
      {
        id: 12,
        role: 'assistant',
        content: '收到。',
        calcium_score: 2.9,
        is_promoted: 0,
      },
    ]);
    const storage = { getSQLite: () => sqlite } as any;
    const assessor = new MemoryAssessor(storage);

    const total = await assessor.triggerSandToGold();

    expect(total).toBe(0);
    expect(sqlite.memories.size).toBe(0);
    expect(sqlite.conversations[0].is_promoted).toBe(0);
    expect(sqlite.vaultLogs).toHaveLength(0);
  });

  it('同一 dna_root 的多条砂金也不会被复制（不产生 mem_* 派生行）', async () => {
    const sqlite = new FakeSQLite([
      {
        id: 21,
        role: 'user',
        content: '我记得妈妈上周提醒我要回家吃饭。',
        calcium_score: 1.8,
        entity_names: '妈妈',
        dna_root_id: 'shared_root',
        topic: '家庭',
        is_promoted: 0,
      },
      {
        id: 22,
        role: 'user',
        content: '后来我又想起她说周末要一起去看外婆。',
        calcium_score: 1.9,
        entity_names: '妈妈,外婆',
        dna_root_id: 'shared_root',
        topic: '家庭',
        is_promoted: 0,
      },
    ]);
    const storage = { getSQLite: () => sqlite } as any;
    const assessor = new MemoryAssessor(storage);

    const total = await assessor.triggerSandToGold();

    expect(total).toBe(0);
    expect(sqlite.memories.has('mem_shared_root_21')).toBe(false);
    expect(sqlite.memories.has('mem_shared_root_22')).toBe(false);
    expect(sqlite.conversations.every((c) => c.is_promoted === 0)).toBe(true);
  });
});
