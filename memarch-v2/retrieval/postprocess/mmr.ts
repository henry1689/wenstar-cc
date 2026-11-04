// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / postprocess/mmr.ts
// MMR 去重 + 上下文打包
//   MMR(d) = λ * Sim(q, d) - (1-λ) * max_{d' in S} Sim(d, d')
//   λ = 0.7 默认（偏相关性，抑制冗余）
//   相似度：token Jaccard 代理（与 rerank 一致）
// =====================================================================

import type { Evidence } from '../types';

function toks(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  const en = lower.match(/[a-z0-9_]+/g);
  if (en) for (const t of en) out.add(t);
  const zh = lower.match(/[\u4e00-\u9fa5]/g);
  if (zh) for (let i = 0; i < zh.length - 1; i++) out.add(zh[i] + zh[i + 1]);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 对 rerank 后的候选做 MMR 去重，返回 top-K。
 * @param candidates 重排后按 score 降序
 * @param topK 最终保留条数
 * @param lambda MMR 平衡因子（默认 0.7）
 */
export function mmrSelect(
  candidates: Evidence[],
  topK: number = 20,
  lambda: number = 0.7
): Evidence[] {
  if (candidates.length <= topK) return candidates;

  const selected: Evidence[] = [];
  const rest = [...candidates];
  const queryTokCache = new Map<number, Set<string>>();
  const textTokCache = new Map<number, Set<string>>();

  const getTok = (e: Evidence): Set<string> => {
    let s = textTokCache.get(e.memory_id as unknown as number);
    if (!s) {
      s = toks(e.text);
      textTokCache.set(e.memory_id as unknown as number, s);
    }
    return s;
  };

  // 先取 score 最高的作为种子
  const first = rest.shift();
  if (first) selected.push(first);

  while (selected.length < topK && rest.length > 0) {
    let bestIdx = -1;
    let bestMmrs = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const cand = rest[i];
      const ct = getTok(cand);
      // Sim(q, d)：用候选 score 作为相关性代理（已重排）
      const simQd = cand.score;
      // Sim(d, d')：与已选集合的最大相似度
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(ct, getTok(s));
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * simQd - (1 - lambda) * maxSim;
      if (mmr > bestMmrs) {
        bestMmrs = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [picked] = rest.splice(bestIdx, 1);
    selected.push(picked);
  }

  return selected;
}

/**
 * 把 Evidence[] 打包成 LLM context window 友好的文本块（可选）
 * 每条证据带 memory_id / score / recency / strength 元信息
 */
export function packContext(evidence: Evidence[], maxChars = 2000): string {
  let out = '';
  let used = 0;
  for (const e of evidence) {
    const block = `[${e.memory_id}] (score=${e.score.toFixed(3)}, recency=${e.recency.toFixed(1)}d, strength=${e.strength.toFixed(2)}, src=${e.source_namespace})\n${e.text}\n\n`;
    if (used + block.length > maxChars) break;
    out += block;
    used += block.length;
  }
  return out;
}
