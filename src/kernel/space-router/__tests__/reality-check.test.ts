/**
 * reality-check — 空间路由器**真实接线**验证（2026-10-31 第三层拆除后）
 *
 * 目的：单测覆盖的是内核公理与适配器局部行为，
 *   但「跨请求」「独处态可达性」这类问题只有把**两次请求**串起来才暴露。
 *
 * 本文件记录当前实现的真实行为（含缺陷），不粉饰。
 */
import { describe, it, expect } from 'vitest';
import { ChatSpaceAdapter } from '../adapters/chat-adapter.js';

const T = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();

describe('[现实核验] 跨请求任期是否延续', () => {
  // 🔴 2026-10-31 状态：**系统侧已规避** —— chat.ts 把适配器提升为模块级单例
  //   （`_spaceAdapterSingleton`），真实链路不再每请求重建 ⇒ 离场记录跨请求保留。
  //   下面的第 2 个用例保留的是一旦有人把适配器改回「每请求新建」就会复发的回归证据。
  it('🔴 A 离场期间业主说的话，A 回来后在**同一 adapter 内**不可见', () => {
    const ad = new ChatSpaceAdapter('meeting:X');
    ad.syncFromHistory([{ role: 'user', content: '开场', timestamp: T(0) }], 0);

    // 第一段任期：A、B 都在场
    ad.syncParticipants([
      { uuid: 'A', name: '徐诗雨' },
      { uuid: 'B', name: '阿珍' },
    ]);
    ad.recordUserSay('A 在场时说的话');

    // A 离场
    ad.syncParticipants([{ uuid: 'B', name: '阿珍' }]);
    ad.recordUserSay('A 不在时说的话');

    const aView = ad.turnsFor('A').map(t => t.content);
    expect(aView).toContain('A 在场时说的话');
    expect(aView, 'A 离场后的话不应被 A 看到').not.toContain('A 不在时说的话');

    // B 一直在场，两句都看得到
    const bView = ad.turnsFor('B').map(t => t.content);
    expect(bView).toContain('A 在场时说的话');
    expect(bView).toContain('A 不在时说的话');
  });

  it('🔴【缺陷】换到第二个 adapter（= 下一次请求）后，A 的离场记录丢失，离场期间的话对 A 可见', () => {
    // 请求 1：A、B 在场 → A 离场 → 业主说了一句（已落库，成为历史）
    const ad1 = new ChatSpaceAdapter('meeting:X');
    ad1.syncFromHistory([{ role: 'user', content: '开场', timestamp: T(0) }], 0);
    ad1.syncParticipants([{ uuid: 'A', name: '徐诗雨' }, { uuid: 'B', name: '阿珍' }]);
    ad1.recordUserSay('A 在场时说的话');
    ad1.syncParticipants([{ uuid: 'B', name: '阿珍' }]);
    ad1.recordUserSay('A 不在时说的话');

    // 请求 2：新 adapter（真实链路里 ctx 每请求新建，所以这就是真实形态）
    //   历史 = 全部已落库的轮次；参与者 = 当前在场者（A 已回来）
    const ad2 = new ChatSpaceAdapter('meeting:X');
    ad2.syncFromHistory(
      [
        { role: 'user', content: '开场', timestamp: T(0) },
        { role: 'user', content: 'A 在场时说的话', timestamp: T(1) },
        { role: 'user', content: 'A 不在时说的话', timestamp: T(3) },
      ],
      0,
    );
    ad2.syncParticipants([{ uuid: 'A', name: '徐诗雨' }, { uuid: 'B', name: '阿珍' }]);

    const aView = ad2.turnsFor('A').map(t => t.content);
    // 白皮书 §2.1 要求：「中间离开再回来，空白段永久不可见」
    // 实测：历史里没有 seat_op 记录 ⇒ 重放时 A 被 enter 到会晤起点 ⇒ 全程可见
    expect(aView, '这是已知缺陷：跨请求重建会丢失离场记录').toContain('A 不在时说的话');
  });
});

