/**
 * recall-bus.ts — 记忆召回总线（MEM-UNIFY-V1 批2A）
 * ====================================================
 * 唯一出口：把各召回腿的候选片段统一做
 *   模式（casual/standard/deep/proactive）→ 归一化去重 → 层保底 →
 *   单一五级闸门（降权参与排序）→ 反馈（recall_count/last_recalled_at）。
 *
 * 为什么需要它（任务书 §六批2A）：
 *   · 旧链路每轮可能同时注入 V13/V11/Foundation/砂金/金库/黑钻/对话组，
 *     但没有一个统一的“层保底”与“单一闸门”，某一层可被另一层挤空；
 *   · 五级闸门此前只在 MemoryRetriever/KnowledgeContextBuilder 挂载，
 *     检索出口没有统一执行，G2/G4/G5 的降权没有真正参与最终排序；
 *   · 召回反馈散落在旧路径，部分命中不回写 recall_count。
 *
 * 边界：
 *   · **纯合并/闸门/反馈层**，不负责具体数据源检索（那是 retrieval-stage / adapters 的事）；
 *   · 不新增 LLM 调用；不写业务表，只按白名单回写 recall_count/last_recalled_at；
 *   · 任何异常降级为“保留候选 + 告警”，不因总线失败把本轮记忆清零。
 */

import { M3_CONFIG } from '../../config/M3Config.js';
import {
  getRetrievalFusionConfig,
  type RecallBusModeBudget,
} from '../../config/retrieval-fusion-config.js';

/** 供测试与调用方复用模式名额类型（不在本模块重复定义） */
export type { RecallBusModeBudget };
import {
  getFiveStageGate,
  type GateResult,
  type ScoredMemory,
} from '../../m3/FiveStageGate.js';

/** 召回模式（与 retrieval-stage 的深度档一一对应） */
export type RecallMode = 'casual' | 'standard' | 'deep' | 'proactive';

/** 记忆层（用于层保底；knowledge/long_text/work 属证据层，不占三层名额） */
export type RecallTier =
  | 'sand'
  | 'gold'
  | 'diamond'
  | 'group'
  | 'knowledge'
  | 'long_text'
  | 'work'
  | 'other';

/** 总线候选（文本 + 分类 + 排序/反馈所需元数据） */
export interface RecallCandidate {
  text: string;
  tier: RecallTier;
  /** 语义/融合分（0~1）；缺省时由钙化 + 近因推导 */
  score?: number;
  createdAt?: string;
  entityUuid?: string | null;
  calciumScore?: number;
  calciumLevel?: number;
  effectiveStrength?: number;
  /** 40D 余弦（可选；缺省时 G1 按阈值下限放行，避免关键词命中被误杀） */
  cosineScore?: number;
  locationFingerprint?: string | null;
  isLandmark?: boolean;
  /** 反馈锚点（有则回写 recall_count） */
  backref?: { table: RecallFeedbackTable; id: string };
}

export type RecallFeedbackTable = 'memories' | 'black_diamond' | 'knowledge_base';

export interface RecallBusOptions {
  mode: RecallMode;
  query: string;
  candidates: RecallCandidate[];
  locationFingerprint?: string;
  previousTopic?: string;
  /** 注入 now（确定性排序 / 可测） */
  nowMs?: number;
}

export interface RecallBusResult {
  selected: RecallCandidate[];
  dropped: { duplicate: number; gate: number; budget: number };
  gateStats?: GateResult['stageStats'];
  /** 各层实际入选数（用于「三层探针各 ≥1」验收） */
  tiers: Record<RecallTier, number>;
  /** 层保底缺口（某层候选不足时如实记录，不静默） */
  shortfalls: Partial<Record<RecallTier, number>>;
}

