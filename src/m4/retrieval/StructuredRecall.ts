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
  ADR_010_BLOCK_WEIGHTS,
  ADR_010_CALCIUM_NORM_DENOM,
  ADR_010_SUMMARY_DENSITY_CAP,
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
  /**
   * dialog_group 域专属：**双通道各自命中量**（ADR-010 §12.2.3 三个分量的输入）。
   *
   * 🔴 为什么不能只用 `hitShards`：摘要路给的是「摘要命中的分片数」，原文路给的是
   *    「conversations 命中的行数」，**量纲不同**；改造前把两者直接相加塞进同一个
   *    `hit` 分量，两路强度无法分辨，法典的 convDensity / summaryDensity / bothChannels
   *    三个分量全都无从计算。分量拆开后各走各的公式。
   *
   * 只有 `DialogGroupAdapter` 会填它（唯一同时握有双通道计数与块元数据的地方）；
   * 其余域的命中没有 `channels` ⇒ ADR 方案的可用性判定按「本池无该分量」重归一。
   */
  channels?: DialogGroupChannels;
}

/** dialog_group 双通道计数（ADR-010 §12.2.3 分量输入；`content` 与 `turnCount` 同为「轮」） */
export interface DialogGroupChannels {
  /** 摘要通道命中分片数 —— `summaryDensity` 的分子 */
  summary: number;
  /**
   * 原文通道**命中轮数** —— `convDensity` 的分子。
   * 🔴 单位是「轮」不是「行」：`dialog_groups.turn_count` 自 2026-11-02 起口径为
   *    已落库问答对数（见 `dialog-group-stage.ts`），分子分母必须同源，
   *    否则密度被系统性低估、块路排序失真。由 `max(命中 user 行数, 命中 assistant 行数)` 推得。
   */
  content: number;
  /** 该组总轮数 —— `convDensity` 的分母（`dialog_groups.turn_count`） */
  turnCount: number;
}

export interface ScoredHit extends EnclosureHit {
  score: number;
  /**
   * 各分量的**贡献值**（键 = 所用方案的分量键），供 §8.3「某分量恒为 0 ⇒ 该通道失效」归因。
   * 默认方案为 `hit / calcium / recency / semantic` 四键；ADR-010 方案为
   * `convDensity / summaryDensity / bothChannels / calcium` 四键。
   */
  breakdown: Readonly<Record<string, number>>;
  /** 本次实际生效的（已重归一）权重快照，键同 `breakdown`；各键之和恒为 1（除非全部失效） */
  activeWeights: Readonly<Record<string, number>>;
}

// ── 排序方案（不变量 #7「同一规则不得多处实现」的落地形态）──

/**
 * 精排的**分量提取口径**：把某个命中映射成 [0,1] 的分量值。
 * `hit` 参数是 `EnclosureHit`（结构性满足，无需引入依赖）。
 */
export type RankingValueFn = (hit: EnclosureHit, ctx: RankingContext) => number;

/** 精排上下文：本轮池级事实，供分量取值与可用性判定共用（避免各分量重复计算） */
export interface RankingContext {
  nowMs: number;
  /** 归一化分片命中（`hitShards / max`）；池内 max 为 0 时为空表 */
  normHit: ReadonlyMap<string, number>;
  /** 本池是否有任一候选带有效余弦，且语义开关打开 */
  semanticActive: boolean;
}

/** 排序方案里的一个分量 */
export interface RankingComponent {
  /** 分量键 —— 同时是 `breakdown` / `activeWeights` 的字段名，池内必须唯一 */
  readonly key: string;
  /** 冻结权重（来自 `Flags` 的常量对象，本处不得写字面量 —— 蓝皮书 §1.2） */
  readonly weight: number;
  /** 取值口径，必须归一到 [0,1]；缺数据返回 0 */
  readonly value: RankingValueFn;
  /**
   * 该分量在**本池**是否可用；不可用 ⇒ 权重置 0 并把其余权重重新归一。
   * 🔴 语义与蓝皮书 §4.4 一致：分量恒为 0 说明该通道整体失效，
   *    此时按 0 分参与会**拉低全池**（变相降级），必须跳过并重归一。缺省 = 恒可用。
   */
  readonly available?: (hits: readonly EnclosureHit[], ctx: RankingContext) => boolean;
}

/**
 * 排序方案：**分量的声明式清单**。
 *
 * 🔴 方案只声明「算哪些分量、各自多重」，**不重写引擎** —— 可用性判定、权重重归一、
 *    fail-open、确定性排序这四件事仍只有 `scoreAndRank` 一处实现（不变量 #7）。
 *    新增一个域要专属权重时，声明一个 scheme 即可，**不得**再写第二个排序函数。
 */
