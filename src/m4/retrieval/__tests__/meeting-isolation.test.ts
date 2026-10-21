import { describe, it, expect } from 'vitest';
import { applyMeetingUuidFilter, meetingSpeakerUuid, verifyMeetingHits } from '../meetingIsolation.js';

/**
 * T013 R6 守卫 —— 会晤 UUID 过滤咽喉（deny-by-default，防 I007 复发）
 */
describe('T013 R6 · applyMeetingUuidFilter', () => {
  it('有 uuid → 白名单仅含该 uuid，strict + enforce', () => {
    const p = applyMeetingUuidFilter('TXS-000000001');
    expect(p.visibleUuids.has('TXS-000000001')).toBe(true);
    expect(p.visibleUuids.size).toBe(1);
    expect(p.searchScope).toBe('strict');
    expect(p.enforce).toBe(true);
    expect(p.allowUnowned).toBe(false);
  });

  it('无 uuid（null/空串/空白）→ 空白名单（deny-by-default，不召回他人）', () => {
    for (const bad of [null, undefined, '', '   ']) {
      const p = applyMeetingUuidFilter(bad as any);
      expect(p.visibleUuids.size, `${JSON.stringify(bad)} 应空白名单`).toBe(0);
      expect(p.enforce, '绝不能 enforce:false（I007 根因）').toBe(true);
    }
  });

  it('enforce 恒为 true（杜绝 I007 的 enforce:false 空子句）', () => {
    expect(applyMeetingUuidFilter('TXS-1').enforce).toBe(true);
    expect(applyMeetingUuidFilter(null).enforce).toBe(true);
  });
});

describe('T013 R6 · verifyMeetingHits 会晤命中泄漏校验', () => {
  it('全部命中为会晤实体 → ok', () => {
    const r = verifyMeetingHits(
      [{ entityUuid: 'TXS-1' }, { entityUuid: 'TXS-1' }, { entityUuid: '' }],
      'TXS-1',
    );
    expect(r.ok).toBe(true);
    expect(r.leaked).toEqual([]);
  });

  it('泄漏他人实体 → 报警（I007 场景）', () => {
    const r = verifyMeetingHits(
      [{ entityUuid: 'TXS-1' }, { entityUuid: 'TXS-9' }],
      'TXS-1',
    );
    expect(r.ok).toBe(false);
    expect(r.leaked).toContain('TXS-9');
  });

  it('无会晤 uuid + 有归属命中 → 全算泄漏', () => {
    const r = verifyMeetingHits([{ entityUuid: 'TXS-1' }], null);
    expect(r.ok).toBe(false);
  });
});

describe('T013 R6 · meetingSpeakerUuid', () => {
  it('取状态中的发言者 uuid；空态返 null', () => {
    expect(meetingSpeakerUuid({ speakerUuid: ' TXS-1 ' })).toBe('TXS-1');
    expect(meetingSpeakerUuid({ speakerUuid: null })).toBeNull();
    expect(meetingSpeakerUuid(null)).toBeNull();
  });
});
