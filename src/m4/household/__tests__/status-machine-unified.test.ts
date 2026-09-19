/**
 * 批13 部分1：状态机统一 —— 行为等价性测试
 *
 * 背景：项目有 3 份状态机实现，其中 FamilyGraph.runDailyHouseholdMaintenance 硬编码
 * 90/365 且不认识 candidate。本批统一到 StatusRules.computeTargetStatus（唯一真源）。
 *
 * 本测试固化「统一前必须保证等价的既有行为」，防止统一引入回归：
 *   - active/dormant/archived 的阈值与方向不变
 *   - deceased/archived/void 不受自动流转影响
 *   - 新增：candidate 专属生命周期（30 天 → void），且不走 dormant/archived
 */
import { describe, it, expect } from 'vitest';
import { computeTargetStatus, STATUS_THRESHOLDS } from '../shared/StatusRules.js';

const D = STATUS_THRESHOLDS;

describe('批13 · 状态机统一：既有行为等价性（回归防线）', () => {
  it('active + 超 90 天无交互 → dormant', () => {
    const r = computeTargetStatus('active', D.DORMANT_AFTER_DAYS + 1);
    expect(r.changed).toBe(true);
    if (r.changed) { expect(r.to).toBe('dormant'); expect(r.from).toBe('active'); }
  });

  it('active + 恰好 90 天 → 不变（用 > 而非 >=）', () => {
    expect(computeTargetStatus('active', D.DORMANT_AFTER_DAYS).changed).toBe(false);
  });

  it('active + 90 天内 → 不变', () => {
    expect(computeTargetStatus('active', 10).changed).toBe(false);
  });

  it('dormant + 超 365 天 → archived', () => {
    const r = computeTargetStatus('dormant', D.ARCHIVE_AFTER_DAYS + 1);
    expect(r.changed).toBe(true);
    if (r.changed) expect(r.to).toBe('archived');
  });

  it('dormant + 90 天内 → 恢复 active', () => {
    const r = computeTargetStatus('dormant', 30);
    expect(r.changed).toBe(true);
    if (r.changed) { expect(r.to).toBe('active'); expect(r.from).toBe('dormant'); }
  });

  it('dormant + 90~365 天区间 → 不变（既不归档也不恢复）', () => {
    expect(computeTargetStatus('dormant', 200).changed).toBe(false);
  });

  it('终点态 deceased/archived/void 一律不自动流转', () => {
    for (const s of ['deceased', 'archived', 'void']) {
      expect(computeTargetStatus(s, 10).changed, s + ' 不应流转').toBe(false);
      expect(computeTargetStatus(s, 999).changed, s + ' 不应流转').toBe(false);
    }
  });

  it('阈值常量未被改动（统一状态机的前提）', () => {
    expect(D.DORMANT_AFTER_DAYS).toBe(90);
    expect(D.ARCHIVE_AFTER_DAYS).toBe(365);
    expect((D as any).CANDIDATE_EXPIRE_DAYS).toBe(30);
  });
});

describe('批13 · candidate 专属生命周期（本批新增能力）', () => {
  it('candidate + 超 30 天 → void（观察区超期回收）', () => {
    const r = computeTargetStatus('candidate', D.CANDIDATE_EXPIRE_DAYS + 1);
    expect(r.changed).toBe(true);
    if (r.changed) { expect(r.to).toBe('void'); expect(r.from).toBe('candidate'); }
  });

  it('candidate + 30 天内 → 不变（给证据累积/梦境判定留时间）', () => {
    expect(computeTargetStatus('candidate', 5).changed).toBe(false);
    expect(computeTargetStatus('candidate', D.CANDIDATE_EXPIRE_DAYS).changed).toBe(false);
  });

  it('candidate 不走 dormant/archived（即使天数很大）', () => {
    const r = computeTargetStatus('candidate', 500);
    expect(r.changed).toBe(true);
    if (r.changed) expect(r.to).toBe('void');
  });
});
