/**
 * landmark-gate.test.ts — 地标晋升闸门守卫（2026-10-18，业主批准方案A-①a）
 * ============================================================
 * 被守的缺陷（生产实测 2026-10-18）：
 *   全库 8957/11157 = 80% 记忆被标 is_landmark=1（阿珍 614/618 = 99.4%）。
 *   「地标 = 少数重要记忆」的稀缺语义名存实亡 ——
 *   `WHERE is_landmark=1 ORDER BY calcium DESC` 的召回路径退化为纯钙化排序，
 *   而 95% 记忆钙化 < 1 ⇒ 区分度归零。
 * 根因：实现远松于文档契约（LIFECYCLE_RULES 写 calcium>=0.65，
 *   ConsolidationQueue 实现 0.25、M8FusionAdapter 取 recent[0] 无条件标）。
 *
 * 本测试锁定：
 *   G1. isLandmarkWorthy 判据 = 文档契约（0.65 / 1.5 / recall3+strength0.5 三路）；
 *   G2. 三个消费方（文档规则表 + ConsolidationQueue + M8FusionAdapter）都必须接闸门，
 *       且不得再出现旧的宽松判据（0.25 / recent[0] 无条件）——能力断言防回退。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLandmarkWorthy, LANDMARK_RULE, LIFECYCLE_RULES } from '../MemoryLifecycleProtocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ── G1: 判据行为 ─────────────────────────────────────
describe('G1 — isLandmarkWorthy 判据（= LIFECYCLE_RULES 文档契约）', () => {
  it('三路全不满足 ⇒ 不够格', () => {
    expect(isLandmarkWorthy({ calcium_score: 0.3, reinforcement_accumulator: 0, recall_count: 0, effective_strength: 0.3 })).toBe(false);
  });

  it('路① calcium >= 0.65 ⇒ 够格', () => {
    expect(isLandmarkWorthy({ calcium_score: 0.65 })).toBe(true);
    expect(isLandmarkWorthy({ calcium_score: 0.64 })).toBe(false); // 边界下沿不够
  });

  it('路② reinforcement >= 1.5 ⇒ 够格（钙化低也行）', () => {
    expect(isLandmarkWorthy({ calcium_score: 0.1, reinforcement_accumulator: 1.5 })).toBe(true);
    expect(isLandmarkWorthy({ calcium_score: 0.1, reinforcement_accumulator: 1.4 })).toBe(false);
  });

  it('路③ recall >= 3 且 strength > 0.5 ⇒ 够格；strength 不够则否', () => {
    expect(isLandmarkWorthy({ calcium_score: 0.1, recall_count: 3, effective_strength: 0.51 })).toBe(true);
    expect(isLandmarkWorthy({ calcium_score: 0.1, recall_count: 3, effective_strength: 0.5 })).toBe(false); // 须 >0.5
    expect(isLandmarkWorthy({ calcium_score: 0.1, recall_count: 2, effective_strength: 0.9 })).toBe(false);
  });

  it('字段缺省按 0 处理（不抛错、不误放行）', () => {
    expect(isLandmarkWorthy({})).toBe(false);
    expect(isLandmarkWorthy({ calcium_score: undefined, recall_count: undefined })).toBe(false);
  });

  it('实测样本：全库 95% 记忆（钙化<1、零召回）必须被拒 —— 闸门真的能止血', () => {
    // 阿珍典型样本（2026-10-18 生产实测）
    expect(isLandmarkWorthy({ calcium_score: 0.41, reinforcement_accumulator: 0, recall_count: 0, effective_strength: 1.0 })).toBe(false);
    expect(isLandmarkWorthy({ calcium_score: 0.91, reinforcement_accumulator: 0, recall_count: 1, effective_strength: 0.9 })).toBe(true);
  });

  it('LANDMARK_RULE 常量与文档规则表 gold→landmark 条款一致（防两处漂移）', () => {
    const rule = LIFECYCLE_RULES.find((r) => r.from === 'gold' && r.to === 'landmark');
    expect(rule).toBeTruthy();
    const cond = rule!.conditions.join(' ');
    expect(cond).toContain(String(LANDMARK_RULE.minCalcium));       // 0.65
    expect(cond).toContain(String(LANDMARK_RULE.minReinforcement)); // 1.5
    expect(cond).toContain('recallCount >= 3');
  });
});

// ── G2: 消费方接线能力断言（防回退）─────────────────────
describe('G2 — 消费方必须接闸门（能力断言）', () => {
  const cq = readFileSync(join(REPO, 'src', 'm7', 'ConsolidationQueue.ts'), 'utf8');
  const m8 = readFileSync(join(REPO, 'src', 'm8', 'M8FusionAdapter.ts'), 'utf8');

  it('ConsolidationQueue 必须消费 isLandmarkWorthy', () => {
    expect(cq).toMatch(/import \{ isLandmarkWorthy \} from '\.\.\/m2\/MemoryLifecycleProtocol\.js'/);
    expect(cq).toMatch(/isLandmarkWorthy\(candidate\)/);
  });

  it('ConsolidationQueue 旧宽松判据 calcium>=0.25 必须消失', () => {
    expect(cq).not.toMatch(/calcium_score >= 0\.25/);
  });

  it('M8FusionAdapter 必须消费 isLandmarkWorthy（两条路径都接）', () => {
    expect(m8).toMatch(/import \{ isLandmarkWorthy \} from '\.\.\/m2\/MemoryLifecycleProtocol\.js'/);
    // 路径一：相似命中强化；路径二：高情感强度新建锚点
    const calls = m8.match(/isLandmarkWorthy\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('M8FusionAdapter「recent[0] 无条件标地标」必须消失 —— 改为 find 够格者', () => {
    expect(m8).not.toMatch(/promoteToLandmark\(\s*recent\[0\]\.id/);
    expect(m8).toMatch(/recent\.find\(\(r\) => isLandmarkWorthy\(r\)\)/);
  });
});
