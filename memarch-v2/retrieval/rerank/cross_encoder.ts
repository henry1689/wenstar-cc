// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / rerank/cross_encoder.ts
// Cross-encoder 精排：
//   - TODO(ce): 生产环境接入 bge-reranker-base（ONNX Runtime Web / native）
//   - 未接入时用占位特征打分：Jaccard 词重叠 + RRF 分 + 先验
//   - 输入：RRF top-N（默认 50）
//   - 输出：重排后的 Evidence[]
// =====================================================================

import type { Evidence } from '../types';

/** 简易 token 化（与 query_understanding 对齐） */
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

export class CrossEncoderReranker {
  /** TODO(ce): 模型加载状态；false 时走 fallback */
  private modelLoaded = false;

  isModelLoaded(): boolean {
    return this.modelLoaded;
  }

  async rerank(query: string, candidates: Evidence[]): Promise<Evidence[]> {
    if (candidates.length === 0) return [];

    if (this.modelLoaded) {
      // TODO(ce): 调用真正的 cross-encoder 模型
      //   const scores = await this.model.score([query], candidates.map(c => c.text));
      //   return candidates.map((c, i) => ({ ...c, score: scores[i] })).sort(...);
      throw new Error('TODO(ce): cross-encoder model not wired');
    }

    // fallback：特征打分
    const qt = toks(query);
    const scored = candidates.map((c) => {
      const ct = toks(c.text);
      const jac = jaccard(qt, ct);
      // 综合分：RRF 分 * 0.5 + Jaccard * 0.3 + 先验 * 0.2
      const prior = 0.25 * c.strength + 0.15 * c.activation;
      const final = c.score * 0.5 + jac * 0.3 + prior * 0.2;
      return { ...c, score: final };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
