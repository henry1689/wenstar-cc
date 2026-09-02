/**
 * profile-acquisition-guard.test.ts — P1-4 PAE 档案信号检测 + 超时配置
 * ==============================================
 * hasProfileSignal：消息含档案事实陈述 → 走 LLM 采集；纯提及/闲聊 → 短路跳过
 * getPAETimeoutMs：读 p1_speed.llm_reduction.pae_timeout_ms（8000）
 */
import { describe, it, expect } from 'vitest';
import { hasProfileSignal, getPAETimeoutMs } from '../profile-acquisition-guard.js';

describe('hasProfileSignal — P1-4 PAE 档案信号', () => {
  it('介绍/归属句式（X是(我的)妈妈）→ true', () => {
    expect(hasProfileSignal('这是我妈')).toBe(true);
    expect(hasProfileSignal('王丽是我妈妈')).toBe(true);
    expect(hasProfileSignal('他是我的男朋友')).toBe(true);
  });
  it('所有格（X的妈妈/爸爸）→ true', () => {
    expect(hasProfileSignal('小明的爸爸是医生')).toBe(true);
  });
  it('职业/工作 → true', () => {
    expect(hasProfileSignal('我在华为上班')).toBe(true);
    expect(hasProfileSignal('他是程序员')).toBe(true);
    expect(hasProfileSignal('我换工作了')).toBe(true);
  });
  it('年龄/生日 → true', () => {
    expect(hasProfileSignal('他今年25岁')).toBe(true);
    expect(hasProfileSignal('下周是我生日')).toBe(true);
  });
  it('姓名陈述 → true', () => {
    expect(hasProfileSignal('他叫王小明')).toBe(true);
  });
  it('健康/状态 → true', () => {
    expect(hasProfileSignal('我妈住院了')).toBe(true);
  });
  it('纯提及人名（无档案事实）→ false', () => {
    expect(hasProfileSignal('小王昨天也来了')).toBe(false);
    expect(hasProfileSignal('刚才看到张伟了')).toBe(false);
  });
  it('纯闲聊 → false', () => {
    expect(hasProfileSignal('今天天气真不错')).toBe(false);
    expect(hasProfileSignal('嗯嗯好的')).toBe(false);
  });
  it('空输入 → false', () => {
    expect(hasProfileSignal('')).toBe(false);
  });
});

describe('getPAETimeoutMs — P1-4 超时配置', () => {
  it('读 yaml p1_speed.llm_reduction.pae_timeout_ms（30s，原 8s 放宽）', () => {
    expect(getPAETimeoutMs()).toBe(30000);
  });
});
