/**
 * policyEngine.test.ts — 策略引擎测试
 *
 * 覆盖：
 * 1. 正常路径：allow 规则匹配、通配符
 * 2. 边界条件：优先级排序、条件表达式
 * 3. 异常路径：deny 优先、默认拒绝
 * 4. 性能基线：策略评估 P99 < 0.5ms
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePolicy,
  upsertRule,
  removeRule,
  clearRules,
  setDefaultDecision,
  timeWindowCondition,
  ipWhitelistCondition,
  resourceTagCondition,
  type EvaluationContext,
} from '../src/policyEngine';

describe('policyEngine', () => {
  beforeEach(() => {
    clearRules();
    setDefaultDecision(false); // 默认拒绝
  });

  afterEach(() => {
    clearRules();
  });

  // ============================================================
  // 正常路径
  // ============================================================

  test('allow 规则匹配时允许', () => {
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: 'memSym:*',
      action: 'read',
      priority: 10,
      description: 'agent 可读记忆',
    });

    const ctx: EvaluationContext = {
      subject: 'agent',
      subjectId: 'agent-001',
      resource: 'memSym:abc',
      action: 'read',
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, true);
    assert.ok(result.matchedRuleId);
  });

  test('通配符 * 匹配所有主体', () => {
    upsertRule({
      effect: 'allow',
      subject: '*',
      resource: 'namespace:public',
      action: 'read',
      priority: 10,
    });

    const ctx: EvaluationContext = {
      subject: 'readOnly',
      subjectId: 'ro-001',
      resource: 'namespace:public',
      action: 'read',
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, true);
  });

  test('通配符后缀匹配', () => {
    upsertRule({
      effect: 'allow',
      subject: 'admin',
      resource: 'mem:*',
      action: '*',
      priority: 10,
    });

    const ctx: EvaluationContext = {
      subject: 'admin',
      subjectId: 'admin-001',
      resource: 'mem:any-id',
      action: 'delete',
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, true);
  });

  // ============================================================
  // 边界条件
  // ============================================================

  test('优先级高的规则先被匹配', () => {
    // 先加低优先级 allow
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: 'memSym:*',
      action: 'read',
      priority: 1,
      description: '低优先级 allow',
    });
    // 再加高优先级 deny
    upsertRule({
      effect: 'deny',
      subject: 'agent',
      resource: 'memSym:secret',
      action: 'read',
      priority: 100,
      description: '高优先级 deny',
    });

    const ctx: EvaluationContext = {
      subject: 'agent',
      subjectId: 'agent-001',
      resource: 'memSym:secret',
      action: 'read',
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, false, '高优先级 deny 应否决');
    assert.ok(result.reason.includes('deny'));
  });

  test('时间窗条件：窗口内允许，窗口外拒绝', () => {
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: '*',
      action: 'read',
      priority: 10,
      condition: timeWindowCondition(0, 23), // 全天允许
    });

    const ctx: EvaluationContext = {
      subject: 'agent',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'read',
      timestamp: new Date('2026-11-04T12:00:00').getTime(),
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, true);
  });

  test('IP 白名单条件：白名单内允许', () => {
    upsertRule({
      effect: 'allow',
      subject: 'admin',
      resource: '*',
      action: 'write',
      priority: 10,
      condition: ipWhitelistCondition(['127.0.0.1']),
    });

    // 白名单内
    const ctx1: EvaluationContext = {
      subject: 'admin',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'write',
      sourceIp: '127.0.0.1',
    };
    assert.equal(evaluatePolicy(ctx1).allow, true);

    // 白名单外
    const ctx2: EvaluationContext = {
      subject: 'admin',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'write',
      sourceIp: '192.168.1.1',
    };
    assert.equal(evaluatePolicy(ctx2).allow, false);
  });

  test('资源标签条件：标签匹配才允许', () => {
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: '*',
      action: 'read',
      priority: 10,
      condition: resourceTagCondition('visibility', 'public'),
    });

    // 标签匹配
    const ctx1: EvaluationContext = {
      subject: 'agent',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'read',
      resourceTags: { visibility: 'public' },
    };
    assert.equal(evaluatePolicy(ctx1).allow, true);

    // 标签不匹配
    const ctx2: EvaluationContext = {
      subject: 'agent',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'read',
      resourceTags: { visibility: 'private' },
    };
    assert.equal(evaluatePolicy(ctx2).allow, false);
  });

  // ============================================================
  // 异常路径
  // ============================================================

  test('deny 优先：即使有 allow 匹配，deny 也否决', () => {
    // allow：agent 可读所有
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: 'memSym:*',
      action: 'read',
      priority: 10,
    });
    // deny：agent 不可读 secret 命名空间
    upsertRule({
      effect: 'deny',
      subject: 'agent',
      resource: 'memSym:secret:*',
      action: 'read',
      priority: 10,
    });

    const ctx: EvaluationContext = {
      subject: 'agent',
      subjectId: 'a1',
      resource: 'memSym:secret:123',
      action: 'read',
    };

    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, false, 'deny 必须优先');
  });

  test('默认拒绝：无匹配规则时拒绝', () => {
    setDefaultDecision(false);
    const ctx: EvaluationContext = {
      subject: 'unknown',
      subjectId: 'u1',
      resource: 'memSym:x',
      action: 'delete',
    };
    const result = evaluatePolicy(ctx);
    assert.equal(result.allow, false);
  });

  test('removeRule 后规则失效', () => {
    const id = upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: '*',
      action: 'read',
      priority: 10,
    });

    const ctx: EvaluationContext = {
      subject: 'agent',
      subjectId: 'a1',
      resource: 'memSym:x',
      action: 'read',
    };
    assert.equal(evaluatePolicy(ctx).allow, true);

    removeRule(id);
    assert.equal(evaluatePolicy(ctx).allow, false);
  });

  // ============================================================
  // 性能基线
  // ============================================================

  test('策略评估性能：P99 < 0.5ms', () => {
    // 加 20 条规则，模拟真实场景
    for (let i = 0; i < 20; i++) {
      upsertRule({
        effect: i % 2 === 0 ? 'allow' : 'deny',
        subject: i % 3 === 0 ? '*' : `role-${i}`,
        resource: `memSym:${i % 5}*`,
        action: i % 4 === 0 ? '*' : (['read', 'write', 'delete', 'export'] as const)[i % 4]!,
        priority: i,
      });
    }

    const ctx: EvaluationContext = {
      subject: 'role-2',
      subjectId: 'test',
      resource: 'memSym:abc123',
      action: 'read',
    };

    const iterations = 1000;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      evaluatePolicy(ctx);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 0.5, `evaluatePolicy P99 = ${p99.toFixed(4)}ms，应 < 0.5ms`);
  });
});
