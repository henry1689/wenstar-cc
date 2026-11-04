/**
 * auditLog.test.ts — 审计日志测试
 *
 * 覆盖：
 * 1. 正常路径：写入日志、查询日志
 * 2. 边界条件：空链验证、范围查询
 * 3. 异常路径：哈希链篡改检测（100% 检出）、并发写入
 * 4. 性能基线：写入 P99 < 2ms
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  log,
  query,
  verifyChain,
  getChainHead,
  getLogCount,
  _resetForTest,
} from '../src/auditLog';
import { initSecurityConfig, _resetForTest as resetConfig } from '../src/securityConfig';

describe('auditLog', () => {
  beforeEach(() => {
    _resetForTest();
    resetConfig();
    initSecurityConfig({ signingKey: 'test-key' });
  });

  afterEach(() => {
    _resetForTest();
    resetConfig();
  });

  // ============================================================
  // 正常路径
  // ============================================================

  test('写入一条日志后链头更新', async () => {
    const headBefore = getChainHead();
    await log({
      subject: 'admin',
      action: 'read',
      resource: 'memSym:123',
      result: 'success',
    });
    const headAfter = getChainHead();
    assert.notEqual(headBefore, headAfter, '写入后链头应变化');
    assert.equal(getLogCount(), 1);
  });

  test('查询日志按条件过滤', async () => {
    await log({ subject: 'admin', action: 'read', resource: 'mem:1', result: 'success' });
    await log({ subject: 'agent', action: 'write', resource: 'mem:2', result: 'failure' });
    await log({ subject: 'admin', action: 'delete', resource: 'mem:3', result: 'success' });

    const adminLogs = query({ subject: 'admin' });
    assert.equal(adminLogs.length, 2, '应有 2 条 admin 日志');

    const failureLogs = query({ result: 'failure' });
    assert.equal(failureLogs.length, 1, '应有 1 条失败日志');
  });

  test('哈希链完整时验证通过', async () => {
    for (let i = 0; i < 10; i++) {
      await log({
        subject: 'test',
        action: 'read',
        resource: `mem:${i}`,
        result: 'success',
      });
    }

    const result = verifyChain();
    assert.equal(result.valid, true, '完整链应验证通过');
    assert.equal(result.totalEntries, 10);
  });

  test('范围验证：部分链校验', async () => {
    for (let i = 0; i < 5; i++) {
      await log({
        subject: 'test',
        action: 'read',
        resource: `mem:${i}`,
        result: 'success',
      });
    }

    const result = verifyChain(0, 2);
    assert.equal(result.valid, true, '前 3 条应完整');
  });

  // ============================================================
  // 边界条件
  // ============================================================

  test('空链验证通过', () => {
    const result = verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 0);
  });

  test('单条日志链验证通过', async () => {
    await log({
      subject: 'a',
      action: 'b',
      resource: 'c',
      result: 'success',
    });
    const result = verifyChain();
    assert.equal(result.valid, true);
  });

  // ============================================================
  // 异常路径
  // ============================================================

  test('篡改检测：修改日志内容 100% 检出', async () => {
    // 写入 5 条日志
    for (let i = 0; i < 5; i++) {
      await log({
        subject: 'test',
        action: 'read',
        resource: `mem:${i}`,
        result: 'success',
      });
    }

    // 验证完整链
    assert.equal(verifyChain().valid, true);

    // 手动篡改第 2 条（通过 query 获取并修改——模拟攻击者篡改）
    const logs = query();
    logs[1]!.resource = 'tampered'; // 篡改资源字段

    // 验证：应该检出篡改
    const result = verifyChain();
    assert.equal(result.valid, false, '篡改后必须检出');
    assert.equal(result.brokenAt, 1, '应在第 1 条检出');
  });

  test('篡改检测：修改哈希值 100% 检出', async () => {
    await log({ subject: 'a', action: 'b', resource: 'c', result: 'success' });
    await log({ subject: 'a', action: 'b', resource: 'd', result: 'success' });

    // 篡改第二条的 hash
    const logs = query();
    logs[1]!.hash = '0'.repeat(64);

    const result = verifyChain();
    assert.equal(result.valid, false, '篡改哈希应检出');
  });

  test('并发写入：链仍然完整', async () => {
    // 并发写入 100 条
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        log({
          subject: 'concurrent',
          action: 'write',
          resource: `mem:${i}`,
          result: 'success',
        })
      );
    }
    await Promise.all(promises);

    assert.equal(getLogCount(), 100, '应有 100 条日志');
    const result = verifyChain();
    assert.equal(result.valid, true, '并发写入后链仍应完整');
  });

  // ============================================================
  // 性能基线
  // ============================================================

  test('写入性能：P99 < 2ms', async () => {
    const iterations = 500;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await log({
        subject: 'perf',
        action: 'read',
        resource: `mem:${i}`,
        result: 'success',
      });
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 2, `auditLog.write P99 = ${p99.toFixed(4)}ms，应 < 2ms`);
  });

  test('链验证性能：万条日志 < 100ms', async () => {
    // 生成 10000 条日志
    for (let i = 0; i < 10000; i++) {
      await log({
        subject: 'perf',
        action: 'read',
        resource: `mem:${i}`,
        result: 'success',
      });
    }

    const start = performance.now();
    const result = verifyChain();
    const duration = performance.now() - start;

    assert.equal(result.valid, true);
    assert.ok(duration < 100, `万条日志验证耗时 ${duration.toFixed(2)}ms，应 < 100ms`);
  });
});
