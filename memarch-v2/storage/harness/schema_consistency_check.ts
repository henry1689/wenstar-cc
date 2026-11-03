/**
 * H-CK-01: schema 一致性校验
 * 对照设计文档预期的 14 张表 + 关键索引，发现缺失/篡改 → 抛出异常
 * 用法: node storage/harness/schema_consistency_check.ts <db_path>
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const EXPECTED_TABLES = [
  'conversations', 'episodes', 'memories', 'semantic_facts',
  'entity_edges', 'trace_entities', 'black_diamond_v2',
  'prospective_items', 'tombstones', 'forget_requests',
  'audit_ledger', 'sleep_runs', 'reinforcement_events', 'wm_buffer',
];

const EXPECTED_INDEXES = [
  'idx_conv_episode_ts', 'idx_mem_consol_lifecycle', 'idx_mem_last_reinforced',
  'idx_fact_subj_pred', 'idx_edge_src', 'idx_edge_dst',
];

const EXPECTED_VIEWS = ['v_conv_real', 'v_mem_real', 'v_ep_real', 'v_fact_real'];

const EXPECTED_TRIGGERS = ['ledger_no_update', 'ledger_no_delete'];

export function checkSchema(dbPath: string): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(dbPath)) {
    return { ok: false, errors: [`db not found: ${dbPath}`], warnings };
  }

  const db = new Database(dbPath, { readonly: true });

  // 1) 表存在性
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));
  for (const t of EXPECTED_TABLES) {
    if (!tableNames.has(t)) errors.push(`missing table: ${t}`);
  }

  // 2) 索引存在性
  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[];
  const idxNames = new Set(indexes.map((i) => i.name));
  for (const i of EXPECTED_INDEXES) {
    if (!idxNames.has(i)) warnings.push(`missing index: ${i}`);
  }

  // 3) 视图
  const views = db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as { name: string }[];
  const viewNames = new Set(views.map((v) => v.name));
  for (const v of EXPECTED_VIEWS) {
    if (!viewNames.has(v)) errors.push(`missing view: ${v}`);
  }

  // 4) 触发器
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as { name: string }[];
  const trigNames = new Set(triggers.map((t) => t.name));
  for (const t of EXPECTED_TRIGGERS) {
    if (!trigNames.has(t)) errors.push(`missing trigger: ${t}`);
  }

  // 5) 外键完整性
  const fk = db.pragma('foreign_key_check') as unknown[];
  if (fk.length > 0) errors.push(`foreign_key_check violations: ${fk.length}`);

  // 6) 完整性
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') errors.push(`integrity_check: ${integrity}`);

  db.close();
  return { ok: errors.length === 0, errors, warnings };
}

// CLI 入口
if (process.argv[1] && process.argv[1].endsWith('schema_consistency_check.ts')) {
  const dbPath = process.argv[2] ?? 'D:/tools/wenstar-cc/data/memarch.db';
  const result = checkSchema(dbPath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}
