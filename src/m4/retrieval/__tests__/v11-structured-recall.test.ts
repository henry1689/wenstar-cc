// 检索架构 v11 §S2 单测 —— 围栏 / 精排 / 组合刺 / 影子观测
// 🔴 本文件**不接触生产库**：围栏取数一律走注入的内存假 db（TEST_NO_PRODUCTION_DB_WRITE）。
import { describe, it, expect, afterEach } from 'vitest';
import {
  aggregateSpines,
  aggregateSpinesWithReason,
  clampSpine40D,
  COMPOSITE_MEMBER_CEILING,
} from '../CompositeUrchin.js';
import {
  aggregateGroupSpines,
  buildKeywordShards,
  countHitShards,
  recallByStructured,
  scoreAndRank,
  shardList,
  type EnclosureHit,
  type StructuredRecallDb,
} from '../StructuredRecall.js';
import {
  CALCIUM_SCORE_MAX,
  ENCLOSURE_DEFAULT_LIMIT,
  QUERY_SHARD_MAX,
  RECENCY_HALF_LIFE_MS,
  RETRIEVAL_V11_WEIGHTS,
  Flags,
  V11_FLAG_NAMES,
} from '../Flags.js';
import {
  coverageOf,
  crossEntityLeakCount,
  isRealRun,
  incr,
  observeLatency,
  resetForTest,
  snapshot,
} from '../ShadowLog.js';

const UUID_A = 'TXS-0001-AAAA';
const UUID_B = 'TXS-0002-BBBB';

const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
  resetForTest();
});

/**
 * 内存假 db：记录被调用的 SQL 与参数，便于断言「UUID 闸门第一个拼进 WHERE」。
 *
 * 🔴 签名必须是 **(sql, params?: unknown[]) 数组式**，与生产 `SQLiteAdapter.queryAll`
 * 一致（`src/m2/SQLiteAdapter.ts:1987`）。假 db 写成 varargs 会掩盖真实实现的签名差异
 * —— 2026-10-27 生产实测就是这么漏掉的（展开调用导致参数静默丢失，围栏恒空）。
 */
function fakeDb(rows: Array<Record<string, unknown>>, onCall?: (sql: string, params: unknown[]) => void): StructuredRecallDb {
  return {
    queryAll(sql: string, params?: unknown[]) {
      const arr = Array.isArray(params) ? params : [];
      onCall?.(sql, arr);
      return rows;
    },
  };
}

