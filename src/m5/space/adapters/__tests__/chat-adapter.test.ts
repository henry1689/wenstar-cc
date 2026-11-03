/**
 * ChatSpaceAdapter · 时序与隔离测试
 * ============================================================
 * 🔴 这些用例锁的是**时序铁律**，不是覆盖率。
 *
 * 适配器最危险的失效模式是「会晤前的历史对参与者可见」——
 * 它不会抛错、不会告警，只会让人物说出不该知道的事，
 * 真机上表现为「她好像知道些什么」，极难归因。
 *
 * 内核 29 条测试直接构造 SpaceState，测不到这一层；
 * 这里是唯一能在开机前拦住它的地方。
 */
import { describe, expect, it } from 'vitest';
import { ChatSpaceAdapter } from '../chat-adapter.js';

const YUYAO = 'TXS-000000001';
const SHIYU = 'TXS-000000007';
const AZHEN = 'TXS-000000008';

const iso = (ms: number) => new Date(ms).toISOString();

/** 构造一条历史轮次 */
function turn(role: 'user' | 'assistant', content: string, tsMs: number, belong?: string) {
  return { role, content, timestamp: iso(tsMs), belongEntityUuid: belong };
}

// ══════════════════════════════════════════════════════════════════
// 时序：会晤前历史必须不可见
// ══════════════════════════════════════════════════════════════════
describe('🔴 时序铁律：会晤之前的历史不得进入参与者视野', () => {
  it('startIndex 之前的轮次一律不摄入', () => {
    const T = Date.now() - 3600_000; // 一小时前开始会晤
    const ad = new ChatSpaceAdapter('S1');
    ad.syncFromHistory(
      [
        turn('user', '会晤前业主独白（诗雨不该记得）', T - 60_000, SHIYU),
        turn('assistant', '会晤前诗雨的回复', T - 59_000, SHIYU),
        turn('user', '会晤开始后的第一句', T + 1_000, SHIYU),
      ],
      2, // 会晤从第 3 条开始
    );
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);

    const turns = ad.turnsFor(SHIYU);
    expect(turns.some((t) => t.content.includes('会晤前'))).toBe(false);
    expect(turns.some((t) => t.content.includes('会晤开始后'))).toBe(true);
  });

  it('🔴 会晤内历史必须可见（enter 必须早于会晤内轮次的时间戳）', () => {
    // 这条是最容易写错、也最容易被忽略的：若 enter 使用 Date.now()，
    // 而历史使用其原生 timestamp（通常早于 now），
    // 则所有会晤内历史都会落在任期之前 ⇒ 人物对新会晤全失忆。
    const T = Date.now() - 3600_000;
    const ad = new ChatSpaceAdapter('S1');
    ad.syncFromHistory(
      [
        turn('user', '会晤第一句', T + 1_000, SHIYU),
        turn('assistant', '诗雨第一答', T + 2_000, SHIYU),
      ],
      0,
    );
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);

    const turns = ad.turnsFor(SHIYU);
    expect(turns.length).toBe(2);
    expect(turns[0].content).toBe('会晤第一句');
    expect(turns[1].content).toBe('诗雨第一答');
  });

  it('时序来源是历史 timestamp，不是摄入时刻', () => {
    const T = Date.now() - 3600_000;
    const ad = new ChatSpaceAdapter('S1');
    ad.syncFromHistory([turn('user', '很早的一句话', T + 1_000, SHIYU)], 0);
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);

    const turns = ad.turnsFor(SHIYU);
    expect(turns).toHaveLength(1);
    // 时间戳必须还原为历史时刻附近，而非「现在」
    const ts = Date.parse(turns[0].timestamp!);
    expect(Math.abs(ts - (T + 1_000))).toBeLessThan(60_000);
  });
});

