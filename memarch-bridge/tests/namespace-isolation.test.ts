/**
 * namespace-isolation.test.ts — 命名空间隔离核心测试
 *
 * 验收：身份不串台
 */
import { NamespaceContext } from '../src/namespace/NamespaceContext.js';
import { strict as assert } from 'node:assert';

async function test() {
  console.log('=== Namespace Isolation Tests ===\n');

  // 1. 不在上下文内必须抛错
  let threw = false;
  try {
    NamespaceContext.require();
  } catch { threw = true; }
  assert.ok(threw, '不在作用域内必须抛错');
  console.log('✓ 测试1: 无作用域时拒绝裸跑');

  // 2. 空 namespace 必须抛错
  threw = false;
  try {
    await NamespaceContext.run({ namespace: '', sessionId: 'x', subject: { id: 's', role: 'system' } }, async () => {});
  } catch { threw = true; }
  assert.ok(threw, '空 namespace 必须抛错');
  console.log('✓ 测试2: 空 namespace 拒绝');

  // 3. 'default' namespace 必须抛错
  threw = false;
  try {
    await NamespaceContext.run({ namespace: 'default', sessionId: 'x', subject: { id: 's', role: 'system' } }, async () => {});
  } catch { threw = true; }
  assert.ok(threw, 'default namespace 必须抛错（这是串台根因）');
  console.log('✓ 测试3: default namespace 拒绝（串台红线）');

  // 4. 正确 namespace 可以跑，且作用域内能取到
  await NamespaceContext.run(
    { namespace: 'ns_yuyao', sessionId: 's1', subject: { id: 'system', role: 'system' } },
    async () => {
      assert.equal(NamespaceContext.namespace(), 'ns_yuyao');
      console.log('✓ 测试4: 正确 namespace 内可正常取值');
    }
  );

  // 5. 不同 namespace 互不干扰（异步隔离）
  let ns1: string | undefined;
  let ns2: string | undefined;
  await Promise.all([
    NamespaceContext.run({ namespace: 'ns_a', sessionId: '1', subject: { id: 's', role: 'system' } }, async () => {
      await new Promise(r => setTimeout(r, 10));
      ns1 = NamespaceContext.namespace();
    }),
    NamespaceContext.run({ namespace: 'ns_b', sessionId: '2', subject: { id: 's', role: 'system' } }, async () => {
      ns2 = NamespaceContext.namespace();
    }),
  ]);
  assert.equal(ns1, 'ns_a');
  assert.equal(ns2, 'ns_b');
  console.log('✓ 测试5: 并发不同 namespace 互不串扰（AsyncLocalStorage 隔离）');

  console.log('\n✅ 全部通过');
}

test().catch(e => { console.error('❌', e); process.exit(1); });
