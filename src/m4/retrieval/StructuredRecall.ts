/**
 * StructuredRecall — 结构化召回：围栏层 + 精排层（蓝皮书第三 / 四章）
 * ============================================================
 * 取代 n-gram 倒排索引的**唯一实现**。不建索引表、不建倒排、不新增依赖。
 *
 * 【三层里的位置】
 *   [1] 围栏（本文件 `recallByStructured`）→ 高召回低精度，结构化条件圈候选池
 *   [2] 精排（本文件 `scoreAndRank`）      → 四权重加权 + 截断 top-K
 *   [3] 注入                                → 由调用方交 MemoryInjector / PromptAssembler
 *   五级闸门 G2–G5 挂在围栏+精排的**出口**上（挂载点在 MemoryRetriever，不在本文件）。
 *
 * 【红线】
 *   1. 🔴 **围栏 SQL 失败必须 fail-closed**：返回 `[]` + `console.warn`（蓝皮书 §2.3）。
 *      拿不到候选池就无从判断安全，宁拒不放。
 *   2. 🔴 **UUID 闸门必须第一个拼进 SQL**，不得先查后过滤 —— 后者会把他人的行
 *      读进内存（蓝皮书 §3.1 第 4 条）。空白名单由 `buildSqlClause` 产出 `AND 1=0`。
 *   3. 🔴 **容器层不得映射 `cosine_score` / `similarity_score`**（蓝皮书 §5.2）：
 *      `FiveStageGate` G1 的 `hasScores` 逻辑会在池内存在任一带分候选时把全部
 *      无分候选清零剔除，六路混合池会被整体清空。本文件不产生该字段。
 *   4. 🔴 **无向量只能跳过语义路，不得降级**（40D 法令第四条）。`cosine` 缺失时
 *      是 `undefined`，**不得填 0 冒充**（蓝皮书 §2.2 `EnclosureHit.cosine` 注释）。
 *   5. 🔴 **相似度只有 `cosineSimilarity40D` 一个实现**，不得新增切片变体。
 *   6. 🔴 **容器层不得新增索引表**（蓝皮书 §3.4 超预算处置顺序：降 LIMIT → 减分片 →
 *      收时间窗，**不得为此新增索引表**）。
 */
import { buildSqlClause, policyFor } from '../../governance/police/UUIDPoliceFilter.js';
import { buildNgrams } from '../SearchIndexBuilder.js';
import {
  decodePerceptionV40,
  cosineSimilarity40D,
} from '../../m2/PerceptionVector40DCodec.js';
import { PERCEPTION_40D_DIM, type PerceptionV40 } from '../../m3/types/perception-40d.js';
import { aggregateSpinesWithReason, type CompositeDegradation } from './CompositeUrchin.js';
import {
  CALCIUM_SCORE_MAX,
  ENCLOSURE_DEFAULT_LIMIT,
  QUERY_SHARD_MAX,
  RECENCY_HALF_LIFE_MS,
  RETRIEVAL_V11_WEIGHTS,
  Flags,
  type RetrievalWeights,
} from './Flags.js';

// ══════════════════════════════════════════════════════════════════
// 一、接口契约（蓝皮书 §2.2 —— 签名不得改变）
// ══════════════════════════════════════════════════════════════════

export type EnclosureDomain = 'memory' | 'conversation' | 'dialog_group' | 'work';

export interface EnclosureQuery {
  domain: EnclosureDomain;
  locusPath?: string;
  /** 已由 UUIDPoliceFilter 裁决；**空数组合法且安全**（⇒ `AND 1=0`，一条不返） */
  entityUuids?: string[];
  keywords?: string[];
  timeWindow?: { fromMs: number; toMs: number };
  /** 围栏上限，默认 500 */
  limit: number;
}

export interface EnclosureHit {
  id: string;
  domain: EnclosureDomain;
  text: string;
  calciumScore: number;
  createdAt: string;
  belongEntityUuid?: string | null;
  /** 分片命中数（现算，不落盘） */
  hitShards: number;
  /** 40D 余弦；无向量则 `undefined`，**不得填 0 冒充** */
  cosine?: number;
  /** 🔴 观测用途：本条的语义信号来源（`atomic` / `composite` / `none`） */
  semanticSource: 'atomic' | 'composite' | 'none';
  /** dialog_group 域：组合刺聚合退化原因（蓝皮书 §7.4） */
  compositeDegradation?: CompositeDegradation;
}

