// 备份分层保留策略单元测试
// 覆盖：recent / daily / weekly 三层窗口、mtime 判定、真实目录清理、异步压缩
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  selectBackupsToKeep,
  pruneBackups,
  gzipFileAsync,
  DEFAULT_RETENTION,
  type BackupEntry,
} from '../BackupRetention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // 2026-11-07 12:00 UTC

const createdDirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'backup-retention-'));
  createdDirs.push(d);
  return d;
}

afterEach(() => {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

describe('selectBackupsToKeep — 分层窗口', () => {
  it('最新 N 个无条件保留', () => {
    const entries: BackupEntry[] = [
      { name: 'a', mtimeMs: NOW - 1 * DAY },
      { name: 'b', mtimeMs: NOW - 2 * DAY },
      { name: 'c', mtimeMs: NOW - 30 * DAY },
    ];
    const keep = selectBackupsToKeep(entries, NOW, { recent: 2, dailyDays: 0, weeklyWeeks: 0 });
    expect([...keep].sort()).toEqual(['a', 'b']);
  });

  it('每日窗口内每天只留最新一份，超窗的旧日期被清', () => {
    const entries: BackupEntry[] = [
      { name: 'today-new', mtimeMs: NOW - 1 * 3600_000 },
      { name: 'today-old', mtimeMs: NOW - 6 * 3600_000 },
      { name: 'yesterday', mtimeMs: NOW - 1 * DAY },
      { name: 'too-old', mtimeMs: NOW - 5 * DAY },
    ];
    const keep = selectBackupsToKeep(entries, NOW, { recent: 1, dailyDays: 3, weeklyWeeks: 0 });
    expect(keep.has('today-new')).toBe(true);
    expect(keep.has('yesterday')).toBe(true);
    expect(keep.has('today-old')).toBe(false);   // 同一天的非最新份
    expect(keep.has('too-old')).toBe(false);     // 超出 3 天日窗口
  });

  it('周窗口保底：日窗口外的旧版本，仍保留每周最新一份', () => {
    const entries: BackupEntry[] = [
      { name: 'now', mtimeMs: NOW },
      { name: 'w1-new', mtimeMs: NOW - 8 * DAY },
      { name: 'w1-old', mtimeMs: NOW - 9 * DAY },
      { name: 'ancient', mtimeMs: NOW - 60 * DAY },
    ];
    const keep = selectBackupsToKeep(entries, NOW, { recent: 1, dailyDays: 3, weeklyWeeks: 2 });
    expect(keep.has('w1-new')).toBe(true);
    expect(keep.has('w1-old')).toBe(false);
    expect(keep.has('ancient')).toBe(false);
  });

  it('默认策略 = 最近 2 + 每日 3 天 + 每周 2 周', () => {
    expect(DEFAULT_RETENTION).toEqual({ recent: 2, dailyDays: 3, weeklyWeeks: 2 });
  });
});

describe('pruneBackups — 真实目录', () => {
  it('按 mtime 删除超窗文件，保留窗口内文件', () => {
    const dir = makeDir();
    const mk = (name: string, daysAgo: number) => {
      const p = join(dir, name);
      writeFileSync(p, 'x');
      const t = (NOW - daysAgo * DAY) / 1000;
      utimesSync(p, t, t);
    };
    mk('knowledge_new.db.gz', 0);
    mk('knowledge_keep2.db.gz', 1);
    mk('knowledge_old.db.gz', 40);
    mk('other_prefix.db', 0); // 前缀不匹配，不应被本前缀清理

    const { kept, deleted } = pruneBackups(dir, 'knowledge', DEFAULT_RETENTION, NOW);
    expect(kept.length).toBe(2);
    expect(deleted).toEqual(['knowledge_old.db.gz']);
    expect(existsSync(join(dir, 'knowledge_old.db.gz'))).toBe(false);
    expect(existsSync(join(dir, 'other_prefix.db'))).toBe(true);
  });

  it('目录不存在时安全返回空结果', () => {
    const { kept, deleted } = pruneBackups(join(tmpdir(), 'no-such-dir-' + Date.now()), 'x', DEFAULT_RETENTION, NOW);
    expect(kept).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

describe('gzipFileAsync — 异步压缩', () => {
  it('生成压缩文件并删除源文件', async () => {
    const dir = makeDir();
    const src = join(dir, 'a.db');
    const dest = join(dir, 'a.db.gz');
    writeFileSync(src, 'hello '.repeat(1000));

    const size = await gzipFileAsync(src, dest);
    expect(size).toBe(statSync(dest).size);
    expect(size).toBeGreaterThan(0);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(dest)).toBe(true);
  });
});
