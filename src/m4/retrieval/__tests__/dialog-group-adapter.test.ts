import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { migrateSchema } from '../../../m2/MigrationManager.js';
import { DialogGroupAdapter } from '../adapters/DialogGroupAdapter.js';
import { indexDocument } from '../../SearchIndexBuilder.js';
import { createDefaultRegistry } from '../index.js';
import type { RetrievalContext } from '../types.js';
import type { PolicePolicy } from '../../../governance/police/UUIDPoliceFilter.js';

/**
 * [ADR-010 P1-C1 / 2026-10-06] 对话块检索域 —— 守卫
 *
 * 锁住四件事：
 *   ① **块聚合**：同一 dialog_group_id 的多条消息命中后聚合成**一个** hit（本域存在的意义）
 *   ② **户籍 fail-closed**：无白名单 ⇒ 零返回；无归属块 ⇒ 不返回（宁缺勿泄）
 *   ③ **元数据透传**：块钙分 / 场景指纹 / 衰减类别 / 轮数进 payload（P1-C2 分层注入要用）
 *   ④ **异常隔离**：SQL 出错返回空数组而非抛出（不得阻塞其他检索路）
 *
 * 另锁一条**架构不变量**：本域复用既有 conversation 索引，**不另建索引**
 * （ADR-010 P1-C1 细化 4 —— search_index 已占全库约 80% 体积）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, '..', '..', '..', 'm2', 'schema.sql');

const UUID_A = 'TXS-000000101';
const UUID_B = 'TXS-000000102';

const q = (db: any, sql: string, p: any[] = []): any[] => {
  const st = db.prepare(sql); st.bind(p);
  const o: any[] = []; while (st.step()) o.push(st.getAsObject()); st.free();
  return o;
};

/** 建库：真 schema + 真迁移（顺带保证 dialog_groups 表按 v16 建出） */
async function buildDb(): Promise<any> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(readFileSync(SCHEMA_SQL, 'utf-8'));
  migrateSchema(db);
  return db;
}

/** 最小 queryAll 适配（sql.js 的 exec 接口 → 行数组） */
function srcOf(db: any) {
  return {
    queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] {
      return q(db, sql, params as any[]) as T[];
    },
  };
}

function policy(visible: string[], searchScope: 'strict' | 'allow-unowned' | 'full' = 'strict'): PolicePolicy {
  return { visibleUuids: new Set(visible), searchScope };
}

const ctxOf = (db: any, over: Partial<RetrievalContext> = {}): RetrievalContext => ({
  query: '杭州 机票',
  policy: policy([UUID_A]),
  entityUuids: [UUID_A],
  mode: 'standard' as any,
  limit: 3,
  ...over,
});

/** 播种子：一个块（2 条消息）+ 索引 */
function seedBlock(
  db: any,
  dgId: string,
  uuid: string | null,
  contents: Array<[string, string]>,
  meta?: { calcium?: number; tag?: string; hash?: string; turns?: number; reason?: string },
): void {
  let seq = Math.floor(Date.now() % 1e6);
  for (const [role, content] of contents) {
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,dialog_group_id,is_test,belong_entity_uuid) VALUES (?,?,?,?,?,0,?)",
      [role, content, '2026-10-06T00:00:00.000Z', ++seq, dgId, uuid],
    );
    const row = q(db, 'SELECT id FROM conversations WHERE seq_pos = ?', [seq])[0];
    // 🔴 用生产同一份索引写入函数 —— 块域复用 conversation 索引，不另建
    indexDocument(db, 'conversation', String(row.id), content, uuid ?? undefined);
  }
  db.run(
    "INSERT OR REPLACE INTO dialog_groups (dialog_group_id,belong_entity_uuid,narrative_tag,block_calcium_score,scene_anchor_hash,turn_count,block_close_reason,lifecycle_state,is_landmark,created_at) " +
    "VALUES (?,?,?,?,?,?,?,'active',0,?)",
    [dgId, uuid ?? '', meta?.tag ?? 'neutral', meta?.calcium ?? 5, meta?.hash ?? 'h-' + dgId,
     meta?.turns ?? contents.length, meta?.reason ?? 'topic_switch', '2026-10-06T00:00:00.000Z'],
  );
}

