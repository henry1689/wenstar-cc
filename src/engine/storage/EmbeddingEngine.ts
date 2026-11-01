/**
 * EmbeddingEngine — 本地向量嵌入引擎
 *
 * 在 KnowledgeEngine 的 ngram 关键词检索基础上，
 * 叠加本地语义向量检索，实现混合召回。
 *
 * 混合召回权重（可配置）：
 *   ngram 关键词分 60% + 语义余弦相似度 40%
 *
 * S3 接入 transformers.js（量化版 bge-small-zh-v1.5，~20MB）
 * 纯前端运行，无需后端服务。
 */
import type { EmotionState24 } from '../bus/types.js';

// ── 嵌入模型状态 ──
export type EmbeddingStatus = 'uninitialized' | 'loading' | 'ready' | 'failed';

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  modelId: string;
}

// ── 嵌入引擎接口 ──
export interface IEmbeddingEngine {
  /** 获取当前状态 */
  getStatus(): EmbeddingStatus;

  /** 预热模型（S1 预埋钩子，空闲时调用） */
  warmup(): Promise<void>;

  /** 生成单条文本的向量嵌入 */
  embed(text: string): Promise<EmbeddingResult>;

  /** 批量生成向量嵌入 */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

  /** 计算两个向量的余弦相似度 */
  cosineSimilarity(a: number[], b: number[]): number;
}

// ── Mock 实现（用于 S3 验证，接入 transformers.js 后替换） ──
export class MockEmbeddingEngine implements IEmbeddingEngine {
  private status: EmbeddingStatus = 'uninitialized';

  getStatus(): EmbeddingStatus { return this.status; }

  async warmup(): Promise<void> {
    this.status = 'loading';
    // 模拟加载耗时
    await new Promise(r => setTimeout(r, 100));
    this.status = 'ready';
    console.log('[Embedding] Mock 引擎已预热');
  }

  async embed(text: string): Promise<EmbeddingResult> {
    // Mock: 返回基于文本内容的确定性伪向量
    // 实际接入 transformers.js 后替换为真实嵌入
    const vec = this.mockVector(text);
    return { vector: vec, dimension: vec.length, modelId: 'mock' };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  /** 确定性伪向量（基于文本哈希） */
  private mockVector(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    // 生成 24 维伪向量（与 24D 情感向量同维度，便于混合）
    const vec = [];
    const seed = Math.abs(hash);
    for (let i = 0; i < 24; i++) {
      vec.push(((seed * (i + 1) * 9301 + 49297) % 233280) / 233280);
    }
    return vec;
  }
}

// ── 混合检索结果 ──
export interface HybridSearchResult {
  id: string;
  title: string;
  content: string;
  /** ngram 文本匹配分 0-1 */
  textScore: number;
  /** 语义向量相似度 0-1 */
  semanticScore: number;
  /** 加权综合分 */
  compositeScore: number;
  source: 'keyword' | 'semantic' | 'both';
}

// ── 混合检索 ──
export function computeHybridScore(
  textScore: number,
  semanticScore: number,
  weights?: { keyword: number; semantic: number },
): number {
  const w = weights ?? { keyword: 0.6, semantic: 0.4 };
  return textScore * w.keyword + semanticScore * w.semantic;
}

/** 判断两个文本是否语义相关（当嵌入引擎可用时使用） */
export async function semanticRelevant(
  query: string,
  target: string,
  engine: IEmbeddingEngine,
  threshold?: number,
): Promise<boolean> {
  if (engine.getStatus() !== 'ready') {
    // 嵌入引擎未就绪时，fallback 到关键词匹配
    return target.includes(query);
  }
  const qVec = await engine.embed(query);
  const tVec = await engine.embed(target);
  const sim = engine.cosineSimilarity(qVec.vector, tVec.vector);
  return sim > (threshold ?? 0.35);
}