export interface ScoredHit extends EnclosureHit {
  score: number;
  /** 四分量各自的贡献值，供 §8.3「某分量恒为 0 ⇒ 该通道失效」归因 */
  breakdown: { hit: number; calcium: number; recency: number; semantic: number };
  /** 本次实际生效的（已重归一）权重快照 */
  activeWeights: RetrievalWeights;
}

/**
 * 本模块接受的最小数据库形状：走 `queryAll`（`SQLiteAdapter.queryAll` 系）。
 *
 * 🔴 **参数是数组，不是可变参数**。`SQLiteAdapter.queryAll` 的真实签名是
 * `queryAll<T>(sql: string, params?: any[]): T[]`（`src/m2/SQLiteAdapter.ts:1987`）。
 * 2026-10-27 生产实测踩过：按接口声明的 `...params` 展开调用，`SQLiteAdapter`
 * 只收下第一个参数当 `params`、其余**静默丢弃** ⇒ UUID / 分片 / LIMIT 全绑不上，
 * 围栏恒返回 0 条（表现是 `in=0 enc=1ms`，看着像「没数据」，实为参数丢失）。
 * ⇒ **不得凭接口声明推断实现签名，以生产实现为准。**
 */
export interface StructuredRecallDb {
  queryAll?: (sql: string, params?: unknown[]) => Array<Record<string, unknown>>;
}

// ══════════════════════════════════════════════════════════════════
// 二、域 → 表/列 映射表（蓝皮书 §3.3 ⚠️ 列名随域变化）
// ══════════════════════════════════════════════════════════════════

interface DomainSpec {
  table: string;
  /**
   * 主键列。🔴 **四域各不相同**，写死 `id` 会让 `dialog_group` 与 `work` 两域
   * 直接 `no such column: id` 而恒 fail-closed（2026-10-27 生产实测）。
   * SQL 里统一 `AS id` 别名，下游只需读 `id`。
   */
  idCol: string;
  /** 正文列 —— 四域各不相同，**禁止**在字符串里写死后再 `replace` */
  textCol: string;
  /** 时间列。🔴 `conversations` 是 `timestamp` 不是 `created_at`（该表实测无 created_at） */
  timeCol: string;
  calciumCol: string | null;
  /** 40D 感知向量列 —— 仅 `memories` 有（生产库实测，白皮书 §7.1） */
  vecCol: string | null;
  locusCol: string | null;
  /** 固定附加条件（测试隔离 / 非空守卫） */
  extraWhere: string;
}

const DOMAIN_SPECS: Readonly<Record<EnclosureDomain, DomainSpec>> = Object.freeze({
  memory: Object.freeze({
    table: 'memories',
    idCol: 'id',
    textCol: 'raw_input',
    timeCol: 'created_at',
    calciumCol: 'calcium_score',
    vecCol: 'perception_40d',
    locusCol: 'locus_path',
    // 白皮书 §4.2.1 条件 4：测试隔离（固定）
    // 🔴 必须以 `AND` 开头：本值直接拼在 police.clause 之后，漏了 AND 会拼成
    //    `IN (?,?) COALESCE(...)` 的语法错误，整条围栏 fail-closed 返回空。
    //    2026-10-27 真实库只读探针实测踩过一次（退化窗口 12 条样本命中率 0%）。
    extraWhere: " AND COALESCE(namespace,'default') <> 'test'",
  }),
  conversation: Object.freeze({
    table: 'conversations',
    idCol: 'id',
    textCol: 'content',
    // 🔴 实测列名是 timestamp（ISO UTC），与 S1.1 台账同源教训：照抄文档的 created_at 必崩
    timeCol: 'timestamp',
    calciumCol: 'calcium_score',
    vecCol: null,
    locusCol: 'topic',
    // 测试隔离：conversations 同时有 namespace 与 is_test 两个既有约定
    // 🔴 同上：必须以 `AND` 开头，否则整条围栏语法错误 fail-closed。
    extraWhere: " AND COALESCE(namespace,'default') <> 'test' AND (is_test IS NULL OR is_test = 0)",
  }),
  dialog_group: Object.freeze({
    table: 'dialog_groups',
    // 🔴 主键是 dialog_group_id 不是 id（写死 id 会 no such column: id ⇒ 恒 fail-closed）
    idCol: 'dialog_group_id',
    textCol: 'block_summary',
    timeCol: 'created_at',
    calciumCol: 'block_calcium_score',
    // 🔴 2026-11-02: 由 null 改为 perception_40d_snapshot。
    //   v31 迁移（P145 批A1）已建该列，BlockArchiveService（批A2）后台写入
    //   组级 40D 聚合快照。原注释「对话组无 40D 列是事实」已过时。
    //   无快照的组该列为 NULL ⇒ `cosine` 为 undefined ⇒ scoreAndRank 按语义权重 0
    //   重归一（《40D 量纲统一法令》第四条：无向量只能跳过，不得填 0 冒充）。
    vecCol: 'perception_40d_snapshot',
    locusCol: null,
    extraWhere: " AND block_summary IS NOT NULL AND block_summary <> ''",
  }),
  work: Object.freeze({
    table: 'works',
    // 🔴 主键是 work_id 不是 id
    idCol: 'work_id',
    textCol: 'full_text',
    timeCol: 'created_at',
    calciumCol: null, // 作品无钙化度
    vecCol: null, // `works.semantic_vector` 188 行全空，作品级不造刺（蓝皮书 §3.2 D）
    locusCol: null,
    extraWhere: '',
  }),
});

