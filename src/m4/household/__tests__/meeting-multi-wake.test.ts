import { describe, it, expect } from 'vitest';
import { EntityMeeting } from '../EntityMeeting.js';

/**
 * T012 P0-5 守卫 —— 多人会晤唤醒（别名感知 + 语序鲁棒）
 * 锁住四件事：
 *   ① 别名在多人唤醒中被归一（"诗雨"→徐诗雨），不再退化单人
 *   ② 把字句/无分隔/多语序 也能正确召出多人
 *   ③ 反例：提及多人但无集合意图（陈述句/疑问句）不误入会晤
 *   ④ 单人唤醒不受影响
 */

const NAMES = ['徐诗雨', '阿珍', '王全芬', '熊梓铭', '安琪'];
const ALIAS = new Map([['诗雨', '徐诗雨'], ['韵韵', '徐诗雨'], ['全芬', '王全芬'], ['阿芬', '王全芬']]);
const wake = (msg: string, inMeeting = false) => EntityMeeting.detectUserIntent(msg, NAMES, inMeeting, ALIAS);

describe('T012 P0-5 · 多人唤醒别名归一', () => {
  it('主名版（回归原有可用）', () => {
    expect(wake('找徐诗雨和阿珍过来聊聊')).toEqual(['徐诗雨', '阿珍']);
  });
  it('别名混入不再退化单人（修复前：只召出主名可匹配者）', () => {
    expect(wake('找诗雨和阿珍过来聊聊')).toEqual(['徐诗雨', '阿珍']);
    expect(wake('诗雨和阿珍都过来')).toEqual(['徐诗雨', '阿珍']);
    expect(wake('叫诗雨、阿珍一起')).toEqual(['徐诗雨', '阿珍']);
    expect(wake('让诗雨和阿芬过来开会')).toEqual(['徐诗雨', '王全芬']);
  });
});

describe('T012 P0-5 · 语序鲁棒（把字句/无分隔）', () => {
  it('把字句（动词在名后）', () => {
    expect(wake('把徐诗雨和阿珍叫过来')).toEqual(['徐诗雨', '阿珍']);
    expect(wake('把诗雨和阿珍喊过来')).toEqual(['徐诗雨', '阿珍']);
  });
  it('无分隔/空格分隔', () => {
    expect(wake('徐诗雨阿珍过来')).toEqual(['徐诗雨', '阿珍']);
    expect(wake('诗雨 阿珍 都来')).toEqual(['徐诗雨', '阿珍']);
  });
});

describe('T012 P0-5 · 反例不误判', () => {
  it('陈述句提及多人无集合意图 → 非唤醒', () => {
    expect(wake('诗雨和阿珍都是我朋友')).toBeNull();
  });
  it('疑问句「都来了吗」→ 非唤醒（防误入会晤）', () => {
    expect(wake('诗雨和阿珍都来了吗')).toBeNull();
  });
  it('单人提及 → 单人而非多人', () => {
    const r = wake('阿珍来了');
    expect(r).toEqual(['阿珍']);
  });
});

describe('T012 P1-3 · 会晤中点名切换（WeChat 风格）', () => {
  const di = (m: string) => EntityMeeting.detectIntent(m, NAMES, true, ALIAS);
  it('称呼点名某参会者 → 切主发言到该人', () => {
    expect(di('阿珍，你在干嘛')).toEqual({ kind: 'switch', targets: ['阿珍'] });
    expect(di('阿芬，你到家了吗')).toEqual({ kind: 'switch', targets: ['王全芬'] }); // 别名
  });
  it('@某人 → 切主发言（不被 wake 抢先）', () => {
    expect(di('@阿珍 在吗')).toEqual({ kind: 'switch', targets: ['阿珍'] });
  });
  it('纯提及（无紧跟分隔符）不误切', () => {
    expect(di('阿珍和徐诗雨都是好人').kind).toBe('normal');
  });
  it('非会晤态称呼仍是唤醒（不回归）', () => {
    const r = EntityMeeting.detectIntent('阿珍，聊聊', NAMES, false, ALIAS);
    expect(r.kind).toBe('wake');
  });
});

describe('T012 发言人推断 inferSpeaker（多人·自然聊天）', () => {
  const stubFG: any = {
    getUUIDByName: (n: string) => ({ 徐诗雨: 'TXS-1', 阿珍: 'TXS-2', 王全芬: 'TXS-3' } as any)[n] || null,
    getEntityByUUID: () => ({ category: 'G' }),
    saveLastMeeting: () => {},
    _saveMeetingSnapshot: () => {},
  };
  const mk = () => { const em = new EntityMeeting(stubFG); em.enterMulti(['徐诗雨', '阿珍']); return em; };

  it('内容提及一人 → 该人接（层②，无LLM）', async () => {
    const em = mk();
    expect(await em.inferSpeaker('今天阿珍心情怎么样')).toBe('阿珍');
  });
  it('别名提及归一后命中（提及非当前参会者）', async () => {
    // 令阿珍为主发言人(当前)，徐诗雨为另一参会者 → 点别名"诗雨"应切到徐诗雨
    const em = new EntityMeeting(stubFG); em.enterMulti(['阿珍', '徐诗雨']);
    expect(await em.inferSpeaker('诗雨你作业写完没', new Map([['诗雨', '徐诗雨']]))).toBe('徐诗雨');
  });
  it('提及当前主发言人 → null（维持，不误切）', async () => {
    const em = mk(); // 当前=徐诗雨
    expect(await em.inferSpeaker('徐诗雨你说呢', new Map([['诗雨', '徐诗雨']]))).toBeNull();
  });
  it('零提及 + LLM 判断 → 返回 LLM 所指（层③方案A）', async () => {
    const em = mk();
    const llm: any = { rawCall: async () => '阿珍' };
    expect(await em.inferSpeaker('上次说的那个方案，跟进下', undefined, llm)).toBe('阿珍');
  });
  it('零提及 + 无LLM → null（默认当前发言人）', async () => {
    const em = mk();
    expect(await em.inferSpeaker('嗯，行吧', undefined, undefined)).toBeNull();
  });
  it('LLM 失败 → null（降级默认，不抛错）', async () => {
    const em = mk();
    const llm: any = { rawCall: async () => { throw new Error('402'); } };
    expect(await em.inferSpeaker('那个事怎么样了', undefined, llm)).toBeNull();
  });
});

describe('T012 P0-5 · 会晤中严格模式仍不误切（不回归）', () => {
  it('会晤中寒暄含名字不触发切换', () => {
    // inMeeting=true 严格模式：单人前缀/纯名不触发；但明确多人集合仍可加人
    expect(wake('全芬你还是那么丰满', true)).toBeNull();
  });
});
