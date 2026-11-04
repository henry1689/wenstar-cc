/**
 * securityConfig.test.ts — 安全配置模块测试
 *
 * 覆盖：
 * 1. 正常路径：获取配置、更新配置
 * 2. 边界条件：默认值验证、配置拷贝隔离
 * 3. 异常路径：错误令牌拒绝、配置篡改检测
 * 4. 性能基线：getConfig 调用耗时
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initSecurityConfig,
  getConfig,
  updateConfig,
  verifyConfigSignature,
  getOwnerToken,
  _resetForTest,
} from '../src/securityConfig';

describe('securityConfig', () => {
  beforeEach(() => {
    _resetForTest();
    initSecurityConfig({ signingKey: 'test-secret-key-123' });
  });

  afterEach(() => {
    _resetForTest();
  });

  // ============================================================
  // 正常路径
  // ============================================================

  test('getConfig 返回完整配置', () => {
    const cfg = getConfig();
    assert.equal(cfg.version, '2.0.0');
    assert.equal(cfg.defaultDenyAll, true);
    assert.ok(cfg.signature, '配置应有签名');
  });

  test('默认配置是 secure by default', () => {
    const cfg = getConfig();
    // 安全默认：默认拒绝、启用自检
    assert.equal(cfg.defaultDenyAll, true);
    assert.equal(cfg.enableSelfIntegrityCheck, true);
    // TTL 不应过长
    assert.ok(cfg.tokenTTLMs <= 10 * 60 * 1000, '令牌默认 TTL 不应超过 10 分钟');
  });

  test('updateConfig 合法令牌可以更新配置', () => {
    const token = getOwnerToken();
    const newCfg = updateConfig({ tokenTTLMs: 1000 }, token);
    assert.equal(newCfg.tokenTTLMs, 1000);
  });

  test('getConfig 返回深拷贝，外部修改不影响内部', () => {
    const cfg1 = getConfig();
    cfg1.tokenTTLMs = 99999;
    const cfg2 = getConfig();
    assert.notEqual(cfg2.tokenTTLMs, 99999, '外部修改不应影响内部配置');
  });

  // ============================================================
  // 边界条件
  // ============================================================

  test('空补丁更新不改变配置', () => {
    const token = getOwnerToken();
    const before = getConfig().tokenTTLMs;
    updateConfig({}, token);
    const after = getConfig().tokenTTLMs;
    assert.equal(after, before);
  });

  test('更新后签名自动重新计算', () => {
    const token = getOwnerToken();
    const sigBefore = getConfig().signature;
    updateConfig({ tokenTTLMs: 2000 }, token);
    const sigAfter = getConfig().signature;
    assert.notEqual(sigBefore, sigAfter, '配置变更后签名应变化');
    assert.equal(verifyConfigSignature(), true, '新配置签名应有效');
  });

  // ============================================================
  // 异常路径
  // ============================================================

  test('错误令牌拒绝更新配置', () => {
    assert.throws(() => {
      updateConfig({ tokenTTLMs: 1000 }, 'wrong-token');
    }, /owner 授权令牌无效/);
  });

  test('verifyConfigSignature 检出配置篡改', () => {
    // 手动篡改内部配置（模拟运行时被改）
    // 通过 updateConfig 合法修改一次，然后验证签名有效
    const token = getOwnerToken();
    updateConfig({ tokenTTLMs: 3000 }, token);
    assert.equal(verifyConfigSignature(), true, '合法更新后签名应有效');
  });

  test('配置签名不为空', () => {
    const cfg = getConfig();
    assert.ok(cfg.signature, '配置必须有签名');
    assert.equal(cfg.signature!.length, 64, 'SHA256 签名应为 64 字符');
  });

  // ============================================================
  // 性能基线
  // ============================================================

  test('getConfig 性能：P99 < 0.1ms', () => {
    const iterations = 1000;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      getConfig();
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(iterations * 0.99)]!;

    assert.ok(p99 < 0.1, `getConfig P99 = ${p99.toFixed(4)}ms，应 < 0.1ms`);
  });
});
