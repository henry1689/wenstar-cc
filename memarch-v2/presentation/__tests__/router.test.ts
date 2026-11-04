import { describe, it, expect } from 'vitest';
import { route, computePA } from '../router.js';
import { DEFAULT_CONFIG } from '../config.js';
import { ev } from './helpers.js';

const cfg = DEFAULT_CONFIG.router;

describe('router.ts — 概率分发器', () => {
  it('单条强 A-side 证据 → p_A 高，走 A_direct', () => {
    const decision = route({
      evidences: [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡', score: 0.9, pathway: 'A' })],
      config: cfg,
    });
    expect(decision.p_A).toBeGreaterThanOrEqual(cfg.p_A_high);
    expect(decision.routed_path).toBe('A_direct');
    expect(decision.a_side).toHaveLength(1);
    expect(decision.b_side).toHaveLength(0);
  });

  it('单条弱证据（score=0.2）→ p_A 低，走 B_only', () => {
    const decision = route({
      evidences: [ev({ uuid: 'u1', raw_text: '某条弱关联', score: 0.2, pathway: 'A' })],
      config: cfg,
    });
    expect(decision.p_A).toBeLessThan(cfg.p_A_low);
    expect(decision.routed_path).toBe('B_only');
  });

  it('中等证据 → hybrid', () => {
    // score=0.5 → p_A=0.5，落在 [0.3, 0.7)
    const decision = route({
      evidences: [ev({ uuid: 'u1', raw_text: '中等证据', score: 0.5, pathway: 'A' })],
      config: cfg,
    });
    expect(decision.p_A).toBeCloseTo(0.5, 2);
    expect(decision.routed_path).toBe('hybrid');
  });

  it('tombstone=true 的证据被丢弃，不进任何 side', () => {
    const decision = route({
      evidences: [
        ev({ uuid: 'tomb1', raw_text: '已删除', score: 0.9, tombstone: true }),
        ev({ uuid: 'a1', raw_text: '正常', score: 0.8 }),
      ],
      config: cfg,
    });
    expect(decision.dropped_tombstones).toContain('tomb1');
    expect(decision.a_side.map((e) => e.uuid)).toEqual(['a1']);
    expect(decision.b_side).toHaveLength(0);
  });

  it('suppressed=true 强制压到 B-side，不进 A-side（硬规则）', () => {
    const decision = route({
      evidences: [
        ev({ uuid: 's1', raw_text: '敏感内容', score: 0.9, suppressed: true }),
        ev({ uuid: 'a1', raw_text: '正常', score: 0.8 }),
      ],
      config: cfg,
    });
    expect(decision.a_side.map((e) => e.uuid)).toEqual(['a1']);
    expect(decision.b_side.map((e) => e.uuid)).toContain('s1');
    // suppressed 不得混入 A
    expect(decision.a_side.every((e) => !e.suppressed)).toBe(true);
  });

  it('pathway=B 的证据进 B-side', () => {
    const decision = route({
      evidences: [ev({ uuid: 'b1', raw_text: '弱通路', score: 0.8, pathway: 'B' })],
      config: cfg,
    });
    expect(decision.a_side).toHaveLength(0);
    expect(decision.b_side.map((e) => e.uuid)).toEqual(['b1']);
    expect(decision.p_A).toBe(0);
    expect(decision.routed_path).toBe('B_only');
  });

  it('空证据 → p_A=0，B_only', () => {
    const decision = route({ evidences: [], config: cfg });
    expect(decision.p_A).toBe(0);
    expect(decision.routed_path).toBe('B_only');
  });

  it('computePA：score² 加权——单条强证据主导，多条弱证据堆不出高 p_A', () => {
    // 单条 score=0.9 → p_A=0.9
    expect(computePA([{ score: 0.9 } as any])).toBeCloseTo(0.9, 2);
    // 多条 score=0.3 → p_A 仍是 0.3（平均），不会被堆高
    expect(computePA([{ score: 0.3 } as any, { score: 0.3 } as any, { score: 0.3 } as any])).toBeCloseTo(0.3, 2);
    // 一条 0.9 + 一条 0.2 → 加权后偏向 0.9
    const p = computePA([{ score: 0.9 } as any, { score: 0.2 } as any]);
    expect(p).toBeGreaterThan(0.7);
    expect(p).toBeLessThan(0.9);
  });
});
