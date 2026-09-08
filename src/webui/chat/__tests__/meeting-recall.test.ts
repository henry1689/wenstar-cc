import { describe, it, expect } from 'vitest';
import {
  RECALL_TRIGGER_RE,
  extractTopicKeywords,
  keywordRecallMemories,
  recentCalciumRows,
  recallOriginalConversations,
  dedupeRowsById,
} from '../../../m4/retrieval/meeting-recall.js';
import type { RecallSource } from '../../../m4/retrieval/meeting-recall.js';

/**
 * 会晤记忆召回修复单测（2026-09-09 徐诗雨续聊失忆场景回归）
 * 场景: 用户与徐诗雨 4:38-6:10 深聊"诗韵的事"(含《蒹葭》引诗/寒假约定),
 *      17:03 续聊"诗雨，还是徐诗韵的事" → 旧实现接不上。
 * 验证: ① 续聊引导触发 RECALL_TRIGGER_RE（原触发词不含"还是X的事"）;
 *       ② 关键词抽取命中"诗韵"（非停用词、排除全名人名后保留 2 字称呼）;
 *       ③ 内容相关召回能捞回低钙化关键记忆（旧实现纯钙化 TOP8 捞不到）;
 *       ④ 压缩原文取回不过滤 is_compacted（旧 EntityContextStore.searchEntityContext 对压缩归档不可见）。
 * 测试样例全部用成人语境安全句,不涉及任何未成年内容。
 */

/** 内存 mock queryAll 源: 按 SQL 特征路由返回预设行 */
function mkSource(rows: Array<{ kind: 'calcium' | 'keyword' | 'original' | 'hist'; data: any[] }>): RecallSource {
  return {
    queryAll<T = unknown>(sql: string, _params?: unknown[]): T {
      const rec = rows.find((r) =>
        r.kind === 'calcium' ? sql.includes("julianday('now') - julianday(created_at) < 1") :
        r.kind === 'hist' ? sql.includes("julianday('now') - julianday(created_at) >= 1") :
        r.kind === 'keyword' ? sql.includes('raw_input LIKE ?') :
        r.kind === 'original' ? sql.includes('FROM conversations') : false,
      );
      return (rec ? rec.data : []) as T;
    },
  };
}

const lowCalciumPoem = {
  id: 'mem_mts9msdz_oz4xka',
  raw_input: '鸿艺……蒹葭苍苍，白露为霜，所谓伊人，在水一方。诗雨知道你心里念着谁了。诗韵那丫头还在里屋呢。',
  calcium_score: 0.7,
  effective_strength: 0.996,
  created_at: '2026-09-08T06:05:30.000Z',
};
const highCalciumAnchor = {
  id: '00020720260908124546M01EMOP_DG_1226_ANCHOR',
  raw_input: '【核心·徐诗雨】鸿艺：不过爱情这个东西谁也控制不住啊……',
  calcium_score: 2.05,
  effective_strength: 0.975,
  created_at: '2026-09-08T04:45:57.000Z',
};

describe('RECALL_TRIGGER_RE — 续聊引导触发', () => {
  it('旧触发词(记得/聊过/上次)仍触发', () => {
    expect(RECALL_TRIGGER_RE.test('我们上次聊到哪里了')).toBe(true);
    expect(RECALL_TRIGGER_RE.test('还记得我们说好的事吗')).toBe(true);
  });

  it('🔴 续聊引导"还是X的事"触发（失忆场景主因，旧正则不触发）', () => {
    expect(RECALL_TRIGGER_RE.test('诗雨，还是徐诗韵的事')).toBe(true);
  });

  it('"继续说/接着"类续聊引导触发', () => {
    expect(RECALL_TRIGGER_RE.test('继续说诗韵的事')).toBe(true);
    expect(RECALL_TRIGGER_RE.test('接着刚才聊的')).toBe(true);
  });
});

describe('extractTopicKeywords — 关键词抽取', () => {
  it('🔴 "诗雨，还是徐诗韵的事" 抽出"诗韵"（排除全名徐诗韵与停用词后保留 2 字称呼）', () => {
    const kw = extractTopicKeywords('诗雨，还是徐诗韵的事', ['徐诗雨', '玉瑶', '徐诗韵'], 4);
    expect(kw).toContain('诗韵');
    expect(kw).not.toContain('的事');
    expect(kw).not.toContain('还是');
  });

  it('停用词过滤：纯寒暄不产生有效关键词', () => {
    const kw = extractTopicKeywords('你好呀，今天天气真好', ['玉瑶']);
    expect(kw.every((k) => k.length >= 2)).toBe(true);
    expect(kw).not.toContain('今天');
  });
});

