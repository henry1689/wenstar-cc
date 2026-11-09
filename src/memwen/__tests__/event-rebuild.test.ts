import { describe, it, expect } from 'vitest';
import { foldApply, reconcileIndex, shouldAlert, type MwEvent, type MwApply } from '../index.js';

/**
 * MemWen OS 守卫9 —— 事件流重建（ADR-024 附录 v2 §6.2）
 * 确定性三前提的行为化断言：纯函数（重放幂等）、载荷时间（不读墙钟）、
 * 对账比较记录集与校验和（不比图结构）。
 */

interface SampleState {
  readonly byId: ReadonlyMap<string, { sum: number; fromTs?: string }>;
}

/** 幂等型 apply（示范 LLM 产物入载荷：值来自 payload，不重算） */
const apply: MwApply<SampleState> = (state, ev) => {
  const next = new Map(state.byId);
  const id = String((ev.payload as { id?: unknown }).id);
  const v = Number((ev.payload as { v?: unknown }).v ?? 0);
  const ts = ev.ts; // 时间只从载荷取 —— apply 不读墙钟
  if (ev.type === 'add') {
    const cur = next.get(id);
    next.set(id, { sum: (cur?.sum ?? 0) + v, fromTs: ts });
  } else if (ev.type === 'set') {
    // set 幂等：重复应用同一事件结果不变
    next.set(id, { sum: v, fromTs: ts });
  }
  return { byId: next };
};

const ev = (type: string, id: string, v: number, ts?: string): MwEvent => ({
  type,
  payload: { id, v },
  ...(ts ? { ts } : {}),
});

const toSnap = (s: SampleState): Map<string, string> =>
  new Map([...s.byId.entries()].map(([k, x]) => [k, `${x.sum}@${x.fromTs ?? ''}`]));

describe('foldApply · 重放幂等与确定性', () => {
  it('同输入两次 fold → 深相等（确定性：apply 纯、不读墙钟）', () => {
    const events = [ev('add', 'a', 1, '2026-11-09T10:00:00Z'), ev('add', 'b', 2, '2026-11-09T11:00:00Z')];
    const r1 = foldApply({ byId: new Map() }, events, apply);
    const r2 = foldApply({ byId: new Map() }, events, apply);
    expect(toSnap(r1)).toEqual(toSnap(r2));
  });

  it('同一 set 事件重复出现（重放）→ 状态不双算（幂等）', () => {
    const e = ev('set', 'a', 5, '2026-11-09T10:00:00Z');
    const once = foldApply({ byId: new Map() }, [e], apply);
    const twice = foldApply({ byId: new Map() }, [e, e], apply);
    expect(toSnap(twice)).toEqual(toSnap(once));
  });

  it('时间只来自事件载荷：构造两个"不同墙钟"场景（纯函数无此输入）→ 结果一致', () => {
    // apply 签名只有 (state, ev)，根本没有 now 可读 —— 这里断言 ts 进了结果且来自载荷
    const r = foldApply({ byId: new Map() }, [ev('add', 'a', 1, 'T1')], apply);
    expect(r.byId.get('a')!.fromTs).toBe('T1');
  });
});

describe('reconcileIndex · Δ=0 不变量', () => {
  const a = new Map([['k1', 'c1'], ['k2', 'c2']]);
  const b = new Map([['k1', 'c1'], ['k2', 'c2']]);

  it('完全一致 → Δ=0、不告警', () => {
    const r = reconcileIndex(a, b);
    expect(r.delta).toBe(0);
    expect(shouldAlert(r)).toBe(false);
  });

  it('重建缺一条 / 多一条 → 对称差检出、告警', () => {
    const built = new Map([['k1', 'c1']]);
    const live = new Map([['k1', 'c1'], ['k2', 'c2']]);
    const r = reconcileIndex(built, live);
    expect(r.delta).toBeGreaterThan(0);
    expect(r.onlyLive).toEqual(['k2']);
    expect(shouldAlert(r)).toBe(true);
  });

  it('key 集合相同但校验和不同（同键内容漂移）→ 检出、告警', () => {
    const built = new Map([['k1', 'c1'], ['k2', 'c2']]);
    const live = new Map([['k1', 'c1'], ['k2', 'c2-DRIFTED']]);
    const r = reconcileIndex(built, live);
    expect(r.delta).toBeGreaterThan(0);
    expect(r.checksumMismatch).toEqual(['k2']);
    expect(shouldAlert(r)).toBe(true);
  });

  it('空对空 → Δ=0（边界）', () => {
    expect(reconcileIndex(new Map(), new Map()).delta).toBe(0);
  });
});