export interface RankingScheme {
  /** 方案名（观测与测试用） */
  readonly name: string;
  readonly components: readonly RankingComponent[];
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
  // 🔴 改善落地 B2：围栏段独立耗时（进 metrics 的 `fence_ms_*`）。
  //   为什么要有：`v11_retrieval_ms` 是整体耗时，围栏占比无法归因；而围栏是纯
  //   LIKE 分片扫描、随 `conversations` 行数线性劣化，劣化必须可观测。
  //   实现约束：本函数是 async ⇒ 动态 import 合法，且无需在文件头新增静态 import
  //   （避免第二个写入点）；埋点自带 try/catch —— 观测层失败绝不影响围栏返回。
  const _fenceStart = performance.now();
  try {
    // 🔴 参数**整组传数组**，不得展开（见 StructuredRecallDb 注释）
    rows = db.queryAll(sql, params) ?? [];
  } catch (e) {
    // 🔴 fail-closed：拿不到候选池就无从判断安全，宁拒不放
    console.warn(`[RetrievalV11] 围栏 SQL 失败（fail-closed 返回空）domain=${q.domain}:`, (e as Error)?.message);
    return [];
  }
  try {
    const { observeFenceLatency } = await import('./ShadowLog.js');
    observeFenceLatency(performance.now() - _fenceStart);
  } catch { /* 观测层异常不阻断围栏返回（红线 3） */ }

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
 * 默认方案（v11 通用四权重）—— 由 `RETRIEVAL_V11_WEIGHTS` **派生**，不重复声明权重。
 *
 * 分量与本函数改造前的实现逐字对应，因此**不传 `scheme` 时行为零变化**：
 * ```
 * score(m) = w_hit      × norm(hitShards_m)
 *          + w_calcium  × norm(calcium_m)
 *          + w_recency  × norm(recency_m)
 *          + w_semantic × cosine40D(query, m)      // 仅当两侧向量均存在
 * ```
 */
function defaultScheme(weights: RetrievalWeights): RankingScheme {
  return {
    name: 'v11-default',
    components: [
      {
        key: 'hit',
        weight: weights.hit,
        value: (h, c) => c.normHit.get(h.id) ?? 0,
        // `max(hitShards) = 0` ⇒ 该分量整体置 0（不除以零），其余权重重归一
        available: (_h, c) => c.normHit.size > 0,
      },
      {
        key: 'calcium',
        weight: weights.calcium,
        value: (h) => Math.max(0, Math.min(1, h.calciumScore / CALCIUM_SCORE_MAX)),
      },
      {
        key: 'recency',
        weight: weights.recency,
        value: (h, c) => {
          const ageMs = Math.max(0, c.nowMs - Date.parse(h.createdAt));
          return 1 - Math.min(1, ageMs / RECENCY_HALF_LIFE_MS);
        },
      },
      {
        key: 'semantic',
        weight: weights.semantic,
        value: (h, c) => (c.semanticActive && typeof h.cosine === 'number' ? h.cosine : 0),
        // 无任何候选带余弦、或语义开关关闭 ⇒ 跳过语义路并把其余权重重归一（§4.4），
        // 而不是把余弦当 0 分拉低全池（后者属变相降级）。
        available: (_h, c) => c.semanticActive,
      },
    ],
  };
}

/**
 * ADR-010 §12.2.3 对话块双通道排序方案（**法典公式**，业主确认 2026-10-18）。
 *
 * ```
 * score = convDensity×0.40 + summaryDensity×0.30 + bothChannels×0.15 + calcium×0.15
 * ```
 * 分量口径：
 * - `convDensity`    = `min(1, 原文命中轮数 / turn_count)`
 * - `summaryDensity` = `min(1, 摘要命中分片数 / 10)`
 * - `bothChannels`   = 原文与摘要同时命中 ⇒ 1，否则 0（法典只写「共振加分」，按命中存在性取值）
 * - `calcium`        = `min(1, block_calcium_score / 5)`　← 基准 **5** 见 ADR-010 §13.1，
 *                     **不是**通用方案的 `CALCIUM_SCORE_MAX`(10)
 *
 * 🔴 本方案**没有 recency 分量** —— 法典只列了四项，不得擅自补时间近因（补了就是第二套判据）。
 *    时间次序由 `DialogGroupAdapter` 的最终排序按 `last_ts` 做同分 tiebreak 承担。
 * 🔴 分量失效按 §4.4 重归一：本池全体拿不到 `turn_count` / 没有任何摘要命中 / 没有双通道共振
 *    时，该分量权重置 0 并把其余重归一 —— 保证「纯摘要池」「纯原文池」各自内部次序仍正确。
 */
// 显式给出 `Object.freeze` 的类型实参：否则泛型返回值推断会让下面的箭头参数退化成 any
export const ADR_010_BLOCK_SCHEME: Readonly<RankingScheme> = Object.freeze<RankingScheme>({
  name: 'adr-010-block',
  components: [
    {
      key: 'convDensity',
      weight: ADR_010_BLOCK_WEIGHTS.convDensity,
      value: (h) => {
        const ch = h.channels;
        if (!ch || !(ch.turnCount > 0)) return 0;
        return Math.max(0, Math.min(1, ch.content / ch.turnCount));
      },
      available: (hs) => hs.some((h) => (h.channels?.turnCount ?? 0) > 0),
    },
    {
      key: 'summaryDensity',
      weight: ADR_010_BLOCK_WEIGHTS.summaryDensity,
      value: (h) => Math.max(0, Math.min(1, (h.channels?.summary ?? 0) / ADR_010_SUMMARY_DENSITY_CAP)),
      available: (hs) => hs.some((h) => (h.channels?.summary ?? 0) > 0),
    },
    {
      key: 'bothChannels',
      weight: ADR_010_BLOCK_WEIGHTS.bothChannels,
      value: (h) => ((h.channels?.content ?? 0) > 0 && (h.channels?.summary ?? 0) > 0 ? 1 : 0),
      available: (hs) =>
        hs.some((h) => (h.channels?.content ?? 0) > 0 && (h.channels?.summary ?? 0) > 0),
    },
    {
      key: 'calcium',
      weight: ADR_010_BLOCK_WEIGHTS.calcium,
      // 🔴 基准 5 而非 CALCIUM_SCORE_MAX(10) —— ADR-010 §13.1 明写「/10 → /5，
      //    高钙阈值即满分」，生产实测 max 7.72 / avg 3.85，除以 10 时高钙与 2~5 分段
      //    在 0.15 权重下只差 0.075，区分度结构性不足。详见 Flags.ADR_010_CALCIUM_NORM_DENOM。
      value: (h) => Math.max(0, Math.min(1, h.calciumScore / ADR_010_CALCIUM_NORM_DENOM)),
    },
  ],
});

/**
 * 精排（蓝皮书 §4.1）。**纯函数**，可单测。
 *
 * **框架单源**：可用性判定 → 权重置 0 → 重归一 → 按分量累加 → 确定性排序，
 * 这五步只有本函数一处实现（不变量 #7）。分量**算什么、多重**由 `scheme` 声明。
 *
 * @param weights 仅在未传 `scheme` 时生效（默认方案的四权重来源，来自 `Flags` 单一对象）
 * @param scheme  排序方案；**传入后 `weights` 不参与**，分量与权重全由方案声明
 *
 * 🔴 无任何候选带余弦时，语义权重置 0 并把其余权重重归一（§4.4）——
 *    这是「跳过语义路」，不是把余弦当 0 分拉低全池（后者属变相降级）。
 * 🔴 LLM 精排失败/超时是 **fail-open**：直接用本函数的规则精排结果。
 * 🔴 本函数不写字面量：权重来自 `Flags` 的常量对象（蓝皮书 §1.2 魔数禁令）。
 */
export function scoreAndRank(
  hits: readonly EnclosureHit[],
  nowMs: number,
  weights: RetrievalWeights = RETRIEVAL_V11_WEIGHTS,
  scheme?: RankingScheme,
): ScoredHit[] {
  if (hits.length === 0) return [];

  const anyCosine = hits.some((h) => typeof h.cosine === 'number' && Number.isFinite(h.cosine));
  // 语义通道开关关闭（`RETRIEVAL_V11_SEMANTIC` 非 true）⇒ 语义权重按 0 参与重归一
  const semanticActive = anyCosine && Flags.semantic();
  const ctx: RankingContext = { nowMs, normHit: normalizeHits(hits), semanticActive };

  const sc = scheme ?? defaultScheme(weights);

  // ① 可用性判定：该分量在本池算不出来 ⇒ 权重置 0（不参与，而不是按 0 分拉低全池）
  const raw: Record<string, number> = {};
  let sum = 0;
  for (const c of sc.components) {
    const on = c.available ? c.available(hits, ctx) : true;
    raw[c.key] = on ? c.weight : 0;
    if (on) sum += c.weight;
  }
  // ② 重归一。全部分量不可用时（理论不可达：两个方案的 calcium 都恒可用）
  //    wSum 取 1 ⇒ 各分量权重保持 0，分数为 0 而不是 NaN / Infinity。
  const wSum = sum > 0 ? sum : 1;
  const eff: Record<string, number> = {};
  for (const k of Object.keys(raw)) eff[k] = raw[k] / wSum;
  Object.freeze(eff);

  // ③ 按方案分量累加
  const scored: ScoredHit[] = hits.map((h) => {
    const breakdown: Record<string, number> = {};
    let score = 0;
    for (const c of sc.components) {
      const part = eff[c.key] * c.value(h, ctx);
      breakdown[c.key] = part;
      score += part;
    }
    return { ...h, score, breakdown: Object.freeze(breakdown), activeWeights: eff };
  });

  // 分数降序；同分按 id 升序保证确定性（同一次查询重复执行结果必须一致）
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}
