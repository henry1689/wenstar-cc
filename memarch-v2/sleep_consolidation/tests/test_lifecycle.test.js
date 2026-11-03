/**
 * M3 单元测试：生命周期状态机
 */

import { describe, it, expect } from 'vitest';
import { LifecycleStateMachine } from '../lifecycle/LifecycleStateMachine.js';

describe('LifecycleStateMachine', () => {
  const sm = new LifecycleStateMachine();

  it('fresh + 高巩固度 + 足够周期 → consolidated', () => {
    const result = sm.transition({
      currentState: 'fresh',
      consolidation: 0.75,
      activation: 0.5,
      sleepCyclesSurvived: 4,
      salience: 0.6,
      nRefs: 5,
      isLandmark: false,
      anchorExempt: false,
      daysSinceLastRecall: 1,
    });
    expect(result.nextState).toBe('consolidated');
    expect(result.shouldPromote).toBe(true);
  });

  it('consolidation 极低 → expiring', () => {
    const result = sm.transition({
      currentState: 'fresh',
      consolidation: 0.1,
      activation: 0.1,
      sleepCyclesSurvived: 1,
      salience: 0.2,
      nRefs: 1,
      isLandmark: false,
      anchorExempt: false,
      daysSinceLastRecall: 10,
    });
    expect(result.nextState).toBe('expiring');
    expect(result.shouldDemote).toBe(true);
  });

  it('黑钻地标记忆豁免衰减', () => {
    const result = sm.transition({
      currentState: 'fresh',
      consolidation: 0.05,
      activation: 0,
      sleepCyclesSurvived: 1,
      salience: 0.1,
      nRefs: 1,
      isLandmark: true,
      anchorExempt: false,
      daysSinceLastRecall: 100,
    });
    expect(result.nextState).toBe('consolidated');
  });

  it('tombstone 是终态，不再转换', () => {
    const result = sm.transition({
      currentState: 'tombstone',
      consolidation: 0,
      activation: 0,
      sleepCyclesSurvived: 10,
      salience: 0,
      nRefs: 0,
      isLandmark: false,
      anchorExempt: false,
      daysSinceLastRecall: 999,
    });
    expect(result.nextState).toBe('tombstone');
  });

  it('shouldEnterTombstone: expiring + 极低巩固度 + 长期未回忆', () => {
    const should = sm.shouldEnterTombstone({
      currentState: 'expiring',
      consolidation: 0.03,
      activation: 0,
      sleepCyclesSurvived: 10,
      salience: 0.1,
      nRefs: 1,
      isLandmark: false,
      anchorExempt: false,
      daysSinceLastRecall: 70,
    });
    expect(should).toBe(true);
  });
});
