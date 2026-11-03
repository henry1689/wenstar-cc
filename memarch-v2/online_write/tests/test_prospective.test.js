/**
 * M2 测试：前瞻记忆在线抽取
 */
import { describe, it, expect } from 'vitest';
import { ProspectiveExtractor } from '../ProspectiveExtractor.js';
import { createTestDb } from './helpers/db.js';
import { WriteQueue } from '../../storage/write_queue/WriteQueue.js';

describe('ProspectiveExtractor', () => {
  const db = createTestDb();
  const writer = new WriteQueue(db);
  const extractor = new ProspectiveExtractor(writer);

  it('承诺类应被识别', () => {
    const items = extractor.extract(
      '我答应你，下次一定请你吃饭',
      'msg_001', 'user'
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.kind === 'promise')).toBe(true);
  });

  it('提醒类应被识别', () => {
    const items = extractor.extract(
      '别忘了明天下午三点开会，记得提醒我',
      'msg_002', 'user'
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.kind === 'reminder')).toBe(true);
  });

  it('计划类应被识别', () => {
    const items = extractor.extract(
      '我们下周去杭州玩吧，计划着去西湖看看',
      'msg_003', 'user'
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.kind === 'plan')).toBe(true);
  });

  it('纪念日类应被识别', () => {
    const items = extractor.extract(
      '下个月是我们的结婚纪念日，准备庆祝一下',
      'msg_004', 'user'
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.kind === 'anniversary')).toBe(true);
  });

  it('普通闲聊不应抽取出前瞻记忆', () => {
    const items = extractor.extract(
      '今天天气真不错，出去散步了',
      'msg_005', 'user'
    );
    expect(items.length).toBe(0);
  });

  it('召回率测试：20 个承诺/提醒句子 ≥ 80%', () => {
    const testCases = [
      '我答应你不会再忘了',
      '下次一定请你吃饭',
      '别忘了明天交报告',
      '记得提醒我下午三点吃药',
      '到时候说一声',
      '我们下周去深圳出差',
      '约好了周六看电影',
      '下个月是我妈妈生日',
      '我保证以后不熬夜了',
      '我一定会记得这件事的',
      '到时候提醒我带钥匙',
      '计划着年底买辆新车',
      '明年是我们认识五周年',
      '答应我照顾好自己',
      '别忘了给花浇水',
      '准备下周一去体检',
      '周日要去参加朋友婚礼',
      '我发誓再也不迟到了',
      '记得下班买瓶酱油',
      '安排了下个月的旅行',
    ];

    let hit = 0;
    for (const text of testCases) {
      const items = extractor.extract(text, 'test', 'user');
      if (items.length > 0) hit++;
    }
    const recall = hit / testCases.length;
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});
