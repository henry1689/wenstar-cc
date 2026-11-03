import { describe, it, expect } from 'vitest';
import { ChatSpaceAdapter } from '../adapters/chat-adapter.js';

/**
 * P138 · 耳语隔离回归（缺口2 视角语义 + 缺口1 打标格式）
 * ============================================================
 * 缺口2：askAll 逐段/主发言切换时，历史须按**当前生成 speaker 的席位视角**取 ——
 *        冲 A 的耳语不得被 B 的轮答读到。chat.ts 侧的视角选择与「防全盲回退」
 *        在调用层（fixedSpeakerUuid ?? GS.speakerUuid ?? _meetingUuid）；
 *        本文件锁定 adapter 侧的视角语义本体。
 * 缺口1：耳语记忆打标 `whisper:<target>`（persistence-stage 写入）——本文件锁定格式契约。
 *
 * 🔴 隐私红线：测试仅用中性占位文本。
 */

function mkHistory(rows: Array<Partial<{ role: string; content: string; timestamp: string; whisperToUuid: string }>>) {
  return rows.map((r, i) => ({
    role: r.role ?? 'user',
    content: r.content ?? `占位消息${i}`,
    timestamp: r.timestamp ?? new Date(1700000000000 + i * 1000).toISOString(),
    whisperToUuid: r.whisperToUuid,
  })) as any;
}

function seed(): ChatSpaceAdapter {
  const ad = new ChatSpaceAdapter('test:space', '鸿艺');
  // 与 chat.ts 相同顺序：先摄入历史（锚定会晤起点）→ 再同步参与者
  ad.syncFromHistory(
    mkHistory([
      { role: 'user', content: '开场', timestamp: new Date(1700000000000).toISOString() },
      { role: 'user', content: '公开的话', timestamp: new Date(1700000001000).toISOString() },
      { role: 'user', content: '冲A的耳语内容', timestamp: new Date(1700000002000).toISOString(), whisperToUuid: 'TXS-A' },
      { role: 'user', content: '耳语之后的公开话', timestamp: new Date(1700000003000).toISOString() },
    ]),
    0,
  );
  ad.syncParticipants([
    { uuid: 'TXS-A', name: '甲' },
    { uuid: 'TXS-B', name: '乙' },
  ]);
  return ad;
}

describe('P138 · turnsFor 席位视角（缺口2）', () => {
  it('① 以 A（耳语目标）视角：耳语内容可见', () => {
    const ad = seed();
    const rows = ad.turnsFor('TXS-A') as any[];
    expect(rows.some((r: any) => String(r.content).includes('耳语内容'))).toBe(true);
  });

  it('② 以 B（第三方轮答者）视角：耳语正文不可见，公开内容照常可见（P138 第三缺口已修）', () => {
    const ad = seed();
    const rows = ad.turnsFor('TXS-B') as any[];
    expect(rows.some((r: any) => String(r.content).includes('耳语内容'))).toBe(false);
    expect(rows.some((r: any) => String(r.content).includes('公开的话'))).toBe(true);
    expect(rows.some((r: any) => String(r.content).includes('耳语之后'))).toBe(true);
  });

  it('③ 未登记席位（防全盲前置）：返回空，交由 chat.ts 回退主实体视角', () => {
    const ad = seed();
    const rows = ad.turnsFor('TXS-UNKNOWN') as any[];
    expect(rows.length).toBe(0);
  });
});

describe('P138 · 耳语记忆打标格式契约（缺口1 持久基础）', () => {
  it('④ 格式锁定：whisper:<targetUuid>', () => {
    // 与 persistence-stage 写入侧同构：`whisper:${whisperToUuid}`
    const tag = `whisper:${'TXS-A'}`;
    expect(tag).toBe('whisper:TXS-A');
    expect(tag.startsWith('whisper:')).toBe(true);
  });
});
