/**
 * vector-contract-guard — 管控总纲§五 制度化守护断言（CI 硬拦）
 * ===================================================================
 * 三断言（2026-10-26 业主确认写做一致；外部审查边界修正已吸收）：
 *   1. 编码器唯一入口：非测试代码不得手写 `{__v…dims}` 序列化（仅允许 codec 内）
 *   2. 查询同源：查询路径白名单内 `projectState24ToV40` 出现次数受限（合法用途白名单：
 *      SQLiteAdapter write() 兑底 + 合并派生 ≤2 处；emotion 路回退 1 处已标注"内部分析"）
 *   3. 隔离全过滤：MemoryRetriever 直写 SQL 检索 memories 必须含 namespace 排除与 UUID 子句
 *
 * 排除面：*.test.ts / __tests__（实测 7 个测试文件有手写 v2 夹具——测试夹具合法）。
 * 防死灰复燃：任何新增绕过 codec 的序列化/查询侧投影/漏过滤 SQL → 本测试红 → CI 拦截。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..').replace(/\\/g, '/');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e).replace(/\\/g, '/');
    if (p.includes('/__tests__/') || p.endsWith('.test.ts')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const codeOf = (f: string): string =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('管控总纲§五 · 向量编码器与闸门一致性守护断言', () => {
  const all = walk(SRC);

  it('1. 编码器唯一入口：非测试代码无手写 {__v…dims} 序列化（codec 除外）', () => {
    const offenders: string[] = [];
    for (const f of all) {
      if (f.endsWith('/m2/PerceptionVector40DCodec.ts')) continue; // 编码器本体允许
      if (/JSON\.stringify\(\s*\{\s*__v\b/.test(codeOf(f))) offenders.push(f.slice(SRC.length + 1));
    }
    expect(offenders, `手写 v2 序列化（应改用 encodePerceptionV40 / encodePerceptionV40FromDims）: ${offenders.join(', ')}`).toEqual([]);
  });

  it('2. 查询同源：SQLiteAdapter 内 projectState24ToV40 ≤ 3 处（write兜底+合并派生+emotion回退），其余查询文件为 0', () => {
    const offenders: string[] = [];
    for (const f of all) {
      const base = f.split('/').pop()!;
      const code = codeOf(f);
      const hits = (code.match(/projectState24ToV40\(/g) ?? []).length;
      if (base === 'SQLiteAdapter.ts') {
        if (hits > 3) offenders.push(`SQLiteAdapter.ts 投影 ${hits} 处 >白名单 3 处（write兜底/合并派生/emotion内部分析回退）`);
      } else if (['UnifiedSearchEngine.ts', 'MemoryRetriever.ts', 'VectorReranker.ts'].includes(base) && hits > 0) {
        offenders.push(`${base} 查询路径出现 ${hits} 处投影（查询必须原生 p40）`);
      }
    }
    expect(offenders, `查询侧违规投影: ${offenders.join('; ')}`).toEqual([]);
  });

  it('3. 隔离全过滤：MemoryRetriever 直写 memories SQL 必含 namespace 排除与 UUID 子句', () => {
    const t = readFileSync(join(SRC, 'm4/MemoryRetriever.ts'), 'utf8');
    const sqlBlocks = t.match(/`[^`]*FROM memories[^`]*`/g) ?? [];
    expect(sqlBlocks.length).toBeGreaterThan(0);
    for (const sql of sqlBlocks) {
      expect(sql, `SQL 缺 namespace test 排除: ${sql.slice(0, 80)}...`).toContain("namespace");
      // id 定向取回（WHERE id IN）：候选 id 源自已过 UUID 子句的上游查询，天然已隔离——豁免 UUID 断言
      if (!/WHERE id IN/.test(sql)) {
        expect(sql, `SQL 缺 UUID 子句: ${sql.slice(0, 80)}...`).toMatch(/belong_entity_uuid|uuidClause|police\.clause/);
      }
    }
  });
});
