/**
 * 批13 部分2: EntityTriageService 单测（mock LLM，不触网）
 *
 * 覆盖：
 *  1. 无候选 → 完全跳过（零 LLM 调用）
 *  2. LLM 失败 → 不改任何数据（宁可不动，不可误动）
 *  3. 正常路径 → 提升 person / 标注 noise / 观察 unknown
 *  4. 🔴 保守边界：noise 永不进入 promote
 *  5. 防重入
 *  6. 解析失败 → 全部 keepObserving，不提升
 */
import { describe, it, expect, vi } from 'vitest';
import { EntityTriageService } from '../EntityTriageService.js';
import type { JudgeItem } from '../EntityQualityJudge.js';

function makeFg(items: JudgeItem[]) {
  const promoted: string[] = [];
  const annotated: string[] = [];
  return {
    fg: {
      collectCandidateItems: (_limit?: number) => items,
      applyJudgments: (o: any) => {
        promoted.push(...(o.promote || []));
        annotated.push(...(o.annotate || []).map((x: any) => x.name));
        return { promoted: (o.promote || []).length, annotated: (o.annotate || []).length };
      },
    },
    promoted,
    annotated,
  };
}

const ITEMS: JudgeItem[] = [
  { name: '张小龙', mentionCount: 5, contexts: ['张小龙说他明天来'] },
  { name: '明伶俐', mentionCount: 1, contexts: ['你倒是聪明伶俐'] },
  { name: '谢想法', mentionCount: 1, contexts: ['谢谢你想法不错'] },
];

describe('批13 · EntityTriageService 编排', () => {
  it('无候选 → 跳过且不调用 LLM（零成本）', async () => {
    const { fg } = makeFg([]);
    const rawCall = vi.fn();
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: rawCall as any });
    const r = await svc.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.scanned).toBe(0);
    expect(rawCall).not.toHaveBeenCalled();
  });

  it('LLM 抛错 → 不改任何数据（宁可不动）', async () => {
    const { fg, promoted, annotated } = makeFg(ITEMS);
    const rawCall = vi.fn().mockRejectedValue(new Error('network down'));
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: rawCall as any });
    const r = await svc.runOnce();
    expect(r.error).toContain('LLM 调用失败');
    expect(promoted).toEqual([]);
    expect(annotated).toEqual([]);
    expect(r.kept).toBe(ITEMS.length);
  });

  it('正常路径 → person 提升 / noise 标注 / unknown 观察', async () => {
    const { fg, promoted, annotated } = makeFg(ITEMS);
    const llmReply = JSON.stringify([
      { name: '张小龙', verdict: 'person', confidence: 0.95, reason: '常见姓名' },
      { name: '明伶俐', verdict: 'noise', confidence: 0.9, reason: '来自聪明伶俐' },
      { name: '谢想法', verdict: 'unknown', confidence: 0.2 },
    ]);
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: vi.fn().mockResolvedValue(llmReply) as any });
    const r = await svc.runOnce();
    expect(r.promoted).toBe(1);
    expect(r.annotated).toBe(1);
    expect(r.kept).toBe(1);
    expect(promoted).toEqual(['张小龙']);
    expect(annotated).toEqual(['明伶俐']);   // 只标注，不是回收
  });

  it('🔴 保守边界：高置信 noise 也绝不进入 promote', async () => {
    const { fg, promoted } = makeFg([{ name: '麻批睡' }]);
    const llmReply = JSON.stringify([{ name: '麻批睡', verdict: 'noise', confidence: 1, reason: '碎片' }]);
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: vi.fn().mockResolvedValue(llmReply) as any });
    await svc.runOnce();
    expect(promoted).toEqual([]);
  });

  it('解析失败 → 全部观察，零提升', async () => {
    const { fg, promoted, annotated } = makeFg(ITEMS);
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: vi.fn().mockResolvedValue('我无法判断') as any });
    const r = await svc.runOnce();
    expect(promoted).toEqual([]);
    expect(annotated).toEqual([]);
    expect(r.kept).toBe(ITEMS.length);
  });

  it('低置信 person → 不提升（继续观察）', async () => {
    const { fg, promoted } = makeFg([{ name: '张三' }]);
    const llmReply = JSON.stringify([{ name: '张三', verdict: 'person', confidence: 0.5 }]);
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: vi.fn().mockResolvedValue(llmReply) as any });
    const r = await svc.runOnce();
    expect(promoted).toEqual([]);
    expect(r.kept).toBe(1);
  });

  it('防重入：并发调用时第二次直接跳过', async () => {
    const { fg } = makeFg(ITEMS);
    let release: (v: string) => void = () => {};
    const rawCall = vi.fn().mockImplementation(() => new Promise<string>((res) => { release = res; }));
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: rawCall as any });
    const p1 = svc.runOnce();
    const r2 = await svc.runOnce();       // 第二次应被拒绝
    expect(r2.skipped).toBe(true);
    expect(r2.error).toContain('进行中');
    release(JSON.stringify([]));
    await p1;
  });

  it('阈值对外可见（保守策略的公开口径）', () => {
    const { fg } = makeFg([]);
    const svc = new EntityTriageService({ familyGraph: fg as any, rawCall: vi.fn() as any });
    expect(svc.promoteThreshold).toBeGreaterThanOrEqual(0.7);
  });
});
