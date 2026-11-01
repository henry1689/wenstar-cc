/**
 * T013 Phase 2 · P055 任务1 — GroupSession.dispatch 的 M 层埋点守卫
 *
 * 🔴 为什么要有这个测试（S4.5 曾以「埋点放唯一调用点」通过审查，而实现是空的）：
 *   P054 生产实测发现交付的 `GroupSession.dispatch` 内**根本没有埋点** ——
 *   审议时的陈述与实现不符，且当时无人发现，因为没有任何东西能发现。
 *   本测试把「每个 action 都有 module_entry/module_exit」变成 S5 阶段的秒级断言。
 *
 * 🔴 特别锁两条（删了不会有任何报错，只会静默丢失可观测性）：
 *   1. **IDLE 与 RESUME 在生产链路上无任何派发点**（全仓仅 types.ts 的类型定义），
 *      唯一能验它们的地方就是这里；
 *   2. **埋点失败不影响主链路** —— 这是 m2.SQLiteAdapter `_hook` 的既定契约，
 *      但此前没有任何测试验证过它在 GroupSession 上成立。
 *
 * ⚠ SPEAK 用例必须切到**另一位**参与者：reduce 规定「同人切换 = 无变化」
 *   （sessionReducer.ts:169 `if (target.uuid === prev.speakerUuid && !action.slot) return prev`），
 *   用主发言者本人会验到 unchanged 而不是 applied。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GroupSession } from '../GroupSession.js';
import type { Action, ContextSlot } from '../types.js';

const T0 = 1_700_000_000_000;
const A = { uuid: 'TXS-1', name: '徐诗雨', category: 'G' };
const B = { uuid: 'TXS-2', name: '熊梓铭', category: 'G' };

/** 玉瑶现场槽（uuid=null）：WAKE 压栈用，批C 的核心语义 */
const SLOT: ContextSlot = {
  uuid: null,
  emotion: { pleasure: 3, arousal: 2, intimacy: 1 },
  sceneAnchor: null,
  contextMemory: null,
  savedRole: 'recaller',
  savedAt: T0,
};

const ENTRY = /\[Hook\] module_entry module=m5\.GroupSession\.dispatch action=(\w+) participants=(\d+)/;
const EXIT = /\[Hook\] module_exit module=m5\.GroupSession\.dispatch 耗时=(\d+)ms status=(\w+) effects=(\d+) participants=(\d+)/;

/** 只收集以 `[Hook]` 开头的日志行；可选让 console.log 抛异常以验证「埋点失败不影响主链路」 */
function spyHooks(opts: { throwOnLog?: boolean } = {}): { lines: () => string[]; restore: () => void } {
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (opts.throwOnLog) throw new Error('console.log 被强制抛异常（测试埋点失败路径）');
    void args;
  });
  return {
    lines: () => spy.mock.calls.map(c => String(c[0] ?? '')).filter(l => l.startsWith('[Hook]')),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => vi.restoreAllMocks());

/** 预置到「双人在会晤中、主发言=A」的稳定起点（避免每个用例重复铺垫） */
function seeded(): GroupSession {
  const gs = new GroupSession({ now: () => T0 });
  gs.dispatch({ type: 'WAKE', targets: [A], now: T0, slot: SLOT });
  gs.dispatch({ type: 'JOIN', target: B, now: T0 });
  return gs;
}

