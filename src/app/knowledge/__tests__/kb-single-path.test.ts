/**
 * kb-single-path.test.ts — 知识检索单一守卫 / 单一来源策略（MEM-UNIFY-V1 批2B）
 * ==========================================================================
 * 锁定四件事：
 *   1. 空关键词不得全表返回（search / weightedSearch）；
 *   2. 显式 UUID 缺省回落会话策略（getSessionEntityUuid）；
 *   3. FTS 命中必须回读 visible_entity_uuids / source_type（否则绕过受限共享与来源隔离）；
 *   4. source_type 只有一套判据（SourceTypePolicy.RETRIEVABLE_WHERE_SQL）；
 *   5. D7：知识库不得再有【本地回复】敏感词直出分支。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RETRIEVABLE_WHERE_SQL,
  RETRIEVABLE_SOURCE_TYPES,
  GARBAGE_SOURCE_TYPES,
  isRetrievable,
} from '../SourceTypePolicy.js';

const ENGINE_SRC = readFileSync(
  join(process.cwd(), 'src/app/knowledge/KnowledgeEngine.ts'), 'utf-8');
const CTX_SRC = readFileSync(
  join(process.cwd(), 'src/app/knowledge/KnowledgeContextBuilder.ts'), 'utf-8');
const FTS_SRC = readFileSync(
  join(process.cwd(), 'src/app/knowledge/FtsSearch.ts'), 'utf-8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('A. 来源策略唯一（SourceTypePolicy）', () => {
  it('SQL 谓词包含 FILE+ANALYSIS，且兼容 NULL/空串', () => {
    const sql = RETRIEVABLE_WHERE_SQL();
    expect(sql).toContain("source_type IN (");
    expect(sql).toContain('source_type IS NULL');
    expect(sql).toContain("source_type = ''");
    expect(sql).toContain("'md'");
    expect(sql).toContain("'document'");
  });

  it('dream_behavior 不在可检索集合（D6 隔离不变）', () => {
    expect(GARBAGE_SOURCE_TYPES.has('dream_behavior')).toBe(true);
    expect(RETRIEVABLE_SOURCE_TYPES.has('dream_behavior')).toBe(false);
    expect(isRetrievable('dream_behavior')).toBe(false);
  });

  it('FtsSearch 索引加载改用统一谓词（不再 NOT IN GARBAGE 的第二套判据）', () => {
    const code = stripComments(FTS_SRC);
    expect(code).toMatch(/RETRIEVABLE_WHERE_SQL\(\)/);
    expect(code).not.toMatch(/GARBAGE_SQL_NOT_IN/);
  });
});

describe('B. 空关键词不得全表返回', () => {
  it('search() 空串直接返回空数组，且不再 SELECT * 全表', () => {
    const code = stripComments(ENGINE_SRC);
    expect(code).toMatch(/if \(!trimmed\) return \[\];/);
    expect(code).not.toMatch(/SELECT \* FROM knowledge_base ORDER BY updated_at DESC LIMIT \?/);
  });

  it('weightedSearch() 空串直接返回空数组', () => {
    const code = stripComments(ENGINE_SRC);
    // 函数体内第一段必须有 trimmed 空守卫
    expect(code).toMatch(/if \(!trimmed\) return \[\];[\s\S]{0,120}const chars/);
  });
});

describe('C. 会话 UUID 兜底 + FTS 行级回读', () => {
  it('search() 用显式 UUID ?? 会话 UUID', () => {
    expect(ENGINE_SRC).toMatch(/const _effUuid = belongEntityUuid \?\? getSessionEntityUuid\(\) \?\? null;/);
  });

  it('FTS 回读 visible_entity_uuids 与 source_type', () => {
    expect(ENGINE_SRC).toMatch(/SELECT id, belong_entity_uuid, visible_entity_uuids, source_type FROM knowledge_base/);
    expect(ENGINE_SRC).toMatch(/visible_entity_uuids: visMap\.get\(r\.id\) \?\? null/);
  });

  it('FTS 与 LIKE 两条路径都不再使用本地 source_type 白名单字面量', () => {
    const code = stripComments(ENGINE_SRC);
    expect(code).not.toMatch(/_fileSourceWhitelist\)\.map/);
    expect(code).toMatch(/RETRIEVABLE_SQL_IN\(\)/);
  });
});

describe('D. D7：【本地回复】直出分支已删除', () => {
  it('KnowledgeContextBuilder 无敏感词直出', () => {
    const code = stripComments(CTX_SRC);
    expect(code).not.toMatch(/【本地回复】/);
    expect(code).not.toMatch(/_isSensitive/);
  });
});
