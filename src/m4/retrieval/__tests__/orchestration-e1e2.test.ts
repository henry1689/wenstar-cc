import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { migrateSchema } from '../../../m2/MigrationManager.js';
import { DialogGroupAdapter } from '../adapters/DialogGroupAdapter.js';
import { HighCalciumGroupAdapter } from '../adapters/HighCalciumGroupAdapter.js';
import { createDefaultRegistry } from '../index.js';
import { BACKREF_TABLE } from '../backref.js';
import { dedupeKeyOf, type RetrievalContext } from '../types.js';
import type { PolicePolicy } from '../../../governance/police/UUIDPoliceFilter.js';

/**
 * Phase 2.3 (T005 任务E) 守卫 —— 注册表一域多适配器 + lifecycle 降权
 * ============================================================
 * 锁三件事：
 *   ① E1 高钙路与块路**同时注册互不覆盖**（Phase 2.2 时一域一适配器限制下曾静默覆盖 B 链路）
 *   ② E1 两路跨域去重键一致（同组两路命中，融合层折叠为一条，不重复注入）
 *   ③ E2 archived 组降权（排序低于 active/consolidating）但**不排除**（仍可关键词命中）
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, '..', '..', '..', 'm2', 'schema.sql');
const UUID_A = 'TXS-000000101';

const q = (db: any, sql: string, p: any[] = []): any[] => {
  const st = db.prepare(sql); st.bind(p);
  const o: any[] = []; while (st.step()) o.push(st.getAsObject()); st.free();
  return o;
};

async function buildDb(): Promise<any> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(readFileSync(SCHEMA_SQL, 'utf-8'));
  migrateSchema(db);
  return db;
}

function srcOf(db: any) {
  return { queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] { return q(db, sql, params as any[]) as T[]; } };
}

const policy = (visible: string[]): PolicePolicy => ({ visibleUuids: new Set(visible), searchScope: 'strict' });

const ctxOf = (over: Partial<RetrievalContext> = {}): RetrievalContext => ({
  query: '杭州 机票',
  policy: policy([UUID_A]),
  entityUuids: [UUID_A],
  mode: 'standard' as any,
  limit: 5,
  ...over,
});

/** 播一个高钙块：2 条命中消息 + 摘要 + 指定 lifecycle_state */
function seedBlock(db: any, dgId: string, state: string, calcium = 5): void {
  let seq = Math.floor(Date.now() % 1e6);
  for (const content of ['杭州的机票订了吗', '杭州机票我看过了，周三出票']) {
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,belong_entity_uuid) VALUES (?,?,?,?,?,0,?)",
      ['user', content, '2026-10-06T00:00:00.000Z', ++seq, dgId, UUID_A],
    );
    // 🔴 2026-11-02 拆除 n-gram：原此处向 search_index 播种 term 行，该表已由 v33 迁移整表下线。
    //   块路（dialog_group）的召回源是 block_summary 本身（v11 围栏直接分片 LIKE），
    //   高钙路走 recallByStructured，两者都不再读倒排表 —— 会话行本身即足够。
  }
  db.run(
    "INSERT OR REPLACE INTO dialog_groups (dialog_group_id,belong_entity_uuid,narrative_tag,block_calcium_score,scene_anchor_hash,turn_count,block_close_reason,lifecycle_state,is_landmark,created_at,block_summary,summary_state,last_ts) " +
    "VALUES (?,?,?,?,?,?,?, ?,0,?, '【标签】出行\n【叙事】杭州机票事宜\n【情感】平静', 'done', ?)",
    [dgId, UUID_A, 'neutral', calcium, 'h-' + dgId, 2, 'topic_switch', state, '2026-10-06T00:00:00.000Z', '2026-10-06T00:10:00.000Z'],
  );
}

describe('E1 — 注册表一域多适配器：高钙路与块路同时注册互不覆盖', () => {
  it('默认注册表同时含 dialog_group（块路）与 high_calcium_group（高钙路）', () => {
    const reg = createDefaultRegistry({ sqlite: { queryAll: () => [] } } as any);
    const domains = reg.all().map((a) => a.domain);
    expect(domains, '块路必须在').toContain('dialog_group');
    expect(domains, '高钙路必须在（E1 独立 domain 注册）').toContain('high_calcium_group');
  });

  it('dialog_group 域仍是块路本身（高钙路不覆盖它）', () => {
    const reg = createDefaultRegistry({ sqlite: { queryAll: () => [] } } as any);
    const dg = reg.get('dialog_group' as any);
    expect(dg, '块路必须仍在注册表').toBeTruthy();
    expect(Array.from(dg!.routes)).toEqual(['dialog_group']);
    const hc = reg.get('high_calcium_group' as any);
    expect(hc, '高钙路独立注册').toBeTruthy();
    expect(Array.from(hc!.routes)).toEqual(['high_calcium_group']);
  });

  it('BACKREF_TABLE 穷举映射含 high_calcium_group，回源 dialog_groups', () => {
    expect(BACKREF_TABLE.high_calcium_group, 'E1 必须补独立 domain 的回源映射')
      .toEqual({ table: 'dialog_groups', idCol: 'dialog_group_id' });
  });

  it('两路同组命中 → 跨域去重键一致（融合层折叠为一条，不重复注入）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DGX', 'active', 6);
    const dgHit = (await new DialogGroupAdapter(srcOf(db)).search(ctxOf()))[0];
    const hcHit = (await new HighCalciumGroupAdapter(srcOf(db)).search(ctxOf({ query: '杭州' })))[0];
    expect(dgHit, '块路应命中').toBeTruthy();
    expect(hcHit, '高钙路应命中').toBeTruthy();
    expect(dedupeKeyOf(dgHit), '两路同组去重键必须一致（否则融合层重复注入）')
      .toBe(dedupeKeyOf(hcHit));
    db.close();
  });
});

describe('E2 — lifecycle_state 降权消费', () => {
  it('同命中同钙分下，archived 组排序低于 active 组', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_ACTIVE', 'active', 5);
    seedBlock(db, 'DG_ARCH', 'archived', 5);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    const ids = hits.map((h) => h.id);
    expect(ids, '两组都应命中').toEqual(expect.arrayContaining(['DG_ACTIVE', 'DG_ARCH']));
    expect(ids.indexOf('DG_ACTIVE'), 'active 必须排在 archived 前')
      .toBeLessThan(ids.indexOf('DG_ARCH'));
    db.close();
  });

  it('archived 组**不排除**：仍被关键词命中返回（只增不减铁律）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_ARCH_ONLY', 'archived', 4);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    expect(hits.map((h) => h.id), 'archived 组仍须可达')
      .toContain('DG_ARCH_ONLY');
    db.close();
  });

  it('active 与 consolidating 同分（降权只作用于 archived）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_A', 'active', 5);
    seedBlock(db, 'DG_C', 'consolidating', 5);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    const byId = new Map(hits.map((h) => [h.id, h.score]));
    expect(byId.get('DG_A')).toBe(byId.get('DG_C'));
    db.close();
  });

  it('archived 降权后仍进 payload.lifecycleState（可观测）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_ARCH2', 'archived', 5);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf());
    expect((hits[0].payload as any).lifecycleState).toBe('archived');
    db.close();
  });
});
