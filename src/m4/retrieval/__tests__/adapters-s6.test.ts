/**
 * adapters-s6.test.ts — S6 复合适配器单元测试（Foundation V1.0）
 * =============================================================
 * 覆盖：
 *   - ConversationAdapter：对话域 / backref=conversations / 会晤过滤
 *   - FamilyGraphAdapter：FG 档案只读检索 / 零写入 / entityUuid=fg uuid
 *   - MemoryAdapter：包装 retrieveMultiRank 6 路 → SearchHit（route 保留）
 *   - createExtendedRegistry：8 域注册
 */

import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { ConversationAdapter } from '../adapters/ConversationAdapter.js';
import { FamilyGraphAdapter } from '../adapters/FamilyGraphAdapter.js';
import { MemoryAdapter } from '../adapters/MemoryAdapter.js';
import { createExtendedRegistry, createDefaultRegistry } from '../index.js';
import type { RetrievalContext } from '../types.js';

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

describe('ConversationAdapter', () => {
  it('对话域 + backref=conversations + 会晤过滤', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`CREATE TABLE conversations (id INTEGER PRIMARY KEY, content TEXT, timestamp TEXT, role TEXT, is_compacted INTEGER, belong_entity_uuid TEXT);`);
    db.exec(`INSERT INTO conversations (id, content, timestamp, role, is_compacted, belong_entity_uuid) VALUES (1, '星落之城后续剧情', '2026-08-01', 'assistant', 0, 'uuid-zm');`);
    const queryAll = (sql: string, params: unknown[] = []): any[] => {
      const stmt = db.prepare(sql); stmt.bind(params); const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
    };
    const ad = new ConversationAdapter({ queryAll });
    // 梓铭会晤（白名单含 uuid-zm）→ 命中
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-zm'] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: '1', domain: 'conversation', route: 'conversation',
      entityUuid: 'uuid-zm', backref: { table: 'conversations', id: 1 },
    });
    // 诗雨会晤 → 查询层 deny
    const hitsSy = await ad.search(makeCtx({ entityUuids: ['uuid-sy'] }));
    expect(hitsSy).toHaveLength(0);
  });
});

describe('FamilyGraphAdapter', () => {
  it('FG 档案只读检索 + entityUuid=fg uuid', async () => {
    const fg = {
      searchPersonWithMemories: vi.fn((name: string) =>
        name === '熊梓铭'
          ? { profile: { name: '熊梓铭', bio: '实验记录者', relation_to_user: '虚构' }, relations: [{ name: '玉瑶', relation: 'mentor_of' }] }
          : { profile: null, relations: [] },
      ),
      getUUIDByName: vi.fn((name: string) => name === '熊梓铭' ? 'uuid-zm' : null),
    };
    const ad = new FamilyGraphAdapter(fg as any);
    const hits = await ad.search(makeCtx({ query: '梓铭是谁', entities: [{ name: '熊梓铭', type: 'person' }] }));
    expect(fg.searchPersonWithMemories).toHaveBeenCalledWith('熊梓铭');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      domain: 'family_graph', route: 'profile', entityUuid: 'uuid-zm',
    });
    expect(hits[0].text).toContain('熊梓铭');
  });

  it('FG 无写入（只读方法验证）', async () => {
    // 构造只含只读方法的 FG，验证不调用写方法
    const fg = { searchPersonWithMemories: () => ({ profile: null, relations: [] }) };
    const ad = new FamilyGraphAdapter(fg as any);
    const hits = await ad.search(makeCtx({ query: '无此人物' }));
    expect(hits).toEqual([]);
  });
});

describe('MemoryAdapter', () => {
  it('包装 retrieveMultiRank 6 路 → SearchHit（route 保留）', async () => {
    const retriever = {
      retrieveMultiRank: vi.fn(async () => ({
        lists: [
          {
            source: 'keyword',
            items: [
              { id: 'm1', text: '星落之城关键词命中', score: 2, source: 'keyword', entityUuid: 'uuid-zm', calciumScore: 1, createdAt: '2026-08-01' },
            ],
          },
          {
            source: 'work',
            items: [
              { id: 'w9', text: '《星落之城》 摘要', score: 1, source: 'work', entityUuid: 'uuid-zm', calciumScore: 0, createdAt: '2026-08-01' },
            ],
          },
        ],
      })),
    };
    const ad = new MemoryAdapter(retriever);
    const hits = await ad.search(makeCtx({ entities: [{ name: '梓铭', type: 'person' }] }));
    expect(retriever.retrieveMultiRank).toHaveBeenCalled();
    // keyword → memory 域，work → work 域；route 保留召回路
    const kw = hits.find(h => h.id === 'm1')!;
    const wk = hits.find(h => h.id === 'w9')!;
    expect(kw.domain).toBe('memory');
    expect(kw.route).toBe('keyword');
    expect(wk.domain).toBe('work');
    expect(wk.route).toBe('work');
  });

  it('异常返回空', async () => {
    const ad = new MemoryAdapter({ retrieveMultiRank: async () => { throw new Error('mr boom'); } });
    const hits = await ad.search(makeCtx());
    expect(hits).toEqual([]);
  });
});

describe('createExtendedRegistry', () => {
  it('7 域注册（默认 4 + S6 3）— S2-E1 收编后 knowledge/work 由主链覆盖', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`CREATE TABLE black_diamond (id TEXT PRIMARY KEY); CREATE TABLE works (work_id TEXT PRIMARY KEY); CREATE TABLE vault_log (id TEXT PRIMARY KEY); CREATE TABLE memories (id TEXT PRIMARY KEY); CREATE TABLE conversations (id INTEGER PRIMARY KEY);`);
    const sqlite = { queryAll: () => [] as any[] };
    const reg = createExtendedRegistry({
      sqlite,
      knowledgeBase: { search: async () => [] },
      familyGraph: { searchPersonWithMemories: () => ({ profile: null, relations: [] }) },
      memoryRetriever: { retrieveMultiRank: async () => ({ lists: [] }) },
    });
    // 🔴 S2-E1: createDefaultRegistry 去掉 knowledge/work 适配器（由 KnowledgeContextBuilder / V13 work 路覆盖）
    //   默认 4 域（black_diamond/vault/note + ADR-010 P1-C1 的 dialog_group）+ S6 3 域
    //   （conversation/family_graph/memory）= 7
    //   ⚠️ 本断言是**清单记录**（登记了哪些域），不是行为规格 —— 域集合被有意扩大时，
    //      清单随之更新且**保留精确计数**（不改成 toBeGreaterThan 之类的宽松形式）。
    //      块域真正的行为规格在 retrieval/__tests__/dialog-group-adapter.test.ts。
    expect(reg.all()).toHaveLength(7);
    // 默认注册表不含 S6 三域，且不含 knowledge/work（收编后）
    const def = createDefaultRegistry({ sqlite, knowledgeBase: { search: async () => [] } });
    expect(def.all()).toHaveLength(4);
    const domains = def.all().map(a => a.domain);
    expect(domains).not.toContain('knowledge');
    expect(domains).not.toContain('work');
    expect(domains).toContain('black_diamond');
    expect(domains).toContain('vault');
    expect(domains).toContain('note');
    // ADR-010 P1-C1: 块域显式登记（不让它只是「数字 +1」）
    expect(domains).toContain('dialog_group');
  });
});
