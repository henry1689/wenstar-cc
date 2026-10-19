import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { migrateSchema } from '../../../m2/MigrationManager.js';
import { highCalciumGroups, countHighCalciumGroups } from '../meeting-recall.js';
import { HighCalciumGroupAdapter } from '../adapters/HighCalciumGroupAdapter.js';
import type { RecallSource } from '../meeting-recall.js';
import type { RetrievalContext } from '../types.js';
import type { PolicePolicy } from '../../../governance/police/UUIDPoliceFilter.js';

/**
 * [Phase 2.2 / B1 · T004] 会晤高钙对话组通道 —— 守卫
 *
 * 锁住五件事（对应 R016 任务B 与 R017 方案②③）：
 *   ① **准入谓词**：只有「钙分 ≥ 阈值 + 有三层摘要 + 过沉淀窗 + 本实体」才进候选
 *   ② **独立配额**：limit 真的裁到位，且按时间近因取
 *   ③ **相关性门**：命中摘要/原文者优先注入；无命中时按近因**保底 1 条**（不永久失忆）
 *   ④ **组级 UUID 隔离**：他人实体的高钙组永不出现（户籍铁律）
 *   ⑤ **适配器契约**：独立 route / domain 级去重键 / 回源键 / 摘要前置
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, '..', '..', '..', 'm2', 'schema.sql');

const UUID_A = 'TXS-000000101';
const UUID_B = 'TXS-000000102';

/** 固定"当前时间"，让沉淀窗与近因排序完全确定（纯函数化） */
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ago = (mins: number) => new Date(NOW - mins * 60000).toISOString();

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

function srcOf(db: any): RecallSource {
  return {
    queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] {
      return q(db, sql, params as any[]) as T[];
    },
  };
}

interface SeedOpts {
  calcium?: number;
  summary?: string | null;
  summaryState?: string;
  lastTs?: string;
  uuid?: string;
  turns?: number;
  reason?: string;
  /** 组内首轮原文（相关性门会拿它做 LIKE 命中校验） */
  body?: string;
}

/** 播一个高钙对话组（摘要默认三层齐全，与 Phase 1 契约一致） */
function seedGroup(db: any, dgId: string, opts: SeedOpts = {}): void {
  const {
    calcium = 6,
    summary = '【标签】杭州、机票\n【叙事】两人讨论去杭州的行程并定了周三的机票。\n【情感】期待',
    summaryState = 'done',
    lastTs = ago(60),
    uuid = UUID_A,
    turns = 4,
    reason = 'topic_switch',
    body = '我们聊聊杭州的机票吧',
  } = opts;
  db.run(
    'INSERT OR REPLACE INTO dialog_groups (dialog_group_id, belong_entity_uuid, narrative_tag, ' +
    'block_calcium_score, scene_anchor_hash, turn_count, block_close_reason, lifecycle_state, ' +
    'is_landmark, created_at, block_summary, summary_state, last_ts) ' +
    "VALUES (?,?,?,?,?,?,?, 'active', 0, ?, ?, ?, ?)",
    [dgId, uuid, 'neutral', calcium, 'h-' + dgId, turns, reason, lastTs, summary, summaryState, lastTs],
  );
  // 组内两轮原文（供"原文命中"相关性校验）
  db.run(
    'INSERT INTO conversations (role, content, timestamp, seq_pos, dialog_group_id, is_test, belong_entity_uuid) ' +
    "VALUES ('user', ?, ?, 1, ?, 0, ?)",
    [body, lastTs, dgId, uuid],
  );
}

const ctxOf = (db: any, over: Partial<RetrievalContext> = {}): RetrievalContext => {
  const policy: PolicePolicy = { visibleUuids: new Set([UUID_A]), searchScope: 'strict' };
  return {
    query: '杭州的机票',
    policy,
    entityUuids: [UUID_A],
    mode: 'standard' as any,
    limit: 3,
    nowMs: NOW,
    ...over,
  };
};

