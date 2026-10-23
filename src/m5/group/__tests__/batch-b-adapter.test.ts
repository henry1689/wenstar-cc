/**
 * T013 Phase 2 批B — 影子投影（project.ts）回归测试
 *
 * 批B 的安全前提：**EntityMeeting 仍是唯一真源**，GroupSession 只被投影、不决策。
 * 因此这里锁死的不是「新状态机对不对」，而是「投影是否忠实反映真源」——
 *   投影一旦错，影子状态就会与真源漂移，而 B3 的身份解析正建立在这个状态上。
 *
 * 另锁 `detectDrift`：漂移必须能被检测出来（而不是悄悄错下去）。
 */
import { describe, it, expect } from 'vitest';
import { projectMeetingState, detectDrift, type MeetingSnapshot } from '../project.js';
import { createSessionState, reduce, isActive, isMulti } from '../sessionReducer.js';
import type { Action, SessionState } from '../types.js';

const T0 = 1_700_000_000_000;
const A = { uuid: 'TXS-1', name: '徐诗雨', category: 'G' };
const B = { uuid: 'TXS-2', name: '熊梓铭', category: 'G' };

const idle = (): MeetingSnapshot => ({ active: false, speakerUuid: null, speakerName: null, participants: [] });
const one = (p = A): MeetingSnapshot => ({ active: true, speakerUuid: p.uuid, speakerName: p.name, participants: [p] });
const two = (speaker = A): MeetingSnapshot => ({
  active: true, speakerUuid: speaker.uuid, speakerName: speaker.name, participants: [A, B],
});

/** 按真源序列走一轮，返回最终影子状态（模拟适配层每轮的投影调用） */
function walk(snaps: MeetingSnapshot[]): SessionState {
  let s = createSessionState(T0);
  for (const snap of snaps) {
    for (const a of projectMeetingState(s, snap, T0)) s = reduce(s, a);
  }
  return s;
}