/** 标签 → 层分类（先匹配更具体的标签，避免「知识库档案」被误判成 knowledge） */
const TIER_MATCHERS: Array<[RecallTier, RegExp]> = [
  ['long_text', /^【(对话原文|知识库档案)/],
  ['work', /^【作品】/],
  // 🔴 批7：深度收集的黑钻片段标签是「金库黑钻」，此前被下方的 /金库/ 先归成 gold，
  //   导致生产 RecallBus 的 diamond 恒为 0、层保底长期缺口。此处显式归 diamond（diamond 先匹配）。
  ['diamond', /【珍藏记忆】|💎|珍藏记忆|【金库黑钻】|金库黑钻/],
  ['gold', /【金库记忆】|金库/],
  ['knowledge', /^\s*📖|^【知识库/],
  ['group', /【对话组|💭|对话组/],
  // 🔴 批7：证据层（档案/记事）是收集材料，不是砂金记忆；归 other 直通，不占三层名额。
  ['other', /^【(?:档案|记事)】/],
  ['sand', /📌|重要记忆|【回忆】|【用户曾提到】/],
];

/**
 * 指令类片段（MEM-UNIFY-V1 批4）：深度回忆素材包 / 结晶令 / 三档协议 / 默契元素 / 主动回忆
 * 是**表达指令**，不是记忆条目 —— 归 other 直通，不占砂金/金库/黑钻/对话组名额。
 */
const DIRECTIVE_FRAGMENT_RE =
  /^【(?:深度回忆素材包|结晶表达|回忆表达三档|默契元素|主动回忆)/;

/** 把注入片段按标签归类；未标注的默认按砂金处理。 */
export function classifyFragmentTier(fragment: string): RecallTier {
  const s = String(fragment || '').trim();
  // 上下文直通：用户状态/系统/引擎块不是记忆，不占记忆预算（见 applyTierFloors）
  if (/^【用户状态】|^【系统|^【引擎/.test(s)) return 'other';
  if (DIRECTIVE_FRAGMENT_RE.test(s)) return 'other';
  for (const [tier, re] of TIER_MATCHERS) {
    if (re.test(s)) return tier;
  }
  return 'sand';
}

/** 归一化去重键：去标签/括号旁白/后缀说明/空白，取前 60 字。 */
function dedupeText(text: string): string {
  return String(text || '')
    .replace(/【[^】]*】/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/——.*$/, '')
    .replace(/\s+/g, '')
    .trim()
    .substring(0, 60);
}

/** 候选排序分：显式 score 优先；否则 0.6*钙化(归一到 0~1) + 0.4*30 天近因。 */
export function candidateScore(c: RecallCandidate, nowMs: number = Date.now()): number {
  if (typeof c.score === 'number' && Number.isFinite(c.score)) return c.score;
  const calcium = Math.min(1, Math.max(0, (c.calciumScore ?? c.calciumLevel ?? 1) / 5));
  let recency = 0.5;
  if (c.createdAt) {
    const ts = Date.parse(c.createdAt);
    if (Number.isFinite(ts)) {
      recency = Math.max(0, 1 - Math.max(0, nowMs - ts) / (30 * 86400000));
    }
  }
  return 0.6 * calcium + 0.4 * recency;
}

/** 归一化去重：同文本保留分更高者（空文本丢弃）。 */
export function dedupeCandidates(candidates: RecallCandidate[], nowMs: number = Date.now()): RecallCandidate[] {
  const kept = new Map<string, RecallCandidate>();
  for (const c of candidates || []) {
    if (!c || !String(c.text || '').trim()) continue;
    const key = dedupeText(c.text);
    if (!key) continue;
    const prev = kept.get(key);
    if (!prev || candidateScore(c, nowMs) > candidateScore(prev, nowMs)) {
      kept.set(key, c);
    }
  }
  return [...kept.values()];
}

/**
 * 层保底：先按 sand/gold/diamond/group 每层保底名额取分最高者，
 * 再用剩余候选补足 total。证据层（knowledge/long_text/work/other）只参与补足。
 */