// ══════════════════════════════════════════════════════════════════
describe('Flags — 八个回滚开关', () => {
  it('未设置任何环境变量时八项全关（fail-safe）', () => {
    for (const n of V11_FLAG_NAMES) setEnv(n, undefined);
    expect(Flags.enabled()).toBe(false);
    expect(Flags.enclosure()).toBe(false);
    expect(Flags.rerank()).toBe(false);
    expect(Flags.semantic()).toBe(false);
    expect(Flags.llmRerank()).toBe(false);
    expect(Flags.dialogGroup()).toBe(false);
    expect(Flags.gateFailClosed()).toBe(false);
    expect(Flags.gapLedger()).toBe(false);
  });

  it('只有显式 "true" 判真，0 / false / TRUE 一律为关', () => {
    for (const n of V11_FLAG_NAMES) setEnv(n, undefined);
    setEnv('RETRIEVAL_V11', '0');
    expect(Flags.enabled()).toBe(false);
    setEnv('RETRIEVAL_V11', 'false');
    expect(Flags.enabled()).toBe(false);
    setEnv('RETRIEVAL_V11', 'TRUE');
    expect(Flags.enabled()).toBe(false);
    setEnv('RETRIEVAL_V11', 'true');
    expect(Flags.enabled()).toBe(true);
  });

  it('改环境变量立即生效，无需重启（任务书 §S2 C）', () => {
    setEnv('RETRIEVAL_V11', 'false');
    const before = Flags.enabled();
    setEnv('RETRIEVAL_V11', 'true');
    expect(Flags.enabled()).not.toBe(before);
    expect(Flags.enabled()).toBe(true);
  });

  it('w_semantic 上限 0.10，四权重和为 1.0', () => {
    expect(RETRIEVAL_V11_WEIGHTS.semantic).toBeLessThanOrEqual(0.10);
    const s = RETRIEVAL_V11_WEIGHTS.hit + RETRIEVAL_V11_WEIGHTS.calcium
      + RETRIEVAL_V11_WEIGHTS.recency + RETRIEVAL_V11_WEIGHTS.semantic;
    expect(s).toBeCloseTo(1.0, 6);
  });

  it('常量冻结，运行期改不动（魔数禁令的机械保障）', () => {
    expect(() => { (RETRIEVAL_V11_WEIGHTS as { hit: number }).hit = 0.9; }).toThrow();
    expect(RETRIEVAL_V11_WEIGHTS.hit).toBe(0.45);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('CompositeUrchin — 组合海胆聚合（不落盘）', () => {
  const spineOf = (v: number) => new Array(40).fill(v);

  it('两个等权成员取平均', () => {
    const out = aggregateSpines([
      { spine: spineOf(0.2), weight: 1 },
      { spine: spineOf(0.4), weight: 1 },
    ]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(40);
    expect(out![0]).toBeCloseTo(0.3, 6);
    expect(out![39]).toBeCloseTo(0.3, 6);
  });

  it('权重不等时按 calcium 加权', () => {
    const out = aggregateSpines([
      { spine: spineOf(0.0), weight: 1 },
      { spine: spineOf(1.0), weight: 3 },
    ]);
    expect(out![0]).toBeCloseTo(0.75, 6);
  });

  it('无有效成员返回 null，不伪造零向量', () => {
    expect(aggregateSpines([])).toBeNull();
    expect(aggregateSpines([{ spine: null, weight: 5 }])).toBeNull();
    expect(aggregateSpines([{ spine: spineOf(1), weight: 0 }])).toBeNull();
    expect(aggregateSpines([{ spine: spineOf(1), weight: -1 }])).toBeNull();
  });

  it('刺长度不是 40 的脏成员被剔除，不参与加权', () => {
    const out = aggregateSpines([
      { spine: new Array(24).fill(1), weight: 100 },
      { spine: spineOf(0.5), weight: 1 },
    ]);
    expect(out![0]).toBeCloseTo(0.5, 6);
  });

  it('值域钳制：D36/D37 允许负值，其余维钳到 [0,1]', () => {
    const v = new Array(40).fill(2);
    v[35] = -3; // D36
    v[36] = -3; // D37
    const c = clampSpine40D(v);
    expect(c[0]).toBe(1);
    expect(c[34]).toBe(1);   // D35 → [0,1]
    expect(c[35]).toBe(-1);  // D36 → [-1,1]
    expect(c[36]).toBe(-1);  // D37 → [-1,1]
    expect(c[37]).toBe(1);   // D38 → [0,1]
    expect(c[39]).toBe(1);   // D40 → [0,1]
  });

  it('成员数超上限不聚合，只用壳肉（蓝皮书 §6.4）', () => {
    const many = Array.from({ length: COMPOSITE_MEMBER_CEILING + 1 }, () => ({ spine: spineOf(1), weight: 1 }));
    expect(aggregateSpines(many)).toBeNull();
    const r = aggregateSpinesWithReason(many);
    expect(r.spine).toBeNull();
    expect(r.reason).toBe('ceiling_exceeded');
  });

  it('退化原因可归因', () => {
    expect(aggregateSpinesWithReason([]).reason).toBe('empty_members');
    expect(aggregateSpinesWithReason([{ spine: null, weight: 1 }]).reason).toBe('no_valid_spine');
    expect(aggregateSpinesWithReason([{ spine: spineOf(0.5), weight: 1 }]).reason).toBe('ok');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('StructuredRecall — 围栏层', () => {
  it('分片复用 buildNgrams，且不超过上限', () => {
    const shards = shardList(['心情不好']);
    expect(shards.length).toBeGreaterThan(0);
    expect(shards.length).toBeLessThanOrEqual(QUERY_SHARD_MAX);
    expect(shards).toContain('心情');
  });

  it('空关键词不产出 LIKE 子句', () => {
    const s = buildKeywordShards('raw_input', []);
    expect(s.sql).toBe('');
    expect(s.params).toEqual([]);
  });

  it('SQL 子句列名来自域映射表，不写死', () => {
    const s = buildKeywordShards('content', ['天气']);
    expect(s.sql).toContain('content LIKE ?');
    expect(s.params.length).toBeGreaterThan(0);
  });

  it('hitShards 现算命中分片数', () => {
    expect(countHitShards('今天心情不好', ['心情', '天气', '不好'])).toBe(2);
    expect(countHitShards('', ['心情'])).toBe(0);
    expect(countHitShards('任意', [])).toBe(0);
  });

  it('🔴 UUID 白名单为空 ⇒ 直接返回空（fail-closed，红线 14）', async () => {
    let called = false;
    const db = fakeDb([{ id: '1', text: 'x' }], () => { called = true; });
    const out = await recallByStructured(db, { domain: 'memory', keywords: ['心情'], limit: 10 });
    expect(out).toEqual([]);
    expect(called).toBe(false); // 一条 SQL 都不该发
  });

  it('🔴 UUID 闸门第一个拼进 WHERE，且空白名单产出 AND 1=0', async () => {
    let seenSql = '';
    const db = fakeDb([], (sql) => { seenSql = sql; });
    await recallByStructured(db, { domain: 'memory', entityUuids: [], keywords: ['心情'], limit: 10 });
    expect(seenSql).toBe('');

    let seenParams: unknown[] = [];
    const db2 = fakeDb([], (sql, p) => { seenSql = sql; seenParams = p; });
    await recallByStructured(db2, {
      domain: 'memory', entityUuids: [UUID_A, UUID_B], keywords: ['心情'], limit: 10,
    });
    const whereIdx = seenSql.indexOf('WHERE');
    expect(whereIdx).toBeGreaterThan(-1);
    // 1=1 之后紧跟的必须是归属闸门，且在 LIKE 分片之前
    const afterWhere = seenSql.slice(whereIdx);
    expect(afterWhere).toContain('belong_entity_uuid IN (?,?)');
    expect(afterWhere.indexOf('belong_entity_uuid IN')).toBeLessThan(afterWhere.indexOf(' LIKE '));
    // UUID 值走参数化占位符，不进 SQL 字符串（防注入）
    expect(seenParams.slice(0, 2)).toEqual([UUID_A, UUID_B]);
    expect(seenSql).not.toContain(UUID_A);
  });

  it('🔴 围栏 SQL 抛错 ⇒ fail-closed 返回空，不抛出', async () => {
    const db: StructuredRecallDb = {
      queryAll() { throw new Error('boom'); },
    };
    const out = await recallByStructured(db, { domain: 'memory', entityUuids: [UUID_A], limit: 5 });
    expect(out).toEqual([]);
  });

  it('🔴 无数据库 queryAll ⇒ fail-closed 返回空', async () => {
    const out = await recallByStructured({} as StructuredRecallDb, {
      domain: 'memory', entityUuids: [UUID_A], limit: 5,
    });
    expect(out).toEqual([]);
  });

  it('未知域 fail-closed', async () => {
    const out = await recallByStructured(fakeDb([]), {
      domain: 'nope' as never, entityUuids: [UUID_A], limit: 5,
    });
    expect(out).toEqual([]);
  });

  it('🔴 conversations 域用 timestamp 列（该表无 created_at）', async () => {
    let seenSql = '';
    const db = fakeDb([], (sql) => { seenSql = sql; });
    await recallByStructured(db, {
      domain: 'conversation',
      entityUuids: [UUID_A],
      timeWindow: { fromMs: Date.now() - 86400_000, toMs: Date.now() },
      limit: 5,
    });
    expect(seenSql).toContain('FROM conversations');
    expect(seenSql).toContain('timestamp');
    expect(seenSql).not.toContain('created_at');
  });

  it('🔴 回归：四域拼出的 WHERE 段每个子句都以 AND 起头（2026-10-27 真库踩过的语法缺陷）', async () => {
    // 缺陷形态：domain 的 extraWhere 漏了开头 AND ⇒ 拼成 `IN (?,?) COALESCE(...)` ⇒
    // 整条围栏 SQL 语法错误 ⇒ fail-closed 全部返回空。假 db 只做子串断言发现不了，
    // 故此处直接断言拼装结果的结构。
    const domains = ['memory', 'conversation', 'dialog_group', 'work'] as const;
    for (const domain of domains) {
      let seenSql = '';
      const db = fakeDb([], (sql) => { seenSql = sql; });
      await recallByStructured(db, {
        domain, entityUuids: [UUID_A], keywords: ['心情'], limit: 5,
      });
      const where = seenSql.slice(seenSql.indexOf('WHERE 1=1') + 'WHERE 1=1'.length);
      // ① 归属闸门之后的每个子句都必须以 AND 开头
      expect(where, `${domain} 域 WHERE 段`).toMatch(/^\s+AND\s/);
      // ② 精确断言缺陷形态：`)` 与关键字之间没有连接词
      //    （合法形态是 `) AND COALESCE`，缺陷形态是 `) COALESCE`）
      expect(where, `${domain} 域 不得裸拼`).not.toMatch(/\)\s+(COALESCE|block_summary|namespace|full_text|is_test)/);
      expect(where, `${domain} 域 必有连接词`).toContain('AND');
    }
  });

  it('🔴 回归：queryAll 收到的 params 必须是数组，且个数与占位符数一致（2026-10-27 生产踩过）', async () => {
    // 生产 SQLiteAdapter.queryAll 签名是 (sql, params?: any[]) —— 展开调用会静默丢参
    let seenParams: unknown[] | undefined;
    let sawArray = false;
    const db: StructuredRecallDb = {
      queryAll(_sql: string, params?: unknown[]) {
        sawArray = Array.isArray(params);
        seenParams = params;
        return [];
      },
    };
    await recallByStructured(db, {
      domain: 'memory', entityUuids: [UUID_A, UUID_B], keywords: ['心情'], limit: 5,
    });
    expect(sawArray, 'queryAll 必须收到数组形式的 params').toBe(true);
    const ph = (seenParams ?? []).length;
    // UUID ×2 + 至少 1 个分片 + LIMIT ×1
    expect(ph).toBeGreaterThanOrEqual(4);
  });

  it('🔴 回归：四域主键列各不相同（dialog_group=dialog_group_id / work=work_id）', async () => {
    // 写死 id 会让这两域 no such column: id ⇒ 恒 fail-closed
    const expected: Record<string, string> = {
      memory: 'memories',
      conversation: 'conversations',
      dialog_group: 'dialog_groups',
      work: 'works',
    };
    for (const [domain, table] of Object.entries(expected)) {
      let seenSql = '';
      const db = fakeDb([], (sql) => { seenSql = sql; });
      await recallByStructured(db, { domain: domain as never, entityUuids: [UUID_A], limit: 5 });
      expect(seenSql, `${domain} 域 FROM 表`).toContain(`FROM ${table}`);
      // SELECT 列表里必须有 `... AS id` 别名，保证下游统一读 id
      expect(seenSql, `${domain} 域 id 别名`).toMatch(/AS id,/);
      expect(seenSql).not.toMatch(/SELECT id,/); // 不得写死裸 id 列
    }
  });

  it('🔴 容器层不映射 cosine_score / similarity_score（hasScores 陷阱）', async () => {
    let seenSql = '';
    const db = fakeDb([{ id: 'm1', text: 'x', calcium_score: 5, created_at: new Date().toISOString(), belong_entity_uuid: UUID_A }], (sql) => { seenSql = sql; });
    const hits = await recallByStructured(db, { domain: 'memory', entityUuids: [UUID_A], limit: 5 });
    expect(seenSql).not.toContain('cosine_score');
    expect(seenSql).not.toContain('similarity_score');
    for (const h of hits) {
      const bag = h as unknown as Record<string, unknown>;
      expect(bag['cosine_score']).toBeUndefined();
      expect(bag['similarity_score']).toBeUndefined();
    }
  });

  it('🔴 无向量 ⇒ cosine 为 undefined 而非 0（不得填 0 冒充）', async () => {
    const db = fakeDb([{
      id: 'm1', text: 'x', calcium_score: 5,
      created_at: new Date().toISOString(), belong_entity_uuid: UUID_A,
      perception_40d: null,
    }]);
    const hits = await recallByStructured(db, { domain: 'memory', entityUuids: [UUID_A], limit: 5 });
    expect(hits[0].cosine).toBeUndefined();
    expect(hits[0].semanticSource).toBe('none');
  });

  it('limit 缺省回落 ENCLOSURE_DEFAULT_LIMIT', async () => {
    let params: unknown[] = [];
    const db = fakeDb([], (_sql, p) => { params = p; });
    await recallByStructured(db, { domain: 'memory', entityUuids: [UUID_A] } as never);
    expect(params[params.length - 1]).toBe(ENCLOSURE_DEFAULT_LIMIT);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('StructuredRecall — 精排层', () => {
  const now = Date.parse('2026-10-27T00:00:00.000Z');
  const hit = (o: Partial<EnclosureHit>): EnclosureHit => ({
    id: 'h1', domain: 'memory', text: 'x',
    calciumScore: 0, createdAt: new Date(now).toISOString(),
    belongEntityUuid: UUID_A, hitShards: 0, semanticSource: 'none', ...o,
  });

  it('四分量按冻结权重加权，分数为四分量之和', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const out = scoreAndRank(
      [hit({ id: 'a', hitShards: 2, calciumScore: 10, cosine: 1 }), hit({ id: 'b', hitShards: 1, calciumScore: 5 })],
      now,
    );
    expect(out.length).toBe(2);
    const a = out[0];
    expect(a.breakdown.hit + a.breakdown.calcium + a.breakdown.recency + a.breakdown.semantic)
      .toBeCloseTo(a.score, 9);
    // a：hit 满分(0.45) + calcium 满分(0.30) + cosine=1 → 语义权重参与
    expect(a.score).toBeGreaterThan(out[1].score);
  });

  it('无任何余弦时语义路跳过，其余三权重重归一（不是当 0 分拉低全池）', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const out = scoreAndRank(
      [hit({ id: 'a', hitShards: 2, calciumScore: 10 }), hit({ id: 'b', hitShards: 0, calciumScore: 0 })],
      now,
    );
    const w = out[0].activeWeights;
    expect(w.semantic).toBe(0);
    expect(w.hit + w.calcium + w.recency).toBeCloseTo(1, 9);
    expect(w.hit).toBeCloseTo(0.45 / 0.9, 6);
  });

  it('🔴 语义通道开关关闭时即使有余弦也不参与（开关只控走哪条路）', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', undefined);
    const out = scoreAndRank([hit({ id: 'a', cosine: 1, calciumScore: 0 })], now);
    expect(out[0].activeWeights.semantic).toBe(0);
    expect(out[0].breakdown.semantic).toBe(0);
  });

  it('🔴 max(hitShards)=0 时该分量整体置 0，不除以零', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const out = scoreAndRank([hit({ id: 'a', hitShards: 0 }), hit({ id: 'b', hitShards: 0 })], now);
    expect(out[0].breakdown.hit).toBe(0);
    expect(Number.isFinite(out[0].score)).toBe(true);
    expect(out[0].activeWeights.hit).toBe(0);
  });

  it('钙分按 /CALCIUM_SCORE_MAX 归一并封顶', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const out = scoreAndRank([hit({ id: 'a', calciumScore: CALCIUM_SCORE_MAX * 3 })], now);
    // 单候选且无分片命中 ⇒ hit 分量整体置 0，其余权重按 §4.2 重归一
    const re = RETRIEVAL_V11_WEIGHTS;
    const expectW = re.calcium / (re.calcium + re.recency);
    expect(out[0].breakdown.calcium).toBeCloseTo(expectW, 6);
  });

  it('时间近因按 `1 - min(1, age/30天)` 线性衰减，满 30 天归 0', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const re = RETRIEVAL_V11_WEIGHTS;
    const expectW = re.recency / (re.calcium + re.recency);
    const recencyAt = (ageMs: number) =>
      scoreAndRank([hit({ id: 'a', createdAt: new Date(now - ageMs).toISOString() })], now)[0].breakdown.recency;

    expect(recencyAt(0)).toBeCloseTo(expectW, 6);
    expect(recencyAt(RECENCY_HALF_LIFE_MS / 2)).toBeCloseTo(expectW / 2, 6);
    // 🔴 蓝皮书 §4.2 给的是 `1 - min(1, age/HALF_LIFE)` —— 满 30 天即归 0，
    //    是线性斜坡不是指数半衰；此处按规格断言，勿"顺手改成"指数衰减。
    expect(recencyAt(RECENCY_HALF_LIFE_MS)).toBe(0);
    expect(recencyAt(RECENCY_HALF_LIFE_MS * 3)).toBe(0);
  });

  it('hit 分量死亡时其余三权重重归一（蓝皮书 §4.2 🔴）', () => {
    setEnv('RETRIEVAL_V11_SEMANTIC', 'true');
    const re = RETRIEVAL_V11_WEIGHTS;
    const out = scoreAndRank([hit({ id: 'a', hitShards: 0, calciumScore: 10, cosine: 1 })], now);
    const w = out[0].activeWeights;
    expect(w.hit).toBe(0);
    // 有效分量仅 calcium + recency + semantic，合计应重归一为 1
    expect(w.calcium + w.recency + w.semantic).toBeCloseTo(1, 9);
    expect(w.calcium).toBeCloseTo(re.calcium / (re.calcium + re.recency + re.semantic), 6);
  });

  it('同分按 id 升序，重复执行结果确定', () => {
    const inputs = [hit({ id: 'b' }), hit({ id: 'a' }), hit({ id: 'c' })];
    const r1 = scoreAndRank(inputs, now).map((x) => x.id);
    const r2 = scoreAndRank([...inputs].reverse(), now).map((x) => x.id);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(['a', 'b', 'c']);
  });

  it('空输入返回空', () => {
    expect(scoreAndRank([], now)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('组合刺语义路', () => {
  it('无查询向量时不产出余弦（跳过，不降级）', () => {
    const out = aggregateGroupSpines([
      { dialogGroupId: 'g1', spine: null, weight: 1 },
    ]);
    expect(out.get('g1')!.cosine).toBeUndefined();
    expect(out.get('g1')!.reason).toBe('no_valid_spine');
  });

  it('按 dialogGroupId 分组，各组独立聚合', () => {
    const out = aggregateGroupSpines([
      { dialogGroupId: 'g1', spine: null, weight: 1 },
      { dialogGroupId: 'g2', spine: null, weight: 2 },
    ]);
    expect(out.size).toBe(2);
    expect(out.has('g1')).toBe(true);
    expect(out.has('g2')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('ShadowLog — 观测与度量口径', () => {
  it('召回覆盖率 = 旧链路结果 ⊆ 新链路候选集 的条数', () => {
    expect(coverageOf(['a', 'b', 'c'], ['a', 'b'])).toEqual({ old_total: 3, old_covered: 2 });
    expect(coverageOf([], ['a'])).toEqual({ old_total: 0, old_covered: 0 });
  });

  it('零串档审计：belong ∉ visible 计数', () => {
    const visible = new Set([UUID_A]);
    expect(crossEntityLeakCount([{ belongEntityUuid: UUID_A }], visible)).toBe(0);
    expect(crossEntityLeakCount([{ belongEntityUuid: UUID_B }], visible)).toBe(1);
    expect(crossEntityLeakCount([{ belongEntityUuid: null }], visible)).toBe(0);
  });

  it('🔴 度量口径剔除 < 2s 的 run', () => {
    expect(isRealRun(1999)).toBe(false);
    expect(isRealRun(2000)).toBe(true);
    expect(isRealRun(NaN)).toBe(false);
    expect(isRealRun(-1)).toBe(false);
  });

  it('计数器与延迟分位数', () => {
    incr('v11_retrieval_total');
    incr('v11_candidates_in', 10);
    incr('v11_candidates_out', 4);
    for (let i = 1; i <= 100; i++) observeLatency(i * 10);
    const s = snapshot();
    expect(s['v11_retrieval_total']).toBe(1);
    expect(s['v11_candidates_in']).toBe(10);
    expect(s['v11_candidates_out']).toBe(4);
    expect(s['gate_failclosed_total']).toBe(0);
    expect(s['v11_retrieval_ms_samples']).toBe(100);
    expect(s['v11_retrieval_ms_p95']).toBeGreaterThanOrEqual(s['v11_retrieval_ms_p50']);
  });

  it('非法延迟不入采样', () => {
    observeLatency(NaN);
    observeLatency(-5);
    expect(snapshot()['v11_retrieval_ms_samples']).toBe(0);
  });
});
