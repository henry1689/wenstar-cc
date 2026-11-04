/**
 * integrityCheck.test.ts — 完整性巡检测试
 *
 * 覆盖：
 * 1. 正常路径：Merkle 根校验通过
 * 2. 边界条件：空条目集、单条目
 * 3. 异常路径：篡改检测、违规事件触发
 * 4. 性能基线：quickCheck P99 < 100ms
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initIntegrityCheck,
  quickCheck,
  deepScan,
  check,
  setBaselineRoot,
  getBaselineRoot,
  onViolation,
  offViolation,
  isolateEntry,
  unisolateEntry,
  isIsolated,
  _resetForTest,
  type MemSymEntry,
  type ViolationEvent,
} from '../src/integrityCheck';
import { initSecurityConfig, _resetForTest as resetConfig } from '../src/securityConfig';

describe('integrityCheck', () => {
  beforeEach(() => {
    _resetForTest();
    resetConfig();
    initSecurityConfig({ signingKey: 'test-key' });
  });

  afterEach(() => {
    _resetForTest();
    resetConfig();
  });

  // 生成测试条目
  function generateEntries(count: number): MemSymEntry[] {
    const entries: MemSymEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        id: `mem-${i}`,
        contentHash: `content-hash-${i}`,
      });
    }
    return entries;
  }

  // ============================================================
  // 正常路径
  // ============================================================

  test('Merkle 根校验通过', () => {
    const entries = generateEntries(100);
    initIntegrityCheck(() => entries);

    const result = quickCheck();
    assert.equal(result.ok, true, '未篡改时应通过');
    assert.ok(result.currentRoot);
  });

  test('初始化时自动建立基线', () => {
    const entries = generateEntries(50);
    initIntegrityCheck(() => entries);

    const baseline = getBaselineRoot();
    assert.ok(baseline, '应自动建立基线');
    assert.equal(baseline.length, 64, 'SHA256 根哈希应为 64 字符');
  });

  test('setBaselineRoot 后比对新基线', () => {
    const entries = generateEntries(50);
    initIntegrityCheck(() => entries);
    const oldBaseline = getBaselineRoot();

    // 修改条目后，用新的作为基线
    entries[0]!.contentHash = 'changed';
    initIntegrityCheck(() => entries);
    const newBaseline = getBaselineRoot();

    assert.notEqual(oldBaseline, newBaseline, '基线应变化');
    assert.equal(quickCheck().ok, true, '新基线下应通过');
  });

  test('check 接口传入期望根', () => {
    const entries = generateEntries(10);
    initIntegrityCheck(() => entries);
    const baseline = getBaselineRoot();

    const result = check(baseline);
    assert.equal(result.ok, true);
  });

  test('深度扫描通过', () => {
    const entries = generateEntries(50);
    initIntegrityCheck(() => entries);

    const result = deepScan();
    assert.equal(result.ok, true);
    assert.equal(result.type, 'deep');
  });

  // ============================================================
  // 边界条件
  // ============================================================

  test('空条目集校验通过', () => {
    initIntegrityCheck(() => []);
    const result = quickCheck();
    assert.equal(result.ok, true);
  });

  test('单条目校验通过', () => {
    const entries = generateEntries(1);
    initIntegrityCheck(() => entries);
    const result = quickCheck();
    assert.equal(result.ok, true);
  });

  test('奇数个条目 Merkle Tree 正常', () => {
    // 7 个条目（奇数），测试补齐逻辑
    const entries = generateEntries(7);
    initIntegrityCheck(() => entries);
    const result = quickCheck();
    assert.equal(result.ok, true);
  });

  // ============================================================
  // 异常路径
  // ============================================================

  test('篡改检测：内容变化导致根哈希不匹配', () => {
    const entries = generateEntries(100);
    initIntegrityCheck(() => entries);
    assert.equal(quickCheck().ok, true, '初始应通过');

    // 篡改一个条目
    entries[10]!.contentHash = 'tampered-content';

    const result = quickCheck();
    assert.equal(result.ok, false, '篡改后应检出');
  });

  test('违规事件触发', () => {
    const entries = generateEntries(50);
    initIntegrityCheck(() => entries);

    let violationEvent: ViolationEvent | null = null;
    onViolation((event) => {
      violationEvent = event;
    });

    // 篡改
    entries[5]!.contentHash = 'bad';

    quickCheck();

    assert.ok(violationEvent, '应触发违规事件');
    assert.equal(violationEvent!.type, 'quick');
    assert.ok(violationEvent!.currentRoot);
    assert.ok(violationEvent!.baselineRoot);

    offViolation((e) => { violationEvent = e; });
  });

  test('隔离条目：深度扫描检出', () => {
    const entries = generateEntries(20);
    initIntegrityCheck(() => entries);

    // 隔离一个条目
    isolateEntry('mem-3');

    const result = deepScan();
    assert.equal(result.ok, false, '有隔离条目应不通过');
    assert.ok(result.corruptedIds.includes('mem-3'));
  });

  test('解除隔离后恢复正常', () => {
    const entries = generateEntries(20);
    initIntegrityCheck(() => entries);

    isolateEntry('mem-5');
    assert.equal(isIsolated('mem-5'), true);

    unisolateEntry('mem-5');
    assert.equal(isIsolated('mem-5'), false);

    const result = deepScan();
    assert.equal(result.ok, true);
  });

  // ============================================================
  // 性能基线
  // ============================================================

  test('quickCheck 性能：万级条目 P99 < 100ms', () => {
    const entries = generateEntries(10000);
    initIntegrityCheck(() => entries);

    // 预热
    quickCheck();

    const iterations = 50;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      quickCheck();
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 100, `quickCheck P99 = ${p99.toFixed(2)}ms，应 < 100ms`);
  });

  test('deepScan 性能：千级条目 < 200ms', () => {
    const entries = generateEntries(1000);
    initIntegrityCheck(() => entries);

    const start = performance.now();
    deepScan();
    const duration = performance.now() - start;

    assert.ok(duration < 200, `deepScan 耗时 ${duration.toFixed(2)}ms，千级条目应 < 200ms`);
  });
});
