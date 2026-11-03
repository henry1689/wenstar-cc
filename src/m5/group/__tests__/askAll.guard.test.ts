/**
 * P090 步骤4 — askAll（向全员提问）轮答状态机守卫测试
 *
 * 守的是三条硬约束（P096 设计稿 §1 + ADR-013）：
 *   ① **队列只在 reduce 写**（ADR-013 硬约束②：状态只有一处写）——
 *      任何在调用层手改 state 的写法都会绕开不变式，此处用纯函数性锁死。
 *   ② **轮答能走完所有人** —— SPEAK 若清空队列，askAll 每推进一人队列即空 ⇒
 *      轮答只能进行一人，其余人被静默跳过（设计稿 §1.3 与 §2.5 的矛盾点，P100 §一已裁决：SPEAK 只出队）。
 *   ③ **不凭空幻觉全员提问** —— JOIN 若无条件追加队尾，不在轮答时的普通加人会把
 *      空队列变非空 ⇒ diffEffects 误派生 askAllStarted ⇒ 凭空多出一次全员提问。
 *
 * 另含向后兼容守卫：schemaVersion **不 bump**（bump 会让 normalizeState 整份拒绝旧快照
 * ⇒ 重启无法恢复会晤 ⇒ 摧毁 P075 路径B），旧快照缺 askAllQueue 时补空数组。
 *
 * 全部为纯状态机断言：不依赖 LLM / 网络 / 数据库 / 时钟（时间戳固定 T0）。
 */
import { describe, it, expect } from 'vitest';
import {
  createSessionState, reduce, diffEffects,
  normalizeState, serializeState, deserializeState,
  sessionMode, isMulti, isActive, speaker,
} from '../sessionReducer.js';
import type { Action, ContextSlot, SessionState } from '../types.js';
import { GROUP_SESSION_SCHEMA_VERSION } from '../types.js';

const T0 = 1_700_000_000_000;
const seed = (uuid: string, name: string) => ({ uuid, name, aliases: [name.slice(-2)], category: 'G' });
const A = seed('TXS-1', '徐诗雨');
const B = seed('TXS-2', '熊梓铭');
const C = seed('TXS-3', '王全芬');

const wake = (targets: typeof A[]): Action => ({ type: 'WAKE', targets, now: T0 });
const askAll = (): Action => ({ type: 'ASK_ALL', now: T0 });
const speak = (uuid: string): Action => ({ type: 'SPEAK', target: uuid, now: T0 });

/** 造一个「三人会晤 + 已进入轮答」的起点 */
const inAskAll = (): SessionState => reduce(reduce(createSessionState(T0), wake([A, B, C])), askAll());

describe('[P090 步骤4] ASK_ALL — 全量入队', () => {
  it('三人会晤向全员提问：队列 = 全部三人（P094 裁决①：含当前发言人，一律全答）', () => {
    const s = inAskAll();
    expect(s.askAllQueue).toEqual([A.uuid, B.uuid, C.uuid]);
  });

  it('入队顺序 = 参与者顺序（顺序由队列固定，不看内容）', () => {
    const s = inAskAll();
    expect(s.askAllQueue[0]).toBe(A.uuid);          // 首位是当前发言者
  });

  it('空参与者时不入队（no-op），不产生「零人轮答」', () => {
    const s0 = createSessionState(T0);
    const s1 = reduce(s0, askAll());
    expect(s1.askAllQueue).toEqual([]);
  });

  it('单人会晤也可入队（裁决①不做跳过判断，是否触发 askAll 由意图层决定）', () => {
    const s = reduce(reduce(createSessionState(T0), wake([A])), askAll());
    expect(s.askAllQueue).toEqual([A.uuid]);
  });
});

