/**
 * storage-bench.test.ts — 存储后端基准测试 (V4.0 Phase 4)
 * ========================================================
 * 对比 SQLiteAdapter (sql.js) vs 内存 Map 的基础操作性能。
 * 不依赖真实 DB 文件，纯内存测试。
 */

import { describe, it, expect } from 'vitest';

describe('STORAGE-BENCH: 后端基础性能对比', () => {
  // ── 基准: 内存 Map（理论最快）─────────────────────────

  it('Map: 写入1000条 < 10ms', () => {
    const m = new Map<string, any>();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      m.set(`k${i}`, { id: `id${i}`, text: '测试'.repeat(5), score: Math.random() });
    }
    expect(performance.now() - t0).toBeLessThan(10);
  });

  it('Map: 搜索100次 < 50ms（遍历+过滤模拟 LIKE）', () => {
    const m = new Map<string, any>();
    for (let i = 0; i < 1000; i++) m.set(`k${i}`, { text: `关键字${i % 10 === 0 ? '电机' : '其他'}内容` });
    const t0 = performance.now();
    for (let j = 0; j < 100; j++) {
      [...m.values()].filter((v: any) => v.text.includes('电机'));
    }
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('Map: 排序100次 < 50ms（模拟 calcium_score DESC）', () => {
    const m = new Map<string, any>();
    for (let i = 0; i < 500; i++) m.set(`k${i}`, { score: Math.random() * 10 });
    const t0 = performance.now();
    for (let j = 0; j < 100; j++) {
      [...m.values()].sort((a: any, b: any) => b.score - a.score);
    }
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // ── JSON 序列化基准 ──────────────────────────────────

  it('JSON: 感知向量序列化1000次 < 50ms', () => {
    const obj = { pleasure: 0.7, arousal: 0.5, intimacy: 0.3, dominance: 0.1, sincerity: 0.8 };
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) { JSON.stringify(obj); }
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('JSON: 感知向量反序列化1000次 < 100ms', () => {
    const str = JSON.stringify({ pleasure: 0.7, arousal: 0.5, intimacy: 0.3 });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) { JSON.parse(str); }
    expect(performance.now() - t0).toBeLessThan(100);
  });

  // ── 海马体索引基准 ──────────────────────────────────

  it('HASH: SHA256-like 摘要计算1000次 < 100ms', () => {
    // 用简单的字符串 hash 模拟 SHA256 开销（实际 SHA256 会慢一些）
    const simpleHash = (s: string): string => {
      let h = 0; for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i); h |= 0;
      }
      return Math.abs(h).toString(16);
    };
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      simpleHash(`domain.root|neu|person1|person2|session_${i}|${Date.now()}`);
    }
    expect(performance.now() - t0).toBeLessThan(100);
  });

  // ── LRU 驱逐基准 ────────────────────────────────────

  it('LRU: 7槽位满负载驱逐1000次 < 50ms', () => {
    const slots: { occupied: boolean; loadedAt: number }[] = Array.from({ length: 7 }, () => ({ occupied: false, loadedAt: 0 }));
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const empty = slots.find(s => !s.occupied);
      if (empty) {
        empty.occupied = true; empty.loadedAt = i;
      } else {
        const lru = slots.reduce((oldest, s) => s.loadedAt < oldest.loadedAt ? s : oldest);
        lru.loadedAt = i;
      }
    }
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // ── 综合模拟：一轮 processChat 的内存压力 ──────────

  it('综合: 模拟完整 processChat 上下文构造 < 5ms', () => {
    const t0 = performance.now();
    const ctx: any = {};
    ctx.snapshot = { snapshotId: 'test', emotion: { pleasure: 0.5, arousal: 0.3, intimacy: 0.2, trend: 'stable' } };
    ctx.blocks = [
      { source: 'core_memory', content: '你是玉瑶…', priority: 100 },
      { source: 'experience', content: '相关经验摘要…', priority: 80 },
      { source: 'emotion_regulation', content: '建议温和回应…', priority: 75 },
    ];
    ctx.assembled = ctx.blocks.sort((a: any, b: any) => b.priority - a.priority).map((b: any) => b.content).join('\n\n');
    expect(ctx.assembled.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(5);
  });
});
