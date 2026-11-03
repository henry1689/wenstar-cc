/**
 * 🔴 检索 v11 §S2-B6 · 五级闸门 fail-closed 专项
 * ==============================================
 * 任务书原文判据：**人为让闸门加载失败 → 必须返回空结果，且 `gate_failclosed_total` +1**。
 *
 * 【为什么这是安全边界】五级闸门 G2–G5 是「不可绕过」的最后一道（白皮书 §4.1.1）。
 * 改造前两处挂载点是 **fail-open**：闸门加载失败只 `console.warn` 然后继续，
 * 使「不可绕过」恰好在异常路径上被绕过 —— 正是最坏的失败模式。
 * 蓝皮书 §5.3 业主裁决 2026-10-27（方案 A）改为 fail-closed。
 *
 * 【覆盖】
 *   1. 动态：注入「闸门加载失败」→ 返回 `[]`，计数 +1
 *   2. 动态：回退开关未闭合时 → fail-open 放行（紧急通道，任务书 §S2 D6 要求可独立回滚）
 *   3. 动态：闸门正常 → 正常过滤且计数不变（证明不是「只要调用就 +1」）
 *   4. 动态：闸门正常但一条都不放行 → 返回空且**不**计为 fail-closed（空结果 ≠ 安全失败）
 *   5. 结构守卫：三个挂载点**都**必须 fail-closed，防止日后改回 fail-open
 *
 * 🔴 红线（任务书 §S2 D3/D6）：闸门不可关、不可跳、不可调阈值。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRetriever } from '../MemoryRetriever.js';
import { resetForTest, snapshot } from '../retrieval/ShadowLog.js';
import type { DNA } from '../../m1/types/dna.js';

/**
 * 🔴 Flags.ts **没有**导出单个开关常量（只有 `V11_FLAG_NAMES` 数组），
 *    这里必须用字面量 —— 别为了省一个字符串去改生产导出。
 */
const GATE_FAILCLOSED_ENV = 'RETRIEVAL_V11_GATE_FAILCLOSED';

// ══════════════════════════════════════════════════════════════════
// 闸门桩：按开关模拟「加载失败」或「全通过」
// ══════════════════════════════════════════════════════════════════
const stub = vi.hoisted(() => ({
  /** true = getFiveStageGate() 抛错（模拟闸门加载失败） */
  failLoad: false,
  /** 闸门 filter 被调用次数 */
  filterCalls: 0,
}));

vi.mock('../../m3/FiveStageGate.js', () => ({
  getFiveStageGate: vi.fn(() => {
    if (stub.failLoad) throw new Error('五级闸门加载失败（S2-B6 人为注入）');
    return {
      filter: (cands: unknown[]) => {
        stub.filterCalls += 1;
        return { passed: cands, stageStats: {} };
      },
    };
  }),
}));

// ══════════════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════════════

/** 极简候选：`_v11ApplyGate` 只读这些字段 */
function dna(id: string): DNA {
  return {
    branch_id: id,
    raw_input: `记忆 ${id}`,
    locus_path: 'test',
    leaf_zone: 'assistant',
  } as unknown as DNA;
}

let retriever: MemoryRetriever;
const savedEnv = process.env[GATE_FAILCLOSED_ENV];

function counter(): number {
  return Number(snapshot()['gate_failclosed_total'] ?? 0);
}

beforeEach(async () => {
  // storage 不参与闸门层，传空壳即可（本文件只测闸门挂载这一层）
  retriever = new MemoryRetriever({} as never);
  stub.failLoad = false;
  stub.filterCalls = 0;
  resetForTest();
  // 把桩复位成默认实现（前一个用例可能 mockImplementationOnce 过）
  const mod = await import('../../m3/FiveStageGate.js');
  vi.mocked(mod.getFiveStageGate).mockImplementation(() => {
    if (stub.failLoad) throw new Error('五级闸门加载失败（S2-B6 人为注入）');
    return {
      filter: (cands: unknown[]) => {
        stub.filterCalls += 1;
        return { passed: cands, stageStats: {} };
      },
    } as never;
  });
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[GATE_FAILCLOSED_ENV];
  else process.env[GATE_FAILCLOSED_ENV] = savedEnv;
});

