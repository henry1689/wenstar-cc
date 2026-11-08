/**
 * 批3（2026-11-08，ADR-021）：FG 观察区(candidate)机制已物理拆除 —— 退役断言
 *
 * 本文件原为「批12 观察区机制」回归测试（283 行、5 个晋升断言）。
 * 业主 2026-11-07 裁决「完全取消观察区流程，物理清除避免死灰复燃」，
 * 批3 已删除 _accumulateCandidateEvidence / collectCandidateItems / applyJudgments
 * 以及 candidate 初始化、晋升与超期规则。保留以下断言，防止机制被重新接回。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FamilyGraph } from '../FamilyGraph.js';
import { computeTargetStatus, STATUS_THRESHOLDS } from '../shared/StatusRules.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_SRC_PATH = join(HERE, '..', 'FamilyGraph.ts');

describe('批3 · 观察区已退役', () => {
  it('三个观察区方法已从 FamilyGraph 物理删除', () => {
    const fg: any = new FamilyGraph();
    expect(fg._accumulateCandidateEvidence).toBeUndefined();
    expect(fg.collectCandidateItems).toBeUndefined();
    expect(fg.applyJudgments).toBeUndefined();
  });

  it('状态机不再有 candidate 超期规则，阈值常量已删除', () => {
    expect((STATUS_THRESHOLDS as any).CANDIDATE_EXPIRE_DAYS).toBeUndefined();
    expect(computeTargetStatus('candidate', 999).changed).toBe(false);
  });

  it('源码中不再有 candidate 写入/晋升（防死灰复燃）', () => {
    const src = readFileSync(FG_SRC_PATH, 'utf-8');
    // 只匹配真实语句（注释里允许保留历史说明）
    expect(src).not.toMatch(/initialStatus\s*=\s*'candidate'\s*;/);
    expect(src).not.toMatch(/UPDATE nodes SET status\s*=\s*'candidate'/);
    expect(src).not.toContain('_accumulateCandidateEvidence(');
    expect(src).not.toContain('collectCandidateItems(');
    expect(src).not.toContain('applyJudgments(');
  });
});
