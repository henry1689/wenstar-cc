/**
 * perception-40d-form.test.ts — 户籍三元组批3：40D 存储形态统一 + 停止兜底造数据
 * ============================================================================
 * 依据：《户籍三元组全域统一任务书 V1》§1.2.2（2026-10-08 实测更正版）
 *
 * 🔴 立项依据的更正（必须先读，否则会误判本测试的意图）：
 *   任务书初版断言「编解码器只认裸数组、同一列两种形态解码器只认一种」。
 *   **该断言是错的** —— 用真实 `decodePerceptionV40` 扫全库，三种形态解码失败 = 0。
 *   故本批的真实危害只剩一条：**兜底写零等于凭空制造数据**；
 *   形态统一降级为**存储卫生**（业主确认一并做，但**不得改变任何向量数值**）。
 *
 * 本测试锁定：
 *   A. 三种形态解码互通、encode 统一产出 v2 包装
 *   B. 🔴 `SQLiteAdapter` 不得再把零数组当作「补齐」写进 black_diamond
 *   C. v18 迁移把 v1 统一为 v2，且**往返校验：向量数值一字不变**
 *   D. v18 幂等（已是 v2 的不重复改）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  decodePerceptionV40,
  encodePerceptionV40,
  PERCEPTION_40D_ENCODING_VERSION,
} from '../PerceptionVector40DCodec.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const req = createRequire(join(REPO, 'package.json'));

/** 剥注释再扫源码 —— 否则自己的说明文字会把守卫绊倒（批1 已踩过）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf-8'));

/** 取出向量的 40 维数值。入参用 unknown 收口 —— `PerceptionV40` 是无索引签名的具名接口，
 *  直接声明成 Record<string, number> 会 TS2345；内部再收窄，避免用 as any 逃逸。 */
function vals(v: unknown): number[] {
  if (!v || typeof v !== 'object') return [];
  return Object.values(v as Record<string, unknown>).map((x) => Number(x) || 0);
}