// ══════════════════════════════════════════════════════════════════
// 标签：说话人必须真实
// ══════════════════════════════════════════════════════════════════
describe('🔴 说话人标签：不得把别人的话标成自己', () => {
  it('B 读到 A 的话时 speakerName 是 A', () => {
    const ad = new ChatSpaceAdapter('S1');
    ad.syncParticipants([
      { uuid: SHIYU, name: '诗雨' },
      { uuid: AZHEN, name: '阿珍' },
    ]);
    ad.recordAgentSay(SHIYU, '诗雨说的话');
    ad.recordAgentSay(AZHEN, '阿珍说的话');

    const azhenTurns = ad.turnsFor(AZHEN);
    const shiyuLine = azhenTurns.find((t) => t.content === '诗雨说的话');
    expect(shiyuLine).toBeDefined();
    expect(shiyuLine!.speakerName).toBe('诗雨');
    expect(shiyuLine!.speakerUuid).toBe(SHIYU);

    const shiyuTurns = ad.turnsFor(SHIYU);
    const azhenLine = shiyuTurns.find((t) => t.content === '阿珍说的话');
    expect(azhenLine!.speakerName).toBe('阿珍');
  });

  it('业主发言 speakerName 为业主名，且不绑定任何实体 UUID', () => {
    const ad = new ChatSpaceAdapter('S1', '鸿艺');
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);
    ad.recordUserSay('业主说的话');

    const t = ad.turnsFor(SHIYU).find((x) => x.content === '业主说的话');
    expect(t!.role).toBe('user');
    expect(t!.speakerName).toBe('鸿艺');
    expect(t!.speakerUuid).toBeUndefined();
    expect(t!.legacyBelongEntityUuid).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 离场隔离
// ══════════════════════════════════════════════════════════════════
describe('🔴 离场之后看不到', () => {
  it('离场者不再读到离场后的内容，在场者仍可见', () => {
    const ad = new ChatSpaceAdapter('S1');
    ad.syncParticipants([
      { uuid: SHIYU, name: '诗雨' },
      { uuid: AZHEN, name: '阿珍' },
    ]);
    ad.recordUserSay('大家都在的时候说的话');
    // 诗雨离场（只保留阿珍）
    ad.syncParticipants([{ uuid: AZHEN, name: '阿珍' }]);
    ad.recordUserSay('诗雨走后悄悄说的话');

    const shiyu = ad.turnsFor(SHIYU).map((t) => t.content);
    expect(shiyu.some((c) => c.includes('大家都在'))).toBe(true);
    expect(shiyu.some((c) => c.includes('走后悄悄'))).toBe(false);

    const azhen = ad.turnsFor(AZHEN).map((t) => t.content);
    expect(azhen.some((c) => c.includes('走后悄悄'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 纯派生：turnsFor 不得改动内部状态
// ══════════════════════════════════════════════════════════════════
describe('turnsFor 是纯派生', () => {
  it('传入 pendingText 不写入内部状态，重复调用结果一致', () => {
    const ad = new ChatSpaceAdapter('S1');
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);
    const before = JSON.stringify(ad.state.events);

    const a = ad.turnsFor(SHIYU, '本轮还没落库的话');
    const b = ad.turnsFor(SHIYU, '本轮还没落库的话');

    expect(JSON.stringify(ad.state.events)).toBe(before);
    expect(a).toEqual(b);
    // 两次调用各算一次，不会累积成两条
    expect(a.filter((t) => t.content === '本轮还没落库的话')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 快照与不变量
// ══════════════════════════════════════════════════════════════════
describe('exportSnapshot', () => {
  it('正常数据通过校验并带出诊断信息', () => {
    const T = Date.now() - 60_000;
    const ad = new ChatSpaceAdapter('S1');
    ad.syncFromHistory([turn('user', '历史一句话', T, SHIYU)], 0);
    ad.syncParticipants([{ uuid: SHIYU, name: '诗雨' }]);

    const snap = ad.exportSnapshot();
    expect(snap.spaceId).toBe('S1');
    expect(snap.ingestedIndex).toBe(1);
    expect(snap.seats.find((s) => s.uuid === SHIYU)!.periods.length).toBe(1);
    expect(Array.isArray(snap.diagnostics)).toBe(true);
  });
});