describe('[批B] projectMeetingState — 真源 → action 投影', () => {
  it('玉瑶态 + 真源仍玉瑶态 → 不产生 action', () => {
    expect(projectMeetingState(createSessionState(T0), idle(), T0)).toEqual([]);
  });

  it('玉瑶态 → 单人会晤：WAKE 一个参与者（真源主发言即首位，无需补 SPEAK）', () => {
    const acts = projectMeetingState(createSessionState(T0), one(), T0);
    expect(acts.map(a => a.type)).toEqual(['WAKE']);
    expect((acts[0] as Extract<Action, { type: 'WAKE' }>).targets.map(t => t.uuid)).toEqual(['TXS-1']);
  });

  it('玉瑶态 → 多人且主发言非首位：WAKE + SPEAK 两步对齐', () => {
    // 🔴 真源主发言是 TXS-2（后来者），而 WAKE 会把主发言设为首位 TXS-1
    //   —— 只发 WAKE 必然漂移，必须补一个 SPEAK（detectDrift 抓到过这个 bug）
    const acts = projectMeetingState(createSessionState(T0), two(B), T0);
    expect(acts.map(a => a.type)).toEqual(['WAKE', 'SPEAK']);
    let s = createSessionState(T0);
    for (const a of acts) s = reduce(s, a);
    expect(s.speakerUuid).toBe('TXS-2');
    expect(detectDrift(s, two(B))).toBeNull();
  });

  it('单人 → 多人：集合变化 ⇒ WAKE 整体重置（不用增量 JOIN 猜中间态）', () => {
    const s0 = walk([one()]);
    const acts = projectMeetingState(s0, two(), T0);
    expect(acts[0].type).toBe('WAKE');
    expect((acts[0] as Extract<Action, { type: 'WAKE' }>).targets).toHaveLength(2);
  });

  it('多人换主发言：集合不变、仅 speaker 变 ⇒ 只有 SPEAK', () => {
    const s0 = walk([two(A)]);
    const acts = projectMeetingState(s0, two(B), T0);
    expect(acts.map(a => a.type)).toEqual(['SPEAK']);
    expect((acts[0] as Extract<Action, { type: 'SPEAK' }>).target).toBe('TXS-2');
    expect(reduce(s0, acts[0]).speakerUuid).toBe('TXS-2');
  });

  it('散会：会晤中 → 真源 inactive ⇒ LEAVE（无 target = 全体）', () => {
    const s0 = walk([two()]);
    const acts = projectMeetingState(s0, idle(), T0);
    expect(acts.map(a => a.type)).toEqual(['LEAVE']);
    expect(reduce(s0, acts[0]).participants).toHaveLength(0);
  });

  it('全链路：玉瑶→单人→多人→换人→散会，终态回到玉瑶态', () => {
    const s = walk([one(), two(A), two(B), idle()]);
    expect(isActive(s)).toBe(false);
    expect(s.speakerUuid).toBeNull();
  });

  it('终态多人：participants=2 且 isMulti 派生为 true', () => {
    const s = walk([one(), two(B)]);
    expect(s.participants).toHaveLength(2);
    expect(isMulti(s)).toBe(true);
    expect(s.speakerUuid).toBe('TXS-2');   // 集合重置后主发言 = 真源当前主发言
  });

  it('玉瑶态 + 真源仍玉瑶态 → 空序列（不重复 dispatch）', () => {
    expect(projectMeetingState(createSessionState(T0), idle(), T0)).toEqual([]);
  });

  it('真源说激活但解析不出参与者 → 视为无效快照，不产生 action', () => {
    const bad: MeetingSnapshot = { active: true, speakerUuid: 'TXS-1', speakerName: '徐诗雨', participants: [] };
    expect(projectMeetingState(createSessionState(T0), bad, T0)).toEqual([]);
  });

  it('参与者缺 uuid/name → 被过滤掉，不产出脏 seed', () => {
    const dirty: MeetingSnapshot = {
      active: true, speakerUuid: '', speakerName: '',
      participants: [{ uuid: '', name: '空uuid' }, { uuid: 'TXS-3', name: '' }, A],
    };
    const acts = projectMeetingState(createSessionState(T0), dirty, T0);
    expect((acts[0] as Extract<Action, { type: 'WAKE' }>).targets.map(t => t.uuid)).toEqual(['TXS-1']);
  });

  it('集合相同且无 speaker 变化 → 空序列（不重复 dispatch）', () => {
    const s0 = walk([two(A)]);
    expect(projectMeetingState(s0, two(A), T0)).toEqual([]);
  });

  it('speakerUuid 指向非参与者 → 不产生 SPEAK（防投影把发言权交给局外人）', () => {
    const s0 = walk([two(A)]);
    const bad: MeetingSnapshot = { active: true, speakerUuid: 'TXS-999', speakerName: '幽灵', participants: [A, B] };
    expect(projectMeetingState(s0, bad, T0)).toEqual([]);
  });
});

describe('[批B] detectDrift — 漂移必须可检出', () => {
  it('一致 → null', () => {
    const s = walk([two(A)]);
    expect(detectDrift(s, two(A))).toBeNull();
  });

  it('active 不一致 → 报出', () => {
    const s = walk([two(A)]);
    expect(detectDrift(s, idle())).toContain('active 漂移');
  });

  it('participants 不一致 → 报出', () => {
    const s = walk([two(A)]);
    expect(detectDrift(s, one(A))).toContain('participants 漂移');
  });

  it('speaker 不一致 → 报出', () => {
    const s = walk([two(A)]);
    expect(detectDrift(s, two(B))).toContain('speaker 漂移');
  });

  it('投影后的状态与真源一致（投影正确性的整体断言）', () => {
    for (const snap of [one(), two(A), two(B), idle()]) {
      const s0 = walk([one()]);
      let s1 = s0;
      for (const a of projectMeetingState(s0, snap, T0)) s1 = reduce(s1, a);
      expect(detectDrift(s1, snap)).toBeNull();
    }
  });
});

describe('[批B] 影子状态绝不污染真源语义', () => {
  it('主发言切换不改变参与者集合', () => {
    const s0 = walk([two(A)]);
    let s1 = s0;
    for (const a of projectMeetingState(s0, two(B), T0)) s1 = reduce(s1, a);
    expect(s1.participants.map(p => p.uuid)).toEqual(s0.participants.map(p => p.uuid));
    expect(s1.speakerUuid).toBe('TXS-2');
  });

  it('序列化往返后仍与真源一致（影子状态可持久化）', () => {
    const s = walk([two(B)]);
    const json = JSON.stringify(s);
    const back = JSON.parse(json) as SessionState;
    expect(detectDrift(back, two(B))).toBeNull();
  });
});