// ══════════════════════════════════════════════════════════════════
// 三、分片构造（白皮书 §4.2.2）
// ══════════════════════════════════════════════════════════════════

/**
 * 由关键词集产出 `AND (col LIKE ? OR col LIKE ? …)` 子句。
 *
 * 🔴 切分逻辑**复用 `buildNgrams`**（白皮书 §4.2.2「与 `buildNgrams` 相同的切分逻辑，
 * 但不建索引」），不另写一套滑窗 —— 双实现必然漂移，且 `buildNgrams` 已含标点清理
 * 与停用词过滤。上限 `QUERY_SHARD_MAX`（40，沿用既有上限）。
 */
export function buildKeywordShards(
  col: string,
  keywords: readonly string[],
): { sql: string; params: string[] } {
  const shards = new Set<string>();
  for (const k of keywords) {
    if (!k) continue;
    for (const g of buildNgrams(k)) {
      if (shards.size >= QUERY_SHARD_MAX) break;
      shards.add(g);
    }
    if (shards.size >= QUERY_SHARD_MAX) break;
  }
  if (shards.size === 0) return { sql: '', params: [] };
  // 列名来自映射表，不接受外部拼接
  const list = [...shards];
  return {
    sql: ` AND (${list.map(() => `${col} LIKE ?`).join(' OR ')})`,
    params: list.map((s) => `%${s}%`),
  };
}

/** 现算某条候选命中了查询分片中的几个（白皮书 §4.3.2，替代 n-gram 的 COUNT(term)） */
export function countHitShards(text: string, shards: readonly string[]): number {
  if (!text || shards.length === 0) return 0;
  let n = 0;
  for (const s of shards) if (text.includes(s)) n++;
  return n;
}

/** 由关键词集导出供现算用的分片数组（与 SQL 子句同一来源，杜绝两套切词） */
export function shardList(keywords: readonly string[]): string[] {
  const set = new Set<string>();
  for (const k of keywords) {
    if (!k) continue;
    for (const g of buildNgrams(k)) {
      if (set.size >= QUERY_SHARD_MAX) break;
      set.add(g);
    }
    if (set.size >= QUERY_SHARD_MAX) break;
  }
  return [...set];
}

// ══════════════════════════════════════════════════════════════════
// 四、围栏层（蓝皮书第三章）
// ══════════════════════════════════════════════════════════════════

