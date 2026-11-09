/**
 * 空间路由器 · 对抗测试
 * ============================================================
 * 🔴 这些用例**不是覆盖率测试**，是**证伪测试**。
 *    T013 的教训：1000 轮结构轨压测证明不了隔离（因为那一轮没有 LLM）。
 *    这里每一条都构造一个"如果规则有洞就会失败"的场景。
 *
 * 用例清单：
 *   T01 空空间说话 → 无人应答
 *   T02 叫人来 → 只看得到入场之后
 *   T03 叫某人走 → 走之后的事件他看不到
 *   T04 离开再进来 → 新任期，中间空白不可见
 *   T05 耳语 → 只有目标读得到正文，其余只见「有人耳语」
 *   T06 旁听者 → 看得见，但永远拿不到令牌
 *   T07 property → 任意随机状态，无人能感知任期之外
 *   T08 多次进出 → 每段任期独立
 *
 * ⚠️ allowHistoryBackread 本期**未实现**（见文件末尾 it.todo），
 *    刻意不用测试假装它已生效；但已加反向守卫，防止有人把它揉进公理。
 */
import { describe, expect, it } from 'vitest';
import { buildViews, canPerceive, isInTenure, route } from '../SpaceRouter.js';
import {
  createEmptySpace,
  type Flow,
  type RouteOutput,
  type Seat,
  type SeatKind,
  type SpaceEvent,
  type SpaceState,
} from '../types.js';

const YUYAO = 'TXS-000000001';
const SHIYU = 'TXS-000000007';
const AZHEN = 'TXS-000000008';

/** 构造一个席位（尚未入场：periods 为空） */
function seat(uuid: string, name: string, kind: SeatKind = 'participant'): Seat {
  return { uuid, displayName: name, kind, periods: [], allowHistoryBackread: false };
}

/** 预先"注册"若干可能出场的人（相当于 FG 里存在的实体） */
function spaceWith(...seats: Seat[]): SpaceState {
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

/** 某席位当前能读到的正文文本 */
function readableTexts(state: SpaceState, uuid: string): string[] {
  const view = buildViews(state, state.events).get(uuid);
  if (!view) return [];
  return view.readable.map((e) => e.privateContent ?? `<${e.kind}>`);
}

// ══════════════════════════════════════════════════════════════════
// T01 空空间
// ══════════════════════════════════════════════════════════════════
describe('T01 空空间（业主独处）', () => {
  it('无人应答 —— 无视图、无指向', () => {
    const empty = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨')); // 已注册但都不在场
    const { out } = route(empty, { kind: 'user_say', text: '明天要开会', ts: 1 });
    // 🔴 2026-10-30 第二层：令牌模型已删除，「无人应答」由「无视图 + 无指向」表达。
    expect(out.views.size).toBe(0); // 从未入场 ⇒ 没有视图
    expect(out.address).toEqual({ kind: 'room' });
  });
});

// ══════════════════════════════════════════════════════════════════
// T02 叫人来 → 只看得到入场之后
// ══════════════════════════════════════════════════════════════════
describe('T02 叫人来', () => {
  it('被叫者拿令牌，但读不到入场前业主说的话', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const { state } = feed(base, [
      { kind: 'user_say', text: '我一个人念叨：明天审厂', ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 2 },
      { kind: 'user_say', text: '你来了，说说审厂怎么准备', ts: 3 },
    ]);

    const texts = readableTexts(state, YUYAO);
    // 入场前的独白不可见
    expect(texts.some((t) => t.includes('一个人念叨'))).toBe(false);
    // 入场后的对话可见
    expect(texts.some((t) => t.includes('你来了'))).toBe(true);
  });

  it('入场当轮开启新任期', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const r = route({ ...base, lastTs: 1 }, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 2 });
    expect(r.nextState.seats[0].periods).toEqual([{ enteredAt: 2 }]);
  });

  it('🔴 房间已有人时，叫第二人进场只新开第二位任期', () => {
    // 锁死语义：本轮只动被叫的那个人，先前在场者的任期原样不动
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 2 },
    ]);
    expect(state.seats.find((s) => s.uuid === YUYAO)!.periods).toEqual([{ enteredAt: 1 }]);
    expect(state.seats.find((s) => s.uuid === SHIYU)!.periods).toEqual([{ enteredAt: 2 }]);
  });
});

