/**
 * 值保留守卫回归测试（批次1-C，2026-09-12）
 * ==========================================
 * 事故（生产实测，conversations 全库派生结果莫名消失）：
 *   `repairDataIntegrity` 每次启动幂等派生 741 条 entity_genes，但 ~80 秒后
 *   全库该列被逐步清回基线（388），20 秒内走完 735→389 的阶梯式下降。
 *
 * 根因链（逐环实证）：
 *   ① `runDecayMaintenance()`（衰减维护，约 80s 一轮）执行 `SELECT * FROM memories`
 *      → `rowsToRecords()` → `rowToRecord()`
 *   ② `rowToRecord()` 把 `entity_genes` **固定写作 `[]`**（注释称"稍后填充"），
 *      从不读取行自身的 `entity_genes` 列
 *   ③ `write()` 的绑定是 `record.entity_genes ? JSON.stringify(...) : null`
 *      —— `[]` 是**真值** → 落库成 `"[]"` → 等价于抹空
 *   ④ `write()` 走 `INSERT OR REPLACE`（= DELETE + INSERT）→ 已派生的值被静默覆盖
 *   ⑤ 唯一兜底来自 `rowsToRecords` 的 `memory_entities` JOIN（仅覆盖 708 条）
 *      → 「能被 JOIN 补上的记录」幸存 —— 与实测「幸存 389 条 100% 落在该集合内」完全吻合
 *
 * 修复：
 *   A. `rowToRecord()` 改为 `parseEntityGenes(obj.entity_genes)`（列值优先，JOIN 仅作兜底）
 *   B. D8 守卫从「列是否在 column list」升级为「**值是否被保留**」：
 *      `write()` 对 6 个身份关键列中入参未携带（undefined/null）者继承旧行值
 *
 * 本测试把这两条不变量固化为回归防线。
 * 语义边界：显式 `[]` / `''` 视为调用方的**有意赋值**（roleplay 隔离依赖 `entity_genes='[]'` 标记），
 * 守卫不得覆盖 —— 见 C2 第二条用例。
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  SQLiteAdapter,
  MEMORY_IDENTITY_CRITICAL_COLUMNS,
  parseEntityGenes,
} from '../SQLiteAdapter.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'SQLiteAdapter.ts'),
  'utf8',
);

const GENES_JSON = JSON.stringify([
  { name: '徐诗韵', type: 'person', allele: '诗韵', phenotype: 'neutral', knowledge_type: 'factual' },
]);

const makeAdapter = () => new SQLiteAdapter(join(tmpdir(), 'unused-in-test.db'));

describe('C1 — parseEntityGenes（列值 → EntityGene[]）', () => {
  it('合法 JSON 文本 → 解析为数组', () => {
    const out = parseEntityGenes(GENES_JSON);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('徐诗韵');
  });

  it('空 / 缺失 / 非法 → []（不抛异常）', () => {
    expect(parseEntityGenes(null)).toEqual([]);
    expect(parseEntityGenes(undefined)).toEqual([]);
    expect(parseEntityGenes('')).toEqual([]);
    expect(parseEntityGenes('[]')).toEqual([]);
    expect(parseEntityGenes('{bad json')).toEqual([]);
    expect(parseEntityGenes('{"not":"array"}')).toEqual([]);
  });

  it('已是数组 → 原样返回（不做无谓拷贝）', () => {
    const arr = [{ name: '玉瑶' }] as never[];
    expect(parseEntityGenes(arr)).toBe(arr);
  });
});

describe('C2 — rowToRecord 必须从行本身读取 entity_genes（事故回归点）', () => {
  it('行内 entity_genes 非空 → 记录必须携带（而不是 []）', () => {
    const rec = (makeAdapter() as never as { rowToRecord: (r: unknown) => { entity_genes: Array<{ name: string }> } })
      .rowToRecord({ id: 'mem_x', entity_genes: GENES_JSON });
    expect(rec.entity_genes).toHaveLength(1);
    expect(rec.entity_genes[0].name).toBe('徐诗韵');
  });

  it('显式空值语义不变：`[]` / 缺失 → []（roleplay 隔离等设计依赖此标记）', () => {
    const a = makeAdapter() as never as { rowToRecord: (r: unknown) => { entity_genes: unknown[] } };
    expect(a.rowToRecord({ id: 'mem_y', entity_genes: '[]' }).entity_genes).toEqual([]);
    expect(a.rowToRecord({ id: 'mem_z' }).entity_genes).toEqual([]);
  });

  it('源码硬断言：不得再出现「entity_genes: []」固定默认，且必须走 parseEntityGenes', () => {
    expect(SRC).not.toContain('entity_genes: [], // 实体会在');
    expect(SRC).toContain('parseEntityGenes(obj.entity_genes)');
  });
});

describe('C3 — write() 值保留守卫接线与列清单', () => {
  it('write() 必须接线 _preserveIdentityCriticalValues（能力+次序断言，E3收口版）', () => {
    // E3 收口（2026-10-20，R019§二.1）：原断言「头部 400 字符内含值保留守卫」被
    //   业主 2026-10-15 批准的 A 去重闸门前置打破（闸门刻意放所有预处理之前短路）。
    //   改为能力+次序断言：① 两个调用都必须存在；② 去重闸门在前（短路语义不变）；
    //   ③ 值保留守卫在去重闸门之后的非重复路径上仍被无条件调用。
    const i = SRC.indexOf('write(record: EmotionalMemoryRecord): void {');
    expect(i).toBeGreaterThan(0);
    const head = SRC.slice(i, i + 1500);
    const dedupIdx = head.indexOf('_isDuplicateNewWrite(');
    const preserveIdx = head.indexOf('_preserveIdentityCriticalValues(record)');
    expect(dedupIdx).toBeGreaterThan(-1);        // ① 去重闸门在场
    expect(preserveIdx).toBeGreaterThan(-1);     // ① 值保留守卫在场
    expect(dedupIdx).toBeLessThan(preserveIdx);  // ② 闸门前置短路
  });

  it('D8 身份关键列仍为 6 列（不得被误删）', () => {
    expect([...MEMORY_IDENTITY_CRITICAL_COLUMNS].sort()).toEqual(
      [
        'belong_entity_uuid',
        'dna_root_id',
        'entity_genes',
        'fg_entity_names',
        'global_uid',
        'location_fingerprint',
      ].sort(),
    );
  });

  it('守卫语义边界：仅 undefined/null 继承；显式 [] 与 [] 数组不触发 fg_entity_names 继承', () => {
    // 断言实现中「显式携带 entity_genes 时不继承 fg_entity_names」的分支存在（避免与 roleplay 标记冲突）
    expect(SRC).toContain("if (col === 'fg_entity_names' && Array.isArray(r.entity_genes)) return false;");
  });
});
