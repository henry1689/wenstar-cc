import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { recentCalciumRows, historyCalciumRows, keywordRecallMemories, type RecallSource } from '../meeting-recall.js';

/**
 * [P0-1 / 2026-10-06 / ADR-011 Phase P1-a] 会晤槽位的时间分层与近因重排
 * ====================================================================
 * 业主实测：「和徐诗雨聊了这几天下雨、去了国美、没看到画展国画，她都记不住」。
 * S1 只读诊断（生产库副本）定位到**结构性**根因：四条通道里没有任何一条会取「1 天以上」的记忆，
 * 而两条槽位都是**纯钙化排序**、无任何时间近因维度。
 *
 * 实测基线（2026-10-06）：
 *   · 14 条 calcium=10 的记忆全部来自 29~40 天前（08-27/28、09-08，其中 4 条是 roleplay 地标）
 *   · 历史槽 ORDER BY calcium_score DESC LIMIT 6 被这 14 条**永久占满**
 *   · 最近 5 天的 176 条记忆在该排序里**最好排名第 43**
 *   · 全表 95.8%（9186/9593）记忆钙化 < 1
 *
 * 本测试锁住两条修法：
 *   历史槽 → **时间片配额**（1~3天:2 / 3~7天:1 / 7~30天:2 / 30天+:1），空片由"最近者"补足
 *   近期槽 → 候选池扩容后按 min(1,钙化)×0.6 + 24h近因×0.4 重排
 */

const ENT = 'TXS-TEST-ENT';
const OTHER = 'TXS-TEST-OTHER';

let SQL: any;
let db: any;

/** 相对当前的 ISO 时间 */
const iso = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

function src(): RecallSource {
  return {
    queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      const st = db.prepare(sql);
      st.bind((params || []) as any[]);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      st.free();
      return out;
    },
  };
}

function put(id: string, hoursAgo: number, calcium: number, belong = ENT, text = '内容'): void {
  db.run(
    'INSERT INTO memories (id, raw_input, calcium_score, effective_strength, created_at, belong_entity_uuid, perception_40d) VALUES (?,?,?,?,?,?,?)',
    [id, `${text}-${id}`, calcium, 1.0, iso(hoursAgo), belong, '{"__v":2,"dims":[]}'],
  );
}

function reset(): void {
  db.run('DELETE FROM memories');
}

