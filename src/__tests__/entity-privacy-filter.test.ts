import { describe, it, expect } from 'vitest';
import { isIntimateAboutOthers, filterPrivateConversations } from '../m4/household/EntityPrivacyFilter.js';

const OTHER_ENTITIES = ['熊梓铭', '玉瑶', '徐诗韵'];

describe('EntityPrivacyFilter — 隐私隔离', () => {
  it('用户对他人私密表白 → 过滤', () => {
    const content = '其实我好喜欢熊梓铭，她让我心动了';
    expect(isIntimateAboutOthers(content, '徐诗雨', OTHER_ENTITIES)).toBe(true);
  });

  it('用户对他人身体亲密 → 过滤', () => {
    const content = '昨晚和玉瑶在一起，抱着她睡觉很安心';
    expect(isIntimateAboutOthers(content, '徐诗雨', OTHER_ENTITIES)).toBe(true);
  });

  it('公开人物背景（梓铭是熊总女儿）→ 保留', () => {
    const content = '梓铭是熊总的女儿，在北师大读书';
    expect(isIntimateAboutOthers(content, '徐诗雨', OTHER_ENTITIES)).toBe(false);
  });

  it('提及他人但无私密（普通提及）→ 保留', () => {
    const content = '诗雨跟梓铭不算特别熟，就是在厂里见过几次';
    expect(isIntimateAboutOthers(content, '徐诗雨', OTHER_ENTITIES)).toBe(false);
  });

  it('只保留 UUID 归属与可信来源均匹配的记录', () => {
    const convos = [
      { role: 'assistant' as const, content: '诗雨觉得今天工作有点累', timestamp: '', belong_entity_uuid: 'uuid-shiyu', source: 'entity-context-store' as const },
      { role: 'user' as const, content: '属于其他实体的私密内容', timestamp: '', belong_entity_uuid: 'uuid-other', source: 'entity-context-store' as const },
      { role: 'user' as const, content: '没有 UUID 的关键词兜底记录', timestamp: '', source: 'conversation-search' as const },
    ];
    const filtered = filterPrivateConversations(convos, { currentEntityUuid: 'uuid-shiyu' });
    expect(filtered).toEqual([convos[0]]);
  });

  it('UUID 缺失、来源不可信或 ACL 拒绝时 fail-closed', () => {
    const trusted = {
      role: 'user', content: '仅当前实体可见', timestamp: '',
      belong_entity_uuid: 'uuid-shiyu', source: 'entity-context-store' as const,
    };

    expect(filterPrivateConversations([trusted], { currentEntityUuid: null })).toEqual([]);
    expect(filterPrivateConversations([{ ...trusted, source: 'conversation-history' }], { currentEntityUuid: 'uuid-shiyu' })).toEqual([]);
    expect(filterPrivateConversations([trusted], {
      currentEntityUuid: 'uuid-shiyu',
      authorize: () => false,
    })).toEqual([]);
    expect(filterPrivateConversations([trusted], {
      currentEntityUuid: 'uuid-shiyu',
      authorize: () => { throw new Error('ACL unavailable'); },
    })).toEqual([]);
  });

  it('空列表 → 返回空', () => {
    expect(filterPrivateConversations([], { currentEntityUuid: 'uuid-shiyu' })).toEqual([]);
  });
});