describe('[P055 任务1] GroupSession.dispatch — M 层埋点', () => {
  // 🔴 六种 action 一个都不能少。IDLE/RESUME 生产无派发点，只有此处能验。
  const CASES: Array<{ label: string; build: (gs: GroupSession) => Action }> = [
    { label: 'WAKE', build: () => ({ type: 'WAKE', targets: [A], now: T0, slot: SLOT }) },
    { label: 'JOIN', build: () => ({ type: 'JOIN', target: B, now: T0 }) },
    { label: 'SPEAK', build: () => ({ type: 'SPEAK', target: B.uuid, now: T0 }) },
    { label: 'LEAVE', build: () => ({ type: 'LEAVE', now: T0 }) },
    { label: 'RESUME', build: (gs) => ({ type: 'RESUME', state: gs.getState(), now: T0 }) },
    { label: 'IDLE', build: () => ({ type: 'IDLE', now: T0 + 1 }) },
  ];

  for (const c of CASES) {
    it(`🔴 ${c.label} 必须同时打出 module_entry 与 module_exit`, () => {
      const gs = seeded();
      const h = spyHooks();
      try {
        gs.dispatch(c.build(gs));
        const lines = h.lines();
        const entries = lines.filter(l => ENTRY.test(l));
        const exits = lines.filter(l => EXIT.test(l));
        expect(entries.length, `${c.label} 缺 module_entry`).toBe(1);
        expect(exits.length, `${c.label} 缺 module_exit`).toBe(1);
        // 配对顺序：entry 必须在 exit 之前
        expect(lines.indexOf(entries[0]), `${c.label} 的 entry 应在 exit 之前`).toBeLessThan(lines.indexOf(exits[0]));
      } finally {
        h.restore();
      }
    });
  }

  it('🔴 entry 必须带 action= 与 participants= 两个字段', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      gs.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
      const m = h.lines().find(l => ENTRY.test(l));
      expect(m, '找不到 entry 日志').toBeTruthy();
      const parsed = ENTRY.exec(m!);
      expect(parsed![1]).toBe('SPEAK');            // action
      expect(Number(parsed![2])).toBe(2);           // 派发前参与者数（seeded 后两人）
    } finally {
      h.restore();
    }
  });

  it('🔴 exit 必须带 耗时=/status=/effects=/participants= 四个字段', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      gs.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
      const m = h.lines().find(l => EXIT.test(l));
      expect(m, '找不到 exit 日志').toBeTruthy();
      const parsed = EXIT.exec(m!);
      expect(Number.isFinite(Number(parsed![1]))).toBe(true);  // 耗时
      expect(['applied', 'unchanged']).toContain(parsed![2]);  // status
      expect(Number(parsed![3])).toBeGreaterThanOrEqual(0);    // effects
      expect(Number(parsed![4])).toBe(2);                      // 派发后参与者数（SPEAK 不增减人）
    } finally {
      h.restore();
    }
  });

  it('🟢 applied 路径：真实状态变更必须记 status=applied', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      gs.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
      const parsed = EXIT.exec(h.lines().find(l => EXIT.test(l))!);
      expect(parsed![2], '切到另一位参与者应是 applied').toBe('applied');
    } finally {
      h.restore();
    }
  });

  it('🟢 unchanged 路径：无变化早退也必须打 exit，且记 status=unchanged', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      // SPEAK 指向不存在的参与者 → reduce 返回原对象 → dispatch 走 unchanged 早退
      const before = gs.getState();
      const after = gs.dispatch({ type: 'SPEAK', target: 'NOPE-不存在', now: T0 });
      expect(after, '该 action 应无状态变更（返回原对象）').toBe(before);
      const parsed = EXIT.exec(h.lines().find(l => EXIT.test(l))!);
      expect(parsed, 'unchanged 早退路径不得丢掉 module_exit').toBeTruthy();
      expect(parsed![2]).toBe('unchanged');
      expect(Number(parsed![3])).toBe(0);
    } finally {
      h.restore();
    }
  });

  it('🔴 埋点抛异常时状态机必须完好（m2 `_hook` 契约在 GroupSession 上成立）', () => {
    const gs = seeded();
    const h = spyHooks({ throwOnLog: true });
    try {
      const after = gs.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
      // 状态照常推进
      expect(after.speakerUuid).toBe(B.uuid);
      expect(gs.getState().speakerUuid).toBe(B.uuid);
      expect(gs.getTrail().length, 'WAKE+JOIN+本次 SPEAK').toBe(3);
      // 监听者照常触发
      let seen = 0;
      const gs2 = new GroupSession({ now: () => T0 });
      gs2.onEffect(() => { seen++; });
      gs2.dispatch({ type: 'WAKE', targets: [A], now: T0, slot: SLOT });
      expect(seen).toBeGreaterThan(0);
    } finally {
      h.restore();
    }
  });

  it('🟢 埋点格式与 m5 文本范式一致（受 reasoning-leak-length-cap 同类断言约束）', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      gs.dispatch({ type: 'LEAVE', now: T0 });
      const entry = h.lines().find(l => ENTRY.test(l))!;
      const exit = h.lines().find(l => EXIT.test(l))!;
      expect(entry).toMatch(/^\[Hook\] module_entry module=m5\.GroupSession\.dispatch /);
      expect(exit).toMatch(/^\[Hook\] module_exit module=m5\.GroupSession\.dispatch 耗时=\d+ms /);
    } finally {
      h.restore();
    }
  });

  it('🟢 reset() 内部的 dispatch 也要有埋点（埋点放 dispatch 而非调用方的直接理由）', () => {
    const gs = seeded();
    const h = spyHooks();
    try {
      gs.reset();
      const lines = h.lines();
      expect(lines.some(l => ENTRY.test(l) && l.includes('action=LEAVE')), 'reset() 内部 dispatch 应有 entry').toBe(true);
      expect(lines.some(l => EXIT.test(l)), 'reset() 内部 dispatch 应有 exit').toBe(true);
    } finally {
      h.restore();
    }
  });
});
