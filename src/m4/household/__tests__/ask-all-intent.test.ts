import { describe, it, expect } from 'vitest';
import { EntityMeeting } from '../EntityMeeting.js';

/**
 * P091 任务1 · askAll（群聊向全员提问）意图识别用例
 * ============================================================
 * 规则（宁窄勿滥，P091 §二）：
 *   双条件缺一不触发：① 复数对象词（你们/大家/各位）或全称量词（都）
 *                    ② 疑问/征询结构（吗/么/？/怎么看/怎么想/觉得呢/怎么样/有什么…/说说…想法）
 *   仅 `inMeeting && isMulti` 生效；判序在 exit/add/switch/点名/wake 之后（先到先拦）。
 *
 * 用例规模：命中 12 + 不命中 12（含判序/边界），共 24 条（P091 要求 ≥20）。
 */

const NAMES = ['徐诗雨', '阿珍', '王全芬', '熊梓铭', '安琪', '徐诗韵', '张小龙', '熊梓玥'];
const ALIAS = new Map<string, string>([['诗雨', '徐诗雨'], ['阿芬', '王全芬'], ['梓铭', '熊梓铭'], ['韵韵', '徐诗韵']]);

/** 群聊态：会晤中 + 多人 */
const multi = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, true, ALIAS, true);
/** 单人会晤态 */
const single = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, true, ALIAS, false);
/** 非会晤态（玉瑶） */
const idle = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, false, ALIAS, false);

describe('P091 askAll 意图识别 · 命中用例（12条）', () => {
  const hits: Array<[string, string]> = [
    ['你们有什么看法', '复数对象+有什么…看法'],
    ['大家都记住了吗', '全称量词+吗'],
    ['各位说说想法', '复数对象+说说…想法（征询祈使）'],
    ['你们觉得呢', '复数对象+觉得呢'],
    ['大家怎么看', '复数对象+怎么看'],
    ['你们有什么想说的吗', '复数对象+有什么…想说+吗'],
    ['各位有什么意见', '复数对象+有什么…意见'],
    ['都听懂了吗', '全称量词+吗'],
    ['大家还有吗', '复数对象+还有吗'],
    ['你们俩怎么想', '复数对象+怎么想'],
    ['大家讲讲各自的看法', '复数对象+讲讲…看法'],
    ['你们觉得怎么样', '复数对象+觉得…怎么样'],
  ];

  for (const [msg, why] of hits) {
    it(`命中：「${msg}」（${why}）`, () => {
      const r = multi(msg);
      expect(r.kind, `「${msg}」应判 askAll`).toBe('askAll');
      expect(r.targets, 'targets 空——全员列表由适配层从 GroupSession 取').toEqual([]);
    });
  }
});

describe('P091 askAll 意图识别 · 不命中用例（12条）', () => {
  it('单数对象不触发：「你有什么看法」→ normal', () => {
    expect(multi('你有什么看法').kind).toBe('normal');
  });
  it('非疑问不触发：「你们先聊，我去倒水」→ normal', () => {
    expect(multi('你们先聊，我去倒水').kind).toBe('normal');
  });
  it('陈述句不触发：「大家都很好」→ normal', () => {
    expect(multi('大家都很好').kind).toBe('normal');
  });
  it('无复数词不触发：「诗雨你怎么看」→ 非 askAll（落 normal 由点名/推断兜底）', () => {
    expect(multi('诗雨你怎么看').kind).not.toBe('askAll');
  });
  it('单人会晤不触发：同句 isMulti=false → normal', () => {
    expect(single('你们有什么看法').kind).toBe('normal');
  });
  it('非会晤态不触发：「你们怎么看」inMeeting=false → 非 askAll', () => {
    expect(idle('你们怎么看').kind).not.toBe('askAll');
  });
  it('集合列举+陈述不触发：「阿珍和诗雨都是好人」→ normal（无疑问结构）', () => {
    expect(multi('阿珍和诗雨都是好人').kind).toBe('normal');
  });
  it('无复数词的疑问不触发：「今天天气怎么样」→ normal（缺前件）', () => {
    expect(multi('今天天气怎么样').kind).toBe('normal');
  });
  it('单数+疑问不触发：「你觉得呢」→ normal（单数「你」，非你们）', () => {
    expect(multi('你觉得呢').kind).toBe('normal');
  });
  it('陈述+全称量词不触发：「大家都散了吧」→ normal（非疑问/征询）', () => {
    expect(multi('大家都散了吧').kind).toBe('normal');
  });
  it('非征询的有…句不触发：「你们都有工牌吗」以外形态——「都十点了」→ normal（缺疑问）', () => {
    expect(multi('都十点了').kind).toBe('normal');
  });
  it('祈使无征询对象不触发：「大家安静一下」→ normal（无疑问结构）', () => {
    expect(multi('大家安静一下').kind).toBe('normal');
  });
});

describe('P091 askAll 意图识别 · 判序与边界（6条）', () => {
  // 🔴 2026-11-02 对齐 D2 转场体验（a516a0b，业主 2026-11-01 批准）：
  //   会晤中点名由 `switch`（永久换主）改为 `addressOnly`（本轮顶替，下一轮请求开头
  //   dispatch SPEAK 恢复原主）。**判序不变** —— 点名仍必须先于 askAll 被拦，
  //   本组用例守的「先到先拦」优先级完全保留，只是「永久换主」这一前提已过时。
  it('点名优先于 askAll：「诗雨，你们觉得呢」→ addressOnly（称呼点名先拦）', () => {
    expect(multi('诗雨，你们觉得呢').kind).toBe('addressOnly');
  });
  it('@点名优先于 askAll：「@阿珍 你们觉得呢」→ addressOnly', () => {
    expect(multi('@阿珍 你们觉得呢').kind).toBe('addressOnly');
  });
  it('wake 优先于 askAll：「叫徐诗雨和阿珍过来你们怎么看」→ wake（聚集句先拦，句内含 askAll 触发词；无逗号防被称呼点名截获）', () => {
    expect(multi('叫徐诗雨和阿珍过来你们怎么看').kind).toBe('wake');
  });
  it('exit 优先：「散会」→ exit（不受 askAll 影响）', () => {
    expect(multi('散会').kind).toBe('exit');
  });
  it('加人句优先于 askAll：「叫安琪也来听听你们怎么看」→ addParticipant（句内含 askAll 触发词）', () => {
    expect(multi('叫安琪也来听听你们怎么看').kind).toBe('addParticipant');
  });
  it('兼容性：不传第5参（旧调用形态）行为不变——群聊句落 normal 而非误判', () => {
    expect(EntityMeeting.detectIntent('你们有什么看法', NAMES, true, ALIAS).kind).toBe('normal');
  });
});