beforeAll(async () => {
  SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, raw_input TEXT, calcium_score REAL, effective_strength REAL,
    created_at TEXT, belong_entity_uuid TEXT, perception_40d TEXT)`);
});

describe('[P0-1] 历史槽：时间片配额', () => {
  /** 复刻生产密度：候选远多于 6 条，配额才真正"咬住"（稀疏实体会被"补足"填满，属设计使然） */
  function seedDense(opts: { recent: number; mid: number; ancient: number }): void {
    for (let i = 0; i < opts.recent; i++) put(`recent-${i}`, 24 * (2 + i * 0.01), 0.3); // 1~3 天，低钙
    for (let i = 0; i < opts.mid; i++) put(`mid-${i}`, 24 * (10 + i * 0.01), 0.5);      // 7~30 天
    for (let i = 0; i < opts.ancient; i++) put(`old-${i}`, 24 * (31 + i), 10);          // 30 天+，钙化天花板
  }

  it('🔴 核心：29~40 天前的高钙地标不得占满历史槽，1~3 天前的记忆必须进得来', () => {
    reset();
    // 复刻生产实测：3 条 30 天前 calcium=10 —— 原实现里它们会占满全部 6 席
    // （实测：最近 5 天的 176 条记忆在该排序里最好排名第 43）
    seedDense({ recent: 20, mid: 5, ancient: 3 });

    const rows = historyCalciumRows(src(), ENT, 6);
    const ids = rows.map((r) => r.id);
    const recentCount = ids.filter((i) => i.startsWith('recent-')).length;

    expect(recentCount, `🔴 近期记忆被古老地标挤光：${JSON.stringify(ids)}`).toBeGreaterThanOrEqual(2);
    expect(ids.filter((i) => i.startsWith('old-')).length, '30 天+ 至多占 1 席').toBeLessThanOrEqual(1);
  });

  it('✅ 30 天+ 时间片只占 1 个名额（高钙也不能多占）', () => {
    reset();
    seedDense({ recent: 0, mid: 20, ancient: 5 });

    const ids = historyCalciumRows(src(), ENT, 6).map((r) => r.id);
    expect(ids.filter((i) => i.startsWith('old-')).length, `实际取到：${JSON.stringify(ids)}`).toBeLessThanOrEqual(1);
    expect(ids.filter((i) => i.startsWith('mid-')).length).toBeGreaterThanOrEqual(2);
  });

  it('🔴 空片补足用的是「最近的」而不是「最高钙的」', () => {
    reset();
    // 4 条 30 天前 calcium=10，外加足够的 2 天前记忆 —— 若补足按钙化序，古老地标会回填占满
    seedDense({ recent: 6, mid: 0, ancient: 4 });

    const ids = historyCalciumRows(src(), ENT, 6).map((r) => r.id);
    expect(ids).toContain('recent-2'); // 片配额 2 之外的近期记忆，靠补足席位进来
    expect(ids.filter((i) => i.startsWith('old-')).length, `实际取到：${JSON.stringify(ids)}`).toBeLessThanOrEqual(1);
  });

  it('✅ 稀疏实体（候选 ≤ limit）全部返回 —— 没有可排除的东西，不该丢', () => {
    reset();
    put('only-recent', 24 * 2, 0.3);
    put('only-old', 24 * 40, 10);
    const ids = historyCalciumRows(src(), ENT, 6).map((r) => r.id);
    expect(ids.sort()).toEqual(['only-old', 'only-recent']);
  });

  it('✅ 结果不超 limit、无重复、且全部 ≥1 天', () => {
    reset();
    for (let i = 0; i < 12; i++) put(`m-${i}`, 24 * (1.5 + i * 3), 5 - i * 0.2);
    const rows = historyCalciumRows(src(), ENT, 6);
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('✅ 实体隔离：别人的记忆不进来', () => {
    reset();
    put('mine', 24 * 2, 1.0);
    put('theirs', 24 * 2.5, 10, OTHER);
    const ids = historyCalciumRows(src(), ENT, 6).map((r) => r.id);
    expect(ids).toContain('mine');
    expect(ids).not.toContain('theirs');
  });

  it('✅ 空库返回空数组', () => {
    reset();
    expect(historyCalciumRows(src(), ENT, 6)).toEqual([]);
  });
});

describe('[P0-1] 近期槽：钙化 + 时间近因重排', () => {
  it('🔴 同钙化时，新的排前（原实现退化为"最新优先"纯靠 SQL 巧合）', () => {
    reset();
    put('same-old', 23, 0.8);
    put('same-new', 0.5, 0.8);
    const now = Date.now();

    const ids = recentCalciumRows(src(), ENT, 8, now).map((r) => r.id);
    expect(ids.indexOf('same-new')).toBeLessThan(ids.indexOf('same-old'));
  });

  it('🔴 但钙化信号不能被近因淹没：当天高钙旧内容仍压过当天低钙新内容', () => {
    reset();
    put('high-old', 20, 1.5); // 1.5×0.6 + 0.167×0.4 ≈ 0.967
    put('low-new', 0.1, 0.3); // 0.3×0.6 + 0.996×0.4 ≈ 0.578
    const now = Date.now();

    const ids = recentCalciumRows(src(), ENT, 8, now).map((r) => r.id);
    expect(
      ids.indexOf('high-old'),
      '🔴 钙化项被压没了 —— 说明归一化用了 calcium/10 而非 min(1, calcium)',
    ).toBeLessThan(ids.indexOf('low-new'));
  });

  it('✅ 只取当日（<1 天），且不超 limit、无重复', () => {
    reset();
    put('today-a', 2, 1.0);
    put('today-b', 5, 0.9);
    put('yesterday', 30, 10); // ≥1 天，不该出现在近期槽

    const rows = recentCalciumRows(src(), ENT, 8, Date.now());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('today-a');
    expect(ids).not.toContain('yesterday');
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('✅ 候选池扩容：limit=3 时仍能从更大的池里挑出最优', () => {
    reset();
    // 钙化序前 3 名都是 23 小时前的旧内容；最新的一条钙化排在第 5
    put('c1', 23, 2.0);
    put('c2', 23, 1.9);
    put('c3', 23, 1.8);
    put('c4', 23, 1.7);
    put('newest', 0.2, 1.6);

    const ids = recentCalciumRows(src(), ENT, 3, Date.now()).map((r) => r.id);
    expect(ids, '🔴 候选池没扩容 —— 最新的一条根本没进池').toContain('newest');
  });

  it('✅ 空库返回空数组', () => {
    reset();
    expect(recentCalciumRows(src(), ENT, 8)).toEqual([]);
  });
});

describe('[P0-1] 关键词路：时间窗与砂金库兜底同源', () => {
  it('🔴 隔天提起话题时也必须能召回（原实现硬编码当日 <1 天）', () => {
    reset();
    // 用户隔天提起的"国美"只出现在 2 天前 —— 当日窗口下必然 0 命中
    put('case-2day', 24 * 2, 0.5, ENT, '国美');

    expect(keywordRecallMemories(src(), ENT, ['国美'], 4, 1), '窗口=1 天时应当够不到').toEqual([]);
    expect(
      keywordRecallMemories(src(), ENT, ['国美'], 4, 7).map((r) => r.id),
      '🔴 窗口放宽后仍取不到 —— 隔天提起的话题永远召不回',
    ).toEqual(['case-2day']);
  });

  it('✅ 每个关键词取**最近** 1 条（不是最高钙的）', () => {
    reset();
    put('old-high', 24 * 5, 10);
    put('recent-low', 24 * 1.5, 0.2);

    const ids = keywordRecallMemories(src(), ENT, ['内容'], 4, 7).map((r) => r.id);
    expect(ids).toEqual(['recent-low']);
  });

  it('✅ 超出窗口的不召回；无关键词返回空', () => {
    reset();
    put('too-old', 24 * 20, 5);
    expect(keywordRecallMemories(src(), ENT, ['内容'], 4, 7)).toEqual([]);
    expect(keywordRecallMemories(src(), ENT, [], 4, 7)).toEqual([]);
  });
});
