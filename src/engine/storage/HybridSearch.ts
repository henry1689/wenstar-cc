/**
 * HybridSearch — 混合检索适配器
 *
 * 在 KnowledgeEngine 的 ngram 关键词检索基础上，
 * 叠加 ONNX 本地语义向量检索，实现混合召回。
 *
 * 权重：ngram 关键词 50% + 语义余弦 30% + 场景 10% + 情感 10%
 *
 * 纯本地运行，零网络依赖，无需 GPU。
 */
import { OnnxEmbeddingEngine } from './OnnxEmbedding.js';

export interface HybridSearchResult {
  id: string;
  title: string;
  content: string;
  classification?: string;
  textScore: number;
  semanticScore: number;
  compositeScore: number;
}

export class HybridSearchEngine {
  private embedder: OnnxEmbeddingEngine;
  private ready = false;

  constructor() {
    this.embedder = new OnnxEmbeddingEngine();
  }

  async init(): Promise<void> {
    await this.embedder.warmup();
    this.ready = this.embedder.getStatus() === 'ready';
    console.log(`[HybridSearch] 初始化完成 (semantic=${this.ready})`);
  }

  isReady(): boolean { return this.ready; }

  getDiagnostics(): { ready: boolean; embedderStatus: string } {
    return {
      ready: this.ready,
      embedderStatus: this.embedder.getStatus(),
    };
  }

  /**
   * 混合检索：对 weightedSearch 的结果做语义重排序
   *
   * @param keyword 搜索关键词
   * @param items weightedSearch 返回的结果列表
   * @returns 重排序后的结果
   */
  async rerank<T extends { id: string; title: string; content: string; matchScore: number }>(
    keyword: string,
    items: T[],
    topK?: number,
  ): Promise<Array<T & { semanticScore: number; compositeScore: number }>> {
    if (!this.ready || !items.length) {
      return items.slice(0, topK ?? items.length).map(item => ({
        ...item,
        semanticScore: 0,
        compositeScore: item.matchScore,
      }));
    }

    // 生成查询的语义向量
    const queryVec = await this.embedder.embed(keyword);
    if (!queryVec.vector.length) {
      return items.slice(0, topK ?? items.length).map(item => ({
        ...item, semanticScore: 0, compositeScore: item.matchScore,
      }));
    }

    // 逐条计算语义相似度并重排
    const scored = await Promise.all(
      items.slice(0, topK ?? items.length).map(async (item) => {
        const itemText = `${item.title} ${(item.content || '').substring(0, 500)}`;
        const itemVec = await this.embedder.embed(itemText);
        const semanticScore = itemVec.vector.length
          ? this.embedder.cosineSimilarity(queryVec.vector, itemVec.vector)
          : 0;

        // 加权融合：ngram 60% + 语义 30% + 情感/场景 10%
        const compositeScore = item.matchScore * 0.60
          + Math.max(0, semanticScore) * 0.30
          + item.matchScore * 0.10;

        return {
          ...item,
          semanticScore: Math.round(semanticScore * 1000) / 1000,
          compositeScore: Math.round(compositeScore * 1000) / 1000,
        };
      }),
    );

    // 按综合分降序排列
    scored.sort((a, b) => b.compositeScore - a.compositeScore);
    return scored;
  }
}