// ══════════════════════════════════════════════════════════════════
// T03 叫某人走 → 走之后看不到
// ══════════════════════════════════════════════════════════════════
describe('T03 走了就不知道后来的事', () => {
  it('离场后的事件对该席位不可感知', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 2 },
      { kind: 'user_say', text: '诗雨在的时候说的话', ts: 3 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 4 },
      { kind: 'user_say', text: '诗雨走后悄悄说的话', ts: 5 },
    ]);

    const shiyuTexts = readableTexts(state, SHIYU);
    expect(shiyuTexts.some((t) => t.includes('在的时候'))).toBe(true);
    expect(shiyuTexts.some((t) => t.includes('走后悄悄'))).toBe(false);

    // 留在场内的玉瑶两条都能看到
    const yuyaoTexts = readableTexts(state, YUYAO);
    expect(yuyaoTexts.some((t) => t.includes('走后悄悄'))).toBe(true);
  });

  it('离场后不再在场（原「不再获得令牌」语义的等价判据）', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 2 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 3 },
      { kind: 'user_say', text: '现在还有谁在？', ts: 4 },
    ]);
    const onStage = state.seats
      .filter((s) => s.periods.some((p) => p.leftAt === undefined))
      .map((s) => s.uuid);
    expect(onStage).toEqual([YUYAO]);
  });

  it('🔴 离场者仍有自己的视图：任期内可读、离场后不可读', () => {
    // 锁死 buildViews 覆盖面：若只给在场席位建视图，
    // 「离场后不可感知」会退化成「没有视图当然感知不到」的同义反复。
    const base = spaceWith(seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 1 },
      { kind: 'user_say', text: '在场时说的', ts: 2 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 3 },
      { kind: 'user_say', text: '走了之后说的', ts: 4 },
    ]);
    const view = buildViews(state, state.events).get(SHIYU);
    expect(view).toBeDefined();
    const texts = view!.readable.map((e) => e.privateContent ?? '');
    expect(texts.some((t) => t.includes('在场时说的'))).toBe(true);
    expect(texts.some((t) => t.includes('走了之后说的'))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// T04 离开再进来 → 新任期
// ══════════════════════════════════════════════════════════════════
describe('T04 离开后再进来', () => {
  it('两段任期间的空白永久不可见', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 1 },
      { kind: 'user_say', text: '第一段期间', ts: 2 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 3 },
      { kind: 'user_say', text: '空白期间', ts: 4 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 5 },
      { kind: 'user_say', text: '第二段期间', ts: 6 },
    ]);

    const texts = readableTexts(state, SHIYU);
    expect(texts.some((t) => t.includes('第一段'))).toBe(true);
    expect(texts.some((t) => t.includes('空白期间'))).toBe(false); // ← 核心
    expect(texts.some((t) => t.includes('第二段'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// T05 耳语
// ══════════════════════════════════════════════════════════════════
describe('T05 耳语：内容私密、存在感公开', () => {
  it('只有目标能读正文，其余只看到「有人耳语」', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'), seat(AZHEN, '阿珍'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 2 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: AZHEN, ts: 3 },
    ]);

    // 手工追加一条耳语事件（内核只负责路由，耳语由上层产生）
    const whisper: SpaceEvent = {
      id: 'w:5', spaceId: state.spaceId, ts: 5, kind: 'whisper',
      actorUuid: null,
      audience: { kind: 'seat', uuid: SHIYU },
      publicMeta: { type: 'whisper', to: SHIYU },
      privateContent: '我只跟你说：明天带那个',
    };
    const withWhisper: SpaceState = { ...state, events: [...state.events, whisper] };
    const views = buildViews(withWhisper, withWhisper.events);

    // 目标：读得到正文
    const shiyuView = views.get(SHIYU)!;
    expect(shiyuView.readable.some((e) => e.privateContent === whisper.privateContent)).toBe(true);

    // 其他人：读不到正文，但知道发生了耳语
    for (const uuid of [YUYAO, AZHEN]) {
      const v = views.get(uuid)!;
      expect(v.readable.some((e) => e.privateContent === whisper.privateContent)).toBe(false);
      expect(v.metaOnly.some((e) => (e.publicMeta as any)?.type === 'whisper')).toBe(true);
      // 🔴 物理隔离：metaOnly 里的 privateContent 必须已被置 null
      expect(v.metaOnly.every((e) => e.privateContent === null)).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// T06 旁听者
// ══════════════════════════════════════════════════════════════════
describe('T06 旁听者', () => {
  it('看得见对话，但永远拿不到令牌', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(AZHEN, '阿珍', 'auditor'));
    const { state, outs } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: AZHEN, ts: 2 },
      { kind: 'user_say', text: '大家都听一下', ts: 3 },
      { kind: 'user_say', text: '再问一句', ts: 4 },
    ]);

    // 🔴 2026-10-30 第二层：令牌模型已删除，「旁听者拿不到应答资格」由席位类型表达。
    expect(state.seats.find((s) => s.uuid === AZHEN)!.kind).toBe('auditor');
    // 整轮都没有把 address 指向他（他从未被点名）
    for (const out of outs) {
      expect(out.address.kind === 'seat' && out.address.uuid === AZHEN).toBe(false);
    }
    const texts = readableTexts(state, AZHEN);
    expect(texts.some((t) => t.includes('大家都听一下'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// T07 property：无人能感知任期之外
// ══════════════════════════════════════════════════════════════════
describe('T07 property：任期是硬边界', () => {
  it('任意随机任期/事件组合，canPerceive 都不会越过任期', () => {
    // 确定性伪随机（不用 Math.random，保证可复现）
    let seed = 20261029;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let iter = 0; iter < 300; iter++) {
      const enteredAt = Math.floor(rnd() * 100);
      const leftAt = enteredAt + Math.floor(rnd() * 50) + 1;
      const s: Seat = {
        uuid: 'U1', displayName: '测试', kind: 'participant',
        periods: [{ enteredAt, leftAt }], allowHistoryBackread: false,
      };
      const ts = Math.floor(rnd() * 200);
      const e: SpaceEvent = {
        id: `e${iter}`, spaceId: 'S', ts, kind: 'say', actorUuid: null,
        audience: { kind: 'room' }, publicMeta: null, privateContent: 'x',
      };

      const expected = ts >= enteredAt && ts < leftAt;
      expect(canPerceive(s, e)).toBe(expected);
      if (!expected) expect(isInTenure(s, e)).toBe(false);
    }
  });

  it('多段任期内，任一段命中即可感知（T08 延伸）', () => {
    const s: Seat = {
      uuid: 'U1', displayName: '多次进出', kind: 'participant',
      periods: [{ enteredAt: 10, leftAt: 20 }, { enteredAt: 30, leftAt: 40 }],
      allowHistoryBackread: false,
    };
    const ev = (ts: number): SpaceEvent => ({
      id: `e${ts}`, spaceId: 'S', ts, kind: 'say', actorUuid: null,
      audience: { kind: 'room' }, publicMeta: null, privateContent: 'x',
    });
    expect(canPerceive(s, ev(15))).toBe(true);   // 第一段内
    expect(canPerceive(s, ev(25))).toBe(false);  // 两段之间 ← 核心
    expect(canPerceive(s, ev(35))).toBe(true);   // 第二段内
    expect(canPerceive(s, ev(45))).toBe(false);  // 全部结束之后
  });

  it('🔴 allowHistoryBackread=true 不得打通两段任期间的空白', () => {
    // 反向守卫：豆包两版都主张把它揉进 isInTenure，那会让 ts=25 返回 true。
    // 一旦有人这么改，这条必须变红。
    const s: Seat = {
      uuid: 'U1', displayName: '回看者', kind: 'participant',
      periods: [{ enteredAt: 10, leftAt: 20 }, { enteredAt: 30, leftAt: 40 }],
      allowHistoryBackread: true,
    };
    const ev = (ts: number): SpaceEvent => ({
      id: `e${ts}`, spaceId: 'S', ts, kind: 'say', actorUuid: null,
      audience: { kind: 'room' }, publicMeta: null, privateContent: 'x',
    });
    expect(canPerceive(s, ev(15))).toBe(true);   // 第一段内仍然可见
    expect(canPerceive(s, ev(25))).toBe(false);  // ← 两段之间，绝不可见
    expect(canPerceive(s, ev(35))).toBe(true);   // 第二段内
    expect(canPerceive(s, ev(45))).toBe(false);  // 全部结束之后
  });
});

// ══════════════════════════════════════════════════════════════════
// keep_only 语义
// ══════════════════════════════════════════════════════════════════
describe('清场只留一人（由 leave 其余人表达）', () => {
  it('保留者仍在场，其余全部离场', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(SHIYU, '诗雨'));
    const { state, outs } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 2 },
      // 2026-11-01：原为 command '诗雨留下'（keep_only）。命令层已随死代码删除，
      //   同一语义用「让其余人离场」表达，断言结果逐条不变。
      { kind: 'internal_seat_op', op: 'leave', targetUuid: YUYAO, ts: 3 },
    ]);
    const yuyao = state.seats.find((s) => s.uuid === YUYAO)!;
    expect(yuyao.periods.at(-1)!.leftAt).toBe(3);
    // 保留者仍在场（原「获得令牌」语义由在场状态表达）
    const shiyu = state.seats.find((s) => s.uuid === SHIYU)!;
    expect(shiyu.periods.at(-1)!.leftAt).toBeUndefined();
  });

  it('保留 auditor 时其类型不变（仍拿不到应答资格）', () => {
    // 席位创建时即为 auditor（原实现靠 command 的 asAuditor 转换；命令层删除后
    //   改由席位类型本身表达，与 T06 旁听用例同一构造方式）。
    const base = spaceWith(seat(YUYAO, '玉瑶'), seat(AZHEN, '阿珍', 'auditor'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: AZHEN, ts: 2 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: YUYAO, ts: 3 },
    ]);
    expect(state.seats.find((s) => s.uuid === AZHEN)!.kind).toBe('auditor');
  });
});

// ══════════════════════════════════════════════════════════════════
// T08 三段任期（比 T04 更进一步：夹在两个空白之间的那段也不能穿）
// ══════════════════════════════════════════════════════════════════
describe('T08 多段任期：每段独立，任两段之间的空白都不可穿透', () => {
  it('三段任期，两段空白均不可见', () => {
    const base = spaceWith(seat(SHIYU, '诗雨'));
    const { state } = feed(base, [
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 1 },
      { kind: 'user_say', text: '第一段对话', ts: 2 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 3 },
      { kind: 'user_say', text: '间隙1对话', ts: 4 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 5 },
      { kind: 'user_say', text: '第二段对话', ts: 6 },
      { kind: 'internal_seat_op', op: 'leave', targetUuid: SHIYU, ts: 7 },
      { kind: 'user_say', text: '间隙2对话', ts: 8 },
      { kind: 'internal_seat_op', op: 'enter', targetUuid: SHIYU, ts: 9 },
      { kind: 'user_say', text: '第三段对话', ts: 10 },
    ]);

    const texts = readableTexts(state, SHIYU);
    expect(texts.some((t) => t.includes('第一段对话'))).toBe(true);
    expect(texts.some((t) => t.includes('间隙1对话'))).toBe(false);
    expect(texts.some((t) => t.includes('第二段对话'))).toBe(true);
    expect(texts.some((t) => t.includes('间隙2对话'))).toBe(false);
    expect(texts.some((t) => t.includes('第三段对话'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 机器指令通道（适配器自动同步席位，不走文本正则）
// ══════════════════════════════════════════════════════════════════
describe('internal_seat_op：机器指令与自然语言命令彻底分流', () => {
  it('enter 等价于叫人进场：开一段新任期', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const r1 = route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 });
    expect(r1.nextState.seats[0].periods).toEqual([{ enteredAt: 1 }]);
    expect(r1.out.appended.some((e) => e.kind === 'enter')).toBe(true);
  });

  it('leave 等价于叫人走：关闭当前开放任期', () => {
    const s1 = route(
      spaceWith(seat(YUYAO, '玉瑶')),
      { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 },
    ).nextState;
    const r2 = route(s1, { kind: 'internal_seat_op', op: 'leave', targetUuid: YUYAO, ts: 2 });
    expect(r2.nextState.seats[0].periods).toEqual([{ enteredAt: 1, leftAt: 2 }]);
  });

  it('🔴 UUID 含命令关键词也不会被误解析（这正是独立通道存在的理由）', () => {
    // 若把 UUID 拼进 command.raw，形如 "TXS-留下-过来-走了-0001" 的标识符
    // 会被 RE_KEEP_ONLY / RE_ENTER / RE_LEAVE 当成自然语言指令。
    const weird = 'TXS-留下-过来-走了-0001';
    const s = spaceWith(seat(weird, '怪名'));
    const r = route(s, { kind: 'internal_seat_op', op: 'enter', targetUuid: weird, ts: 1 });
    expect(r.out.warnings).toHaveLength(0);
    expect(r.nextState.seats[0].periods).toEqual([{ enteredAt: 1 }]);
  });

  it('目标席位不存在 ⇒ 告警且不改任何席位状态', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const r = route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: 'NOPE-UUID', ts: 1 });
    expect(r.out.warnings.some((w) => w.startsWith('command_target_not_found'))).toBe(true);
    expect(r.nextState.seats[0].periods).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 纯函数性与时序
// ══════════════════════════════════════════════════════════════════
describe('纯函数性', () => {
  it('route 不修改入参 state', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const snapshot = JSON.stringify(base);
    route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('🔴 agent_say 不修改入参 state（原「令牌就地消费」路径已随令牌模型删除）', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const s1 = route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 }).nextState;
    const snapshot = JSON.stringify(s1);
    const r = route(s1, { kind: 'agent_say', uuid: YUYAO, text: '在', ts: 2 });
    expect(JSON.stringify(s1)).toBe(snapshot);
    expect(r.nextState.events.length).toBe(s1.events.length + 1);
  });

  it('同一 (state, flow) 两次调用结果完全一致（可回放）', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const a = route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 });
    const b = route(base, { kind: 'internal_seat_op', op: 'enter', targetUuid: YUYAO, ts: 1 });
    expect(JSON.stringify(a.nextState)).toBe(JSON.stringify(b.nextState));
  });
});

describe('时序：不纠错，但可观测', () => {
  it('ts 倒退产出 ts_out_of_order 告警，lastTs 不回退', () => {
    const base = spaceWith(seat(YUYAO, '玉瑶'));
    const s1 = route(base, { kind: 'user_say', text: 'a', ts: 10 }).nextState;
    const r2 = route(s1, { kind: 'user_say', text: 'b', ts: 5 });
    expect(r2.out.warnings.some((w) => w.startsWith('ts_out_of_order'))).toBe(true);
    expect(r2.nextState.lastTs).toBe(10);
  });
});

// ══════════════════════════════════════════════════════════════════
// 预留：allowHistoryBackread（本期未实现，故意不用 todo 之外的假绿灯）
// ══════════════════════════════════════════════════════════════════
describe('allowHistoryBackread（预留，本期未实现）', () => {
  it.todo('置 true 时可见"最早入场之前"的历史，但离场之后的内容仍不可见');
  it.todo('不得把它揉进 canPerceive —— 公理保持不变，只在视图层分支');
});