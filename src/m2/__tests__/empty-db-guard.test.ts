/**
 * empty-db-guard.test.ts — 「空库熔断」回归防线（2026-09-19 事故后加固）
 * ==============================================================================
 * 事故：生产库 `data/webui/fusion_memory.db` 由 **229MB / 4068 对话** 被覆盖为
 *       **3.9MB / 84 对话** 的空库。机理：sql.js 内存库 flush 时直接 `export()` 覆盖磁盘文件，
 *       而**没有任何“空库/载入异常”保护** ⇒ 只要有一个实例以空库状态跑起来，它的一次 flush
 *       就会抹掉全部生产数据。（当时已用 12:52 备份回滚。）
 *
 * 本测试把两层防线钉死：
 *   ① 加载期守卫：磁盘库 ≥5MB 而载入后 memories/conversations 均 0 行 ⇒ `initialize()` **抛错**
 *   ② 落盘期守卫：内存库两表空 + 磁盘文件大 ⇒ `_safeWriteDbFile()` **拒绝覆盖**（返回 false，文件不变）
 *
 * 为什么这两条都要：① 防“带空库跑起来”；② 即使 ① 被绕过，也防“拿空库覆盖真实文件”。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteAdapter } from '../SQLiteAdapter.js';

const TMP = 'D:/tmp/wenstar-empty-db-guard-test';
const GUARD_THRESHOLD = 5 * 1024 * 1024; // 与 SQLiteAdapter.DB_EMPTY_GUARD_MIN_BYTES 对齐

/** 造一个「文件很大、但核心表 0 行」的库（模拟加载异常/半读的真实后果形态） */
async function makeBigButEmptyDb(file: string): Promise<number> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE memories (id TEXT PRIMARY KEY, seq_pos INTEGER)');
  db.run('CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)');
  db.run('CREATE TABLE filler (id INTEGER PRIMARY KEY, blob BLOB)');
  const blob = new Uint8Array(1024 * 1024); // 1MB
  for (let i = 0; i < 6; i++) db.run('INSERT INTO filler (blob) VALUES (?)', [blob]);
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return statSync(file).size;
}

describe('[数据安全守卫] 空库不得覆盖真实数据（229MB→3.9MB 事故回归防线）', () => {
  beforeAll(() => { if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true }); });
  afterAll(() => { rmSync(TMP, { recursive: true, force: true }); });

  it('① 加载期守卫：大库载入后两表 0 行 → initialize() 必须抛错拒绝启动', async () => {
    const p = join(TMP, 'big-empty.db');
    const size = await makeBigButEmptyDb(p);
    expect(size, '夹具必须超过守卫阈值').toBeGreaterThanOrEqual(GUARD_THRESHOLD);

    const a = new SQLiteAdapter(p);
    await expect(a.initialize()).rejects.toThrow(/拒绝启动/);
  });

  it('② 落盘期守卫：内存库两表空 + 磁盘文件大 → 拒绝覆盖（返回 false，文件字节数不变）', async () => {
    const p = join(TMP, 'target.db');
    const size = await makeBigButEmptyDb(p);

    // 直接验证咽喉点：桩 db 让 COUNT(*) 返回 0（模拟空库状态），dbPath 指向上面那个大文件
    const stub = {
      exec: (sql: string) => (/COUNT\(\*\)/i.test(sql) ? [{ values: [[0]] }] : [{ values: [[]] }]),
    };
    const a = new SQLiteAdapter(p) as unknown as { db: unknown; _safeWriteDbFile: (b: Uint8Array, why: string) => boolean };
    a.db = stub;

    const ok = a._safeWriteDbFile(new Uint8Array(1024), 'unit-test');
    expect(ok, '守卫必须返回 false（拒绝写入）').toBe(false);
    expect(statSync(p).size, '磁盘文件字节数必须保持不变（未被抹小）').toBe(size);
  });

  it('③ 守卫不得误伤正常库：两表非空时照常写入', async () => {
    const p = join(TMP, 'normal.db');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE memories (id TEXT PRIMARY KEY, seq_pos INTEGER)');
    db.run('CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)');
    db.run("INSERT INTO memories VALUES ('m1', 1)");
    db.run("INSERT INTO conversations (content) VALUES ('c1')");
    writeFileSync(p, Buffer.from(db.export()));
    db.close();

    const stub = {
      // 非空：COUNT 返回 1
      exec: (sql: string) => (/COUNT\(\*\)/i.test(sql) ? [{ values: [[1]] }] : [{ values: [[]] }]),
    };
    const a = new SQLiteAdapter(p) as unknown as { db: unknown; _safeWriteDbFile: (b: Uint8Array, why: string) => boolean };
    a.db = stub;

    const ok = a._safeWriteDbFile(new TextEncoder().encode('x'), 'unit-test-normal');
    expect(ok, '正常库必须允许写入').toBe(true);
  });

  it('④ 原子写：成功路径与拒绝路径都不得留下 .tmp-* 残留（原文件不被半写破坏）', () => {
    // 上两例分别走“拒绝”与“成功”路径；原子写要求两条路径都不留临时文件。
    const residue = readdirSync(TMP).filter((f) => f.includes('.tmp-'));
    expect(residue, `临时残留: ${residue.join(', ')}`).toEqual([]);
  });
});
