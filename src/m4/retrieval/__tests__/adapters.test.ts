/**
 * adapters.test.ts — 多路检索首批适配器单元测试（Foundation V1.0）
 * ================================================================
 * 覆盖：
 *   - KnowledgeAdapter：包 ctx.knowledgeBase.search，backref/entityUuid 正确
 *   - BlackDiamondAdapter：SQL 直查 + buildSqlClause 收编，会晤过滤
 *   - WorkAdapter：work 域 / backref=works / 会晤仅实体作品
 *   - VaultAdapter：vault 域 / backref=vault_log
 *   - NoteAdapter：note 域 / backref=memories
 *   - backfillBackrefs：真 id 补 backref，假 id 剔除
 */

import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { KnowledgeAdapter } from '../adapters/KnowledgeAdapter.js';
import { BlackDiamondAdapter } from '../adapters/BlackDiamondAdapter.js';
import { WorkAdapter } from '../adapters/WorkAdapter.js';
import { VaultAdapter } from '../adapters/VaultAdapter.js';
import { NoteAdapter } from '../adapters/NoteAdapter.js';
import { backfillBackrefs } from '../backref.js';
import type { RetrievalContext } from '../types.js';

/** sql.js 内存库 + queryAll 包装 */
async function makeDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const queryAll = (sql: string, params: unknown[] = []): any[] => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  // 建表（对齐 schema 关键列）
  db.exec(`
    CREATE TABLE black_diamond (id TEXT PRIMARY KEY, summary TEXT, emotion_tag TEXT, source_id TEXT, tags TEXT, calcium_level REAL, created_at TEXT, belong_entity_uuid TEXT);
    CREATE TABLE works (work_id TEXT PRIMARY KEY, title TEXT, work_type TEXT, summary TEXT, full_text TEXT, belong_entity_uuid TEXT, created_at TEXT);
    CREATE TABLE vault_log (id TEXT PRIMARY KEY, detail TEXT, content_md TEXT, operation TEXT, created_at TEXT, belong_entity_uuid TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, memory_type TEXT, sub_type TEXT, note_key TEXT, raw_input TEXT, is_valid INTEGER, created_at TEXT, belong_entity_uuid TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, content TEXT, belong_entity_uuid TEXT);
  `);
  return { queryAll };
}

/** 构造 ctx：entityUuids 与 policy 同步（对齐 buildPolicePolicy 语义：会晤 deny / 户主 enforce:false） */
function makeCtx(over: Partial<RetrievalContext> = {}): RetrievalContext {
  const entityUuids = over.entityUuids ?? [];
  const policy: import('../../../governance/police/UUIDPoliceFilter.js').PolicePolicy =
    entityUuids.length > 0
      ? { visibleUuids: new Set<string>(entityUuids), allowUnowned: false }
      : { visibleUuids: new Set<string>(), allowUnowned: true, enforce: false };
  return {
    query: '星落之城',
    policy,
    entityUuids,
    mode: 'balanced',
    limit: 5,
    locusPath: 'default',
    ...over,
  };
}

describe('KnowledgeAdapter', () => {
  it('包装 knowledgeBase.search，输出 SearchHit + backref', async () => {
    const kb = {
      search: vi.fn(async () => [
        { id: 'kb1', title: '星落之城设定', content: '一座悬浮在银河上的古城', created_at: '2026-07-01', belong_entity_uuid: null },
        { id: 'kb2', title: '梓铭档案', content: '实验记录者', created_at: '2026-07-02', belong_entity_uuid: 'uuid-zm' },
      ]),
    };
    const ad = new KnowledgeAdapter({ knowledgeBase: kb });
    const hits = await ad.search(makeCtx());
    // 批2B：KnowledgeAdapter 现在传 (query, limit, perception, entityUuid)；
    //   无活跃实体时第 4 参为 undefined，由引擎内部回落会话策略。
    expect(kb.search.mock.calls[0].slice(0, 2)).toEqual(['星落之城', 5]);
    await ad.search(makeCtx({ entityUuids: ['uuid-zm'] }));
    expect((kb.search.mock.calls[1] as unknown[])[3]).toBe('uuid-zm');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      id: 'kb1', domain: 'knowledge', route: 'knowledge',
      entityUuid: null, backref: { table: 'knowledge_base', id: 'kb1' },
    });
    expect(hits[0].text).toContain('星落之城设定');
    expect(hits[1].entityUuid).toBe('uuid-zm');
  });

  it('短查询返回空', async () => {
    const ad = new KnowledgeAdapter({ knowledgeBase: { search: vi.fn() } });
    const hits = await ad.search(makeCtx({ query: '  ' }));
    expect(hits).toEqual([]);
  });

  it('异常返回空不抛出', async () => {
    const ad = new KnowledgeAdapter({ knowledgeBase: { search: vi.fn(async () => { throw new Error('kb boom'); }) } });
    const hits = await ad.search(makeCtx());
    expect(hits).toEqual([]);
  });
});

