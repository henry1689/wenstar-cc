// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / rerank/cross_encoder.ts
//
// Cross-encoder 精排（设计 §8.1⑥ / §8.4）。
//
// 🔴 为什么必须换成真模型：
//   旧实现是 **Jaccard 中文 bigram 词重叠**冒充 cross-encoder。它衡量的是
//   「查询和候选的字面重合度」，对「前天的事还记得吗」这种查询，字面最重合的
//   恰恰是历史上其他「你还记得吗」的问句 —— 实测召回 9 条全是问题本身，
//   没有一条是答案。cross-encoder 做的是 query-doc **成对语义打分**，
//   能区分「提问」和「回答」。
//
// 模型：`Xenova/bge-reranker-base`（ONNX 量化，~280MB，中文场景成熟）
//   —— 与主系统 `src/m4/rerank/OnnxCrossEncoderReranker.ts` 同源同模型，
//      但这里是**独立实现**而非跨子工程 import：memarch-v2 的依赖方向只允许
//      「主系统 → v2」，反向 import 会把 src/ 拖进 v2 的编译单元。
//
// 三态降级（与主系统一致）：ready → 算法 fallback → 原序返回。
//   模型加载失败**绝不阻断检索**，只是退回旧打分。
//
// 🔴 打分融合（设计 §8.4）：
//   score = wRel·rel + wRrf·(rrf/rrfMax) + wPrior·prior + wImp·importance
//   默认 0.55 / 0.20 / 0.15 / 0.10 —— rel 是主项，但 RRF 与先验仍参与，
//   避免单条召回腿的偶然高分把明显不相关的内容顶上来。
// =====================================================================

import { existsSync } from 'node:fs';
import type { Evidence } from '../types';

const MODEL_ID = 'Xenova/bge-reranker-base';
const CACHE_DIR = 'D:/tools/wenstar-cc/.cache/huggingface';
const MIRROR = 'https://hf-mirror.com/';
/**
 * 单次推理上限。
 *
 * ⚠️ 8000 → 220ms：外层 `retrieval/index.ts` 用 `withTimeout(rerank_ms=200)` 包着，
 *   超时会返回 RRF 序 —— 但**原 promise 仍在跑**，280MB 模型继续占 CPU，
 *   下一轮检索接着排队，实测把 retrieval 阶段推到 1.5~5s。
 *   这里把上限压到 220（略高于外层 200），超时立刻放弃并走算法打分，
 *   让推理真正停下来。打不赢就别拖着。
 */
const INFER_TIMEOUT_MS = 220;

/** 融合权重（设计 §8.4 默认值，全部可调） */
const W_REL = 0.55;
const W_RRF = 0.20;
const W_PRIOR = 0.15;
const W_IMP = 0.10;

