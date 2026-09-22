/**
 * M4 缓存守卫（2026-09-22）
 *
 * 背景（实测 M4·timing，308 次采样）：`fgSummary` P95 1,442ms（最大 7,490ms）、
 * `batchProfile` P95 1,370ms（最大 6,660ms）—— 前者因 `!hasNewEntities` 一有新实体就**整轮同步重建**，
 * 后者**完全无缓存**。两者都是回复路径上的同步阻塞。
 *
 * 修复：① fgSummary 改 **stale-while-revalidate**；② batchProfile 加 **60s TTL 缓存**。
 * 本文件盯住这两条策略不被回退（源码级能力断言）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'M4Orchestrator.ts'), 'utf-8');

describe('M4 缓存守卫（防“整轮同步重建”回归）', () => {
  it('fgSummary 必须走 stale-while-revalidate：陈旧时先返回 + 后台刷新（有在途标记）', () => {
    expect(SRC, '需要后台刷新在途标记').toContain('_fgRefreshing');
    expect(SRC, '陈旧时应先返回旧摘要而非同步重建').toContain('陈旧-后台刷新');
    expect(SRC, '仅冷启动才同步等待（冷启动分支保留）').toContain('familySummary = await activeFG.getFamilySummary()');
  });

  it('batchProfile 必须有短 TTL 缓存（键=排序后名字集）', () => {
    expect(SRC, '需要 TTL 常量').toContain('PROFILE_CACHE_TTL');
    expect(SRC, '需要缓存变量').toContain('_profileCache');
    expect(SRC, '缓存键必须是排序后的名字集（同轮/相邻轮高度重合）').toContain('[...names].sort().join');
    expect(SRC, '命中时必须直接返回').toContain('return _profileCache.data;');
  });

  it('缓存命中/刷新必须有可观测日志（否则无法验证是否生效）', () => {
    expect(SRC).toContain('FG 摘要缓存命中');
    expect(SRC).toContain('[M4·profile] 批量加载');
  });
});
