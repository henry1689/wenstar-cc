/**
 * EntityQualityJudge — 实体质量【离线终审】判定器
 * ================================================
 * 与 EntityCandidateGrader（在线快筛）同域，二者构成完整结构：
 *
 *   在线（零 LLM）              离线（梦境/维护）
 *   ─────────────              ──────────────
 *   L3 → candidate              candidate 队列 → 批量 LLM 终审
 *   证据分累积晋升              判为真人 → 提升 active（增益）
 *
 * 设计约束（用户 2026-09-20 决策）：
 *   - **保守**：本判定器只产出建议；执行层【只做提升】，噪声仅标注不回收。
 *     理由：真人被误 void 的代价 >> 噪声多留一阵。
 *   - **批量**：一次 prompt 判 N 个，成本 O(批次) 而非 O(实体)。
 *   - **纯函数**：本模块只负责「构造 prompt / 解析响应 / 应用策略」，
 *     不直接调 LLM —— 便于单测，也让调用时机（梦境/维护）与判定逻辑解耦。
 *   - **可复用**：批14 存量清洗复用同一判定器输出清单，不另写第二套逻辑。
 *
 * @module app/entity
 */

/** 待判定条目（由调用方从 FG 的 candidate 节点 + 其提及上下文组装） */
export interface JudgeItem {
  /** 实体名 */
  name: string;
  /** 累计提及次数（在线证据） */
  mentionCount?: number;
  /** 该名出现过的原文片段（限量，用于给 LLM 语境） */
  contexts?: string[];
  /** 已建立的 FG 关系（如 acquaintance_of / mother_of） */
  relations?: string[];
}

/** 单条判定结果 */
export interface EntityJudgment {
  name: string;
  verdict: 'person' | 'noise' | 'unknown';
  /** 0~1 */
  confidence: number;
  /** LLM 给出的理由（短） */
  reason?: string;
}

/** 策略应用结果：保守 = 只提升 + 只标注 */
export interface ConservativeOutcome {
  /** 建议提升为 active 的名字（verdict=person） */
  promote: string[];
  /** 仅标注、不回收的名字（verdict=noise）—— 供批14 出人工清单 */
  annotate: Array<{ name: string; confidence: number; reason?: string }>;
  /** 证据不足/LLM 不确定 —— 保持观察区继续累积 */
  keepObserving: string[];
}

/** 判定用的上下文片段上限（防止 prompt 膨胀） */
const MAX_CONTEXTS_PER_ITEM = 3;
const MAX_CONTEXT_CHARS = 120;

/**
 * 构造批量判定 prompt。
 * 输出要求：严格 JSON 数组，元素 {name, verdict, confidence, reason}。
 */
export function buildJudgePrompt(items: JudgeItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    const ctxs = (it.contexts ?? [])
      .slice(0, MAX_CONTEXTS_PER_ITEM)
      .map((c) => '「' + String(c).replace(/\s+/g, ' ').slice(0, MAX_CONTEXT_CHARS) + '」')
      .join(' ');
    const meta: string[] = [];
    if (typeof it.mentionCount === 'number') meta.push('提及' + it.mentionCount + '次');
    if (it.relations?.length) meta.push('已有关系:' + it.relations.slice(0, 3).join('/'));
    lines.push(`- 名字: ${it.name}${meta.length ? '（' + meta.join('，') + '）' : ''}${ctxs ? ' 出现语境: ' + ctxs : ''}`);
  }

  return [
    '你是中文对话语料的实体审核员。下面是系统从对话里切分出的「候选人名」及其出现语境。',
    '请判断每个名字是否【真的是一个人的名字】（可以是姓名、小名、昵称、称谓+名字的组合）。',
    '',
    '判定标准：',
    '- person：确实是某人的人名（如"张小龙""徐诗雨""阿芬"）',
    '- noise：并非人名，而是把一句话切碎的片段、普通词组合、或无语义碎片',
    '         （如"明伶俐"来自"聪明伶俐"、"后找男""谢想法"这类跨词边界的滑窗片段）',
    '- unknown：信息不足，无法判断',
    '',
    '待判定列表：',
    ...lines,
    '',
    '只输出 JSON 数组，不要任何解释、不要 markdown 代码块。格式：',
    '[{"name":"原名","verdict":"person|noise|unknown","confidence":0.0~1.0,"reason":"不超过20字"}]',
    `必须覆盖全部 ${items.length} 个名字，name 必须与输入完全一致。`,
  ].join('\n');
}

/**
 * 解析 LLM 响应。容错策略：
 *  1) 直接 JSON.parse
 *  2) 失败则提取第一个 '[' 到最后一个 ']' 的子串再 parse
 *  3) 仍失败 → 全部视为 unknown（绝不因解析失败而误判）
 * 并对 verdict/confidence 做合法性收敛，保证返回条数覆盖 expected。
 */
export function parseJudgeResponse(raw: string, expected: string[]): EntityJudgment[] {
  const fallback = (): EntityJudgment[] =>
    expected.map((name) => ({ name, verdict: 'unknown' as const, confidence: 0 }));

  if (!raw || typeof raw !== 'string') return fallback();

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const s = raw.indexOf('[');
    const e = raw.lastIndexOf(']');
    if (s >= 0 && e > s) {
      try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch { parsed = null; }
    }
  }
  if (!Array.isArray(parsed)) return fallback();

  const byName = new Map<string, EntityJudgment>();
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const v = String(row.verdict ?? '').toLowerCase();
    const verdict: EntityJudgment['verdict'] =
      v === 'person' ? 'person' : v === 'noise' ? 'noise' : 'unknown';
    let confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    byName.set(name, {
      name,
      verdict,
      confidence,
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 40) : undefined,
    });
  }

  // 以 expected 为准补齐（LLM 漏项 → unknown，绝不猜测）
  return expected.map((name) =>
    byName.get(name) ?? { name, verdict: 'unknown' as const, confidence: 0 },
  );
}

/** 置信度阈值：低于此值视为不确定（保守） */
export const JUDGE_PROMOTE_MIN_CONFIDENCE = 0.75;

/**
 * 应用【保守】策略：
 *   - person 且 confidence ≥ 阈值 → promote（提升 active）
 *   - noise                      → annotate（只记录，绝不自动回收）
 *   - 其他（unknown / 低置信 person）→ keepObserving（继续累积证据）
 *
 * 注意：**本函数永不产出「回收」动作** —— 这是用户明确选择的保守边界。
 */
export function applyConservativePolicy(judgments: EntityJudgment[]): ConservativeOutcome {
  const out: ConservativeOutcome = { promote: [], annotate: [], keepObserving: [] };
  for (const j of judgments) {
    if (j.verdict === 'person' && j.confidence >= JUDGE_PROMOTE_MIN_CONFIDENCE) {
      out.promote.push(j.name);
    } else if (j.verdict === 'noise') {
      // 只标注：批14 会把这些整理成人工清单，而不是直接 void
      out.annotate.push({ name: j.name, confidence: j.confidence, reason: j.reason });
    } else {
      out.keepObserving.push(j.name);
    }
  }
  return out;
}

export default { buildJudgePrompt, parseJudgeResponse, applyConservativePolicy };
