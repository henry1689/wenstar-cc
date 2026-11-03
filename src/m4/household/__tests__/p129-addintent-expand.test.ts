import { describe, it, expect } from 'vitest';
import { EntityMeeting } from '../EntityMeeting.js';

/**
 * P129 · 加人意图正则缺口修复 + 单人态扩员检测层用例
 * ============================================================
 * 裁决：豆包 P129（业主确认开工）｜诊断：P128 三问题
 *
 * 任务1（检测层，本文件覆盖）：
 *   ① add 动词表 +「找」——「找阿珍过来」曾落 normal（AI 口头答应去叫但人未加入）
 *   ② 新增「XX(你)也过来」句式——「阿珍你也过来」曾判 wake 被门卫拒
 *   宁窄勿滥：动词+尾词双校验，_fuzzyFindName 找不到人名即不命中（防误伤反例）
 *
 * 任务2/3（chat.ts 会晤中块：单人态 JOIN 扩员 + deny 文案显示待加入者）为编排层，
 *   由分支条件与生产回归覆盖——本文件锁定其**意图输入**（何句进扩员分支、何句仍 deny）。
 */

const NAMES = ['徐诗雨', '阿珍', '王全芬', '熊梓铭', '安琪', '徐诗韵', '张小龙', '熊梓玥'];
const ALIAS = new Map<string, string>([['诗雨', '徐诗雨'], ['阿芬', '王全芬'], ['梓铭', '熊梓铭'], ['韵韵', '徐诗韵'], ['阿珍', '罗珍思']]);

/** 群聊态 / 单人会晤态 / 非会晤态 */
const multi = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, true, ALIAS, true);
const single = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, true, ALIAS, false);
const idle = (msg: string) => EntityMeeting.detectIntent(msg, NAMES, false, ALIAS, false);

describe('P129 任务1 · add 正则扩词「找」（P127 实测句回归）', () => {
  it('「这样找阿珍过来一起聊聊」→ add（曾落 normal 致 AI 口头答应人未加入）', () => {
    const r = single('这样找阿珍过来一起聊聊');
    expect(r.kind).toBe('addParticipant');
    expect(r.targets).toContain('阿珍');
  });
  it('「找阿珍过来」（短句）→ add', () => {
    expect(single('找阿珍过来').kind).toBe('addParticipant');
  });
  it('非会晤态「找阿珍过来」→ add（chat.ts S4-FIX 并入 _enterTargets 唤醒进入）', () => {
    expect(idle('找阿珍过来').kind).toBe('addParticipant');
  });
  it('群聊态「找王全芬过来」→ add（多人群聊加人保持可用）', () => {
    expect(multi('找王全芬过来').kind).toBe('addParticipant');
  });
});

describe('P129 任务1 · 新句式「XX(你)也过来」（P127 实测句回归）', () => {
  it('「阿珍你也过来一起聊聊」→ add（曾判 wake 被门卫拒）', () => {
    const r = single('阿珍你也过来一起聊聊');
    expect(r.kind).toBe('addParticipant');
    expect(r.targets).toContain('阿珍');
  });
  it('「王全芬也来」→ add（无“你”也命中）', () => {
    const r = single('王全芬也来');
    expect(r.kind).toBe('addParticipant');
    expect(r.targets).toEqual(['王全芬']);
  });
});

describe('P129 任务1 · 宁窄勿滥反例（不命中 add）', () => {
  it('「找个地方聊聊」→ 非 add（尾词「聊」不匹配）', () => {
    expect(single('找个地方聊聊').kind).not.toBe('addParticipant');
  });
  it('「找阿珍聊聊」→ 非 add（保持既有 wake/唤醒行为，尾词不匹配）', () => {
    expect(single('找阿珍聊聊').kind).not.toBe('addParticipant');
  });
  it('「找徐诗雨和阿珍过来一起聊聊」→ 非 add（6字超 2-4 字捕获 → 落 wake 多目标，由扩员分支接手）', () => {
    const r = single('找徐诗雨和阿珍过来一起聊聊');
    expect(r.kind).not.toBe('addParticipant');
    expect(r.kind).toBe('wake');
    expect(r.targets.length).toBeGreaterThanOrEqual(2);
  });
  it('「我们也来」→ 非 add（fuzzyFindName 找不到「们」）', () => {
    expect(single('我们也来').kind).not.toBe('addParticipant');
  });
  it('「大家都来吧」→ 非 add（无 2-4 字人名候选）', () => {
    expect(single('大家都来吧').kind).not.toBe('addParticipant');
  });
});

describe('P129 任务2 · 扩员分支的意图输入（单人态多目标 wake 保留）', () => {
  it('「找徐诗雨和阿珍一起聊聊」单人态 → wake 多目标（→ chat.ts 扩员分支 JOIN 新增者）', () => {
    const r = single('找徐诗雨和阿珍一起聊聊');
    expect(r.kind).toBe('wake');
    expect(r.targets).toEqual(expect.arrayContaining(['徐诗雨']));
    expect(r.targets.length).toBeGreaterThanOrEqual(2);
  });
  it('别名归一：「找诗雨和阿珍过来」→ 目标含主名徐诗雨', () => {
    const r = single('找诗雨和阿珍过来');
    expect(r.kind === 'wake' || r.kind === 'addParticipant').toBe(true);
    if (r.kind === 'wake') expect(r.targets).toContain('徐诗雨');
  });
});

describe('P129 任务2/3 · 判序不回归（P113 关键用例抽查）', () => {
  it('exit 优先：「散会」→ exit（不受新句式影响）', () => {
    expect(single('散会').kind).toBe('exit');
  });
  it('switch 仍独立：「换熊梓铭来」→ switch', () => {
    expect(single('换熊梓铭来').kind).toBe('switch');
  });
  it('askAll 不受扰：「你们觉得呢」群聊态 → askAll', () => {
    expect(multi('你们觉得呢').kind).toBe('askAll');
  });
  it('点名 switch 优先：「阿珍，你也过来」（带逗号）→ 不误判为 add', () => {
    const r = single('阿珍，你也过来');
    expect(r.kind).not.toBe('addParticipant');
  });
});
