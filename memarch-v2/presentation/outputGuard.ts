/**
 * MemArch-v2.0.0 / M5-Presentation / outputGuard.ts
 *
 * 两级校验（纯规则，无 LLM 自评）：
 *   ① 断言抽取：把候选 utterance 切成原子断言 + token 化
 *   ② 蕴含验证：每条断言必须在 Evidence[] 里找到 token 支撑，否则丢弃
 *
 * 附加约束：
 *   - 通路 B 话术不得出现事实陈述（narrative_markers 命中即改写）
 *   - 零证据时必须走 fallback，不得硬编
 */

import type {
  Assertion,
  NormalizedEvidence,
  RoutedPath,
} from './types.js';
import type { GuardConfig } from './config.js';

// 停用词——不参与蕴含验证
const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '这', '那', '吗', '呢', '吧', '啊', '呀', '哦',
  '嗯', '就', '都', '也', '还', '在', '有', '和', '与', '或', '把', '被', '让', '给', '到',
  '上', '下', '里', '中', '对', '为', '以', '及', '着', '过', '来', '去', '说', '想', '记',
  '记得', '好像', '觉得', '感觉', '一下', '一些', '那个', '这个', '我们', '你们', '他们',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'I', 'you', 'he', 'she', 'it', 'we', 'they',
]);

/**
 * 极简 token 化：
 * - 英文按空格 + 标点切
 * - 中文按 2~4 字滑窗 + 单字（去停用词）
 * 不引入分词库（避免重依赖），足够做蕴含粗筛。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const clean = text.replace(/[，。！？；：、""''《》（）()\[\]{}\s,.!?;:]/g, ' ');
  const tokens: string[] = [];
  // 英文词
  const enWords = clean.match(/[A-Za-z][A-Za-z0-9']+/g) ?? [];
  for (const w of enWords) {
    const low = w.toLowerCase();
    if (!STOPWORDS.has(low) && low.length > 1) tokens.push(low);
  }
  // 中文连续段 → 2~4 字滑窗
  const cnSegments = clean.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const seg of cnSegments) {
    // 整段先作为一个 token（短词）
    if (seg.length >= 2 && seg.length <= 6 && !STOPWORDS.has(seg)) tokens.push(seg);
    // 2-gram 滑窗
    for (let i = 0; i + 2 <= seg.length; i++) {
      const gram = seg.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) tokens.push(gram);
    }
  }
  // 去重
  return [...new Set(tokens)];
}

/** ① 断言抽取：按标点切句，每句一个断言 */
export function extractAssertions(utterance: string): Assertion[] {
  if (!utterance) return [];
  // 按句末标点切
  const clauses = utterance.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  return clauses.map((c) => ({
    text: c,
    tokens: tokenize(c),
  }));
}

/**
 * ② 蕴含验证：单条断言是否被某条证据支撑。
 * 规则：断言 tokens 与 evidence.raw_text 的 token 集合做 jaccard。
 * 命中数 >= min_token_hits 且 jaccard >= min_token_overlap → 通过。
 */
export function assertionSupported(
  assertion: Assertion,
  evidences: NormalizedEvidence[],
  cfg: GuardConfig,
): { supported: boolean; by?: NormalizedEvidence } {
  if (assertion.tokens.length === 0) {
    // 纯语气词/无实义断言——视为无需证据（如"嗯"）
    return { supported: true };
  }
  for (const ev of evidences) {
    if (ev.tombstone) continue;
    const evTokens = new Set(tokenize(ev.raw_text));
    let hits = 0;
    for (const t of assertion.tokens) {
      if (evTokens.has(t)) hits++;
    }
    if (hits < cfg.min_token_hits) continue;
    const union = new Set([...assertion.tokens, ...evTokens]).size;
    const jaccard = union === 0 ? 0 : hits / union;
    if (jaccard >= cfg.min_token_overlap) {
      return { supported: true, by: ev };
    }
  }
  return { supported: false };
}

/** 通路 B 话术校验：出现叙事标记 → 判定为事实陈述，必须改写 */
export function hasNarrativeMarker(utterance: string, cfg: GuardConfig): boolean {
  for (const re of cfg.pathway_b_narrative_markers) {
    if (re.test(utterance)) return true;
  }
  return false;
}

/** 通路 B 暗示话术模板（不得含事实陈述） */
export function buildPathwayBHedge(): string {
  // 模糊暗示——只说"有感觉"，不说"是什么"
  const hedges = [
    '感觉好像之前有聊过类似的氛围，具体细节我不太敢确定。',
    '隐约有一点印象，像是之前提到过，但我不确定是不是同一件事。',
    '好像有点熟悉的感觉，不过具体内容我把握不大。',
  ];
  // 按毫秒确定性选一条，避免随机性导致测试不稳定
  const idx = Math.floor(Date.now() / 1000) % hedges.length;
  return hedges[idx];
}

export interface GuardInput {
  candidate_utterance: string;
  evidences: NormalizedEvidence[];
  routed_path: RoutedPath;
  config: GuardConfig;
}

export interface GuardResult {
  utterance: string;
  guard_passed: boolean;
  dropped_assertions: Assertion[];
  /** 通路 B 被改写标记 */
  rewritten_for_pathway_b: boolean;
}

/**
 * OutputGuard 主入口。
 *
 * 流程：
 *   1. 零证据 → 直接返回 fallback（guard_passed=false 但 utterance 是安全兜底）
 *   2. 抽断言
 *   3. 逐条蕴含验证，丢掉无支撑断言
 *   4. 把有支撑的断言拼回 utterance；若全部被丢 → fallback
 *   5. 通路 B：检查是否含叙事标记，命中则改写为 hedge
 */
export function runGuard(input: GuardInput): GuardResult {
  const { candidate_utterance, evidences, routed_path, config } = input;

  const visibleEvidences = evidences.filter((e) => !e.tombstone);

  // 零证据兜底
  if (visibleEvidences.length === 0 || !candidate_utterance.trim()) {
    return {
      utterance: config.fallback_no_evidence,
      guard_passed: false,
      dropped_assertions: extractAssertions(candidate_utterance),
      rewritten_for_pathway_b: false,
    };
  }

  const assertions = extractAssertions(candidate_utterance);
  const kept: Assertion[] = [];
  const dropped: Assertion[] = [];

  for (const a of assertions) {
    const { supported, by } = assertionSupported(a, visibleEvidences, config);
    if (supported) {
      kept.push({ ...a, supportedBy: by?.uuid });
    } else {
      dropped.push(a);
    }
  }

  let utterance: string;
  if (kept.length === 0) {
    // 所有断言都无证据 → 吞掉整个候选，走兜底
    utterance = config.fallback_no_evidence;
  } else {
    utterance = kept.map((k) => k.text).join('');
  }

  // 通路 B 额外约束：不得出现事实陈述
  let rewritten_for_pathway_b = false;
  if (routed_path === 'B_only' && hasNarrativeMarker(utterance, config)) {
    utterance = buildPathwayBHedge();
    rewritten_for_pathway_b = true;
  }

  return {
    utterance,
    guard_passed: dropped.length === 0 && kept.length > 0 && !rewritten_for_pathway_b,
    dropped_assertions: dropped,
    rewritten_for_pathway_b,
  };
}