describe('[现实核验] 独处态可达性', () => {
  // 🔴 2026-10-31 状态：**已修复** —— 判据不再依赖适配器（玉瑶态下它不存在），
  //   改为 chat.ts 的模块标志 `_hadMeeting` ∧「此刻 participants 为空」。
  //   实机验证：散会后说「嗯，就我一个人了」⇒ reply 为空 + `[SoloMode]` 日志。
  //   下面保留适配器层面的推演，说明**为什么**原判据不可达。
  /**
   * chat.ts 的真实条件链：
   *   `const _meetingUuid = ctx._entityMeeting?.getEntityUUID?.();`
   *   `if (_meetingUuid) { ...创建 _spaceAdapter... }`
   *   `_soloMode` = adapter 存在 && 有过任期 && 零人在场
   *
   * 推演：adapter 只在**会晤态**创建；会晤态下 GroupSession 必有 speaker
   *       ⇒ syncParticipants 的 want 非空 ⇒ 至少一人在场 ⇒ soloMode 恒 false。
   *       玉瑶态下 adapter 根本不存在 ⇒ 同样 false。
   */
  it('🔴【缺陷】会晤态下 adapter 必然有在场者 ⇒ 独处态永远不可达', () => {
    // 会晤态：GroupSession 有 speaker，所以 want 至少 1 人
    const ad = new ChatSpaceAdapter('meeting:X');
    ad.syncFromHistory([{ role: 'user', content: 'x', timestamp: T(0) }], 0);
    ad.syncParticipants([{ uuid: 'A', name: '徐诗雨' }]);   // 会晤态必有参与者

    const snap = ad.exportSnapshot();
    const hasTenure = snap.seats.some(s => s.periods.length > 0);
    const onStage = snap.seats.some(s => s.periods.some(p => p.leftAt === undefined));
    expect(hasTenure).toBe(true);
    expect(onStage, '会晤态至少一人在场').toBe(true);
    expect(!onStage, '⇒ 独处判据恒 false').toBe(false);
  });

  it('🟢 全员离场后（同一 adapter 内）独处判据**可以**成立 —— 说明缺的是「谁会调用它」', () => {
    const ad = new ChatSpaceAdapter('meeting:X');
    ad.syncFromHistory([{ role: 'user', content: 'x', timestamp: T(0) }], 0);
    ad.syncParticipants([{ uuid: 'A', name: '徐诗雨' }, { uuid: 'B', name: '阿珍' }]);
    ad.syncParticipants([]);   // 全员离场

    const snap = ad.exportSnapshot();
    const hasTenure = snap.seats.some(s => s.periods.length > 0);
    const onStage = snap.seats.some(s => s.periods.some(p => p.leftAt === undefined));
    expect(hasTenure).toBe(true);
    expect(onStage).toBe(false);
    expect(!onStage, '判据本身可用').toBe(true);
  });
});

describe('[现实核验] 耳语链路', () => {
  it('🟢 同一 adapter 内：目标读得到正文，其余人只看到占位', () => {
    const ad = new ChatSpaceAdapter('meeting:X');
    ad.syncFromHistory([{ role: 'user', content: '开场', timestamp: T(0) }], 0);
    ad.syncParticipants([{ uuid: 'A', name: '徐诗雨' }, { uuid: 'B', name: '阿珍' }]);
    ad.recordUserSay('我悄悄跟你说件事', 'A');

    const aView = ad.turnsFor('A');
    const bView = ad.turnsFor('B');
    expect(aView.some(t => t.content === '我悄悄跟你说件事'), '目标读到正文').toBe(true);
    expect(bView.some(t => t.content === '我悄悄跟你说件事'), '其他人读不到正文').toBe(false);
    expect(bView.some(t => t.isWhisper === true && t.content.includes('耳语')), '其他人看到占位').toBe(true);
  });
});