describe('[P090 步骤4] ② SPEAK 只出队不清空 —— 轮答必须能走完所有人', () => {
  it('🔴 SPEAK 当前发言人 = no-op（同人切换无变化）—— 这正是轮答首轮的真实情形', () => {
    // WAKE 首位 A 即当前 speaker，而 ASK_ALL 把 A 也入队（P094 裁决①）。
    // 故首轮对队头 SPEAK 必然 no-op、队列不减 —— 已答者只能由**返回层按 speakerUuid 过滤**，
    // 否则调用层会再让 A 答一次 ⇒ 同一个人的回复出现两遍。
    const s0 = inAskAll();
    const s1 = reduce(s0, speak(A.uuid));
    expect(s1).toBe(s0);                           // 原引用 = 纯 no-op
    expect(s1.askAllQueue).toEqual([A.uuid, B.uuid, C.uuid]);
  });

  it('SPEAK 非当前发言人：只移除该人，其余仍在队列', () => {
    const s1 = reduce(inAskAll(), speak(B.uuid));
    expect(s1.askAllQueue).toEqual([A.uuid, C.uuid]);
  });

  it('逐人推进：每推进一人只减一格，不会一人就清空', () => {
    let s = reduce(inAskAll(), speak(B.uuid));
    expect(s.askAllQueue).toHaveLength(2);         // 推进 1 人后仍剩 2 人
    s = reduce(s, speak(C.uuid));
    expect(s.askAllQueue).toHaveLength(1);         // 推进 2 人后仍剩 1 人
    s = reduce(s, speak(A.uuid));                  // 此时 speaker=C，A 非当前 ⇒ 正常出队
    expect(s.askAllQueue).toHaveLength(0);
  });

  it('SPEAK 非参与者：不动队列（reduce 自行判空，调用层不重复校验）', () => {
    const before = inAskAll();
    const after = reduce(before, speak('TXS-NOT-EXIST'));
    expect(after.askAllQueue).toEqual(before.askAllQueue);
  });
});

describe('[P090 步骤4] ③ JOIN 带前置条件 —— 不凭空幻觉全员提问', () => {
  it('不在轮答时（队列空）加人：队列仍为空', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B]));
    const s1 = reduce(s0, { type: 'JOIN', target: C, now: T0 });
    expect(s1.askAllQueue).toEqual([]);             // 无条件追加会把空队列变非空 ⇒ 误派生 askAllStarted
  });

  it('正在轮答时（队列非空）加人：追加到队尾，新人也要被问到', () => {
    const s1 = reduce(inAskAll(), speak(B.uuid));   // 推进一人后队列剩 [A, C]
    const s2 = reduce(s1, { type: 'JOIN', target: seed('TXS-4', '罗珍思'), now: T0 });
    expect(s2.askAllQueue).toEqual([A.uuid, C.uuid, 'TXS-4']);
  });
});

describe('[P090 步骤4] LEAVE / 散会 / WAKE / RESUME 清空语义', () => {
  it('单人离开：只移除该人', () => {
    const s1 = reduce(inAskAll(), { type: 'LEAVE', target: B.uuid, now: T0 });
    expect(s1.askAllQueue).toEqual([A.uuid, C.uuid]);
  });

  it('离开非队列成员：队列不变', () => {
    const before = inAskAll();
    const after = reduce(before, { type: 'LEAVE', target: 'TXS-NOT-EXIST', now: T0 });
    expect(after.askAllQueue).toEqual(before.askAllQueue);
  });

  it('散会（清空参与者）：队列一并清空 —— 不向已散会的人继续轮询', () => {
    let s = inAskAll();
    for (const uuid of [A.uuid, B.uuid, C.uuid]) s = reduce(s, { type: 'LEAVE', target: uuid, now: T0 });
    expect(s.participants).toHaveLength(0);
    expect(s.askAllQueue).toEqual([]);
  });

  it('重新 WAKE：清空队列（防上一场会晤的残留队列被带进新会晤）', () => {
    const s = reduce(inAskAll(), wake([A, B]));
    expect(s.askAllQueue).toEqual([]);
  });
});

