/**
 * MemArch-v2.0.0 / M5-Presentation / labeler.ts
 *
 * 证据标签四档判定：「记得」/「印象」/「线索」/「不说」。
 *
 * 判定逻辑（纯规则，无 LLM 自评）：
 *   1. 单条证据：score + recency 落入 config.labels 阈值表。
 *   2. 多条证据聚合：取最高档，但有两条降级规则：
 *      a. 用户查询是"借用意象烘托当下"（模糊指代+无具体事件）→ 强制降到 impression 封顶。
 *      b. 多条 A-side 证据互相矛盾 → 降一档。
 */

import type { EvidenceLabel, NormalizedEvidence } from './types.js';
import type { LabelConfig } from './config.js';

// 模糊指代词——出现这些词说明用户在借氛围，不是在调取具体记忆
const VAGUE_MOOD_MARKERS = [
  /那种感觉/,
  /那种温柔/,
  /那种氛围/,
  /那种(的)?感觉/,
  /就像我们之前/,
  /好像我们之前/,
  /当初的感觉/,
  /过去的(那种|那种感觉)/,
];

// 否定词对——简单矛盾检测
const NEGATION_WORDS = ['不', '没', '别', '讨厌', '不要', '不是'];

export interface LabelInput {
  evidences: NormalizedEvidence[];
  /** 当前用户 query（用于模糊指代检测） */
  user_query: string;
  config: LabelConfig;
}

export interface LabelResult {
  label: EvidenceLabel;
  /** 单条证据各自的标签（诊断用） */
  per_evidence: { uuid: string; label: EvidenceLabel }[];
  /** 是否触发了"模糊指代降档" */
  degraded_vague: boolean;
  /** 是否触发了"证据矛盾降档" */
  degraded_conflict: boolean;
}

/** 单条证据 → 标签（按阈值表自上而下匹配） */
export function labelSingle(ev: NormalizedEvidence, cfg: LabelConfig): EvidenceLabel {
  if (ev.tombstone) return 'refused';
  if (ev.score >= cfg.remembered.min_score && ev.recency <= cfg.remembered.max_recency_days) {
    return 'remembered';
  }
  if (ev.score >= cfg.impression.min_score && ev.recency <= cfg.impression.max_recency_days) {
    return 'impression';
  }
  if (ev.score >= cfg.clue.min_score && ev.recency <= cfg.clue.max_recency_days) {
    return 'clue';
  }
  return 'refused';
}

/** 检测用户 query 是否在"借氛围"——不指向具体事件 */
export function isVagueMoodQuery(query: string): boolean {
  const q = query.trim();
  // 短 query + 模糊指代词
  if (q.length > 30) return false;
  for (const re of VAGUE_MOOD_MARKERS) {
    if (re.test(q)) return true;
  }
  return false;
}

/** 检测 A-side 证据之间是否存在矛盾（共现实体 + 否定冲突） */
export function hasConflict(a_side: NormalizedEvidence[]): boolean {
  if (a_side.length < 2) return false;
  for (let i = 0; i < a_side.length; i++) {
    for (let j = i + 1; j < a_side.length; j++) {
      const a = a_side[i];
      const b = a_side[j];
      // 必须有共享实体，否则不算矛盾
      const entA = new Set(a.entities ?? []);
      const entB = new Set(b.entities ?? []);
      const shared = [...entA].filter((x) => entB.has(x));
      if (shared.length === 0) continue;
      // 一方含否定词、另一方不含 → 矛盾
      const aNeg = NEGATION_WORDS.some((w) => a.raw_text.includes(w));
      const bNeg = NEGATION_WORDS.some((w) => b.raw_text.includes(w));
      if (aNeg !== bNeg) return true;
    }
  }
  return false;
}

const LABEL_ORDER: EvidenceLabel[] = ['remembered', 'impression', 'clue', 'refused'];

/** 降一档：remembered→impression→clue→refused */
function downgradeOne(label: EvidenceLabel): EvidenceLabel {
  const idx = LABEL_ORDER.indexOf(label);
  if (idx < 0 || idx >= LABEL_ORDER.length - 1) return 'refused';
  return LABEL_ORDER[idx + 1];
}

/** 多条证据聚合打标签 */
export function labelAggregate(input: LabelInput): LabelResult {
  const { evidences, user_query, config } = input;

  const per_evidence = evidences.map((ev) => ({
    uuid: ev.uuid,
    label: labelSingle(ev, config),
  }));

  // 取最强档（remembered > impression > clue > refused）
  let top: EvidenceLabel = 'refused';
  for (const { label } of per_evidence) {
    if (LABEL_ORDER.indexOf(label) < LABEL_ORDER.indexOf(top)) top = label;
  }

  let degraded_vague = false;
  let degraded_conflict = false;

  // 降档规则 a：模糊借氛围 → 封顶 impression（即使单条证据够 remembered）
  if (top === 'remembered' && isVagueMoodQuery(user_query)) {
    top = 'impression';
    degraded_vague = true;
  }

  // 降档规则 b：证据矛盾 → 再降一档
  if (hasConflict(evidences.filter((e) => !e.tombstone && !e.suppressed && e.pathway === 'A'))) {
    top = downgradeOne(top);
    degraded_conflict = true;
  }

  return { label: top, per_evidence, degraded_vague, degraded_conflict };
}