// ── 算法 fallback（模型不可用时的退路，保留旧实现） ─────────────────
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
  private extractor: unknown = null;
  private status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private loading: Promise<void> | null = null;
  private warned = false;

  isModelLoaded(): boolean {
    return this.status === 'ready';
  }

  private async ensureModel(): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'failed') return;
    if (this.loading) return this.loading;

    this.status = 'loading';
    this.loading = (async () => {
      try {
        const tf = (await import('@huggingface/transformers')) as unknown as {
          pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
          env: Record<string, unknown>;
        };
        // 🔴 transformers.js v4 不读 HF_ENDPOINT 环境变量（实测），必须显式设置
        tf.env.remoteHost = MIRROR;
        if (!existsSync(CACHE_DIR)) console.log(`[CrossEncoder] 缓存目录将创建于 ${CACHE_DIR}`);
        tf.env.cacheDir = CACHE_DIR;
        // 🔴 v4 用 dtype 取代 v2/v3 的 quantized（后者类型定义已无该字段，传了不生效）。
        //   q8 → model_quantized.onnx(267MB)；不写则落 DEFAULT_DEVICE_DTYPE=fp32 → model.onnx(1060MB)，
        //   fp32 权重常驻堆外即稳态 RSS 1246MB / 峰值 2756MB 的主因之一。
        this.extractor = await tf.pipeline('text-classification', MODEL_ID, { dtype: 'q8' });
        this.status = 'ready';
        console.log(`[CrossEncoder] ${MODEL_ID} 就绪`);
      } catch (e) {
        this.status = 'failed';
        console.warn(`[CrossEncoder] 模型加载失败，退回算法打分: ${(e as Error)?.message || String(e)}`);
      }
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** 成对打分，返回 [0,1]。任何异常返回 null 交给上层走 fallback。 */
  private async scorePairs(query: string, docs: string[]): Promise<number[] | null> {
    if (!this.extractor) return null;
    const fn = this.extractor as (input: unknown, opts?: Record<string, unknown>) => Promise<
      Array<{ label: string; score: number }> | Array<Array<{ label: string; score: number }>>
    >;
    // 🔴 成对输入必须是 { text, text_pair } 对象，不能是 [a, b] 数组 ——
    //   传数组时 pipeline 会把整组当成一条文本，报 "text.replace is not a function"。
    const pairs = docs.map((d) => ({ text: query, text_pair: d.slice(0, 400) })); // 截断：reranker 输入上限 512 token

    const work = (async () => {
      const raw = await fn(pairs, { topk: 1 });
      // pipeline 对成对输入可能返回 2D 或 1D；统一成每对取正类分
      const flat = raw as Array<{ label: string; score: number } | Array<{ label: string; score: number }>>;
      return flat.map((r) => {
        const item = Array.isArray(r) ? r[0] : r;
        if (!item) return 0;
        // bge-reranker 的 label 通常是 LABEL_1（相关）/ LABEL_0（无关）
        return item.label === 'LABEL_0' ? 1 - item.score : item.score;
      });
    })();

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), INFER_TIMEOUT_MS));
    const r = await Promise.race([work, timeout]);
    return r;
  }

  async rerank(query: string, candidates: Evidence[]): Promise<Evidence[]> {
    if (candidates.length === 0) return [];

    if (this.status === 'idle') {
      // 首次调用触发加载；本次仍走 fallback，不阻塞首查
      void this.ensureModel();
    }

    const top = candidates.slice(0, 15); // 短列表：成对推理耗时随条数线性增长，15 对是延迟与质量的平衡点
    let rel: number[] | null = null;
    if (this.status === 'ready') {
      try {
        rel = await this.scorePairs(query, top.map((c) => c.text));
      } catch (e) {
        if (!this.warned) {
          console.warn('[CrossEncoder] 推理失败，本轮用算法打分:', (e as Error)?.message);
          this.warned = true;
        }
      }
    }

    if (!rel || rel.length !== top.length) {
      // fallback：Jaccard 词重叠作为 rel 代理
      const qt = toks(query);
      rel = top.map((c) => jaccard(qt, toks(c.text)));
    }

    const maxRrf = Math.max(...top.map((c) => c.score), 1e-9);
    const scored = top.map((c, i) => {
      const prior = Math.max(0, Math.min(1, c.strength ?? 0)); // M3 巩固度作为先验代理
      const imp = Math.max(0, Math.min(1, c.activation ?? 0)); // 激活度作为重要性代理
      const score = W_REL * rel![i]
        + W_RRF * (c.score / maxRrf)
        + W_PRIOR * prior
        + W_IMP * imp;
      return { ...c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    // 超出 top 的候选按原序追加（不丢候选，只是不参与精排）
    return scored.concat(candidates.slice(30));
  }

  /** 预热（服务启动时后台调用，避免首查走 fallback） */
  async warmup(): Promise<void> {
    await this.ensureModel();
  }
}

/**
 * 进程内单例。ONNX session 很重（bge-reranker-base ~280MB），
 * 多个 Retriever 实例不得各持一份；预热也必须是同一个实例，否则热了白热。
 */
let _shared: CrossEncoderReranker | null = null;

export function getSharedCrossEncoder(): CrossEncoderReranker {
  if (!_shared) _shared = new CrossEncoderReranker();
  return _shared;
}
