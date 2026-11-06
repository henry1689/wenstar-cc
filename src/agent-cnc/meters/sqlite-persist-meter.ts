// ============================================================
// Agent CNC Harness — SQLite 持久化 Meter
// 检查 save() / scheduleFlush / export()
// ============================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { HarnessContext, MeterResult } from '../types.js';
import { fileExists } from '../utils.js';
import { createResult, countOccurrences } from './base.js';

export async function runSqlitePersistMeter(
  context: HarnessContext,
): Promise<MeterResult> {
  const result = createResult('persist-meter', 'SQLite 持久化检查', 'S');

  const sqlitePath = path.join(context.rootDir, 'src', 'm2', 'SQLiteAdapter.ts');
  const fusionPath = path.join(
    context.rootDir,
    'src',
    'm2',
    'FusionStorageAdapter.ts',
  );
  const persistPath = path.join(
    context.rootDir,
    'src',
    'webui',
    'chat',
    'persistence-stage.ts',
  );

  if (!fileExists(sqlitePath)) {
    result.status = 'skipped';
    result.score = 0;
    result.warnings.push('SQLiteAdapter.ts 不存在');
    return result;
  }

  // 🔴 2026-11-06 存储底座迁移：判据反转。
  //   迁移前：必须存在 save/scheduleFlush/export（防落盘逻辑被误删）。
  //   迁移后：better-sqlite3 写即落盘 —— **不得**再出现整库导出/防抖落盘符号，
  //   且主库必须经 SqlJsCompat 接入原生驱动。
  //   ⚠️ 必须剥除注释后统计：迁移说明注释里会提到这些符号本身，否则恒定误报。
  const stripComments = (filePath: string): string => {
    try {
      return fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    } catch {
      return '';
    }
  };

  const legacySymbols = ['initSqlJs', 'scheduleFlush', 'shutdownFlush', 'export()'];
  const fileList = [sqlitePath, fusionPath, persistPath];

  let totalFound = 0;
  for (const file of fileList) {
    const code = stripComments(file);
    for (const sym of legacySymbols) {
      let count = 0;
      let idx = 0;
      while ((idx = code.indexOf(sym, idx)) !== -1) { count++; idx += sym.length; }
      if (count > 0) {
        totalFound += count;
        result.evidence.push(`${path.basename(file)}: "${sym}" 出现 ${count} 次`);
      }
    }
  }

  const usesCompat = stripComments(sqlitePath).includes('SqlJsCompat');
  if (totalFound > 0) {
    result.failures.push(
      `持久化旧链路残留 ${totalFound} 处（initSqlJs/scheduleFlush/shutdownFlush/export()）—— 应已随 better-sqlite3 迁移删除`,
    );
    result.status = 'fail';
    result.score = 0;
  } else if (!usesCompat) {
    result.failures.push('SQLiteAdapter.ts 未通过 SqlJsCompat 接入 better-sqlite3');
    result.status = 'fail';
    result.score = 0;
  } else {
    result.evidence.push('better-sqlite3 页级落盘（无整库导出残留）');
    result.score = 100;
  }

  // 检查数据库文件
  const dbPath = context.dbPath;
  if (fileExists(dbPath)) {
    try {
      const stat = fs.statSync(dbPath);
      result.evidence.push(
        `fusion_memory.db: ${(stat.size / 1024).toFixed(1)} KB`,
      );
      if (stat.size === 0) {
        result.failures.push('fusion_memory.db 文件大小为 0');
        result.status = 'fail';
        result.score = 0;
      }
    } catch {
      result.warnings.push('无法读取 fusion_memory.db 文件信息');
    }
  }

  // 如果 SQLite 相关文件被修改
  const sqliteChanged = context.changedFiles.some(
    (f) =>
      f.includes('SQLiteAdapter') ||
      f.includes('FusionStorageAdapter') ||
      f.includes('persistence-stage') ||
      f.startsWith('scripts/'),
  );
  if (sqliteChanged) {
    result.warnings.push(
      '⚠️ SQLite 持久化相关文件已修改，必须执行 停服→重启→查库 验证',
    );
    result.evidence.push(
      '持久化规则见: .agent-cnc/redlines/sqlite-persistence-rules.yaml',
    );
  }

  return result;
}
