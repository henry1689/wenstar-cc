/**
 * BackupRetention — 备份分层保留 + 异步压缩
 * =====================================================================
 * 背景（2026-11-07 业主决策）：
 *   系统里有三套备份各自为政——
 *     ① `server.ts` 的 runUnifiedBackup：每 6 小时写 knowledge / family_graph / vault，
 *        内联清理只按「每日最新一份」留 3~7 天，单份 knowledge 135MB **未压缩**，稳态约 390MB；
 *     ② `MemoryVault.backup()`：每日一份，**完全没有清理**；
 *     ③ 手工 `.bak` 快照：无托管。
 *   业主选择「分层保留 + 压缩」：最近 2 个 + 每日 1 个留 3 天 + 每周 1 个留 2 周。
 *   同一批真实库实测压缩率 21~22%（135MB → ~29MB），因此分层保留反而比原来的
 *   「每日一份不压缩」更省空间，且恢复窗口从 3 天扩展到 2 周。
 *
 * 🔴 两条硬约束（实现时必须守住）：
 *   1. **压缩必须异步流式**（createGzip + pipeline）。`gzipSync` 对 135MB 会同步阻塞
 *      主线程数秒——这正是 sql.js 整库导出的老毛病，迁移时刚付出过代价。
 *   2. **保留判定以文件 mtime 为准**，不解析文件名。历史文件名有多种形态
 *      （`prefix_ISO.db` / `prefix_YYYY-MM-DD.db` / `prefix_ISO.db.gz`），
 *      按 mtime 排序对它们一视同仁。
 */

import { createReadStream, createWriteStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** 一个待参与保留判定的备份文件 */
export interface BackupEntry {
  name: string;
  /** 文件最后修改时间（毫秒）—— 保留判定唯一依据 */
  mtimeMs: number;
}

/** 分层保留策略 */
export interface RetentionPolicy {
  /** 无条件保留的最新份数（覆盖「最近 12 小时」这类短窗口） */
  recent: number;
  /** 每日保留最新一份，天数窗口 */
  dailyDays: number;
  /** 每周保留最新一份，周数窗口 */
  weeklyWeeks: number;
}

/** 业主 2026-11-07 定下的默认策略 */
export const DEFAULT_RETENTION: RetentionPolicy = { recent: 2, dailyDays: 3, weeklyWeeks: 2 };

const DAY_MS = 86_400_000;

/** 日历日键（本地时区，保证「每天一份」符合人的直觉） */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 周桶键：从 epoch 起每 7 天一个桶，稳定且无需 ISO 周算法 */
function weekKey(ms: number): string {
  return String(Math.floor(ms / (7 * DAY_MS)));
}

/** 按 keyOf 分组，每组取时间最新的一条（entries 需已按时间倒序） */
function newestPer(sorted: BackupEntry[], keyOf: (ms: number) => string): BackupEntry[] {
  const grouped = sorted.reduce<Record<string, BackupEntry>>((acc, e) => {
    const k = keyOf(e.mtimeMs);
    acc[k] = acc[k] ?? e;
    return acc;
  }, {});
  return Object.values(grouped);
}

/**
 * 计算应保留的文件名集合。
 * 保留 = 最新 N 个 ∪ 最近 dailyDays 天每天最新一个 ∪ 最近 weeklyWeeks 周每周最新一个。
 * 三层天然重叠（最新的那份通常同时是当天/当周最新的），集合语义会自动去重。
 */
export function selectBackupsToKeep(
  entries: BackupEntry[],
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Set<string> {
  const sorted = entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(sorted.slice(0, policy.recent).map((e) => e.name));

  const dailyCutoff = now - policy.dailyDays * DAY_MS;
  const weeklyCutoff = now - policy.weeklyWeeks * 7 * DAY_MS;
  const stamped = [
    ...newestPer(sorted, dayKey).filter((e) => e.mtimeMs >= dailyCutoff),
    ...newestPer(sorted, weekKey).filter((e) => e.mtimeMs >= weeklyCutoff),
  ];
  stamped.forEach((e) => keep.add(e.name));
  return keep;
}

/** 列出某目录下以 `prefix_` 开头的备份（读不到目录时返回空数组，不抛错） */
function listBackupEntries(dir: string, prefix: string): BackupEntry[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(`${prefix}_`))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
  } catch {
    return [];
  }
}

/**
 * 按策略清理目录中某前缀的旧备份。
 * 只删除不在保留集合里的文件；单个删除失败（被占用等）只跳过，不影响其它文件。
 */
export function pruneBackups(
  dir: string,
  prefix: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): { kept: string[]; deleted: string[] } {
  const entries = listBackupEntries(dir, prefix);
  const keep = selectBackupsToKeep(entries, now, policy);
  const deleted: string[] = [];
  entries
    .filter((e) => !keep.has(e.name))
    .forEach((e) => {
      try {
        unlinkSync(join(dir, e.name));
        deleted.push(e.name);
      } catch {
        /* 被占用 / 已删除：跳过 */
      }
    });
  return { kept: [...keep], deleted };
}

/**
 * 异步流式压缩并删除源文件，返回压缩后字节数。
 * 用 pipeline 而非 gzipSync：大库同步压缩会阻塞事件循环数秒。
 */
export async function gzipFileAsync(srcPath: string, destPath: string): Promise<number> {
  await pipeline(createReadStream(srcPath), createGzip({ level: 6 }), createWriteStream(destPath));
  const size = statSync(destPath).size;
  if (size <= 0) {
    throw new Error(`gzip 产物为空: ${destPath}`);
  }
  unlinkSync(srcPath);
  return size;
}
