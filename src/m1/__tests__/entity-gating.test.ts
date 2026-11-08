/**
 * entity-gating.test.ts — 批2（ADR-020）：独立 LLM 实体提取已物理退场
 * ================================================================
 * 本文件原先是 P1-3「实体信号检测 + 条件化 LLM 提取」的测试。
 * 批2 起，实体取证并入**主回复调用**（`entity: 名称|类型|证据原文`），
 * 准入只由「证据必须是用户消息连续子串」决定；旧的启发式信号检测与
 * `LLMEntityExtractor` 一并退场。
 *
 * 本文件改为**退役断言**：任何把旧提取接回来的改动都会在这里失败。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyAdmission, parseEntityEvidence } from '../entity-admission.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('批2 · 旧提取入口退役', () => {
  it('🔴 LLMEntityExtractor.ts 已物理删除（禁止复活）', () => {
    expect(existsSync(join(HERE, '../LLMEntityExtractor.ts'))).toBe(false);
  });

  it('🔴 准入改由原文证据决定：证据不在消息里 → 拒绝', () => {
    expect(verifyAdmission({ name: '安琪', type: 'person', evidence: '她叫安琪' }, '她叫安琪，是我同事').admitted).toBe(true);
    expect(verifyAdmission({ name: '安琪', type: 'person', evidence: '她叫安琪' }, '今天天气不错').admitted).toBe(false);
  });

  it('🔴 无启发式信号：短句没有"像人名"也不准入，长句有关键词也不自动准入', () => {
    // 旧实现 hasEntitySignal 会对"阿珍""张总"等形态直接放行；现在没有这层
    expect(verifyAdmission({ name: '阿珍', type: 'person', evidence: '阿珍' }, '今天好累').admitted).toBe(false);
    expect(parseEntityEvidence('阿珍来了').present).toBe(false);
  });
});
