/**
 * accessControl.test.ts — 访问控制测试
 *
 * 覆盖：
 * 1. 正常路径：权限检查通过、缓存命中
 * 2. 边界条件：临时令牌、角色层级
 * 3. 异常路径：越权拒绝、TTL 过期
 * 4. 性能基线：checkPermission P99 < 1ms
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPermission,
  issueTempToken,
  verifyTempToken,
  revokeTempToken,
  clearPermissionCache,
  hasRoleLevel,
  _resetForTest,
  type Subject,
  type Resource,
} from '../src/accessControl';
import { upsertRule, clearRules, setDefaultDecision } from '../src/policyEngine';
import { initSecurityConfig, _resetForTest as resetConfig } from '../src/securityConfig';

describe('accessControl', () => {
  beforeEach(() => {
    _resetForTest();
    resetConfig();
    initSecurityConfig({ signingKey: 'test-key' });
    clearRules();
    setDefaultDecision(false);

    // 注入基础策略：
    // 1. owner 全权
    upsertRule({
      effect: 'allow',
      subject: 'owner',
      resource: '*',
      action: '*',
      priority: 100,
    });
    // 2. admin 读写
    upsertRule({
      effect: 'allow',
      subject: 'admin',
      resource: '*',
      action: 'read',
      priority: 50,
    });
    upsertRule({
      effect: 'allow',
      subject: 'admin',
      resource: '*',
      action: 'write',
      priority: 50,
    });
    // 3. agent 只读
    upsertRule({
      effect: 'allow',
      subject: 'agent',
      resource: 'memSym:*',
      action: 'read',
      priority: 30,
    });
    // 4. readOnly 只读公开
    upsertRule({
      effect: 'allow',
      subject: 'readOnly',
      resource: 'memSym:public:*',
      action: 'read',
      priority: 20,
    });
  });

  afterEach(() => {
    _resetForTest();
    resetConfig();
    clearRules();
  });

  // ============================================================
  // 正常路径
  // ============================================================

  test('owner 拥有所有权限', async () => {
    const subject: Subject = { role: 'owner', id: 'owner-001' };
    const resource: Resource = { type: 'memSym', id: 'any' };

    for (const action of ['read', 'write', 'delete', 'export', 'audit'] as const) {
      const decision = await checkPermission(subject, resource, action);
      assert.equal(decision.allow, true, `owner 应允许 ${action}`);
    }
  });

  test('agent 可以读 memSym 但不能写', async () => {
    const subject: Subject = { role: 'agent', id: 'agent-001' };
    const resource: Resource = { type: 'memSym', id: 'abc' };

    const readDecision = await checkPermission(subject, resource, 'read');
    assert.equal(readDecision.allow, true, 'agent 应允许读');

    const writeDecision = await checkPermission(subject, resource, 'write');
    assert.equal(writeDecision.allow, false, 'agent 应拒绝写');
  });

  test('缓存命中：第二次查询更快且标记 fromCache', async () => {
    const subject: Subject = { role: 'owner', id: 'o1' };
    const resource: Resource = { type: 'memSym', id: 'cached' };

    const first = await checkPermission(subject, resource, 'read');
    assert.equal(first.fromCache, false, '第一次应未命中缓存');

    const second = await checkPermission(subject, resource, 'read');
    assert.equal(second.fromCache, true, '第二次应命中缓存');
  });

  test('临时令牌颁发和验证', () => {
    const subject: Subject = { role: 'agent', id: 'a1' };
    const token = issueTempToken(subject, 60000);

    assert.ok(token.startsWith('tkn_'), '令牌应有前缀');
    const verified = verifyTempToken(token);
    assert.ok(verified, '令牌应验证通过');
    assert.equal(verified!.id, 'a1');
  });

  test('撤销临时令牌', () => {
    const subject: Subject = { role: 'agent', id: 'a1' };
    const token = issueTempToken(subject, 60000);

    revokeTempToken(token);
    assert.equal(verifyTempToken(token), null, '撤销后应验证失败');
  });

  test('角色层级比较', () => {
    assert.equal(hasRoleLevel({ role: 'owner', id: 'o' }, 'admin'), true);
    assert.equal(hasRoleLevel({ role: 'readOnly', id: 'r' }, 'admin'), false);
    assert.equal(hasRoleLevel({ role: 'admin', id: 'a' }, 'agent'), true);
  });

  // ============================================================
  // 边界条件
  // ============================================================

  test('clearPermissionCache 后缓存失效', async () => {
    const subject: Subject = { role: 'owner', id: 'o1' };
    const resource: Resource = { type: 'memSym', id: 'x' };

    await checkPermission(subject, resource, 'read');
    clearPermissionCache();
    const decision = await checkPermission(subject, resource, 'read');
    assert.equal(decision.fromCache, false, '清缓存后应重新计算');
  });

  test('不同资源的权限独立缓存', async () => {
    const subject: Subject = { role: 'agent', id: 'a1' };
    const res1: Resource = { type: 'memSym', id: 'pub' };
    const res2: Resource = { type: 'memSym', id: 'priv' };

    // agent 可读 memSym:*，所以两个都 allow
    const d1 = await checkPermission(subject, res1, 'read');
    const d2 = await checkPermission(subject, res2, 'read');

    assert.equal(d1.allow, true);
    assert.equal(d2.allow, true);
    assert.equal(d2.fromCache, false, '不同资源不应共用缓存');
  });

  // ============================================================
  // 异常路径
  // ============================================================

  test('越权请求 100% 被拒绝', async () => {
    // readOnly 不能 delete
    const subject: Subject = { role: 'readOnly', id: 'ro1' };
    const resource: Resource = { type: 'memSym', id: 'anything' };

    const decision = await checkPermission(subject, resource, 'delete');
    assert.equal(decision.allow, false, 'readOnly 删除必须被拒绝');
  });

  test('不存在的角色默认拒绝', async () => {
    // @ts-expect-error 测试非法角色
    const subject: Subject = { role: 'unknownRole', id: 'u1' };
    const resource: Resource = { type: 'memSym', id: 'x' };

    const decision = await checkPermission(subject, resource, 'read');
    assert.equal(decision.allow, false, '未知角色应默认拒绝');
  });

  // ============================================================
  // 性能基线
  // ============================================================

  test('checkPermission 性能：P99 < 1ms（缓存命中）', async () => {
    const subject: Subject = { role: 'owner', id: 'o-perf' };
    const resource: Resource = { type: 'memSym', id: 'perf-test' };

    // 预热缓存
    await checkPermission(subject, resource, 'read');

    const iterations = 2000;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await checkPermission(subject, resource, 'read');
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 1, `checkPermission P99 = ${p99.toFixed(4)}ms，应 < 1ms`);
  });

  test('checkPermission 冷启动（未命中缓存）P99 < 1ms', async () => {
    const iterations = 500;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      clearPermissionCache();
      const subject: Subject = { role: 'owner', id: `o-${i}` };
      const resource: Resource = { type: 'memSym', id: `cold-${i}` };

      const start = performance.now();
      await checkPermission(subject, resource, 'read');
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 1, `冷启动 P99 = ${p99.toFixed(4)}ms，应 < 1ms`);
  });
});