export function applyTierFloors(
  candidates: RecallCandidate[],
  budget: RecallBusModeBudget,
  nowMs: number = Date.now(),
): { selected: RecallCandidate[]; shortfalls: Partial<Record<RecallTier, number>> } {
  const sorted = [...(candidates || [])].sort((a, b) => candidateScore(b, nowMs) - candidateScore(a, nowMs));
  // other = 上下文直通（用户状态/系统/引擎）：不占记忆名额、不受 total 截断
  const passthrough = sorted.filter(c => c.tier === 'other');
  const memorySorted = sorted.filter(c => c.tier !== 'other');
  const selected: RecallCandidate[] = [];
  const picked = new Set<RecallCandidate>();
  const shortfalls: Partial<Record<RecallTier, number>> = {};

  const floors: Array<[RecallTier, number]> = [
    ['sand', budget.sand],
    ['gold', budget.gold],
    ['diamond', budget.diamond],
    ['group', budget.group],
  ];
  for (const [tier, needRaw] of floors) {
    let need = Math.max(0, Math.floor(needRaw || 0));
    if (need === 0) continue;
    for (const c of memorySorted) {
      if (need <= 0) break;
      if (picked.has(c) || c.tier !== tier) continue;
      selected.push(c);
      picked.add(c);
      need--;
    }
    if (need > 0) shortfalls[tier] = need;
  }

  for (const c of memorySorted) {
    if (selected.length >= budget.total) break;
    if (picked.has(c)) continue;
    selected.push(c);
    picked.add(c);
  }

  return {
    selected: [...passthrough, ...selected].slice(0, Math.max(0, budget.total) + passthrough.length),
    shortfalls,
  };
}

/**
 * 单一五级闸门：把候选映射成 ScoredMemory 后调用 FiveStageGate，
 * 返回顺序即闸门最终排序（G2/G4/G5 的 effective_strength 降权真正参与）。
 *
 * G1 说明：闸门 G1 是语义向量硬阈值；总线候选是混合来源，非向量命中没有真实
 * cosine。此处对非向量命中按 G1 阈值下限放行（与 FiveStageGate 自身
 * “无向量 → 全部放行”语义一致），避免关键词命中被静默误杀；G2-G5 照常执行。
 */
export function applyGate(
  candidates: RecallCandidate[],
  opts: { query: string; locationFingerprint?: string; previousTopic?: string },
): { passed: RecallCandidate[]; gate: GateResult | null } {
  if (!candidates || candidates.length === 0) return { passed: [], gate: null };
  const g1Floor = Number(M3_CONFIG.fiveStageGate.g1CosineThreshold) || 0.3;
  const mapped: Array<{ c: RecallCandidate; m: ScoredMemory }> = candidates.map((c, i) => {
    const ts = c.createdAt ? Date.parse(c.createdAt) : NaN;
    return {
      c,
      m: {
        id: `rb_${i}`,
        raw_input: c.text,
        calcium_score: c.calciumScore ?? c.calciumLevel ?? 1,
        effective_strength: c.effectiveStrength ?? 1,
        created_at: c.createdAt,
        absolute_timestamp: Number.isFinite(ts) ? ts : undefined,
        perception_40d: undefined,
        location_fingerprint: c.locationFingerprint ?? undefined,
        is_landmark: c.isLandmark ? 1 : 0,
        // 语义分缺省时按阈值下限放行（见上方 G1 说明）
        cosine_score: typeof c.cosineScore === 'number' && c.cosineScore > 0
          ? Math.max(g1Floor, c.cosineScore)
          : g1Floor,
      },
    };
  });

  try {
    const gate = getFiveStageGate();
    const res = gate.filter(mapped.map(x => x.m), {
      query: opts.query,
      locationFingerprint: opts.locationFingerprint,
      previousTopic: opts.previousTopic,
    });
    const byId = new Map(mapped.map(x => [String(x.m.id), x.c]));
    const passed = res.passed
      .map(m => byId.get(String(m.id)))
      .filter((c): c is RecallCandidate => !!c);
    return { passed, gate: res };
  } catch (e) {
    // 闸门异常不得把本轮记忆清零：保留候选 + 显式告警（降级可见）
    console.warn('[RecallBus] 五级闸门异常，按降级放行:', (e as Error)?.message || e);
    return { passed: candidates, gate: null };
  }
}