describe('① 准入谓词：钙分 / 三层摘要 / 沉淀窗 / 组级 UUID', () => {
  it('🔴 只有「钙分≥5 + 有摘要 + 过沉淀窗 + 本实体」的组进候选', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_OK', { calcium: 6, lastTs: ago(120) });                 // 全部满足
    seedGroup(db, 'DG_LOW', { calcium: 4, lastTs: ago(120) });                // 低钙 → 排除
    seedGroup(db, 'DG_PENDING', { summaryState: 'pending', lastTs: ago(120) }); // 未生成摘要 → 排除
    seedGroup(db, 'DG_FRESH', { calcium: 6, lastTs: ago(5) });                // 5 分钟前闭组（沉淀窗内）→ 排除
    seedGroup(db, 'DG_OTHER', { calcium: 9, lastTs: ago(120), uuid: UUID_B }); // 他实体 → 排除

    const rows = highCalciumGroups(srcOf(db), UUID_A, 10, { nowMs: NOW, keywords: ['杭州'] });
    expect(rows.map((r) => r.dg_id)).toEqual(['DG_OK']);
    expect(rows[0].uuid).toBe(UUID_A);
    expect(rows[0].calcium).toBe(6);
  });

  it('countHighCalciumGroups 与准入谓词同源（自检口径一致）', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG1', { lastTs: ago(120) });
    seedGroup(db, 'DG2', { lastTs: ago(180) });
    seedGroup(db, 'DG_LOW', { calcium: 4, lastTs: ago(120) });
    seedGroup(db, 'DG_FRESH', { lastTs: ago(5) });

    expect(countHighCalciumGroups(srcOf(db), UUID_A, { nowMs: NOW })).toBe(2);
    // 空实体 → 0（不查库、不抛）
    expect(countHighCalciumGroups(srcOf(db), '')).toBe(0);
  });
});

describe('② 独立配额与时间近因', () => {
  it('limit 裁到位，且取的是**最近**的 N 组', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_OLD', { lastTs: ago(60 * 24 * 9), summary: '【叙事】很早以前的事。\n【标签】旧\n【情感】平' });
    seedGroup(db, 'DG_MID', { lastTs: ago(60 * 24 * 3) });
    seedGroup(db, 'DG_NEW', { lastTs: ago(90) });

    const rows = highCalciumGroups(srcOf(db), UUID_A, 2, { nowMs: NOW });
    expect(rows.map((r) => r.dg_id)).toEqual(['DG_NEW', 'DG_MID']);
  });

  it('同近因时按钙分 tie-break（钙分高者优先）', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_C6', { calcium: 6, lastTs: ago(100) });
    seedGroup(db, 'DG_C9', { calcium: 9, lastTs: ago(100) });

    const rows = highCalciumGroups(srcOf(db), UUID_A, 2, { nowMs: NOW });
    expect(rows[0].dg_id).toBe('DG_C9');
  });

  it('幂等：同参数两次调用返回同一序列', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG1', { lastTs: ago(100) });
    seedGroup(db, 'DG2', { lastTs: ago(200) });
    const a = highCalciumGroups(srcOf(db), UUID_A, 2, { nowMs: NOW }).map((r) => r.dg_id);
    const b = highCalciumGroups(srcOf(db), UUID_A, 2, { nowMs: NOW }).map((r) => r.dg_id);
    expect(a).toEqual(b);
  });

  it('limit <= 0 或空实体 → 空（不查库）', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG1', { lastTs: ago(100) });
    expect(highCalciumGroups(srcOf(db), UUID_A, 0, { nowMs: NOW })).toEqual([]);
    expect(highCalciumGroups(srcOf(db), '', 3, { nowMs: NOW })).toEqual([]);
  });
});

