import { describe, it, expect, vi } from 'vitest';
import {
  classifyFragmentTier,
  dedupeCandidates,
  applyTierFloors,
  applyGate,
  runRecallBus,
  applyRecallFeedback,
  type RecallCandidate,
  type RecallBusModeBudget,
} from '../recall-bus.js';

const NOW = Date.parse('2026-11-09T00:00:00.000Z');

function cand(over: Partial<RecallCandidate> & { text: string }): RecallCandidate {
  return {
    tier: 'sand',
    score: 0.5,
    createdAt: '2026-11-08T00:00:00.000Z',
    calciumScore: 1,
    effectiveStrength: 1,
    ...over,
  };
}

describe('RecallBus · 标签分层', () => {
  it('按注入标签归类，知识库档案优先判 long_text', () => {
    expect(classifyFragmentTier('【金库记忆】他说过会回来')).toBe('gold');
    expect(classifyFragmentTier('【珍藏记忆】那年夏天')).toBe('diamond');
    expect(classifyFragmentTier('💎 黑钻里的往事')).toBe('diamond');
    expect(classifyFragmentTier('【对话组·2026-10-01】摘要')).toBe('group');
    expect(classifyFragmentTier('📖 某篇知识')).toBe('knowledge');
    expect(classifyFragmentTier('【知识库档案】原文')).toBe('long_text');
    expect(classifyFragmentTier('【对话原文·权威记录】原文')).toBe('long_text');
    expect(classifyFragmentTier('【作品】长篇小说')).toBe('work');
    expect(classifyFragmentTier('📌 一条重要记忆')).toBe('sand');
    expect(classifyFragmentTier('没有标签的普通片段')).toBe('sand');
  });

  it('批4：指令类片段归 other，不占三层名额', () => {
    expect(classifyFragmentTier('【深度回忆素材包 · MemSym】以下是全部记忆仓…')).toBe('other');
    expect(classifyFragmentTier('【结晶表达 · 宪法信条0】照三重奏说…')).toBe('other');
    expect(classifyFragmentTier('【回忆表达三档 · MemSym】关于过去的记忆…')).toBe('other');
    expect(classifyFragmentTier('【默契元素 · MemSym】以下是沉淀元素…')).toBe('other');
    expect(classifyFragmentTier('【主动回忆 · MemSym】本轮检测到主动回忆信号…')).toBe('other');
  });
});

describe('RecallBus · 归一化去重', () => {
  it('去标签/括号/后缀后同文只留分更高者；空文本丢弃', () => {
    const out = dedupeCandidates([
      cand({ text: '【回忆】她说想去看海（笑着）——旧后缀', score: 0.4 }),
      cand({ text: '她说想去看海', score: 0.8 }),
      cand({ text: '   ', score: 0.9 }),
    ], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0.8);
  });
});

describe('RecallBus · 层保底', () => {
  const budget: RecallBusModeBudget = { total: 5, sand: 1, gold: 1, diamond: 1, group: 1 };

  it('每层至少 1 条，剩余名额按分补足', () => {
    const out = applyTierFloors([
      cand({ text: 'sand-1', tier: 'sand', score: 0.9 }),
      cand({ text: 'sand-2', tier: 'sand', score: 0.8 }),
      cand({ text: 'gold-1', tier: 'gold', score: 0.1 }),
      cand({ text: 'diamond-1', tier: 'diamond', score: 0.1 }),
      cand({ text: 'group-1', tier: 'group', score: 0.1 }),
      cand({ text: 'knowledge-1', tier: 'knowledge', score: 0.7 }),
    ], budget, NOW);
    expect(out.selected).toHaveLength(5);
    const tiers = out.selected.map(c => c.tier);
    for (const t of ['sand', 'gold', 'diamond', 'group'] as const) {
      expect(tiers, `缺层 ${t}`).toContain(t);
    }
    expect(out.shortfalls).toEqual({});
  });

  it('某层候选不足时如实记录 shortfalls，不静默', () => {
    const out = applyTierFloors([
      cand({ text: 'sand-1', tier: 'sand' }),
      cand({ text: 'sand-2', tier: 'sand' }),
    ], budget, NOW);
    expect(out.shortfalls.gold).toBe(1);
    expect(out.shortfalls.diamond).toBe(1);
    expect(out.shortfalls.group).toBe(1);
    expect(out.selected.length).toBe(2);
  });
});

describe('RecallBus · 五级闸门降权参与排序', () => {
  it('G4 被动闲聊降权非地标；地标按 effective_strength 排前', () => {
    const out = applyGate([
      cand({ text: '普通碎片', tier: 'sand', effectiveStrength: 1, isLandmark: false, score: 0.9 }),
      cand({ text: '地标记忆', tier: 'sand', effectiveStrength: 0.9, isLandmark: true, score: 0.5 }),
    ], { query: '今天天气怎么样' });
    expect(out.gate).not.toBeNull();
    expect(out.passed[0].text).toBe('地标记忆');
  });

  it('空候选不抛，返回空', () => {
    const out = applyGate([], { query: 'test' });
    expect(out.passed).toEqual([]);
    expect(out.gate).toBeNull();
  });
});

describe('RecallBus · 单入口', () => {
  it('casual 模式去重后按层保底返回；空输入不抛', () => {
    const out = runRecallBus({
      mode: 'casual',
      query: '在干嘛',
      nowMs: NOW,
      candidates: [
        cand({ text: '【金库记忆】承诺', tier: 'gold', score: 0.2 }),
        cand({ text: '【珍藏记忆】往事', tier: 'diamond', score: 0.2 }),
        cand({ text: '📌 砂金', tier: 'sand', score: 0.9 }),
        cand({ text: '【对话组·10-01】组摘要', tier: 'group', score: 0.1 }),
      ],
    });
    expect(out.selected.length).toBeLessThanOrEqual(8);
    const tiers = out.selected.map(c => c.tier);
    for (const t of ['sand', 'gold', 'diamond', 'group'] as const) {
      expect(tiers, `缺层 ${t}`).toContain(t);
    }
    expect(() => runRecallBus({ mode: 'standard', query: 'x', candidates: [] })).not.toThrow();
  });
});

describe('RecallBus · 召回反馈单点', () => {
  it('按白名单表回写 recall_count，同轮同 id 只记一次', () => {
    const writeRaw = vi.fn();
    const n = applyRecallFeedback({ writeRaw }, [
      { table: 'memories', id: 'm1' },
      { table: 'memories', id: 'm1' },
      { table: 'black_diamond', id: 'b1' },
      { table: 'knowledge_base', id: 'k1' },
    ]);
    expect(n).toBe(3);
    expect(writeRaw).toHaveBeenCalledTimes(3);
    const sqls = writeRaw.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('UPDATE memories'))).toBe(true);
    expect(sqls.some(s => s.includes('UPDATE black_diamond'))).toBe(true);
    expect(sqls.some(s => s.includes('UPDATE knowledge_base'))).toBe(true);
  });

  it('非法表名在运行时被拒绝；无 sqlite 返回 0', () => {
    const writeRaw = vi.fn();
    const n = applyRecallFeedback({ writeRaw }, [
      { table: 'users' as any, id: 'x' },
    ]);
    expect(n).toBe(0);
    expect(writeRaw).not.toHaveBeenCalled();
    expect(applyRecallFeedback(null, [{ table: 'memories', id: 'm1' }])).toBe(0);
  });
});
