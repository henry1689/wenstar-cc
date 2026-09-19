/**
 * `safe-db-copy` 的能力断言（不是计数/位置断言）
 *
 * 要证明的能力：
 * 1. 结构完好的 SQLite 文件 ⇒ 判定可用；
 * 2. **torn read**（文件被截断在页中间）⇒ 判定不可用（这是"复制运行中导出的库"最常见的坏形态）；
 * 3. 坏夹具 ⇒ `copyRealDbForTest` **抛错**（fail-closed），绝不静默返回坏副本。
 *
 * 为什么必须有这一条：静默返回坏夹具 / 静默跳过 = **假绿**，比测试红更危险。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { copyRealDbForTest, verifySqliteFile } from './helpers/safe-db-copy.js';

const WORK = mkdtempSync(join(tmpdir(), 'safe-db-copy-test-'));

/** 造一个结构合法的 SQLite 文件（头 + 页对齐长度） */
function makeValidSqlite(file: string, pageSize = 4096): number {
  const buf = Buffer.alloc(pageSize);
  buf.write('SQLite format 3\0', 0, 'latin1');
  buf.writeUInt16BE(pageSize, 16);
  writeFileSync(file, buf);
  return buf.length;
}

afterAll(() => {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('safe-db-copy · 结构性判定', () => {
  it('完好的 SQLite（页对齐）→ 判定可用', () => {
    const f = join(WORK, 'ok.db');
    const size = makeValidSqlite(f);
    const v = verifySqliteFile(f);
    expect(v.ok, v.reason).toBe(true);
    expect(v.bytes).toBe(size);
    expect(v.pageSize).toBe(4096);
  });

  it('torn read：文件被截断在页中间 → 判定不可用（含"整数倍"原因）', () => {
    const f = join(WORK, 'torn.db');
    makeValidSqlite(f);
    writeFileSync(f, readFileSync(f).subarray(0, 1000));
    const v = verifySqliteFile(f);
    expect(v.ok, '截断到页中间必须被识别').toBe(false);
    expect(v.reason).toContain('整数倍');
  });

  it('魔数不匹配 → 判定不可用', () => {
    const f = join(WORK, 'nota.db');
    writeFileSync(f, Buffer.alloc(4096));
    const v = verifySqliteFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('魔数');
  });

  it('非法页大小 → 判定不可用', () => {
    const f = join(WORK, 'badpage.db');
    const buf = Buffer.alloc(4096);
    buf.write('SQLite format 3\0', 0, 'latin1');
    buf.writeUInt16BE(7, 16); // 非 512..65536 的 2 的幂
    writeFileSync(f, buf);
    const v = verifySqliteFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('页大小');
  });
});

describe('safe-db-copy · fail-closed（不得静默返回坏夹具）', () => {
  it('源库结构坏 → 抛错（而不是返回一个"看起来能打开"的副本）', async () => {
    const src = join(WORK, 'broken-src.db');
    writeFileSync(src, Buffer.alloc(4096)); // 非 SQLite
    await expect(copyRealDbForTest(src, { attempts: 2, backoffMs: 1 })).rejects.toThrow(/判定为\*\*失败\*\*|校验失败/);
  });

  it('源库不存在 → 抛错', async () => {
    await expect(copyRealDbForTest(join(WORK, 'no-such.db'))).rejects.toThrow(/源库不存在/);
  });

  it('源库完好 → 返回已校验副本，且 attemptsUsed ≥ 1、源字节数如实', async () => {
    const src = join(WORK, 'good-src.db');
    const size = makeValidSqlite(src);
    const r = await copyRealDbForTest(src, { attempts: 3, backoffMs: 1 });
    try {
      expect(r.attemptsUsed).toBeGreaterThanOrEqual(1);
      expect(r.sourceBytes).toBe(size);
      expect(verifySqliteFile(r.path).ok).toBe(true);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
