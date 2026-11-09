/**
 * meeting-start-ts-anchor.test.ts — 会晤起点锚点必须从任一合法时间戳推导（2026-10-30）
 * ============================================================
 * 被守的缺陷（真机日志 [SpaceView] 实测复现）：
 *
 *   [SpaceView] 对象=熊梓铭 历史=0条 席位=5(在场1) 事件=173 诊断=76
 *   [SpaceView] 诊断: history_ts_missing:index=71 | history_assistant_unowned:…
 *
 *   `syncFromHistory` 只检查**第一行**被摄入历史的 timestamp 来锚定「会晤起点」：
 *     if (this._meetingStartTs === null && from < history.length) {
 *       const firstTs = Date.parse(history[from].timestamp);
 *       if (Number.isFinite(firstTs)) this._meetingStartTs = firstTs;   // ← 只看首行
 *     }
 *
 *   首行恰好缺时间戳（或值损坏）⇒ `_meetingStartTs` 永久为 null
 *     ⇒ 首次 `syncParticipants` 的 `anchorTs` 为 null
 *     ⇒ 入场时间退化成 `_ts()` = **当前最大 ts + 1**
 *     ⇒ 会晤里所有人「入场」在全部历史**之后**
 *     ⇒ `turnsFor()` 按任期过滤后一条不剩 = `历史=0条`
 *
 *   症状极具迷惑性：事件数正常（173）、席位数正常（5）、诊断只有几条
 *   `ts_missing`，唯独历史为空 —— 角色于是失忆。
 *
 * 修复：起点锚点必须扫描**被摄入区间内任一**合法时间戳；全部非法时退化为 0
 *      （= 可见全量历史），而不是退化为「全部不可见」。
 *
 *      判据方向很关键：**宁可多看，不可全盲**。
 */
import { describe, it, expect } from 'vitest';
import { ChatSpaceAdapter } from '../chat-adapter.js';

const U = 'TXS-000000007';

type Turn = { role: string; content: string; timestamp?: string; belongEntityUuid?: string };

/** 构造一个会晤场景：业主与某角色来回几句，再同步参与者 */
function make(history: Turn[], startIndex = 0): ChatSpaceAdapter {
  const ad = new ChatSpaceAdapter('meeting:test-anchor', '鸿艺');
  ad.syncFromHistory(history as any, startIndex);
  ad.syncParticipants([{ uuid: U, name: '徐诗雨' }]);
  return ad;
}

describe('会晤起点锚点：首行时间戳缺失不得导致全部历史不可见', () => {
  it('① 首行缺 timestamp，后续行合法 —— 仍应读到历史', () => {
    const ad = make([
      { role: 'user', content: '诗雨你在吗' },                                      // ← 首行无时间戳
      { role: 'assistant', content: '在的', timestamp: '2026-10-30T10:00:00.000Z', belongEntityUuid: U },
      { role: 'user', content: '那就好', timestamp: '2026-10-30T10:01:00.000Z' },
    ]);
    expect(ad.turnsFor(U).length, '历史不得为 0').toBeGreaterThan(0);
  });

  it('② 首行时间戳损坏（非 ISO 格式）—— 同上', () => {
    const ad = make([
      { role: 'user', content: '诗雨你在吗', timestamp: '昨天' },
      { role: 'assistant', content: '在的', timestamp: '2026-10-30T10:00:00.000Z', belongEntityUuid: U },
    ]);
    expect(ad.turnsFor(U).length).toBeGreaterThan(0);
  });

  it('③ 全部行都缺时间戳 —— 退化为单调递增后仍应可读', () => {
    const ad = make([
      { role: 'user', content: '诗雨你在吗' },
      { role: 'assistant', content: '在的', belongEntityUuid: U },
      { role: 'user', content: '那就好' },
    ]);
    expect(ad.turnsFor(U).length).toBeGreaterThan(0);
  });

  it('④ 正常形态回归：首行有合法时间戳（防修复反噬）', () => {
    const ad = make([
      { role: 'user', content: '诗雨你在吗', timestamp: '2026-10-30T10:00:00.000Z' },
      { role: 'assistant', content: '在的', timestamp: '2026-10-30T10:00:30.000Z', belongEntityUuid: U },
      { role: 'user', content: '那就好', timestamp: '2026-10-30T10:01:00.000Z' },
    ]);
    expect(ad.turnsFor(U).length).toBeGreaterThan(0);
  });
});