describe('BlackDiamondAdapter', () => {
  it('SQL 直查 + backref + entityUuid 保留', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO black_diamond (id, summary, emotion_tag, tags, calcium_level, created_at, belong_entity_uuid) VALUES ('bd1', '星落之城核心剧情', 'longing', '[]', 3, '2026-07-01', 'uuid-zm')`);
    const ad = new BlackDiamondAdapter({ queryAll });
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-zm'] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'bd1', domain: 'black_diamond', route: 'diamond',
      entityUuid: 'uuid-zm', backref: { table: 'black_diamond', id: 'bd1' },
    });
    expect(hits[0].calciumLevel).toBe(3);
  });

  it('会晤过滤：白名单外实体黑钻不返回（查询层 deny）', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO black_diamond (id, summary, emotion_tag, tags, calcium_level, created_at, belong_entity_uuid) VALUES ('bd1', '梓铭的私密', 'sad', '[]', 2, '2026-07-01', 'uuid-zm')`);
    const ad = new BlackDiamondAdapter({ queryAll });
    // 诗雨会晤（白名单=诗雨），梓铭的黑钻被查询层拦截
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-sy'] }));
    expect(hits).toHaveLength(0);
  });
});

describe('WorkAdapter', () => {
  it('作品召回 + backref=works + 会晤仅实体作品', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO works (work_id, title, work_type, summary, full_text, belong_entity_uuid, created_at) VALUES ('w1', '星落之城', 'novel', '第一篇章', '很长的小说全文', 'uuid-zm', '2026-07-01')`);
    const ad = new WorkAdapter({ queryAll });
    // 户主（无 entityUuids）→ 全放行
    const hitsMaster = await ad.search(makeCtx());
    expect(hitsMaster).toHaveLength(1);
    expect(hitsMaster[0]).toMatchObject({
      id: 'w1', domain: 'work', route: 'work',
      entityUuid: 'uuid-zm', backref: { table: 'works', id: 'w1' },
    });
    expect(hitsMaster[0].text).toContain('《星落之城》');
    // 会晤（诗雨）→ 梓铭作品 deny
    const hitsMeeting = await ad.search(makeCtx({ entityUuids: ['uuid-sy'] }));
    expect(hitsMeeting).toHaveLength(0);
  });
});

describe('VaultAdapter', () => {
  // 🔴 MEM-UNIFY-V1 批3（D3）：vault_log 是审计台账 —— 只有 auto_induct 事实锚点进入证据层，
  //   promote/landmark 记录只审计、不得被召回。
  it('只召回 auto_induct（promote 记录不进入召回）+ backref=vault_log', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO vault_log (id, detail, content_md, operation, created_at, belong_entity_uuid) VALUES ('v1', '用户说过要写星落之城', '承诺写星落之城', 'promote', '2026-07-01', 'uuid-zm')`);
    queryAll(`INSERT INTO vault_log (id, detail, content_md, operation, created_at, belong_entity_uuid) VALUES ('v2', '[对话归纳·地址] 我住在银河路', '鸿艺曾说过：我住在银河路', 'auto_induct', '2026-07-02', 'uuid-zm')`);
    const ad = new VaultAdapter({ queryAll });
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-zm'] }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      domain: 'vault', route: 'vault',
      backref: { table: 'vault_log', id: 'v2' },
    });
    expect(hits[0].text).toContain('银河路');
    expect(hits.map((h) => h.id)).not.toContain('v1');
  });
});

describe('NoteAdapter', () => {
  it('玉瑶记事检索 + backref=memories', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO memories (id, memory_type, sub_type, note_key, raw_input, is_valid, created_at, belong_entity_uuid) VALUES ('n1', 'note', 'fact', '星落之城位置', '星落之城位于银河第三旋臂', 1, '2026-07-01', 'uuid-zm')`);
    const ad = new NoteAdapter({ queryAll });
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-zm'] }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      id: 'n1', domain: 'note', route: 'note',
      backref: { table: 'memories', id: 'n1' },
    });
    expect(hits[0].text).toContain('星落之城');
  });
});

describe('backfillBackrefs', () => {
  it('真 id 补 backref，假 id 剔除（V13 fake id 修复）', async () => {
    const { queryAll } = await makeDb();
    queryAll(`INSERT INTO conversations (id, content, belong_entity_uuid) VALUES ('conv1', '真实对话', 'uuid-zm')`);
    const hits = [
      // 真 conversation id → 补 backref
      { id: 'conv1', domain: 'conversation', text: 't', score: 1, entityUuid: 'uuid-zm', createdAt: '' },
      // 假 conversation id（V13 fake 映射：id 是 memories UUID 非 conversations.id）→ 剔除
      { id: 'fake-memory-uuid', domain: 'conversation', text: 't', score: 1, entityUuid: 'uuid-zm', createdAt: '' },
      // family_graph 不校验 → 保留
      { id: 'fg-uuid', domain: 'family_graph', text: 't', score: 1, entityUuid: null, createdAt: '' },
    ] as any[];
    const result = backfillBackrefs(hits, { queryAll });
    expect(result).toHaveLength(2);
    expect(result[0].backref).toEqual({ table: 'conversations', id: 'conv1' });
    expect(result[1].domain).toBe('family_graph');
  });
});
