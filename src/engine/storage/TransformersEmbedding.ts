/**
 * TransformersEmbedding — 基于 transformers.js 的本地嵌入引擎
 *
 * 使用量化版 bge-small-zh-v1.5 模型（~20MB），纯前端运行。
 * 首次使用时自动下载模型，后续缓存到 IndexedDB。
 *
 * 替代 MockEmbeddingEngine，接入后情感检索从纯关键词升级为语义检索。
 */
import type { IEmbeddingEngine, EmbeddingResult, EmbeddingStatus } from './EmbeddingEngine.js';

// @huggingface/transformers 动态导入
let pipeline: any = null;

export class TransformersEmbeddingEngine implements IEmbeddingEngine {
  private status: EmbeddingStatus = 'uninitialized';
  private extractor: any = null;
  private modelId = 'Xenova/all-MiniLM-L6-v2'; // 轻量量化模型，~23MB

  async warmup(): Promise<void> {
    if (this.status === 'ready' || this.status === 'loading') return;
    this.status = 'loading';
    console.log('[Embedding] 开始加载嵌入模型...');
    try {
      const { pipeline } = await import('@huggingface/transformers');
      this.extractor = await pipeline('feature-extraction', this.modelId, {
        quantized: true,
      } as any);
      this.status = 'ready';
      console.log('[Embedding] 模型加载完成');
    } catch (err) {
      this.status = 'failed';
      console.error('[Embedding] 模型加载失败:', err);
    }
  }

  getStatus(): EmbeddingStatus { return this.status; }

  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.extractor) await this.warmup();
    if (!this.extractor) {
      return { vector: [], dimension: 0, modelId: 'failed' };
    }
    const result = await this.extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(result.data) as number[];
    return { vector: vec, dimension: vec.length, modelId: this.modelId };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }
}
