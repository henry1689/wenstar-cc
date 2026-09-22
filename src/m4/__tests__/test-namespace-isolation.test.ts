/**
 * 测试隔离（#D）的能力守卫
 *
 * 背景：另一会话的测试曾直投主库（`test_mode` 未开）⇒ 产生「你好」×427、「帮我记个事」×124、
 * 「徐诗雨」×103 等测试串，其中 656 条一度 active/promoted **正在参与检索**，
 * 于 2026-09-22 批量隔离（`lifecycle_state='suppressed'`）。
 *
 * 本文件盯住三条**硬约束**不被回归（源码级能力断言；端到端验证另见提交说明）：
 * 1. 写入侧：`test_mode` ⇒ `namespace='test'`（memories + conversations 共 4 处）；
 * 2. 检索侧：`MemoryRetriever` 的候选查询必须排 `namespace='test'`；
 * 3. 晋升侧：`autoPromoteCandidatesV2` 预筛必须排 `namespace='test'`。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // src/m4/__tests__ ⇒ 上三级才是仓库根
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

describe('测试隔离硬约束（#D 防回归）', () => {
  it('写入侧：test_mode ⇒ namespace 标 test（4 处：2 条对话 + 2 条记忆）', () => {
    const src = read('src/webui/chat/persistence-stage.ts');
    const hits = src.match(/testMode \? 'test' : 'default'/g) ?? [];
    expect(hits.length, `persistence-stage 应有 4 处 testMode 命名空间分支，实际 ${hits.length}`).toBeGreaterThanOrEqual(4);
  });

  it('检索侧：MemoryRetriever 的候选查询必须排除 test 命名空间', () => {
    const src = read('src/m4/MemoryRetriever.ts');
    const hits = src.match(/COALESCE\(namespace,'default'\) <> 'test'/g) ?? [];
    expect(hits.length, `MemoryRetriever 应有 ≥3 处排除 test 命名空间，实际 ${hits.length}`).toBeGreaterThanOrEqual(3);
  });

  it('晋升侧：autoPromoteCandidatesV2 预筛必须排除 test 命名空间', () => {
    const src = read('src/app/vault/VaultManager.ts');
    expect(src, '黑钻晋升预筛需排除 test 命名空间').toContain("COALESCE(namespace, 'default') <> 'test'");
  });
});