/** 走生产实现的私有挂载点（v11 出口与旧链主出口共用同一实现） */
function applyGate(dnas: DNA[]): Promise<DNA[]> {
  return (retriever as unknown as {
    _v11ApplyGate(d: DNA[], locus: string, fp: string): Promise<DNA[]>;
  })._v11ApplyGate(dnas, 'test', '');
}

describe('S2-B6 · 闸门加载失败必须 fail-closed', () => {
  it('🔴 闸门加载失败 ⇒ 返回**空结果**，且 gate_failclosed_total +1', async () => {
    process.env[GATE_FAILCLOSED_ENV] = 'true';
    stub.failLoad = true;
    const before = counter();

    const out = await applyGate([dna('a'), dna('b'), dna('c')]);

    expect(out).toEqual([]);           // 宁拒不放
    expect(stub.filterCalls).toBe(0);  // 闸门没起来就绝不能落穿
    expect(counter()).toBe(before + 1);
  });

  it('连续两次加载失败 ⇒ 连续 +2（计数是次数，不是布尔）', async () => {
    process.env[GATE_FAILCLOSED_ENV] = 'true';
    stub.failLoad = true;
    const before = counter();
    await applyGate([dna('a')]);
    await applyGate([dna('b')]);
    expect(counter()).toBe(before + 2);
  });

  it('🔴 回退开关未闭合 ⇒ fail-open 放行，计数不加（紧急通道必须可验证）', async () => {
    process.env[GATE_FAILCLOSED_ENV] = 'false';
    stub.failLoad = true;
    const before = counter();

    const out = await applyGate([dna('x'), dna('y')]);

    expect(out).toHaveLength(2);       // 放行 = 原候选原样返回
    expect(out.map((d) => d.branch_id)).toEqual(['x', 'y']);
    expect(counter()).toBe(before);    // 不得把紧急放行记成安全失败
  });

  it('闸门正常 ⇒ 正常过滤且计数不变（证明 +1 只来自失败路径）', async () => {
    process.env[GATE_FAILCLOSED_ENV] = 'true';
    stub.failLoad = false;
    const before = counter();

    const out = await applyGate([dna('p'), dna('q')]);

    expect(stub.filterCalls).toBe(1);
    expect(out).toHaveLength(2);
    expect(counter()).toBe(before);
  });

  it('🔴 闸门正常但一条都不放行 ⇒ 返回空，且**不**计为 fail-closed（空结果≠安全失败）', async () => {
    process.env[GATE_FAILCLOSED_ENV] = 'true';
    stub.failLoad = false;
    const before = counter();
    const mod = await import('../../m3/FiveStageGate.js');
    vi.mocked(mod.getFiveStageGate).mockImplementationOnce(() => ({
      filter: () => ({ passed: [], stageStats: {} }),
    }) as never);

    const out = await applyGate([dna('z')]);

    expect(out).toEqual([]);
    expect(counter()).toBe(before);    // 这是闸门在正常工作，不是加载失败
  });
});

describe('S2-B6 · 结构守卫：三个挂载点都不得退回 fail-open', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../MemoryRetriever.ts', import.meta.url)),
    'utf-8',
  );

  it('🔴 fail-closed 分支恰好 3 处（v11 出口 / 旧链主出口 / 主链共享出口）', () => {
    expect(src.match(/incrMetric\('gate_failclosed_total'\)/g)?.length).toBe(3);
    expect(src.match(/Flags\.gateFailClosed\(\)/g)?.length).toBe(3);
  });

  it('🔴 每个 fail-closed 分支在计数之后必须紧跟 return（不得只告警后落穿）', () => {
    const parts = src.split("incrMetric('gate_failclosed_total')");
    expect(parts.length).toBe(4); // 3 个计数点 ⇒ 4 段
    for (let i = 1; i < parts.length; i++) {
      expect(
        parts[i].slice(0, 160),
        `第 ${i} 处 fail-closed 分支未紧跟 return —— 改回 fail-open 了`,
      ).toMatch(/return/);
    }
  });

  it('fail-closed 必须用 console.error，不得降级成 warn（它是异常不是降级）', () => {
    const parts = src.split("incrMetric('gate_failclosed_total')");
    for (let i = 1; i < parts.length; i++) {
      expect(
        parts[i - 1].slice(-200),
        `第 ${i} 处 fail-closed 未用 console.error —— 蓝皮书 §5.3 明确要求 error 级别`,
      ).toMatch(/console\.error/);
    }
  });
});
