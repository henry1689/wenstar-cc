/**
 * D8 结构守卫测试 —— memories 覆盖写列清单一致性（2026-09-11）
 * ============================================================
 * 背景（真实事故）：
 *   `memories` 表存在多处 `INSERT OR REPLACE`，而 REPLACE = DELETE + INSERT ——
 *   未列入 column list 的列会被**静默重置为 NULL**（不报错、不告警）。
 *
 *   事故实例：`SQLiteAdapter.writeMemory()` 的列清单漏了 `fg_entity_names`，
 *   导致全库 2012 条该列恒为 NULL；而同路径 `entity_genes` 保留 362 条 ——
 *   正是「列缺失」而非「未赋值」的铁证。修复见 SQLiteAdapter writeMemory。
 *
 * 本测试把这条不变量固化为回归防线。S4 独立评审后按 P2-1/P2-2/P2-4 加固：
 *   - 命中 marker 但解析不出列清单者 → 直接判为 offender（fail-closed，不再静默跳过）
 *   - 例外判定改为「唯一 SQL 指纹」而非单个列名（避免未来误放行）
 *   - 删除空断言
 *
 * ⚠️ 已登记的范围外写入点（本测试当前不扫，属已知债务，见 S7 归档）：
 *   - `scripts/rebuild-memories-from-convs.cjs:76` —— `INSERT OR REPLACE INTO memories (...)`
 *     列清单仍含已删除的 `perception_json`（脚本修复另立任务）
 *   - `src/app/memory-vault/MemoryVault.ts:86` —— 同名 `memories` 表但在**另一个库**
 *     (`data/memory-vault/vault.db`)，非本守卫对象
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  MEMORY_IDENTITY_CRITICAL_COLUMNS,
  missingMemoryCriticalColumns,
  extractInsertColumns,
} from '../SQLiteAdapter.js';

const ADAPTER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'SQLiteAdapter.ts');

/**
 * 已文档化的唯一例外：对话组锚点重建（_rebuildMemoryAnchors）。
 *
 * 例外理由：该路径的 id 为 `<dialogGroupId>_ANCHOR`（SQLiteAdapter `const id = dg + '_ANCHOR'`）
 * 独立命名空间，INSERT OR REPLACE 只会重写它自己那一行，不会抹除其他记忆的列；
 * 且锚点行本就不携带 entity_genes。
 *
 * S4 评审 P2-2: 原以「列名 source_type」作代理过宽 —— 任何未来合法列出该列的写入点
 * 都会被自动豁免。改为要求**两个特征同时命中**（fail-closed）：
 * 若锚点 SQL 将来被改写导致指纹不再命中，本测试会失败并要求人工重新确认例外。
 */
function isDocumentedAnchor(site: { columns: string[]; window: string }): boolean {
  return site.columns.includes('source_type') && site.window.includes("'user.misc.default'");
}

/** 扫描源码中所有 `INSERT OR REPLACE INTO memories` 的列清单（解析失败者 columns=[]） */
function collectMemoryInsertColumnLists(src: string): Array<{ columns: string[]; snippet: string; window: string }> {
  const out: Array<{ columns: string[]; snippet: string; window: string }> = [];
  const marker = /INSERT\s+OR\s+REPLACE\s+INTO\s+memories/gi;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    // 解析必须用**完整剩余源码**——截断片段会丢掉列清单的收尾括号，导致误判为「无列清单」
    const rest = src.slice(m.index);
    out.push({
      columns: extractInsertColumns(rest),
      snippet: rest.slice(0, 200),
      window: rest.slice(0, 1500),
    });
  }
  return out;
}

describe('[D8] memories 覆盖写列清单一致性守卫', () => {
  const src = readFileSync(ADAPTER_SRC, 'utf-8');
  const sites = collectMemoryInsertColumnLists(src);

  it('至少能扫描到 SQLiteAdapter 中的 memories 写入点（防扫描器失效导致空转通过）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('每个写入点要么携带全部关键列，要么是已文档化的锚点例外（含解析失败→fail-closed）', () => {
    const offenders: string[] = [];
    for (const site of sites) {
      if (isDocumentedAnchor(site)) continue;
      const missing = missingMemoryCriticalColumns(site.columns);
      if (missing.length === 0) continue;
      const reason = site.columns.length === 0
        ? '无显式列清单（INSERT…SELECT 类，最危险，无法保证不抹列）'
        : `缺 [${missing.join(', ')}]`;
      offenders.push(`${reason} :: ${site.snippet.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    expect(offenders, `以下 memories 覆盖写点缺少关键列（会静默抹字段）:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('锚点例外指纹唯一且被显式识别（指纹漂移时本测试失败，需人工重新确认）', () => {
    const anchors = sites.filter(isDocumentedAnchor);
    expect(anchors.length, '锚点例外应恰好命中 1 处；命中 0 处=指纹已漂移，>1 处=例外过宽').toBe(1);
  });

  it('write() 与 writeMemory() 两处普通记忆写入点都必须携带 fg_entity_names（本次事故的直接回归防线）', () => {
    const withFg = sites.filter((s) => s.columns.includes('fg_entity_names'));
    expect(withFg.length).toBeGreaterThanOrEqual(2);
  });
});

describe('[D8] 纯函数行为', () => {
  it('missingMemoryCriticalColumns 正确识别缺失列', () => {
    expect(missingMemoryCriticalColumns([])).toEqual([...MEMORY_IDENTITY_CRITICAL_COLUMNS]);
    expect(missingMemoryCriticalColumns(['id', 'fg_entity_names'])).toEqual(
      [...MEMORY_IDENTITY_CRITICAL_COLUMNS].filter((c) => c !== 'fg_entity_names'),
    );
  });

  it('missingMemoryCriticalColumns 对完整清单返回空', () => {
    expect(missingMemoryCriticalColumns([...MEMORY_IDENTITY_CRITICAL_COLUMNS, 'id'])).toEqual([]);
  });

  it('missingMemoryCriticalColumns 对空白/缩进鲁棒', () => {
    expect(missingMemoryCriticalColumns(['  fg_entity_names ', '\tdna_root_id\n'])).not.toContain('fg_entity_names');
  });

  it('extractInsertColumns 解析多行与 OR REPLACE', () => {
    const cols = extractInsertColumns(
      'INSERT OR REPLACE INTO memories\n  (id,\n   fg_entity_names,\n   seq_pos)\nVALUES (?, ?, ?)',
    );
    expect(cols).toEqual(['id', 'fg_entity_names', 'seq_pos']);
  });

  it('extractInsertColumns 能清理拼接式 SQL 的引号与加号（S4 P2-2 噪音项）', () => {
    const cols = extractInsertColumns(
      'INSERT OR REPLACE INTO memories (id,seq_pos," +\n      "locus_path,leaf_zone) " + "VALUES (?,?,?,?)',
    );
    expect(cols).toEqual(['id', 'seq_pos', 'locus_path', 'leaf_zone']);
  });

  it('extractInsertColumns 对非 INSERT 文本返回空数组', () => {
    expect(extractInsertColumns('SELECT 1')).toEqual([]);
  });
});