describe('[批3] 40D 三种形态：解码互通、encode 统一', () => {
  const v2 = JSON.stringify({ __v: 2, dims: new Array(40).fill(0).map((_, i) => i / 40) });
  const v1 = JSON.stringify(new Array(40).fill(0.5));
  const v0 = JSON.stringify({ d12_enjoyment: 0.5, d15_partner_attachment: 0.7 });

  it('v2 包装 / v1 裸数组 / v0 命名对象 —— 三种都能解出 40 维', () => {
    for (const [name, s] of [['v2', v2], ['v1', v1], ['v0', v0]] as const) {
      const d = decodePerceptionV40(s);
      expect(d, `${name} 形态解码必须成功`).not.toBeNull();
      expect(vals(d).length, `${name} 必须解出 40 维`).toBe(40);
    }
  });

  it('encode 统一产出 v2 包装（含 __v 与 dims）', () => {
    const out = encodePerceptionV40(decodePerceptionV40(v1)!);
    expect(out).toMatch(/"__v":\s*2/);
    expect(out).toMatch(/"dims":\s*\[/);
    expect(JSON.parse(out).__v).toBe(PERCEPTION_40D_ENCODING_VERSION);
  });

  it('🔴 往返无损：v1 → encode → decode 后数值逐维一致（形态统一的底线）', () => {
    const before = vals(decodePerceptionV40(v1));
    const after = vals(decodePerceptionV40(encodePerceptionV40(decodePerceptionV40(v1)!)));
    expect(after).toEqual(before);
  });
});

describe('[批3] 记录：编解码器 v0 分支 fail-open（已知缺陷，本批不修）', () => {
  /**
   * 🔴 这是「零向量」的**真正生产线**，由本批守卫测试当场抓获：
   *   `decodePerceptionV40` 的 v0 命名对象分支对**任意 JSON 对象**都返回全零 40D 向量 ——
   *   因为 `Number(undefined) = NaN` 被 `isFinite` 跳过，于是 40 个维度全留 0，
   *   而不是返回 null 表示「解不出来」。
   *
   * 本批**不修编解码器**（改它会影响全部调用方的语义，属结构性变更，须业主单独裁定）；
   * 改为在**使用侧**自我防护：v18 迁移先做**形态级预检**再决定是否转换。
   *
   * ⚠️ 若日后修好了 v0 分支（让它对「无任何已知维键的对象」返回 null），
   *   **本测试会失败** —— 那是好事：请同步复核 v18 迁移的预检是否仍必要（可保留，无害）。
   */
  it('任意 JSON 对象 → 全零 40D 向量（而不是 null）', () => {
    const d = decodePerceptionV40('{"this":"is not a 40d vector"}');
    expect(d, '当前实现是 fail-open：返回向量而非 null').not.toBeNull();
    expect(vals(d).every((x) => x === 0), '且这个向量是全零').toBe(true);

    // 对照：v2 声明了 __v 却无 dims → 走畸形分支返回 null（这一支是 fail-closed 的）
    expect(decodePerceptionV40('{"__v":2}')).toBeNull();
    // v1 长度不对 → null（fail-closed）
    expect(decodePerceptionV40(JSON.stringify([1, 2, 3]))).toBeNull();
    // 完全非 JSON → null
    expect(decodePerceptionV40('not json at all')).toBeNull();
  });
});

describe('[批3] 守卫：不得再把零数组当作「补齐」写进库', () => {
  it('SQLiteAdapter 不得出现「UPDATE black_diamond SET emotion_vector」+ 零数组的组合', () => {
    const src = read('src/m2/SQLiteAdapter.ts');
    // 逐行检查：同一条语句里既有 black_diamond 的 emotion_vector 更新，又有 new Array(40).fill(0)
    const offenders = src
      .split('\n')
      .filter((l) => /UPDATE\s+black_diamond\s+SET\s+emotion_vector/i.test(l) && /new Array\(40\)\.fill\(0\)/.test(l));
    expect(
      offenders,
      '兜底写零会把「无法解析」伪装成「感知全为零」——等于凭空制造数据。应改为跳过 + 告警。',
    ).toEqual([]);
  });

  it('SQLiteAdapter 必须保留「跳过」语义的可见证据（可审计，而非静默丢弃）', () => {
    const src = read('src/m2/SQLiteAdapter.ts');
    expect(src, 'black_diamond 无法解码时应跳过并告警').toMatch(/不写零向量/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v18 迁移的真实集成测试（跑在内存 sql.js 上）
// ─────────────────────────────────────────────────────────────────────────────

async function freshDb(rows: { kb: Array<[string, string]>; bd: Array<[string, string]> }) {
  const initSqlJs = req('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, migrated_at TEXT NOT NULL, checksum TEXT)`);
  db.run(`INSERT INTO schema_version VALUES (17, 'test-baseline', '2026-10-08T00:00:00Z', 'x')`);
  db.run(`CREATE TABLE knowledge_base (id TEXT PRIMARY KEY, emotion_vector TEXT)`);
  db.run(`CREATE TABLE black_diamond (id TEXT PRIMARY KEY, emotion_vector TEXT)`);
  for (const [id, v] of rows.kb) db.run(`INSERT INTO knowledge_base VALUES (?, ?)`, [id, v]);
  for (const [id, v] of rows.bd) db.run(`INSERT INTO black_diamond VALUES (?, ?)`, [id, v]);
  return { SQL, db };
}
function dump(db: any, table: string): Record<string, string> {
  const res = db.exec(`SELECT id, emotion_vector FROM ${table} ORDER BY id`);
  const out: Record<string, string> = {};
  if (res[0]) for (const [id, v] of res[0].values as string[][]) out[String(id)] = String(v);
  return out;
}

describe('[批3] MigrationManager v18 —— 形态统一且数值不变', () => {
  it('v1 裸数组被统一为 v2 包装，且解码值逐维不变', async () => {
    const { migrateSchema } = await import('../MigrationManager.js');
    const v1 = JSON.stringify(new Array(40).fill(0).map((_, i) => (i % 5) / 5));
    const v0 = JSON.stringify({ d12_enjoyment: 0.9 });
    const { db } = await freshDb({
      kb: [['kb1', v1], ['kb2', v0]],
      bd: [['bd1', v1]],
    });

    const beforeValues = {
      kb1: vals(decodePerceptionV40(v1)),
      kb2: vals(decodePerceptionV40(v0)),
      bd1: vals(decodePerceptionV40(v1)),
    };

    const n = migrateSchema(db);
    expect(n, '应执行 v18（基线 = 17）').toBeGreaterThanOrEqual(1);

    const kb = dump(db, 'knowledge_base');
    const bd = dump(db, 'black_diamond');

    // ① 形态已统一为 v2 包装
    for (const [id, raw] of Object.entries({ ...kb, ...bd })) {
      expect(raw, `${id} 应已统一为 v2 包装`).toMatch(/"__v":\s*2/);
    }
    // ② 🔴 数值一字不变（本批的硬约束）
    expect(vals(decodePerceptionV40(kb.kb1))).toEqual(beforeValues.kb1);
    expect(vals(decodePerceptionV40(kb.kb2))).toEqual(beforeValues.kb2);
    expect(vals(decodePerceptionV40(bd.bd1))).toEqual(beforeValues.bd1);
  });

  it('幂等：已是 v2 包装的行不被改动', async () => {
    const { migrateSchema } = await import('../MigrationManager.js');
    const v2 = JSON.stringify({ __v: 2, dims: new Array(40).fill(0.25) });
    const { db } = await freshDb({ kb: [['kb1', v2]], bd: [] });
    const before = dump(db, 'knowledge_base');
    migrateSchema(db);
    const after = dump(db, 'knowledge_base');
    expect(after.kb1, '已是 v2 的行必须原样保留').toBe(before.kb1);
  });

  it('🔴 解不出来的行**不碰**（不制造数据）—— 不能把它变成零向量', async () => {
    const { migrateSchema } = await import('../MigrationManager.js');
    const bad = '{"this":"is not a 40d vector"}';
    const { db } = await freshDb({ kb: [['kbBad', bad]], bd: [] });
    migrateSchema(db);
    const after = dump(db, 'knowledge_base');
    expect(after.kbBad, '无法解码的行必须原样保留，不得被改写成零向量').toBe(bad);
  });
});