describe('[ADR-010 P1-C1] 对话块聚合 —— 本域存在的意义', () => {
  it('🔴 同块的多条消息命中 → 聚合成**一个** hit（不是多条）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗'], ['assistant', '杭州机票我看过了，周三出票']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db));

    expect(hits.length, '一个块只应产出一个 hit').toBe(1);
    expect(hits[0].domain).toBe('dialog_group');
    expect(hits[0].route).toBe('dialog_group');
    expect(hits[0].id).toBe('DG1');
    expect(hits[0].backref, '回源键须指向 dialog_groups').toEqual({ table: 'dialog_groups', id: 'DG1' });
    expect(hits[0].text, 'hit.text 应含块内正文（供相关性判断）').toContain('杭州');
  });

  it('两个块 ⇒ 两个 hit；正文不串块', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗']]);
    seedBlock(db, 'DG2', UUID_A, [['user', '杭州那边下雨吗']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db));

    expect(hits.length).toBe(2);
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(['DG1', 'DG2']);
    expect(hits.find((h) => h.id === 'DG2')!.text, 'DG2 的正文不得含 DG1 的内容').not.toContain('机票');
  });

  it('块级元数据透传进 payload（P1-C2 分层注入要用）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗']],
      { calcium: 7.5, tag: 'emotional', hash: 'HASH-X', turns: 4, reason: 'idle_timeout' });
    const [hit] = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db));

    expect(hit.payload).toMatchObject({
      narrativeTag: 'emotional', sceneAnchorHash: 'HASH-X', turnCount: 4, blockCloseReason: 'idle_timeout',
    });
    expect(hit.calciumScore).toBe(7.5);
  });
});

describe('[ADR-010 P1-C1] 户籍 fail-closed —— 宁缺勿泄', () => {
  it('🔴 无白名单（visibleUuids 空）⇒ 零返回', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db, {
      policy: { visibleUuids: new Set(), searchScope: 'strict' } as PolicePolicy,
    }));
    expect(hits, '无白名单必须零返回（buildSqlClause 返回 AND 1=0）').toEqual([]);
  });

  it('🔴 strict 模式下，白名单外的块不得返回', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_A', UUID_A, [['user', '杭州的机票订了吗']]);
    seedBlock(db, 'DG_B', UUID_B, [['user', '杭州的机票订了吗']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db, { policy: policy([UUID_A]) }));

    expect(hits.map((h) => h.id)).toEqual(['DG_A']);
    expect(hits.some((h) => h.id === 'DG_B'), '🔴 白名单外的块泄漏了 —— 跨角色记忆串流').toBe(false);
  });

  it('🔴 strict 模式下，无归属的块不得返回（不走 OR IS NULL 逃生口）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_NULL', null, [['user', '杭州的机票订了吗']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db, { policy: policy([UUID_A]) }));
    expect(hits, 'strict 模式不得放行无归属块').toEqual([]);
  });

  it('enforce=false（离线巡检）时不设 UUID 过滤', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG_B', UUID_B, [['user', '杭州的机票订了吗']]);
    const hits = await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db, {
      policy: { visibleUuids: new Set(), enforce: false, searchScope: 'full' } as PolicePolicy,
    }));
    expect(hits.length, '离线巡检应能全库搜').toBe(1);
  });
});

describe('[ADR-010 P1-C1] 退化输入与异常隔离', () => {
  it('空查询 / 单字查询 ⇒ 空（不查库）', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗']]);
    const a = new DialogGroupAdapter(srcOf(db));
    expect(await a.search(ctxOf(db, { query: '' }))).toEqual([]);
    expect(await a.search(ctxOf(db, { query: '杭' }))).toEqual([]);
  });

  it('🔴 SQL 异常不得抛出 —— 返回空数组，不阻塞其他检索路', async () => {
    const broken = { queryAll(): never { throw new Error('disk I/O error'); } };
    const hits = await new DialogGroupAdapter(broken as any).search(ctxOf(null as any));
    expect(hits, '适配器必须吞掉自身异常并返回空（runAdapter 另有兜底）').toEqual([]);
  });

  it('库中无块 ⇒ 空数组', async () => {
    const db = await buildDb();
    expect(await new DialogGroupAdapter(srcOf(db)).search(ctxOf(db))).toEqual([]);
  });
});

describe('[ADR-010 P1-C1] 架构不变量：复用索引 + 开关可控', () => {
  it('🔴 块域走既有 conversation 索引 —— 不得出现 source_type=dialog_group 的索引行', async () => {
    const db = await buildDb();
    seedBlock(db, 'DG1', UUID_A, [['user', '杭州的机票订了吗']]);
    const kinds = q(db, 'SELECT DISTINCT source_type FROM search_index').map((r) => r.source_type);
    expect(kinds, '块不另建索引（ADR-010 P1-C1 细化 4：search_index 已占全库约 80% 体积）')
      .not.toContain('dialog_group');
    expect(kinds).toContain('conversation');
  });

  it('开关默认开 ⇒ 默认注册表含 dialog_group 域', () => {
    const reg = createDefaultRegistry({ sqlite: { queryAll: () => [] } } as any);
    const domains = reg.all().map((a) => a.domain);
    expect(domains, 'dialog_group 应进入默认注册（当前 yaml enable_dialog_group_memory=true）')
      .toContain('dialog_group');
  });
});
