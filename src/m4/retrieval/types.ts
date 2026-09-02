/**
 * types.ts — 多路检索统一命中类型（Foundation V1.0）
 * ==================================================
 * 多路并行检索架构改造的底座统一类型层。
 *
 * 解决痛点：
 *   1. V13 fake id：`RankedItem.source`（召回路）与 `MemoryCandidate.source`（存储域）
 *      混用一个字段，V13 输出把召回路假映射回存储域（spine→black_diamond、
 *      keyword/locus→conversation），下游靠 `source==='conversation'` 猜 id。
 *      引入 `domain` + `route` 分离 + `backref` 回源键，从根上消除假映射。
 *   2. 无统一命中类型：RankedItem / MemoryCandidate / ScoredMemory / SearchResult 字段各异。
 *   3. 融合阶段无法跨域去重：引入 `dedupeKey`（同记录跨域折叠）。
 *
 * 设计原则：
 *   - 纯类型 + 纯函数，零副作用，零 FG 依赖（测试友好）
 *   - 与旧类型 `src/m4/types/retrieval.ts` 通过映射桥（rankedItemToHit）渐进兼容
 */

import type { Perception24D } from '../../m3/types/perception.js';
import type { PerceptionV40 } from '../../m3/types/perception-40d.js';
import type { SearchMode } from '../types/retrieval.js';
import type { PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';

/** 存储域标识 — 一条数据物理存在于哪张表/哪个库 */
export type SearchDomain =
  | 'conversation'    // 砂金库 conversations 表（原始对话）
  | 'memory'          // 金库 memories 表（含 砂金高钙化 子集）
  | 'black_diamond'   // 黑钻库 black_diamond 表（固化记忆）
  | 'knowledge'       // 知识库 knowledge_base 表（FTS5）
  | 'vault'           // 金库 vault_log 表（promote 记录）
  | 'work'            // 作品 works 表（长文/小说）
  | 'family_graph'    // 家族图谱 FG（person 节点 / profile）
  | 'note';           // 玉瑶记事（memories memory_kind='note'）

/** 召回路标识 — 一条命中从哪条检索路进来，融合阶段按此取 RRF 权重 */
export type RetrievalRoute =
  | 'emotion' | 'keyword' | 'spine' | 'locus' | 'entity' | 'work'  // 现有 6 路（MemoryRetriever）
  | 'diamond' | 'knowledge' | 'vault' | 'note' | 'profile'          // 新增域路由
  | 'conversation' | 'default'
  | 'meeting';                                                      // 会晤隔离墙（MeetingWallAdapter）

/**
 * 统一命中 — 多路并行检索的原子单位。
 *
 * 与旧类型的关键差异：
 *   - `domain`（存储域）与 `route`（召回路）分离，二者不再互相污染
 *   - `backref` 携带真实回源键，下游长文直取 / recall_count 更新直接使用，
 *     不再靠 `source==='conversation'` 猜测（根治 V13 fake id）
 */
export interface SearchHit {
  /** 域内主键（真实回源键，同 domain 内唯一：conversations.id / memories.id / black_diamond.id / knowledge_base.id / works.work_id / vault_log.id / FG node uuid） */
  id: string;
  /** 存储域标识 */
  domain: SearchDomain;
  /** 摘要文本（≤ 规定字符；work 路为标题+摘要） */
  text: string;
  /** 路内原始分（RRF 只看排名不看量纲） */
  score: number;
  /** 召回路（融合阶段按此取权重；缺省由适配器声明 routes 推导为默认） */
  route?: RetrievalRoute;
  /** 归属实体 UUID（belong_entity_uuid，行级 deny-by-default 依据） */
  entityUuid: string | null;
  /** 钙化信息 */
  calciumScore?: number;
  calciumLevel?: number;
  /** 创建时间（ISO，供 L0 时序围栏 + 近因因子） */
  createdAt: string;
  /** 附加域数据（黑钻 emotion_tag/source_id、作品 title/full_text、FG profile 等） */
  payload?: Record<string, unknown>;
  /**
   * 回源键（table + 真实 PK）。下游长文直取 / recall_count 更新直接用，
   * 不再靠 source 猜。生产时由适配器设置；存量 RankedItem 映射时用 backfillBackrefs 校验补全。
   */
  backref?: { table: string; id: string | number };
  /** 显式去重键（跨域折叠，如黑钻 source_id 与金库 id 同记录时）默认取 `${domain}:${id}` */
  dedupeKey?: string;
  /** 时间戳 ms（近因因子用，避免反复 new Date） */
  timeMs?: number;
  /** 前瞻时态标记（V13 Foresight 透传） */
  isForesight?: boolean;
  validStartMs?: number | null;
  validUntilMs?: number | null;
  foresightStatus?: string | null;
}

/**
 * 检索上下文 — 编排层构造一次，所有适配器共享。
 * 只含查询级元数据，不含 sqlite（适配器依赖经构造函数/工厂注入，保持接口纯净可测）。
 */
export interface RetrievalContext {
  /** 用户消息原文 */
  query: string;
  /** 统一过滤策略（编排层用 buildPolicePolicy 构造，适配器必带） */
  policy: PolicePolicy;
  /** 当前 24D 感知向量 */
  perception?: Perception24D;
  /** M3 直出 40D 感知向量（V3） */
  perception40d?: PerceptionV40 | null;
  /** 活跃实体 UUID（会晤白名单） */
  entityUuids: string[];
  /** 检索力度 */
  mode: SearchMode;
  /** 话题路径（emotion/keyword/locus 路用） */
  locusPath?: string;
  /** DNA 实体（M1 entity_genes 形状，MemoryAdapter 的 retrieveMultiRank 需要） */
  entities?: Array<{ name: string; type: string }>;
  /** 最大返回条数 */
  limit?: number;
  /** 会话 ID（缓存 key 用） */
  sessionId?: string;
  /** 时间导航参数（ConversationAdapter 用） */
  timeRange?: { start: string; end?: string };
  /** 注入 now（融合阶段近因因子用，纯函数可测） */
  nowMs?: number;
}

/** 一路召回的命中集（融合输入） */
export interface RouteHitList {
  route: RetrievalRoute;
  hits: SearchHit[];
}

/** 融合选项（全部可配，注入 nowMs 保纯函数可测） */
export interface FuseOptions {
  /** RRF 平滑常数（默认 60，对齐 DEFAULT_RRF_CONFIG.k） */
  k?: number;
  /** 各召回路权重（默认 = FOUNDATION_DEFAULT_WEIGHTS） */
  weights?: Partial<Record<RetrievalRoute, number>>;
  /** 多路命中 bonus（默认 1.2） */
  multiHitBonus?: number;
  /** 融合后候选条数（RRF 阶段，默认 50） */
  rrfTopK?: number;
  /** MMR λ（默认 0.7） */
  lambda?: number;
  /** 最终返回条数（默认 10） */
  topK?: number;
  /** 时间近因因子权重 0-1（默认 0.10，复刻 P3-B2） */
  recencyFactor?: number;
  /** 注入当前时间（测试传固定值） */
  nowMs?: number;
}

/** 融合结果 */
export interface FuseResult {
  /** 融合后命中（已按最终分排序，MMR 去重后） */
  hits: SearchHit[];
  /** dedupeKey → 融合分（真实 RRF+近因分，替代 V13 的 `1.0-i*0.02` 合成） */
  scoreMap: Map<string, number>;
}

/** 显式去重键（同记录跨域折叠）；缺省为 domain:id */
export function dedupeKeyOf(hit: SearchHit): string {
  return hit.dedupeKey ?? `${hit.domain}:${hit.id}`;
}

/**
 * RankedItem → SearchHit 映射桥（MemoryAdapter 内部用）。
 * 存量召回路映射规则：
 *   - work 路 → work 域（id 是 work_id）
 *   - 其余路（emotion/keyword/spine/locus/entity）→ memory 域（id 是 memories.id / spine global_uid）
 *
 * 🔴 注意：spine 路 id 是 state_spines.global_uid（非 memories.id），text 恒为空串，
 *   映射后需 backfillBackrefs 校验剔除假 id（V13 fake id 修复的一环）。
 */
export function rankedItemToHit(r: {
  id: string;
  text: string;
  score: number;
  source: string;
  entityUuid?: string | null;
  calciumScore?: number;
  createdAt?: string;
  isForesight?: boolean;
  validStartMs?: number | null;
  validUntilMs?: number | null;
  foresightStatus?: string | null;
}): SearchHit {
  const domain: SearchDomain = r.source === 'work' ? 'work' : 'memory';
  return {
    id: r.id,
    domain,
    text: r.text,
    score: r.score,
    route: r.source as RetrievalRoute,
    entityUuid: r.entityUuid ?? null,
    calciumScore: r.calciumScore ?? 0,
    createdAt: r.createdAt ?? '',
    isForesight: r.isForesight,
    validStartMs: r.validStartMs,
    validUntilMs: r.validUntilMs,
    foresightStatus: r.foresightStatus,
    timeMs: r.createdAt ? new Date(r.createdAt).getTime() : undefined,
  };
}

