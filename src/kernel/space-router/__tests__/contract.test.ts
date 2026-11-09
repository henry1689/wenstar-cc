/**
 * 空间路由器 · 行为契约测试（Phase A · 先红后实现）
 * ============================================================
 * 🔴 这些用例**不测实现**，测的是业主用自然语言描述的规则。
 *    它们是后面所有实现的对错判据——先让它们红，再写代码让它们绿。
 *
 * 规则来源（业主 2026-10-29 原话 + 修正）：
 *   R1 指名进入：说「阿珍，X」→ 阿珍若不在场则入场；address=阿珍；focus:=阿珍
 *   R2 不指名：说「X」→ address=全场；focus 不变
 *   R3 离场：说「阿珍走了」→ 关闭任期；若 focus=阿珍 → focus:=null
 *   R4 独处：空间无席位 → 无人应答
 *   R5 唯一发言：只有 focus 产出回复
 *   R6 没有例外：玉瑶与其他席位完全同权，无默认发言人
 *   R7 无限任期：没叫离场就一直陪伴
 *
 * 三条关系（互不混用，这是本次重构的理论核心）：
 *   audience —— 谁听得见     （已实现）
 *   address  —— 冲着谁说的   （本次新增）
 *   focus    —— 下一句谁答    （本次新增）
 *
 * ⚠️ 本文件在 Phase B 实现完成前**预期编译失败 / 全红**，这是刻意的。
 */
import { describe, expect, it } from 'vitest';
import { route } from '../SpaceRouter.js';
import {
  createEmptySpace,
  type Flow,
  type RouteOutput,
  type Seat,
  type SpaceState,
} from '../types.js';

const YUYAO = 'TXS-000000001';
const SHIYU = 'TXS-000000007';
const AZHEN = 'TXS-000000008';

/** 登记一个席位（periods 为空 = 尚未入场，但空间"认识"她） */
function seat(uuid: string, name: string): Seat {
  return { uuid, displayName: name, kind: 'participant', periods: [], allowHistoryBackread: false };
}

function space(...seats: Seat[]): SpaceState {
  return { ...createEmptySpace('SPACE-1'), seats };
}

/** 依次喂 flow，返回终态与每轮输出 */
function feed(initial: SpaceState, flows: Flow[]): { state: SpaceState; outs: RouteOutput[] } {
  let state = initial;
  const outs: RouteOutput[] = [];
  for (const f of flows) {
    const r = route(state, f);
    state = r.nextState;
    outs.push(r.out);
  }
  return { state, outs };
}

const say = (text: string, ts: number): Flow => ({ kind: 'user_say', text, ts });
const cmd = (uuid: string, ts: number): Flow => ({ kind: 'internal_seat_op', op: 'leave', targetUuid: uuid, ts });

// ══════════════════════════════════════════════════════════════════
// C1 指名：说「阿珍，X」→ 本轮应答者是阿珍
// ══════════════════════════════════════════════════════════════════
describe('C1 指名即指定发言人', () => {
  it('说「阿珍，别忘了带那个」→ 本轮指向阿珍', () => {
    const base = space(seat(AZHEN, '阿珍'), seat(SHIYU, '诗雨'));
    const r = route(base, say('阿珍，别忘了带那个', 1));
    // 🔴 2026-10-30 第二层：focus 已从内核删除，「谁接话」由 GroupSession.speakerUuid 承担；
    //   内核保留的等价判据是 address（这话冲着谁）。
    expect(r.out.address).toEqual({ kind: 'seat', uuid: AZHEN });
  });

  it('句中提到别人的名字不影响指名（句首称呼优先）', () => {
    // 业主实测事故：说「阿珍，我刚刚给徐诗雨聊了会」，系统把目标解析成了徐诗雨
    const base = space(seat(AZHEN, '阿珍'), seat(SHIYU, '诗雨'));
    const { outs } = feed(base, [
      say('阿珍，我刚刚给徐诗雨聊了会，你给我说说我给她说了啥', 1),
    ]);
    expect(outs.at(-1)!.address).toEqual({ kind: 'seat', uuid: AZHEN });
  });
});