describe('③ 相关性门：命中者优先，无命中保底 1 条', () => {
  it('摘要命中者优先注入，不相关者不占名额', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_RELEVANT', { lastTs: ago(60 * 24 * 2) });  // 较旧，但摘要含"杭州"
    seedGroup(db, 'DG_FRESH_UNRELATED', {
      lastTs: ago(90),
      summary: '【标签】菜谱\n【叙事】讨论晚饭做什么菜。\n【情感】轻松',
      body: '我们晚饭到底做什么菜呢',
    });

    const rows = highCalciumGroups(srcOf(db), UUID_A, 3, { nowMs: NOW, keywords: ['杭州'] });
    expect(rows.map((r) => r.dg_id)).toEqual(['DG_RELEVANT']);
    expect(rows[0].relevant).toBe(true);
    expect(rows[0].matched_terms).toContain('杭州');
  });

  it('摘要没命中但**组内原文**命中 ⇒ 仍判相关', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_BODY', {
      lastTs: ago(90),
      summary: '【标签】晚饭\n【叙事】讨论吃什么。\n【情感】轻松',
    });
    // 原文由 seedGroup 播成"我们聊聊杭州的机票吧" ⇒ 关键词"机票"只在原文出现
    const rows = highCalciumGroups(srcOf(db), UUID_A, 3, { nowMs: NOW, keywords: ['机票'] });
    expect(rows.map((r) => r.dg_id)).toEqual(['DG_BODY']);
    expect(rows[0].relevant).toBe(true);
  });

  it('🔴 无任何相关者 ⇒ 按时间近因**保底 1 条**（不得结构性失忆）', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_A', { lastTs: ago(60 * 24 * 5), summary: '【标签】园艺\n【叙事】讨论种花。\n【情感】平' });
    seedGroup(db, 'DG_B', { lastTs: ago(60 * 24), summary: '【标签】修车\n【叙事】讨论修自行车。\n【情感】烦' });

    const rows = highCalciumGroups(srcOf(db), UUID_A, 3, { nowMs: NOW, keywords: ['量子物理'] });
    expect(rows.length).toBe(1);
    expect(rows[0].dg_id).toBe('DG_B');   // 最近的那组
    expect(rows[0].relevant).toBe(false);
  });

  it('keywords 缺失时用 query 抽词（仍能判相关）', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_Q', { lastTs: ago(90) });
    const rows = highCalciumGroups(srcOf(db), UUID_A, 3, { nowMs: NOW, query: '杭州的机票怎么样' });
    expect(rows.map((r) => r.dg_id)).toEqual(['DG_Q']);
    expect(rows[0].relevant).toBe(true);
  });
});

describe('⑤ 适配器契约（独立 route / 去重键 / 回源键 / 摘要前置）', () => {
  it('无 entityUuids（非会晤）⇒ 零返回', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG1', { lastTs: ago(90) });
    const hits = await new HighCalciumGroupAdapter(srcOf(db)).search(ctxOf(db, { entityUuids: [] }));
    expect(hits).toEqual([]);
  });

  it('有会晤实体 ⇒ route=high_calcium_group、domain 级去重键、回源键指向 dialog_groups', async () => {
    const db = await buildDb();
    seedGroup(db, 'DG_HC', { calcium: 7, lastTs: ago(90) });
    const hits = await new HighCalciumGroupAdapter(srcOf(db)).search(ctxOf(db));

    expect(hits.length).toBe(1);
    const h = hits[0];
    expect(h.route).toBe('high_calcium_group');
    // 存储域与块路相同（同一张 dialog_groups），但**不注册进注册表**（一域一适配器会互相覆盖）
    expect(h.domain).toBe('dialog_group');
    expect(h.id).toBe('DG_HC');
    // 与块路共用 domain 级去重键 ⇒ 同一组两条路都命中时融合层只留一条
    expect(h.dedupeKey).toBe('dialog_group:DG_HC');
    expect(h.backref).toEqual({ table: 'dialog_groups', id: 'DG_HC' });
    expect(h.text).toContain('【摘要】');
    expect(h.entityUuid).toBe(UUID_A);
    expect(h.calciumScore).toBe(7);
    expect(h.createdAt).toBe(ago(90));
    // 分数 = 钙分归一 × 0.6 + 7 天近因 × 0.4 ∈ (0, 1]
    expect(h.score).toBeGreaterThan(0);
    expect(h.score).toBeLessThanOrEqual(1);
    expect((h.payload as any)?.source).toBe('high_calcium_group');
    expect((h.payload as any)?.calciumFloor).toBeGreaterThan(0);
  });
});
