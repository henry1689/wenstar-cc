/**
 * 批13 部分2：EntityQualityJudge 单测
 *
 * 覆盖要点：
 *  1. prompt 构造包含全部待判名字 + 明确输出格式
 *  2. 响应解析容错（纯 JSON / 带代码块 / 解析失败 / 漏项 / 非法值收敛）
 *  3. 🔴 保守策略不变式：**本判定器永不产出「回收」动作**
 *  4. 批14 复用口径：annotate 即"人工清单"来源，而非自动 void 依据
 */
import { describe, it, expect } from 'vitest';
import {
  buildJudgePrompt,
  parseJudgeResponse,
  applyConservativePolicy,
  JUDGE_PROMOTE_MIN_CONFIDENCE,
  type JudgeItem,
} from '../EntityQualityJudge.js';

const ITEMS: JudgeItem[] = [
  { name: '张小龙', mentionCount: 5, contexts: ['张小龙说他要来'], relations: ['acquaintance_of'] },
  { name: '明伶俐', mentionCount: 1, contexts: ['你倒是聪明伶俐'] },
  { name: '谢想法', mentionCount: 1, contexts: ['谢谢你想法很周到'] },
];

describe('批13 · buildJudgePrompt', () => {
  it('包含全部待判名字与语境', () => {
    const p = buildJudgePrompt(ITEMS);
    for (const it of ITEMS) expect(p).toContain(it.name);
    expect(p).toContain('张小龙说他要来');
    expect(p).toContain('提及5次');
  });

  it('明确要求 JSON 数组且覆盖全部条目', () => {
    const p = buildJudgePrompt(ITEMS);
    expect(p).toContain('只输出 JSON 数组');
    expect(p).toContain('verdict');
    expect(p).toContain('必须覆盖全部 3 个名字');
  });

  it('语境条数与长度受控（防 prompt 膨胀）', () => {
    const p = buildJudgePrompt([
      { name: 'X', contexts: ['a'.repeat(500), 'b', 'c', 'd', 'e'] },
    ]);
    expect(p.length).toBeLessThan(1200); // 5 条被截到 3 条 + 单条 120 字
  });
});

describe('批13 · parseJudgeResponse 容错', () => {
  it('纯 JSON → 正常解析', () => {
    const raw = '[{"name":"张小龙","verdict":"person","confidence":0.95,"reason":"常见姓名"}]';
    const r = parseJudgeResponse(raw, ['张小龙']);
    expect(r[0].verdict).toBe('person');
    expect(r[0].confidence).toBe(0.95);
  });

  it('带 markdown 代码块 → 提取 JSON', () => {
    const raw = '```json\n[{"name":"明伶俐","verdict":"noise","confidence":0.9,"reason":"来自聪明伶俐"}]\n```';
    const r = parseJudgeResponse(raw, ['明伶俐']);
    expect(r[0].verdict).toBe('noise');
  });

  it('解析失败 → 全部 unknown（绝不猜测）', () => {
    const r = parseJudgeResponse('抱歉我无法判断', ITEMS.map((i) => i.name));
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.verdict === 'unknown')).toBe(true);
    expect(r.every((x) => x.confidence === 0)).toBe(true);
  });

  it('LLM 漏项 → 缺的补 unknown（不误判为 person）', () => {
    const raw = '[{"name":"张小龙","verdict":"person","confidence":0.9,"reason":"ok"}]';
    const r = parseJudgeResponse(raw, ['张小龙', '明伶俐', '谢想法']);
    expect(r).toHaveLength(3);
    expect(r.find((x) => x.name === '明伶俐')!.verdict).toBe('unknown');
  });

  it('非法 verdict / 越界 confidence → 收敛', () => {
    const raw = '[{"name":"A","verdict":"MAYBE","confidence":9,"reason":"x"},{"name":"B","verdict":"person","confidence":-3}]';
    const r = parseJudgeResponse(raw, ['A', 'B']);
    expect(r[0].verdict).toBe('unknown');
    expect(r[0].confidence).toBe(1);
    expect(r[1].confidence).toBe(0);
  });
});

describe('批13 · 保守策略（用户明确决策）', () => {
  it('person + 高置信 → 提升', () => {
    const o = applyConservativePolicy([
      { name: '张小龙', verdict: 'person', confidence: 0.9 },
    ]);
    expect(o.promote).toEqual(['张小龙']);
    expect(o.annotate).toEqual([]);
  });

  it('person + 低置信 → 继续观察（不提升）', () => {
    const o = applyConservativePolicy([
      { name: '张三', verdict: 'person', confidence: JUDGE_PROMOTE_MIN_CONFIDENCE - 0.01 },
    ]);
    expect(o.promote).toEqual([]);
    expect(o.keepObserving).toEqual(['张三']);
  });

  it('🔴 noise → 只标注（annotate），永久不会自动回收', () => {
    const o = applyConservativePolicy([
      { name: '明伶俐', verdict: 'noise', confidence: 0.99, reason: '滑窗片段' },
    ]);
    expect(o.annotate).toEqual([{ name: '明伶俐', confidence: 0.99, reason: '滑窗片段' }]);
    expect(o.promote).toEqual([]);
    // 不变式：ConservativeOutcome 结构里根本不存在 "reclaim/void" 字段
    expect(Object.keys(o).sort()).toEqual(['annotate', 'keepObserving', 'promote']);
  });

  it('🔴 高置信 noise 也不进 promote（保守边界）', () => {
    const o = applyConservativePolicy([
      { name: '谢想法', verdict: 'noise', confidence: 1 },
    ]);
    expect(o.promote).not.toContain('谢想法');
    expect(o.annotate.map((a) => a.name)).toContain('谢想法');
  });

  it('unknown → 继续观察', () => {
    const o = applyConservativePolicy([{ name: 'X', verdict: 'unknown', confidence: 0 }]);
    expect(o.keepObserving).toEqual(['X']);
  });

  it('混合输入 → 三类各自归位', () => {
    const o = applyConservativePolicy([
      { name: 'A', verdict: 'person', confidence: 0.9 },
      { name: 'B', verdict: 'noise', confidence: 0.8 },
      { name: 'C', verdict: 'unknown', confidence: 0 },
    ]);
    expect(o.promote).toEqual(['A']);
    expect(o.annotate.map((a) => a.name)).toEqual(['B']);
    expect(o.keepObserving).toEqual(['C']);
  });
});
