/**
 * dedupe-zone-scope.test.ts — 记忆去重作用域与写后验证同源契约（2026-10-30，业主批准）
 * ============================================================
 * 被守的缺陷：
 *
 *   同一件事实（「这条内容在不在库里」）曾有两份口径：
 *     A 去重   SQLiteAdapter._isDuplicateNewWrite  → 全库、TRIM、**跨 zone**
 *     B 验证   persistence-stage 写后读验证        → 同 zone、精确、**不 TRIM**
 *
 *   后果一（真丢数据）：玉瑶在 assistant 区说过一句与用户相同的话 ⇒ 用户这条被判
 *     「已存在」而不写 ⇒ 用户侧记忆真缺失（「刚说的话她没记住」的根因之一）。
 *   后果二（假警）：A 拦下后 B 必然找不到 ⇒ 实测「去重拦下 27 次 ↔ 写后验证失败 26 次」
 *     一一配对，把真正的写入故障淹没在噪声里。
 *   后果三（必然假警）：助手轮以 `cleanReply`（剥离括号场景描写后）写入，验证却用
 *     `input.reply` 比对 ⇒ 两者必然不等。
 *
 * 修复：
 *   · A 增加可选 leafZone：传了 ⇒ 同 zone 去重；不传 ⇒ 保持原全库语义（write() 事件行）。
 *   · B 改用 TRIM + leaf_zone（与 A 同口径），且助手轮用 `cleanReply`（与写入值同源）。
 *
 * 本文件用**桩 queryAll** 驱动私有判定，不加载真实库、不写盘、不依赖服务。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteAdapter } from '../SQLiteAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 构造一个只暴露 queryAll 的桩适配器。
 * @param zoneRows 按「命中 zone」返回的行：{ assistant: [行], user: [] } 表示 assistant 区有同文
 */
function makeStub(zoneRows: Record<string, Array<{ id: string }>>) {
  const a = new SQLiteAdapter('D:/tmp/__unused_dedupe_zone_test.db') as unknown as {
    queryAll: (sql: string, params: unknown[]) => unknown[];
    _isDuplicateNewWrite: (raw: string, selfId: string, zone?: string | null) => boolean;
    __sqls: string[];
  };
  a.__sqls = [];
  a.queryAll = (sql: string, params: unknown[]) => {
    a.__sqls.push(sql);
    // 自身 id 存在性检查 → 恒不存在（模拟「新建」）
    if (/SELECT 1 FROM memories WHERE id = \?/.test(sql)) return [];
    // zone 作用域查询 → 按 zone 返回
    if (/AND leaf_zone = \?/.test(sql)) {
      const zone = String(params[1] ?? '');
      return zoneRows[zone] ?? [];
    }
    // 无 zone 的全库查询（旧语义）→ 所有 zone 的行并集
    return Object.values(zoneRows).flat();
  };
  return a;
}

describe('D1 跨 zone 不再互相拦截（用户发言不被 assistant 同文吃掉）', () => {
  it('assistant 区已有同文，user 区写入不得被判重复', () => {
    const a = makeStub({ assistant: [{ id: 'mem_a' }], user: [] });
    expect(a._isDuplicateNewWrite('灵叶你好漂亮', 'mem_new', 'user')).toBe(false);
  });

  it('查询必须带 leaf_zone 约束（证明走的是 zone 作用域而非全库）', () => {
    const a = makeStub({ assistant: [{ id: 'mem_a' }], user: [] });
    a._isDuplicateNewWrite('灵叶你好漂亮', 'mem_new', 'user');
    expect(a.__sqls.some((s) => /AND leaf_zone = \?/.test(s))).toBe(true);
  });
});

describe('D2 同 zone 内重复仍然拦截（防止同区刷重复）', () => {
  it('user 区已有同文 → 判定重复', () => {
    const a = makeStub({ user: [{ id: 'mem_u' }] });
    expect(a._isDuplicateNewWrite('灵叶你好漂亮', 'mem_new', 'user')).toBe(true);
  });

  it('assistant 区已有同文 → assistant 写入同样判定重复', () => {
    const a = makeStub({ assistant: [{ id: 'mem_a' }] });
    expect(a._isDuplicateNewWrite('好的呀，我在呢。', 'mem_new', 'assistant')).toBe(true);
  });
});

describe('D3 未传 zone 的调用方保持原全库语义（write() 事件行零行为变化）', () => {
  it('不传 zone → 走全库查询（不带 leaf_zone 约束）', () => {
    const a = makeStub({ assistant: [{ id: 'mem_a' }] });
    expect(a._isDuplicateNewWrite('同文', 'mem_new')).toBe(true);
    expect(a.__sqls.some((s) => /AND leaf_zone = \?/.test(s))).toBe(false);
  });

  it('自身 id 已存在（更新既有行）→ 一律放行', () => {
    const a = new SQLiteAdapter('D:/tmp/__unused_dedupe_zone_test.db') as unknown as {
      queryAll: (sql: string, params: unknown[]) => unknown[];
      _isDuplicateNewWrite: (raw: string, selfId: string, zone?: string | null) => boolean;
    };
    a.queryAll = () => [{ id: 'self' }];
    expect(a._isDuplicateNewWrite('任意内容', 'mem_same', 'user')).toBe(false);
  });
});

describe('D4 写后验证与写入同源（结构性断言）', () => {
  const src = readFileSync(join(REPO, 'src', 'webui', 'chat', 'persistence-stage.ts'), 'utf8');

  it('验证 SQL 与去重同口径：TRIM + leaf_zone', () => {
    expect(src).toMatch(/TRIM\(raw_input\) = \? AND leaf_zone = \? LIMIT 1/);
  });

  it('助手轮验证必须用 cleanReply（写入值），不得用 input.reply', () => {
    expect(src).toMatch(/byContent\(cleanReply, 'assistant'\)/);
    expect(src).not.toMatch(/byContent\(input\.reply/);
  });

  it('cleanReply 只允许一处定义（防同名遮蔽导致规则漂移）', () => {
    const defs = src.match(/const cleanReply\s*=/g) ?? [];
    expect(defs).toHaveLength(1);
  });

  it('cleanReply 的定义必须早于写入点与验证点', () => {
    const def = src.indexOf('const cleanReply');
    const write = src.indexOf("leafZone: 'assistant', rawInput: cleanReply");
    const verify = src.indexOf("byContent(cleanReply, 'assistant')");
    expect(def).toBeGreaterThan(-1);
    expect(def).toBeLessThan(write);
    expect(def).toBeLessThan(verify);
  });
});