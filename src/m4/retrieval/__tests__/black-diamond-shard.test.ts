import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { BlackDiamondAdapter, buildDiamondShards } from '../adapters/BlackDiamondAdapter.js';
import {
  decodePerceptionV40,
  encodePerceptionV40FromDims,
} from '../../../m2/PerceptionVector40DCodec.js';
import type { RetrievalContext } from '../types.js';

async function makeDb(withVector: boolean) {
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
  db.exec(`
    CREATE TABLE black_diamond (id TEXT PRIMARY KEY, summary TEXT, emotion_tag TEXT, source_id TEXT, tags TEXT, calcium_level REAL, created_at TEXT, belong_entity_uuid TEXT${withVector ? ', emotion_vector TEXT' : ''});
  `);
  return { queryAll, db };
}

function makeCtx(over: Partial<RetrievalContext> = {}): RetrievalContext {
  const entityUuids = over.entityUuids ?? [];
  const policy: import('../../../governance/police/UUIDPoliceFilter.js').PolicePolicy =
    entityUuids.length > 0
      ? { visibleUuids: new Set<string>(entityUuids), allowUnowned: false }
      : { visibleUuids: new Set<string>(), allowUnowned: true, enforce: false };
  return {
    query: '你还记得我们那次去海边吗',
    policy,
    entityUuids,
    mode: 'balanced',
    limit: 5,
    locusPath: 'default',
    ...over,
  } as RetrievalContext;
}

function vector(close: boolean): string {
  const dims = Array.from({ length: 40 }, (_, i) => (close ? 1 : (i % 2 === 0 ? -1 : 1)));
  return encodePerceptionV40FromDims(dims);
}

describe('BlackDiamondAdapter · 分片 LIKE', () => {
  it('长句切成标点词 + CJK 2-gram，最多 12 片', () => {
    const shards = buildDiamondShards('你还记得我们那次去海边吗');
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.length).toBeLessThanOrEqual(12);
    expect(shards).toContain('海边');
  });

  it('SQL 使用多片 OR LIKE，并扩大候选池后再精排', async () => {
    const { queryAll, db } = await makeDb(true);
    const spy = vi.fn(queryAll);
    const ad = new BlackDiamondAdapter({ queryAll: spy });
    await ad.search(makeCtx());
    const sql = String(spy.mock.calls[0][0]);
    expect((sql.match(/LIKE \?/g) || []).length).toBeGreaterThan(3);
    expect(sql).toContain('emotion_vector');
    const params = spy.mock.calls[0]?.[1] as unknown[] | undefined;
    expect(Number(params?.[(params?.length ?? 0) - 1])).toBeGreaterThanOrEqual(20);
    db.close();
  });
});

describe('BlackDiamondAdapter · 40D 重排', () => {
  it('关键词命中相同时，40D 更接近的排前', async () => {
    const { queryAll, db } = await makeDb(true);
    db.exec(`INSERT INTO black_diamond (id, summary, emotion_tag, tags, calcium_level, created_at, belong_entity_uuid, emotion_vector)
      VALUES ('near', '海边那次', 'warm', '[]', 3, '2026-07-01', 'uuid-zm', '${vector(true).replace(/'/g, "''")}');
      INSERT INTO black_diamond (id, summary, emotion_tag, tags, calcium_level, created_at, belong_entity_uuid, emotion_vector)
      VALUES ('far', '海边那回', 'cold', '[]', 3, '2026-07-01', 'uuid-zm', '${vector(false).replace(/'/g, "''")}');`);
    const q40 = decodePerceptionV40(vector(true))!;
    const ad = new BlackDiamondAdapter({ queryAll });
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-zm'], perception40d: q40 }));
    expect(hits.length).toBe(2);
    expect(hits[0].id).toBe('near');
    db.close();
  });

  it('无 emotion_vector 列时回退，不阻塞召回', async () => {
    const rows = [{ id: 'bd1', summary: '海边那次', emotion_tag: 'warm', source_id: null, calcium_level: 2, created_at: '2026-07-01', belong_entity_uuid: null }];
    const queryAll = vi.fn((sql: string) => {
      if (sql.includes('emotion_vector')) throw new Error('no such column: emotion_vector');
      return rows;
    }) as any;
    const ad = new BlackDiamondAdapter({ queryAll });
    const hits = await ad.search(makeCtx());
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('bd1');
    expect(queryAll).toHaveBeenCalledTimes(2);
  });
});

describe('BlackDiamondAdapter · UUID 隔离', () => {
  it('会晤白名单外实体的黑钻不返回', async () => {
    const { queryAll, db } = await makeDb(false);
    db.exec(`INSERT INTO black_diamond (id, summary, emotion_tag, tags, calcium_level, created_at, belong_entity_uuid)
      VALUES ('bd1', '梓铭的私密海边', 'sad', '[]', 2, '2026-07-01', 'uuid-zm');`);
    const ad = new BlackDiamondAdapter({ queryAll });
    const hits = await ad.search(makeCtx({ entityUuids: ['uuid-sy'] }));
    expect(hits).toHaveLength(0);
    db.close();
  });
});