const num = (v: unknown, dflt = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * 结构化围栏。**不做 top-K 截断**（蓝皮书 §2.2），截断在精排层。
 *
 * 失败契约（蓝皮书 §2.3）：
 *   - **无 UUID 白名单** ⇒ 直接 `[]`（fail-closed，`buildSqlClause` 的 `AND 1=0` 语义）
 *   - **SQL 抛错** ⇒ `[]` + warn（fail-closed，宁拒不放）
 *   - 无关键词 ⇒ 不加 LIKE 子句，退化为结构化围栏（白皮书 §4.2.4）
 */
export async function recallByStructured(
  db: StructuredRecallDb,
  q: EnclosureQuery,
  p40?: PerceptionV40,
): Promise<EnclosureHit[]> {
  const spec = DOMAIN_SPECS[q.domain];
  if (!spec) {
    console.warn(`[RetrievalV11] 围栏 fail-closed：未知域 ${String(q.domain)}`);
    return [];
  }
  if (typeof db?.queryAll !== 'function') {
    console.warn('[RetrievalV11] 围栏 fail-closed：数据库对象无 queryAll');
    return [];
  }

  const uuids = (q.entityUuids ?? []).filter(Boolean);
  // 🔴 红线 14：禁止 UUID 白名单为空时放行。空白名单 ⇒ buildSqlClause 产出 `AND 1=0`，
  //    此处提前短路，语义等价且不浪费一次查询。
  if (uuids.length === 0) {
    console.warn(`[RetrievalV11] 围栏 fail-closed：${q.domain} 无 UUID 白名单，返回空`);
    return [];
  }

  // UUID 闸门**第一个**拼进 SQL（红线 2）
  const police = buildSqlClause(policyFor('private', uuids));
  const keywords = (q.keywords ?? []).filter(Boolean);

  const shards = shardList(keywords);
  const shardClause = buildKeywordShards(spec.textCol, keywords);

  // 统一 `AS id` 别名：四域主键列名不同（id / dialog_group_id / work_id），下游只读 id
  const cols = [`${spec.idCol} AS id`, `${spec.textCol} AS text`, spec.timeCol, 'belong_entity_uuid'];
  if (spec.calciumCol) cols.push(`${spec.calciumCol} AS calcium_score`);
  if (spec.vecCol) cols.push(`${spec.vecCol} AS perception_40d`);
  if (spec.locusCol) cols.push(`${spec.locusCol} AS locus_path`);

  const params: unknown[] = [];
  let sql = `SELECT ${cols.join(', ')} FROM ${spec.table} WHERE 1=1`;
  sql += police.clause;
  params.push(...police.params);
  sql += spec.extraWhere;

  // 时间窗（调用方传入；退化期回捞时必须传）
  if (q.timeWindow && Number.isFinite(q.timeWindow.fromMs) && Number.isFinite(q.timeWindow.toMs)) {
    sql += ` AND ${spec.timeCol} >= ? AND ${spec.timeCol} <= ?`;
    params.push(new Date(q.timeWindow.fromMs).toISOString(), new Date(q.timeWindow.toMs).toISOString());
  }

  // 话题前缀（无话题时省略）
  if (spec.locusCol && q.locusPath && q.locusPath !== 'default' && q.locusPath !== 'general') {
    sql += ` AND ${spec.locusCol} LIKE ?`;
    params.push(`${q.locusPath}%`);
  }

  // 分片 LIKE —— 合并成一次 OR，禁止循环查（白皮书 RA-4）
  sql += shardClause.sql;
  params.push(...shardClause.params);

  sql += ` ORDER BY ${spec.timeCol} DESC LIMIT ?`;
  params.push(q.limit > 0 ? q.limit : ENCLOSURE_DEFAULT_LIMIT);

  let rows: Array<Record<string, unknown>>;
  try {
    // 🔴 参数**整组传数组**，不得展开（见 StructuredRecallDb 注释）
    rows = db.queryAll(sql, params) ?? [];
  } catch (e) {
    // 🔴 fail-closed：拿不到候选池就无从判断安全，宁拒不放
    console.warn(`[RetrievalV11] 围栏 SQL 失败（fail-closed 返回空）domain=${q.domain}:`, (e as Error)?.message);
    return [];
  }

  const nowMs = Date.now();
  const hits: EnclosureHit[] = [];
  for (const r of rows) {
    const id = str(r['id']);
    if (!id) continue;
    const text = str(r['text']);
    const hit: EnclosureHit = {
      id,
      domain: q.domain,
      text,
      calciumScore: num(r['calcium_score'], 0),
      createdAt: str(r[spec.timeCol]),
      belongEntityUuid: r['belong_entity_uuid'] == null ? null : str(r['belong_entity_uuid']),
      hitShards: countHitShards(text, shards),
      semanticSource: 'none',
    };
    // 语义路：仅当调用方给了原生 40D 查询向量（法令第四条：无向量只能跳过）
    if (p40 && spec.vecCol) {
      const rawVec = r['perception_40d'];
      if (rawVec) {
        const mv = decodePerceptionV40(str(rawVec));
        // 解析失败 ⇒ cosine 保持 undefined，不清零（缺数据 ≠ 负相关）
        if (mv) {
          hit.cosine = cosineSimilarity40D(p40, mv);
          hit.semanticSource = 'atomic';
        }
      }
    }
    hits.push(hit);
  }

  // 现算耗时（白皮书 §4.3.2：500 条 < 10ms）—— 超预算由调用方按 §3.4 顺序处置
  void nowMs;
  return hits;
}

/** 对话组的一个成员原子海胆（蓝皮书 §7.2 步骤 ②） */
export interface CompositeMemberRow {
  /** 成员所属的 `dialog_groups.dialog_group_id` */
  dialogGroupId: string;
  /** 成员的原生 40D 感知向量（`decodePerceptionV40` 结果）；缺项为 null */
  spine: PerceptionV40 | null;
  /** 成员权重 = 该成员的 `calcium_score`（蓝皮书 §6.1） */
  weight: number;
}

/**
 * 对话组主路的组合刺聚合 + 语义余弦（蓝皮书 §7.2 步骤 ③④）。
 *
 * 🔴 组合刺**不落盘**（ADR-013 豁免边界 / 附录 A 第 7 条）：每次由成员原子海胆
 *    现算，成员变动与钙化衰减都不会让缓存过期。
 * 🔴 无原生 40D 查询向量 ⇒ **跳过**语义路（`cosine` 保持 `undefined`），
 *    **不得**填 0 冒充，也不得做任何维度降级（40D 法令第四条）。
 * 🔴 组合失败（`spine = null`）⇒ 该组降级为「无组合刺」，靠壳肉文本命中
 *    （蓝皮书 §2.3：组合海胆聚合失败是 fail-open，它是辅助信号）。
 *
 * @returns 逐组的组合刺与余弦，键为 `dialog_group_id`。
 */
export function aggregateGroupSpines(
  memberRows: readonly CompositeMemberRow[],
  p40?: PerceptionV40,
): Map<string, { spine: number[] | null; cosine?: number; reason: CompositeDegradation }> {
  const grouped = new Map<string, CompositeMemberRow[]>();
  for (const r of memberRows) {
    const list = grouped.get(r.dialogGroupId);
    if (list) list.push(r);
    else grouped.set(r.dialogGroupId, [r]);
  }

  const out = new Map<string, { spine: number[] | null; cosine?: number; reason: CompositeDegradation }>();
  for (const [groupId, rows] of grouped) {
    // 组合刺内部按 40 维数组承载；`cosineSimilarity40D` 收的是 PerceptionV40 对象，
    // 故只有当成员刺可被组装回 PerceptionV40 时才算余弦 —— 见下方 `cosineOfComposite`。
    const { spine, reason } = aggregateSpinesWithReason(
      rows.map((r) => ({ spine: toArray40(r.spine), weight: r.weight })),
    );
    const cosine = spine && p40 ? cosineOfComposite(spine, rows, p40) : undefined;
    out.set(groupId, { spine, cosine, reason });
  }
  return out;
}

/** `PerceptionV40` → 定长 40 维数组（键序即 `PERCEPTION_40D_KEYS`，与编解码对齐） */
function toArray40(p: PerceptionV40 | null | undefined): number[] | null {
  if (!p) return null;
  const arr = Object.values(p) as number[];
  return arr.length === PERCEPTION_40D_DIM ? arr.map((x) => (Number.isFinite(x) ? x : 0)) : null;
}

/**
 * 组合刺余弦。
 *
 * 🔴 不把组合刺数组强转回 `PerceptionV40` 去调 `cosineSimilarity40D` ——
 * 那会依赖 `Object.keys` 顺序，是隐式契约。此处改为**逐成员余弦按权重平均**，
 * 数学上等价于「先加权平均再算余弦」的线性近似，但每一步都走唯一的
 * `cosineSimilarity40D` 实现，不产生第二个相似度函数（40D 法令第三条）。
 */
function cosineOfComposite(
  _spine: number[],
  rows: readonly CompositeMemberRow[],
  p40: PerceptionV40,
): number | undefined {
  const wSum = rows.reduce((s, r) => s + (r.weight > 0 ? r.weight : 0), 0);
  if (wSum <= 0) return undefined;
  let acc = 0;
  let used = 0;
  for (const r of rows) {
    if (!(r.weight > 0) || !r.spine) continue;
    acc += (r.weight / wSum) * cosineSimilarity40D(p40, r.spine);
    used++;
  }
  return used > 0 ? acc : undefined;
}

// ══════════════════════════════════════════════════════════════════
// 五、精排层（蓝皮书第四章）
// ══════════════════════════════════════════════════════════════════

/**
 * 归一化分片命中数：`x / max(hitShards)`。
 * 🔴 `max = 0` 时该分量整体置 0，**不得除以零**；其余权重由 `scoreAndRank` 重归一。
 */
function normalizeHits(hits: readonly EnclosureHit[]): Map<string, number> {
  const out = new Map<string, number>();
  let max = 0;
  for (const h of hits) if (h.hitShards > max) max = h.hitShards;
  if (max <= 0) return out; // 整体置 0
  for (const h of hits) out.set(h.id, h.hitShards / max);
  return out;
}

/**
 * 精排（蓝皮书 §4.1）。**纯函数**，可单测。
 *
 * ```
 * score(m) = w_hit      × norm(hitShards_m)
 *          + w_calcium  × norm(calcium_m)
 *          + w_recency  × norm(recency_m)
 *          + w_semantic × cosine40D(query, m)      // 仅当两侧向量均存在
 * ```
 *
 * 🔴 权重来自 `RETRIEVAL_V11_WEIGHTS` 单一对象，本函数**不写字面量**。
 * 🔴 无任何候选带余弦时，语义权重置 0 并把其余三权重重新归一（§4.4）——
 *    这是「跳过语义路」，不是把余弦当 0 分拉低全池（后者属变相降级）。
 * 🔴 LLM 精排失败/超时是 **fail-open**：直接用本函数的规则精排结果。
 */
export function scoreAndRank(
  hits: readonly EnclosureHit[],
  nowMs: number,
  weights: RetrievalWeights = RETRIEVAL_V11_WEIGHTS,
): ScoredHit[] {
  if (hits.length === 0) return [];

  const anyCosine = hits.some((h) => typeof h.cosine === 'number' && Number.isFinite(h.cosine));
  // 语义通道开关关闭（`RETRIEVAL_V11_SEMANTIC` 非 true）⇒ 语义权重按 0 参与重归一
  const semanticActive = anyCosine && Flags.semantic();

  const normHit = normalizeHits(hits);
  const hitMax = normHit.size > 0;

  const active: RetrievalWeights = Object.freeze({
    hit: hitMax ? weights.hit : 0,
    calcium: weights.calcium,
    recency: weights.recency,
    semantic: semanticActive ? weights.semantic : 0,
  });
  const sum = active.hit + active.calcium + active.recency + active.semantic;
  // 四路全灭（理论上不可能：calcium/recency 恒有值）—— 退化为等权，不返回全 0
  const wSum = sum > 0 ? sum : 1;
  const eff: RetrievalWeights = {
    hit: active.hit / wSum,
    calcium: active.calcium / wSum,
    recency: active.recency / wSum,
    semantic: active.semantic / wSum,
  };

  const scored: ScoredHit[] = hits.map((h) => {
    const nHit = normHit.get(h.id) ?? 0;
    const nCal = Math.max(0, Math.min(1, h.calciumScore / CALCIUM_SCORE_MAX));
    const ageMs = Math.max(0, nowMs - Date.parse(h.createdAt));
    const nRec = 1 - Math.min(1, ageMs / RECENCY_HALF_LIFE_MS);
    const sem = semanticActive && typeof h.cosine === 'number' ? h.cosine : 0;

    const bHit = eff.hit * nHit;
    const bCal = eff.calcium * nCal;
    const bRec = eff.recency * nRec;
    const bSem = eff.semantic * sem;

    return {
      ...h,
      score: bHit + bCal + bRec + bSem,
      breakdown: { hit: bHit, calcium: bCal, recency: bRec, semantic: bSem },
      activeWeights: eff,
    };
  });

  // 分数降序；同分按 id 升序保证确定性（同一次查询重复执行结果必须一致）
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}
