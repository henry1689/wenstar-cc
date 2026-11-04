/**
 * MemArch-v2.0.0 / M5-Presentation / attributor.ts
 *
 * 强化归因器：对用户回应打四类标签。
 *   confirm   用户确认正确
 *   engaged   被触发但未确认（提到了证据实体/关键词）
 *   ignored   提及但无反馈
 *   correct   用户纠正
 *
 * 纯规则匹配（无 LLM 自评），命中结果交给上层调 ReinforceSink。
 */

import type {
  AttributionHit,
  AttributionSignal,
  NormalizedEvidence,
} from './types.js';
import type { AttributionConfig } from './config.js';
import { tokenize } from './outputGuard.js';

export interface AttributorInput {
  /** 用户这一轮的回应原文 */
  user_reply: string;
  /** 上一轮 assistant 输出时实际采用的证据 */
  used_evidences: NormalizedEvidence[];
  config: AttributionConfig;
}

/** 检查用户回应是否命中某个正则组 */
function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * 主入口。
 *
 * 判定优先级：correct > confirm > engaged > ignored。
 * - correct：命中纠正词即触发（针对所有 used_evidences）
 * - confirm：命中确认词 AND token 命中某条证据
 * - engaged：token 命中某条证据但无明确肯定
 * - ignored：token 没命中任何证据（针对 top-1 证据发一次 ignored）
 */
export function attribute(input: AttributorInput): AttributionHit[] {
  const { user_reply, used_evidences, config } = input;
  const reply = user_reply.trim();
  if (!reply) return [];

  const hits: AttributionHit[] = [];

  // 1. correct：纠正词命中 → 对所有 used 证据打 correct
  const isCorrect = matchAny(reply, config.correct_patterns);
  if (isCorrect) {
    for (const ev of used_evidences) {
      hits.push({
        uuid: ev.uuid,
        signal: 'correct',
        reason: 'correct_pattern_hit',
      });
    }
    return hits; // correct 优先级最高，短路
  }

  // 2. 算用户回应与每条证据的 token overlap
  const replyTokens = new Set(tokenize(reply));
  const overlapScores = used_evidences.map((ev) => {
    const evTokens = new Set(tokenize(ev.raw_text));
    let hits_ = 0;
    for (const t of replyTokens) if (evTokens.has(t)) hits_++;
    const union = new Set([...replyTokens, ...evTokens]).size;
    const jaccard = union === 0 ? 0 : hits_ / union;
    return { ev, hits: hits_, jaccard };
  });

  const isConfirm = matchAny(reply, config.confirm_patterns);

  // 3. confirm：确认词 + token 命中
  if (isConfirm) {
    for (const { ev, jaccard } of overlapScores) {
      if (jaccard >= config.engaged_min_token_overlap) {
        hits.push({
          uuid: ev.uuid,
          signal: 'confirm',
          reason: `confirm_pattern+token_overlap=${jaccard.toFixed(2)}`,
        });
      }
    }
    if (hits.length > 0) return hits;
    // 只有确认词但没 token 命中——不发信号（用户在空泛肯定，不知道确认啥）
  }

  // 4. engaged：token 命中但无明确肯定/否定
  for (const { ev, jaccard } of overlapScores) {
    if (jaccard >= config.engaged_min_token_overlap) {
      hits.push({
        uuid: ev.uuid,
        signal: 'engaged',
        reason: `token_overlap=${jaccard.toFixed(2)}`,
      });
    }
  }
  if (hits.length > 0) return hits;

  // 5. ignored：完全没提到任何证据 → 对 top-1 证据发 ignored（用户看到了但没接话）
  if (used_evidences.length > 0) {
    const top = [...used_evidences].sort((a, b) => b.score - a.score)[0];
    hits.push({
      uuid: top.uuid,
      signal: 'ignored',
      reason: 'no_token_overlap_with_any_evidence',
    });
  }

  return hits;
}

/** 把 AttributionSignal 映射到 ReinforceSink 需要的 ReinforceSignal */
export function toReinforceSignal(signal: AttributionSignal): 'positive' | 'negative' {
  switch (signal) {
    case 'confirm':
    case 'engaged':
      return 'positive';
    case 'ignored':
      return 'negative';
    case 'correct':
      // correct 走再巩固路径，不直接发 reinforce；这里返回 negative 仅作兜底
      return 'negative';
  }
}
