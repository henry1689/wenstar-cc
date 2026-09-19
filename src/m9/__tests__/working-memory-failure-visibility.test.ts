/**
 * 批处理路径的「失败可见性」能力断言（批次 B）
 *
 * 事故背景：`consolidate()` 抛错会一路冒到 `setInterval` 的 async 回调 →
 * 变成 `unhandledRejection`（当时是 `UNIQUE constraint failed: memories.seq_pos`）；
 * 而 `push()` 里的 `.catch(() => {})` 又把失败**静默吞掉** ⇒ 失败既不可见也不可控。
 *
 * 本文件要证明的三个能力（都不看计数/行号）：
 * 1. **不产生未捕获拒绝**：write 抛错时，定时器路径与手动路径都不触发 `unhandledRejection`；
 * 2. **失败可见**：失败被 `console.error` 明确打印（含累计次数），并被 `getStatus()` 计数暴露；
 * 3. **不丢数据**：失败的条目仍留在 buffer（下一轮重试），不被静默清空。
 */
import { describe, it, expect, vi } from 'vitest';

import { MemoryWriteBuffer } from '../WorkingMemory.js';

/** 造一条"必定毕业"的缓冲条目（calciumScore≥阈值 + 有实体 ⇒ shouldGraduate='full'） */
function fullEntry(seqPos: number): any {
  return {
    dna: { seq_pos: seqPos, raw_input: '测试输入', entity_genes: [{ type: 'person', name: '测试' }] },
    perception: {},
    calciumScore: 0.9,
    calciumLevel: 3,
    seqPos,
    cycleCount: 0,
    hasMeaningfulEntity: true,
    createdAt: Date.now(),
  };
}

/** 存储桩：write 永远抛错（模拟写冲突/磁盘问题） */
function failingStorage(message = 'UNIQUE constraint failed: memories.seq_pos') {
  return {
    write: async () => {
      throw new Error(message);
    },
    reserveNextSeq: () => 1,
  } as any;
}

describe('M9 WorkingMemory · 巩固失败必须可见且不丢数据', () => {
  it('手动路径：write 抛错 ⇒ consolidateSafe 不 reject（不会 unhandledRejection）+ 打印 + 计数', async () => {
    const wm = new MemoryWriteBuffer(failingStorage(), 5) as any;
    wm.buffer.push(fullEntry(1));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 关键：必须 resolve（原先无 catch 会 reject）
      await expect(wm.consolidateSafe()).resolves.toBeUndefined();
      expect(errSpy, '失败必须打印（可见）').toHaveBeenCalled();
      const msg = String(errSpy.mock.calls.map((c) => c.join(' ')).join(' | '));
      expect(msg, '打印内容应含失败原因').toContain('UNIQUE constraint failed');
      expect(msg, '打印内容应含累计次数').toContain('累计 1 次');

      const st = wm.getStatus();
      expect(st.consolidateFailures, '累计失败计数应暴露').toBe(1);
      expect(st.consecutiveConsolidateFailures, '连续失败计数应暴露').toBe(1);
      expect(st.size, '失败条目必须留在缓冲（不丢数据）').toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('定时器路径：write 抛错 ⇒ 不产生 unhandledRejection', async () => {
    const wm = new MemoryWriteBuffer(failingStorage(), 1) as any;
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandled);
    try {
      wm.buffer.push(fullEntry(2));
      wm.startFlushTimer(5);
      await new Promise((r) => setTimeout(r, 120));
      wm.stopFlushTimer();
      await new Promise((r) => setTimeout(r, 30));
      expect(seen, `不应有未捕获拒绝，实际: ${seen.map(String).join(',')}`).toEqual([]);
      expect(wm.getStatus().consolidateFailures, '定时器轮的失败也要计数').toBeGreaterThan(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errSpy.mockRestore();
    }
  });

  it('恢复能力：失败后换可用存储 ⇒ 计数清零且条目毕业（缓冲不卡死）', async () => {
    const okStorage = { write: async () => ({ success: true, real_ref: 'r', seq_pos: 1 }), reserveNextSeq: () => 1 } as any;
    const wm = new MemoryWriteBuffer(failingStorage(), 5) as any;
    wm.buffer.push(fullEntry(3));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await wm.consolidateSafe();
      expect(wm.getStatus().consolidateFailures).toBe(1);
      wm.storage = okStorage; // 注入可用存储（模拟冲突消失）
      await wm.consolidateSafe();
      expect(wm.getStatus().consecutiveConsolidateFailures, '成功后连续计数应清零').toBe(0);
      expect(wm.getStatus().size, '成功后条目应已毕业离开缓冲').toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