describe('keywordRecallMemories — 内容相关召回', () => {
  it('🔴 关键词"诗韵"捞回低钙化《蒹葭》记忆（旧钙化 TOP8 只给高钙 ANCHOR）', () => {
    const src = mkSource([{ kind: 'keyword', data: [lowCalciumPoem] }]);
    const rows = keywordRecallMemories(src, 'TXS-000000007', ['诗韵'], 4);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('mem_mts9msdz_oz4xka');
    expect(rows[0].raw_input).toContain('蒹葭苍苍');
  });

  it('关键词召回限流去重（同 id 不重复）', () => {
    const src = mkSource([{ kind: 'keyword', data: [lowCalciumPoem, lowCalciumPoem] }]);
    const rows = keywordRecallMemories(src, 'TXS-000000007', ['诗韵'], 4);
    expect(rows.length).toBe(1);
  });

  it('🔴 多关键词广度遍历：前序宽泛词命中不饿死后序关键词（诗雨→诗韵都能查）', () => {
    // mock: 记录每次查询参数，按 LIKE 词返回对应行
    const calls: string[] = [];
    const src: RecallSource = {
      queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
        const kw = String((params?.[1] ?? '') as string).replace(/%/g, '');
        calls.push(kw);
        if (kw === '诗韵') return [lowCalciumPoem] as T[];
        if (kw === '诗雨') return [highCalciumAnchor] as T[];
        return [] as T[];
      },
    };
    const rows = keywordRecallMemories(src, 'TXS-000000007', ['诗雨', '诗韵'], 4);
    expect(calls).toContain('诗韵');      // 诗韵关键词确实被查询（未被 limit 饿死）
    expect(rows.some((r) => r.id === lowCalciumPoem.id)).toBe(true);  // 蒹葭记忆被召回
  });

  it('无关键词 → 空结果（安全降级到纯钙化保底）', () => {
    const src = mkSource([{ kind: 'keyword', data: [] }]);
    expect(keywordRecallMemories(src, 'U', [], 4)).toEqual([]);
  });
});

describe('recallOriginalConversations — 压缩原文取回', () => {
  const conv = {
    role: 'assistant',
    content: '鸿艺……蒹葭苍苍，白露为霜。诗雨知道你心里念着谁了。诗韵那丫头放寒假肯定要回来的。',
    timestamp: '2026-09-08T06:05:30.000Z',
  };

  it('🔴 从 conversations 原文取回（SQL 不带 is_compacted 过滤 → 压缩归档原文可见）', () => {
    // 捕获实际 SQL 验证不含 is_compacted 条件
    let capturedSql = '';
    const src: RecallSource = {
      queryAll<T = unknown>(sql: string): T {
        capturedSql = sql;
        return [{ ...conv }] as T;
      },
    };
    const hits = recallOriginalConversations(src, 'TXS-000000007', ['诗韵'], 2, 400);
    expect(capturedSql).not.toContain('is_compacted');
    expect(capturedSql).toContain('FROM conversations');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('蒹葭苍苍');
    expect(hits[0].content.length).toBeLessThanOrEqual(400);
  });

  it('截断上限 400 字生效', () => {
    const long = { ...conv, content: '长'.repeat(800) };
    const src = mkSource([{ kind: 'original', data: [long] }]);
    const hits = recallOriginalConversations(src, 'U', ['诗韵'], 2, 400);
    expect(hits[0].content.length).toBe(400);
  });
});

describe('钙化槽 + 去重', () => {
  it('近期槽取钙化序（高钙 ANCHOR 保底仍在，仅排序不再独占）', () => {
    const src = mkSource([{ kind: 'calcium', data: [highCalciumAnchor, lowCalciumPoem] }]);
    const rows = recentCalciumRows(src, 'TXS-000000007', 8);
    expect(rows.length).toBe(2);
    expect(rows[0].calcium_score).toBeGreaterThan(rows[1].calcium_score);
  });

  it('dedupeRowsById 关键词在前合并时不重复', () => {
    const merged = dedupeRowsById([lowCalciumPoem, highCalciumAnchor, lowCalciumPoem]);
    expect(merged.length).toBe(2);
    expect(merged[0].id).toBe('mem_mts9msdz_oz4xka');
  });
});
