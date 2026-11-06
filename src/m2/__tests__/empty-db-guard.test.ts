/**
 * empty-db-guard.test.ts — 「空库熔断」回归防线（2026-09-19 事故后加固）
 * ==============================================================================
 * 事故：生产库 `data/webui/fusion_memory.db` 由 **229MB / 4068 对话** 被覆盖为
 *       **3.9MB / 84 对话** 的空库。机理：sql.js 内存库 flush 时直接 `export()` 覆盖磁盘文件，
 *       而**没有任何“空库/载入异常”保护** ⇒ 只要有一个实例以空库状态跑起来，它的一次 flush
 *       就会抹掉全部生产数据。（当时已用 12:52 备份回滚。）
 *
 * 🔴 2026-11-06 存储底座迁移（better-sqlite3）后，本文件的防线收缩为一条：
 *   ① 加载期守卫：磁盘库 ≥5MB 而读取后 memories/conversations 均 0 行 ⇒ `initialize()` 抛错。
 *
 *   原来的 ②「落盘期守卫」/ ③「不误伤正常库」/ ④「原子写无 .tmp 残留」全部删除 ——
 *   它们验证的 `_safeWriteDbFile()`（整库 export → tmp→rename 覆盖磁盘）已随迁移移除；
 *   better-sqlite3 页级写盘**不存在整文件替换**，那类“空库覆盖真实文件”的事故路径
 *   在结构上已不可能发生（历史实现见 git）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('① 加载期守卫：大库读取后两表 0 行 → initialize() 必须抛错拒绝启动', async () => {
    const p = join(TMP, 'big-empty.db');
    const size = await makeBigButEmptyDb(p);
    expect(size, '夹具必须超过守卫阈值').toBeGreaterThanOrEqual(GUARD_THRESHOLD);

    const a = new SQLiteAdapter(p);
    await expect(a.initialize()).rejects.toThrow(/拒绝启动/);
  });
});
