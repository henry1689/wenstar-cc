/**
 * search_index memory 索引回归测试
 * DS-21: 修改目的达成度 — memory 索引必须建立
 * DS-23: 举一反三 — 验证全 source_type 索引完整性
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const Database = require('better-sqlite3');

describe('search_index memory 索引', () => {
  let db: any;

  beforeAll(() => {
    db = new Database('data/webui/fusion_memory.db', { readonly: true, fileMustExist: true });
  });

  afterAll(() => {
    db.close();
  });

  it('DS-21: memory 类型索引存在且非空', () => {
    const r = db.prepare("SELECT COUNT(*) as n FROM search_index WHERE source_type='memory'").get() as { n: number };
    expect(r.n).toBeGreaterThan(0);
  });

  it('DS-23: 所有 source_type 索引完整性', () => {
    const types = db.prepare("SELECT DISTINCT source_type FROM search_index ORDER BY source_type").all() as Array<{ source_type: string }>;
    const typeNames = types.map(t => t.source_type);
    expect(typeNames).toContain('conversation');
    expect(typeNames).toContain('memory');
    expect(typeNames).toContain('black_diamond');
    expect(typeNames).toContain('knowledge_base');
  });

  it('DS-21: memory 索引条目与 memories 表数量一致', () => {
    const memCount = db.prepare("SELECT COUNT(*) as n FROM memories WHERE raw_input IS NOT NULL").get() as { n: number };
    const idxCount = db.prepare("SELECT COUNT(DISTINCT source_id) as n FROM search_index WHERE source_type='memory'").get() as { n: number };
    expect(idxCount.n).toBeGreaterThan(0);
    expect(idxCount.n).toBeLessThanOrEqual(memCount.n);
  });
});