function emptyTierCounts(): Record<RecallTier, number> {
  return { sand: 0, gold: 0, diamond: 0, group: 0, knowledge: 0, long_text: 0, work: 0, other: 0 };
}

/**
 * 总线唯一入口：去重 → 闸门 → 层保底 → 截断。
 * 配置关闭时退化为“去重 + 截断”，保证可回滚。
 */
export function runRecallBus(opts: RecallBusOptions): RecallBusResult {
  const cfg = getRetrievalFusionConfig().recall_bus;
  const nowMs = opts.nowMs ?? Date.now();
  const budget = cfg?.modes?.[opts.mode] ?? cfg?.modes?.standard ?? {
    total: 8, sand: 2, gold: 1, diamond: 1, group: 1,
  };
  const input = opts.candidates || [];
  const deduped = dedupeCandidates(input, nowMs);

  if (cfg && cfg.enabled === false) {
    const selected = deduped.slice(0, Math.max(0, budget.total));
    const tiers = emptyTierCounts();
    for (const c of selected) tiers[c.tier]++;
    return {
      selected,
      dropped: { duplicate: input.length - deduped.length, gate: 0, budget: deduped.length - selected.length },
      tiers,
      shortfalls: {},
    };
  }

  const gated = cfg?.gate?.enabled === false
    ? { passed: deduped, gate: null }
    : applyGate(deduped, {
        query: opts.query,
        locationFingerprint: opts.locationFingerprint,
        previousTopic: opts.previousTopic,
      });

  const { selected, shortfalls } = applyTierFloors(gated.passed, budget, nowMs);
  const tiers = emptyTierCounts();
  for (const c of selected) tiers[c.tier]++;

  const result: RecallBusResult = {
    selected,
    dropped: {
      duplicate: input.length - deduped.length,
      gate: deduped.length - gated.passed.length,
      budget: gated.passed.length - selected.length,
    },
    gateStats: gated.gate?.stageStats,
    tiers,
    shortfalls,
  };

  console.log(
    `[RecallBus] mode=${opts.mode} in=${input.length} → dedupe=${deduped.length} → gate=${gated.passed.length} → selected=${selected.length}` +
    ` | tiers=${JSON.stringify(tiers)}` +
    (Object.keys(shortfalls).length > 0 ? ` | 层保底缺口=${JSON.stringify(shortfalls)}` : ''),
  );
  return result;
}

const FEEDBACK_SQL: Record<RecallFeedbackTable, string> = {
  memories: 'UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled_at = ? WHERE id = ?',
  black_diamond: 'UPDATE black_diamond SET recall_count = COALESCE(recall_count, 0) + 1, updated_at = ? WHERE id = ?',
  knowledge_base: 'UPDATE knowledge_base SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled_at = ? WHERE id = ?',
};

export interface RecallFeedbackRef {
  table: RecallFeedbackTable;
  id: string;
}

export interface RecallFeedbackSql {
  writeRaw?: (sql: string, params?: unknown[]) => unknown;
}

/**
 * 召回反馈单点：只按白名单表回写 recall_count（+ memories/knowledge_base 的 last_recalled_at）。
 * 同一 (table,id) 一轮只记一次；失败不阻塞。
 */
export function applyRecallFeedback(
  sqlite: RecallFeedbackSql | null | undefined,
  refs: RecallFeedbackRef[] | null | undefined,
): number {
  if (!sqlite || typeof sqlite.writeRaw !== 'function' || !refs || refs.length === 0) return 0;
  const now = new Date().toISOString();
  const seen = new Set<string>();
  let updated = 0;
  for (const r of refs) {
    if (!r || !r.id) continue;
    const table = r.table;
    if (!Object.prototype.hasOwnProperty.call(FEEDBACK_SQL, table)) continue;
    const key = table + ':' + r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      sqlite.writeRaw(FEEDBACK_SQL[table], [now, r.id]);
      updated++;
    } catch (e) {
      console.warn('[RecallBus] 召回反馈失败:', table, r.id, (e as Error)?.message || e);
    }
  }
  return updated;
}
