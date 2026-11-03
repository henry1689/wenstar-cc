/**
 * seq_pos 冲突处置不变量守卫（🔴 2026-09-23，C 阶段）
 *
 * 背景（真实事故链）：批 4/5 把 memories 写入从 `INSERT OR REPLACE` 改为
 * `ON CONFLICT(id) DO UPDATE` 后，**seq_pos 冲突由“静默替换”变为抛错**（这是有意的
 * “失败可见”）；但 M9 `WorkingMemory.consolidate()` 等**批处理**路径没有 catch
 * ⇒ 历史上 266 次 `UNIQUE constraint failed: memories.seq_pos` 冒到
 * `[Server] 未捕获Promise拒绝`，并最终参与把生产库覆盖为空库的事故链。
 *
 * 修复方式（SQLiteAdapter.write 内）：**写入前预检** seq_pos 是否已被别的 id 占用，
 * 被占用则重分配 `MAX(seq_pos)+1`（不丢写入、不让异常逃逸到无 catch 的批处理链路）。
 *
 * 本测试锁定两条不变量（能力断言，非实现细节）：
 *  I1 必须存在 seq_pos 冲突预检 + 重分配；
 *  I2 **禁止**改为 `ON CONFLICT(seq_pos) DO UPDATE` —— 那会把“另一条记忆”覆盖掉
 *     （静默数据丢失），与事故修复的初衷相反。任何未来“顺手修一下”的改动必须被此测试拦住。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'SQLiteAdapter.ts'),
  'utf-8',
);

/** 取 write() 方法体（从 write( 到下一个顶层方法），用于局部断言 */
function writeBody(): string {
  const start = SRC.indexOf('  write(');
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 5);
  const nextMethod = rest.search(/\n  (?:private |public |protected )?(?:async )?[a-zA-Z_$]+\s*\(/);
  return nextMethod > -1 ? rest.slice(0, nextMethod) : rest;
}

describe('seq_pos 冲突处置不变量', () => {
  it('I1: write() 内含 seq_pos 冲突预检（按 seq_pos 查他行 + id <> 自身）', () => {
    const body = writeBody();
    expect(body).toMatch(/SELECT id FROM memories WHERE seq_pos = \? AND id <> \?/);
  });

  it('I1: 冲突时重分配为 MAX(seq_pos)+1（不丢写入）', () => {
    const body = writeBody();
    expect(body).toMatch(/COALESCE\(MAX\(seq_pos\),\s*0\)\+1/);
    expect(body).toMatch(/record\.seq_pos = _next/);
  });

  it('I2: 主写入路径禁止使用 ON CONFLICT(seq_pos) DO UPDATE（会覆盖他行＝静默丢数据）', () => {
    const body = writeBody();
    expect(body).not.toMatch(/ON CONFLICT\s*\(\s*seq_pos\s*\)/i);
    // 允许且仅允许 id 冲突走 UPDATE（幂等重写自身）
    expect(body).toMatch(/ON CONFLICT\s*\(\s*id\s*\)\s*DO UPDATE/i);
  });

  it('I2: 不得回退为 INSERT OR REPLACE（对任唯一冲突先 DELETE 再 INSERT）', () => {
    const body = writeBody();
    expect(body).not.toMatch(/INSERT\s+OR\s+REPLACE\s+INTO\s+memories/i);
  });

  it('预检失败不得阻塞写入（防御式降级保留）', () => {
    const body = writeBody();
    // 预检块必须自带 catch（否则预检自身的异常会变成新的写入失败源）
    const idx = body.indexOf('SELECT id FROM memories WHERE seq_pos');
    expect(idx).toBeGreaterThan(-1);
    expect(body.slice(idx, idx + 900)).toMatch(/catch/);
  });
});
