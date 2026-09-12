import { describe, it, expect } from 'vitest';
import { MemoryRetriever } from '../MemoryRetriever.js';

// B1 关键词倒排召回回归测试（2026-09-12）
//
// 现象：会晤中问"还记得我们的中秋之约吗" → 答不出，用户感受为"已记住却召不回"。
//
// 根因（两条，均由实测取证）：
//   ① 查询词来源错：keywords 只取「实体名 + locus 末段」，用户消息正文里的"中秋"
//      根本不进关键词集合 → 这条通道连查都没查；
//   ② 检索窗口错：走 findBySeqPosRange(limit 200) 拉最新 200 条再内存 includes 过滤
//      → 会晤实体（实测徐诗雨 599 条）的早期记忆被挤出窗口。
//   实测铁证：search_index 中 term='中秋' AND belong_entity_uuid='TXS-000000007'
//      命中 5+ 条（第一条正文「中秋节快到了…」），索引 2178 个 memory 文档中 2096 带 UUID。
//
// 修复：查询词改由用户当前消息 buildNgrams 派生；检索改走 search_index 倒排
//      （term IN + belong_entity_uuid 白名单，GROUP BY source_id 按命中词数排序）。
//      索引不可用/零命中 → 回退原路径，不阻断其余五路召回。
//
// 样例为日常语境，不涉亲密内容。

const UUID = 'TXS-000000007';
const QUERY = '你还记得我们的中秋之约吗';

/** 早期记忆（9-05，seq_pos 小）—— 只有当检索走倒排索引时才可达 */
const OLD_LANDMARK = {
  id: 'mem_old_landmark', seq_pos: 12,
  raw_input: '中秋节快到了，我们的约定还算数吗', created_at: '2026-09-05T10:00:00.000Z',
  calcium_score: 6.2, calcium_level: 4, is_landmark: 1, locus_path: 'life.festival',
  memory_kind: 'dialog', memory_type: 'dialog', belong_entity_uuid: UUID,
};
const RECENT = Array.from({ length: 6 }, (_, i) => ({
  id: 'mem_recent_' + i, seq_pos: 900 + i,
  raw_input: '最近的一次闲聊 ' + i, created_at: '2026-09-12T06:0' + i + ':00.000Z',
  calcium_score: 0.4, calcium_level: 1, is_landmark: 0, locus_path: 'life.daily',
  memory_kind: 'dialog', memory_type: 'dialog', belong_entity_uuid: UUID,
}));

// B1 新增的可选入参 rawQuery —— 实现落地前先用交集类型断言驱动红测试，
// 避免「红测试引用了尚不存在的参数」把 S3 的 tsc 前置检查卡死。
// 实现落地后本断言即为真实签名的一部分，无需再改。
type RetrieveOptions = NonNullable<Parameters<MemoryRetriever['retrieveMemories']>[2]>;
type B1Options = RetrieveOptions & { rawQuery: string };

function mkStorage() {
  const calls: string[] = [];
  return {
    calls,
    findByLocus: async () => { calls.push('findByLocus'); return []; },
    // 回退路径：只返回"最新 N 条"，**不含**早期地标 —— 精确模拟旧实现的窗口瓶颈
    findBySeqPosRange: async (_a: any, _b: any, o: any) => {
      calls.push('findBySeqPosRange:' + (o?.limit ?? ''));
      return RECENT.slice(0, o?.limit ?? 200);
    },
    findByEmotionalSimilarity: () => { calls.push('findByEmotionalSimilarity'); return []; },
    getSQLite: () => ({
      queryAll: (sql: string, params: any[]) => {
        // 倒排索引路：记录查询词，供断言「查询词是否来自用户消息」
        if (/FROM search_index/.test(sql)) {
          calls.push('searchIndex:' + JSON.stringify(params.slice(0, -1)));
          return [{ source_id: 'mem_old_landmark', hit: 3 }];
        }
        // 回表取正文
        if (/FROM memories WHERE id IN/.test(sql)) {
          calls.push('memoryByIds');
          return [OLD_LANDMARK];
        }
        return [];
      },
    }),
    findByEntityUuid: (uuid: string, limit: number) => {
      calls.push('findByEntityUuid:' + limit);
      return [];
    },
  } as any;
}

describe('[m4] 关键词倒排召回：查询词来自用户消息，窗口不再受「最新 200 条」限制', () => {
  it('早期记忆经倒排索引可达（旧实现只扫最新 200 条 → 红）', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    const out = await r.retrieveMemories('life.daily', [], {
      entityUuids: [UUID], limit: 20, rawQuery: QUERY,
    } as B1Options);
    const ids = out.map((d: any) => d.branch_id);
    expect(ids).toContain('mem_old_landmark');
  });

  it('走的是 search_index 倒排（而非仅内存 includes 过滤）', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    await r.retrieveMemories('life.daily', [], {
      entityUuids: [UUID], limit: 20, rawQuery: QUERY,
    } as B1Options);
    expect(storage.calls.some((c: string) => c.startsWith('searchIndex:'))).toBe(true);
    expect(storage.calls).toContain('memoryByIds');
  });

  it('查询词由用户当前消息派生（含"中秋"），不再只取实体名', async () => {
    const storage = mkStorage();
    const r = new MemoryRetriever(storage);
    await r.retrieveMemories('life.daily', [], {
      entityUuids: [UUID], limit: 20, rawQuery: QUERY,
    } as B1Options);
    const termCall = storage.calls.find((c: string) => c.startsWith('searchIndex:'));
    expect(termCall).toBeTruthy();
    // buildNgrams("你还记得我们的中秋之约吗") 应含 2-gram「中秋」
    expect(termCall).toContain('中秋');
  });
});
