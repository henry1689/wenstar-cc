// 闲聊快路径判定边界（2026-11-07）
// ============================================================
// 背景：MemoryGate.decideMode 此前在生产链路无调用方（buildGuards 无消费者），
//   memoryGate 恒为默认 casual 而检索不读它 ⇒ 每轮跑完整 v11/Foundation。
//   本测锁定「哪些消息可以走快路径（casual）、哪些必须走完整链路」的边界：
//   casual → 跳过网络检索；knowledge_query / memory_recall / 感知增强 → 完整链路。
import { describe, it, expect } from 'vitest';
import { decideMode, type MemoryGateContext } from '../MemoryGate.js';

function ctx(message: string, over: Partial<MemoryGateContext> = {}): MemoryGateContext {
  return {
    message,
    recentHistory: [],
    isFollowUp: false,
    hasNewEntity: false,
    hasContinuationMarkers: false,
    calciumLevel: 0,
    messageLength: message.length,
    ...over,
  };
}

describe('MemoryGate — 闲聊快路径边界（2026-11-07）', () => {
  it('纯闲聊 → casual（可走快路径）', () => {
    for (const m of ['嗯', '好呀', '你在干嘛', '今天天气不错', '随便聊聊', '我想你了', '抱抱', '晚安']) {
      expect(decideMode(ctx(m)).mode, `「${m}」应为 casual`).toBe('casual');
    }
  });

  it('知识查询 → knowledge_query（必须走完整链路）', () => {
    for (const m of ['知识库里有没有相关资料', '什么是量子纠缠', '查一下这个原理']) {
      expect(decideMode(ctx(m)).mode, `「${m}」应为 knowledge_query`).toBe('knowledge_query');
    }
  });

  it('回忆类 → 非 casual（必须走完整链路）', () => {
    for (const m of ['你还记得上次我们去的那家店吗', '以前我们在海边那次', '后来呢']) {
      expect(decideMode(ctx(m)).mode, `「${m}」不应走快路径`).not.toBe('casual');
    }
  });

  // ⚠️ 已知边界（既有实现，非本批引入）：感知增强只作用于命中 CASUAL_MARKERS 的消息；
  //   纯默认 casual（如「嗯」）不走感知分支。此处按现有语义锁定可快路径的边界。
  it('感知增强：负面高唤醒 → memory_recall（命中闲聊词时也不走快路径）', () => {
    const p = { pleasure: -0.5, arousal: 0.6, intimacy: 0.1 } as any;
    expect(decideMode(ctx('好累', { perception: p })).mode).toBe('memory_recall');
  });

  it('感知增强：高亲密 → memory_recall（命中闲聊词时也不走快路径）', () => {
    const p = { pleasure: 0.2, arousal: 0.1, intimacy: 0.6 } as any;
    expect(decideMode(ctx('心情', { perception: p })).mode).toBe('memory_recall');
  });
});
