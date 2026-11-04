import { describe, it, expect } from 'vitest';
import { runGuard, extractAssertions, tokenize, hasNarrativeMarker } from '../outputGuard.js';
import { DEFAULT_CONFIG } from '../config.js';
import { ev } from './helpers.js';

const cfg = DEFAULT_CONFIG.guard;

describe('outputGuard.ts — 两级校验', () => {
  it('断言抽取：按标点切句', () => {
    const assertions = extractAssertions('你喜欢喝咖啡。上次在东莞见过。感觉很好！');
    expect(assertions).toHaveLength(3);
    expect(assertions[0].text).toContain('你喜欢喝咖啡');
  });

  it('tokenize：中文 2-gram + 英文词', () => {
    const tokens = tokenize('你喜欢喝咖啡');
    expect(tokens).toContain('喜欢');
    expect(tokens).toContain('咖啡');
    expect(tokens).toContain('喜欢喝');
  });

  it('蕴含验证：断言与证据重合 → 通过', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡，特别是拿铁' })];
    const result = runGuard({
      candidate_utterance: '你喜欢喝咖啡。',
      evidences,
      routed_path: 'A_direct',
      config: cfg,
    });
    expect(result.guard_passed).toBe(true);
    expect(result.dropped_assertions).toHaveLength(0);
    expect(result.utterance).toContain('咖啡');
  });

  it('虚构率 < 1%：无证据的断言被拦下来', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡' })];
    // 候选 utterance 里塞一条捏造的事实
    const result = runGuard({
      candidate_utterance: '你喜欢喝咖啡。你昨天去了北京。',
      evidences,
      routed_path: 'A_direct',
      config: cfg,
    });
    // "你昨天去了北京" 无证据 → 必须被丢
    const droppedTexts = result.dropped_assertions.map((a) => a.text);
    expect(droppedTexts.some((t) => t.includes('北京'))).toBe(true);
    // 输出里不能出现"北京"
    expect(result.utterance).not.toContain('北京');
  });

  it('虚构率 < 1%：整条 utterance 都无证据 → 吞掉，走 fallback', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡' })];
    const result = runGuard({
      candidate_utterance: '你昨天去北京出差。天气很好。',
      evidences,
      routed_path: 'A_direct',
      config: cfg,
    });
    expect(result.utterance).toBe(cfg.fallback_no_evidence);
    expect(result.guard_passed).toBe(false);
  });

  it('零证据 → fallback，不硬编', () => {
    const result = runGuard({
      candidate_utterance: '随便说点什么',
      evidences: [],
      routed_path: 'B_only',
      config: cfg,
    });
    expect(result.utterance).toBe(cfg.fallback_no_evidence);
    expect(result.guard_passed).toBe(false);
  });

  it('通路 B：叙事标记检测', () => {
    expect(hasNarrativeMarker('我记得你说过这件事', cfg)).toBe(true);
    expect(hasNarrativeMarker('那天我们在东莞', cfg)).toBe(true);
    expect(hasNarrativeMarker('感觉好像有印象', cfg)).toBe(false);
  });

  it('通路 B：候选 utterance 含事实陈述 → 改写为暗示话术', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '某条 B-side 弱证据', pathway: 'B' })];
    const result = runGuard({
      candidate_utterance: '我记得你说过那天在东莞。',
      evidences,
      routed_path: 'B_only',
      config: cfg,
    });
    expect(result.rewritten_for_pathway_b).toBe(true);
    // 改写后的 utterance 不应再含叙事标记
    expect(hasNarrativeMarker(result.utterance, cfg)).toBe(false);
  });

  it('tombstone 证据不参与支撑验证', () => {
    const evidences = [ev({ uuid: 't1', raw_text: '你喜欢喝咖啡', tombstone: true })];
    const result = runGuard({
      candidate_utterance: '你喜欢喝咖啡。',
      evidences,
      routed_path: 'A_direct',
      config: cfg,
    });
    // tombstone 不可见 → 等于无证据 → fallback
    expect(result.utterance).toBe(cfg.fallback_no_evidence);
  });
});