describe('[P090 步骤4] ① 队列只在 reduce 写 —— ADR-013 硬约束②', () => {
  it('reduce 不修改入参（纯函数：不改引用、不改内容）', () => {
    const s0 = inAskAll();
    const snapshot = JSON.stringify(s0);
    reduce(s0, speak(A.uuid));
    expect(JSON.stringify(s0)).toBe(snapshot);      // 入参逐字节未变
  });

  it('同输入必得同输出（可重放：队列不依赖时钟/随机/全局态）', () => {
    const a = reduce(inAskAll(), speak(A.uuid));
    const b = reduce(inAskAll(), speak(A.uuid));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('返回的是新对象而非原引用（不可变更新；用非当前发言人以避开 SPEAK no-op 分支）', () => {
    const s0 = inAskAll();
    const s1 = reduce(s0, speak(B.uuid));
    expect(s1).not.toBe(s0);
  });
});

describe('[P090 步骤4] diffEffects — askAllStarted 只派生一次', () => {
  it('队列 空 → 非空：派生 askAllStarted，uuids = 完整队列', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B]));
    expect(s0.askAllQueue).toEqual([]);
    const s1 = reduce(s0, askAll());
    const eff = diffEffects(s0, s1).filter(e => e.type === 'askAllStarted');
    expect(eff).toHaveLength(1);
    expect((eff[0] as { uuids: string[] }).uuids).toEqual([A.uuid, B.uuid]);
  });

  it('队列 非空 → 非空（轮答推进中）：不再派生', () => {
    const s0 = inAskAll();
    const s1 = reduce(s0, speak(A.uuid));
    expect(diffEffects(s0, s1).filter(e => e.type === 'askAllStarted')).toHaveLength(0);
  });

  it('队列 非空 → 空（轮答结束）：不派生 askAllStarted', () => {
    let s = inAskAll();
    const s0 = s;
    for (const uuid of [A.uuid, B.uuid, C.uuid]) s = reduce(s, speak(uuid));
    expect(diffEffects(s0, s).filter(e => e.type === 'askAllStarted')).toHaveLength(0);
  });
});

describe('[P090 步骤4] 向后兼容 — schemaVersion 不 bump', () => {
  it('schemaVersion 与常量一致（bump 会让 normalizeState 整份拒绝旧快照 ⇒ 重启无法恢复会晤）', () => {
    expect(createSessionState(T0).schemaVersion).toBe(GROUP_SESSION_SCHEMA_VERSION);
  });

  it('旧快照缺 askAllQueue 字段：补空数组而非拒绝（向后兼容）', () => {
    const legacy = {
      schemaVersion: GROUP_SESSION_SCHEMA_VERSION,
      participants: [A, B],
      speakerUuid: A.uuid,
      contextStack: [],
    };
    const s = normalizeState(legacy, T0);
    expect(s).not.toBeNull();
    expect(s!.askAllQueue).toEqual([]);
  });

  it('队列含非参与者：整份拒绝（半错队列 = 向已离席者继续轮询）', () => {
    const s = inAskAll();
    const bad = { ...JSON.parse(JSON.stringify(s)), askAllQueue: [A.uuid, 'TXS-GHOST'] };
    expect(normalizeState(bad, T0)).toBeNull();
  });

  it('序列化/反序列化往返：队列逐字保持（跨请求依赖 loadSession 恢复队列）', () => {
    const s = inAskAll();
    const back = deserializeState(serializeState(s), T0);
    expect(back).not.toBeNull();
    expect(back!.askAllQueue).toEqual(s.askAllQueue);
  });
});

describe('[P090 步骤4] 队列下界 — 未派发 ASK_ALL 时队列恒空', () => {
  it('不派发 ASK_ALL：队列恒空 ⇒ 调用层循环 0 次', () => {
    // 🔴 2026-10-31 第三层固化：原「WS_GROUP_V2=0 回滚」语义已随开关删除，
    //   但**状态机侧的下界不变** —— 不派发 ASK_ALL 就不会有队列，
    //   调用层因队列空而不进入轮答循环。这条是 reducer 自身的不变量，与开关无关。
    const s0 = reduce(createSessionState(T0), wake([A, B, C]));
    expect(s0.askAllQueue).toEqual([]);
    expect(diffEffects(reduce(createSessionState(T0), wake([A])), s0)
      .filter(e => e.type === 'askAllStarted')).toHaveLength(0);
  });
});

describe('[P090 步骤4] 派生字段不冗余 — mode/isMulti/isActive 仍由 participants 派生', () => {
  it('入队与出队不改变会晤模式判定（队列不是存库布尔，不参与 mode 派生）', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B, C]));
    const s1 = inAskAll();                                    // 入队后
    const s2 = reduce(s1, speak(A.uuid));                     // 出队后
    for (const s of [s0, s1, s2]) {
      expect(sessionMode(s)).toBe('meeting');
      expect(isMulti(s)).toBe(true);
      expect(isActive(s)).toBe(true);
    }
    expect(speaker(s1)?.uuid).toBe(A.uuid);                   // 发言者仍由 participants 决定
  });
});