// ══════════════════════════════════════════════════════════════════
// C2 指名不在场者 → 她入场
// ══════════════════════════════════════════════════════════════════
describe('C2 指名即入场', () => {
  it('阿珍从未入场，说「阿珍，你在吗」→ 阿珍开任期且本轮指向她', () => {
    const base = space(seat(AZHEN, '阿珍'));
    const r = route(base, say('阿珍，你在吗', 1));
    const azhen = r.nextState.seats.find((s) => s.uuid === AZHEN)!;
    expect(azhen.periods).toHaveLength(1);
    expect(azhen.periods[0].enteredAt).toBe(1);
    expect(r.out.address).toEqual({ kind: 'seat', uuid: AZHEN });
  });
});

// ══════════════════════════════════════════════════════════════════
// C3 共享：两人都在场时，说给一个人听的话，两人都听得见
//     但只有被指名者知道"这话是给我的"
// ══════════════════════════════════════════════════════════════════
describe('C3 听得见 ≠ 冲着你说', () => {
  it('阿珍、诗雨都在场：说给阿珍的话两人视图都有，但只有阿珍被标记为「对我说」', () => {
    const base = space(seat(AZHEN, '阿珍'), seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      say('阿珍，你在吗', 1), // 阿珍入场
      say('诗雨，你在吗', 2), // 诗雨入场
      say('阿珍，今晚回去记得把电话带上', 3), // 两人都在场之后，再说指向阿珍的话
    ]);

    const target = state.events.find((e) => e.privateContent?.includes('把电话带上'));
    expect(target, '应存在「把电话带上」这条事件').toBeDefined();

    const r = route(state, say('我再说一遍', 3));
    const azhenView = r.out.views.get(AZHEN);
    const shiyuView = r.out.views.get(SHIYU);

    // 两人都在场 ⇒ 都听得见
    expect(azhenView!.readable.some((e) => e.id === target!.id)).toBe(true);
    expect(shiyuView!.readable.some((e) => e.id === target!.id)).toBe(true);

    // 但只有阿珍"被指着说"
    expect(azhenView!.addressed.some((e) => e.id === target!.id)).toBe(true);
    expect(shiyuView!.addressed.some((e) => e.id === target!.id)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// C4 隔离：离场之后产生的任何内容，离场者不可见
// ══════════════════════════════════════════════════════════════════
describe('C4 走了就不知道后来的事', () => {
  it('阿珍离场后说的话，阿珍的视图里没有', () => {
    const base = space(seat(AZHEN, '阿珍'), seat(SHIYU, '诗雨'));
    const { state, outs } = feed(base, [
      say('阿珍，你在吗', 1),
      say('诗雨，你在吗', 2),
      cmd(AZHEN, 3),
      say('阿珍走了以后说的话', 4),
    ]);

    const view = outs.at(-1)!.views.get(AZHEN);
    expect(view, '离场者仍应有自己的视图（否则 C4 退化为同义反复）').toBeDefined();
    expect(view!.readable.some((e) => e.privateContent?.includes('走了以后'))).toBe(false);
    expect(state.seats.find((s) => s.uuid === AZHEN)!.periods[0].leftAt).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════
// C5 空白：离开再回来，中间那段永久不可见
// ══════════════════════════════════════════════════════════════════
describe('C5 两段任期之间的空白', () => {
  it('阿珍离开再回来，中间那段看不到', () => {
    const base = space(seat(AZHEN, '阿珍'));
    const { outs } = feed(base, [
      say('阿珍，你在吗', 1),
      say('第一段期间', 2),
      cmd(AZHEN, 3),
      say('空白期间', 4),
      say('阿珍，你回来', 5),
      say('第二段期间', 6),
    ]);

    const view = outs.at(-1)!.views.get(AZHEN)!;
    const texts = view.readable.map((e) => e.privateContent ?? '');
    expect(texts.some((t) => t.includes('第一段'))).toBe(true);
    expect(texts.some((t) => t.includes('空白期间'))).toBe(false);
    expect(texts.some((t) => t.includes('第二段'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// C6 独处：空间没有人 → 无人应答
// ══════════════════════════════════════════════════════════════════
describe('C6 业主独处', () => {
  it('空空间说话 → 无指向、无视图、无人应答', () => {
    const empty = space(seat(AZHEN, '阿珍')); // 已登记但未入场
    const r = route(empty, say('我一个人念叨两句', 1));
    expect(r.out.address).toEqual({ kind: 'room' });
    expect(r.out.views.size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// C7 回落：focus 离场 → 回落 null，不是玉瑶
// ══════════════════════════════════════════════════════════════════
describe('C7 发言人离场后的回落', () => {
  it('阿珍离场后，不带名字的一轮不得自动指向任何人（尤其不是玉瑶）', () => {
    const base = space(seat(AZHEN, '阿珍'), seat(YUYAO, '玉瑶'));
    const { outs } = feed(base, [say('阿珍，你在吗', 1), cmd(AZHEN, 2), say('我一个人待会儿', 3)]);
    // 🔴 「离场后谁来接」的状态归属 GroupSession；内核能保证的是：不替业主臆造指向。
    expect(outs.at(-1)!.address).toEqual({ kind: 'room' });
  });

  it('还有别人在场时也一样：不点名的一轮不自动转给他人', () => {
    // 依据 R5/R6：系统不替业主决定下一位是谁；要换人必须再指名。
    const base = space(seat(AZHEN, '阿珍'), seat(SHIYU, '诗雨'));
    const { outs } = feed(base, [
      say('阿珍，你在吗', 1),
      say('诗雨，你在吗', 2),
      say('阿珍，再聊两句', 3),
      cmd(AZHEN, 4),
      say('说点别的', 5),
    ]);
    expect(outs.at(-1)!.address).toEqual({ kind: 'room' });
  });
});

// ══════════════════════════════════════════════════════════════════
// C8 无例外：玉瑶与其他席位完全同权
// ══════════════════════════════════════════════════════════════════
describe('C8 系统里没有例外', () => {
  it('玉瑶被叫来的行为与任何席位一致', () => {
    const base = space(seat(YUYAO, '玉瑶'));
    const r = route(base, say('玉瑶，你在吗', 1));
    const yuyao = r.nextState.seats.find((s) => s.uuid === YUYAO)!;
    expect(yuyao.periods).toHaveLength(1);
    expect(r.out.address).toEqual({ kind: 'seat', uuid: YUYAO });
  });

  it('玉瑶被叫走之后，系统不会自动回到她', () => {
    const base = space(seat(YUYAO, '玉瑶'), seat(AZHEN, '阿珍'));
    const { state, outs } = feed(base, [
      say('玉瑶，你在吗', 1),
      cmd(YUYAO, 2),
      say('现在还有谁在', 3),
    ]);
    expect(outs.at(-1)!.address).toEqual({ kind: 'room' });
    // 离场者仍保留自己的视图（见 C4），故不能断言 views 为空；
    // 真正要断言的是「无人在场」——没有人能应答。
    expect(state.seats.some((s) => s.periods.some((p) => p.leftAt === undefined))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// R7 无限任期：没叫离场就一直陪伴
// ══════════════════════════════════════════════════════════════════
describe('R7 无限任期', () => {
  it('入场后不叫离场，任期一直开放，多轮后仍是 focus', () => {
    const base = space(seat(AZHEN, '阿珍'));
    const { state, outs } = feed(base, [
      say('阿珍，你在吗', 1),
      say('聊第一件事', 2),
      say('聊第二件事', 3),
      say('聊第三件事', 4),
    ]);
    const azhen = state.seats.find((s) => s.uuid === AZHEN)!;
    expect(azhen.periods).toHaveLength(1);
    expect(azhen.periods[0].leftAt).toBeUndefined();
    // 不指名的一轮不产生指向（R2 的「不自动换人」语义现由 GroupSession 承担）
    expect(outs.at(-1)!.address).toEqual({ kind: 'room' });
  });
});