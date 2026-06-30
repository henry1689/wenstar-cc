/**
 * AutoRec — M-04 标签向量对齐模块
 *
 * 包装 EmbeddingProvider + VectorStore 现有规则
 * S2.2 首批 3 子模块
 */
import type { AutoRecModule, PipelineContext, VectorAlignInput, VectorAlignOutput } from '../types.js';
import { createLocalEmbedding } from '../../app/knowledge/EmbeddingProvider.js';
import { VectorStore } from '../../app/knowledge/VectorStore.js';
import { FileChunker } from '../../app/tools/FileChunker.js';
import { getQueue } from '../../hooks/queue.js';

const chunker = new FileChunker({ strategy: 'paragraph', chunkSize: 500, overlap: 50, minChunkLen: 20 });
const embedder = createLocalEmbedding();
const vectorStore = new VectorStore();

export class VectorAlignModule implements AutoRecModule<VectorAlignInput, VectorAlignOutput> {
  id = 'vector_align';
  name = '标签向量对齐';

  async execute(input: VectorAlignInput, context: PipelineContext): Promise<VectorAlignOutput> {
    const _hq = getQueue();
    const _hstart = Date.now();
    const content = input.content || '';
    if (!content) {
      _hq.push({ operation_type: 'module_vector_align', duration_ms: Date.now()-_hstart, status:'success', timestamp: new Date().toISOString() }).catch(()=>{});
      return { chunks: 0, embeddingsCount: 0 };
    }

    // 分块
    const chunkResult = chunker.chunkWithSummary({
      text: content,
      source: input.knId || 'auto_rec',
    });

    if (chunkResult.chunks.length === 0) return { chunks: 0, embeddingsCount: 0 };

    // 批量嵌入
    const texts = chunkResult.chunks.map(c => c.content);
    const embeddings = embedder.isAvailable()
      ? await embedder.embedBatch(texts).catch(() => [])
      : [];

    // 写入向量索引
    let embeddedCount = 0;
    for (let i = 0; i < chunkResult.chunks.length; i++) {
      const chunk = chunkResult.chunks[i];
      const chunkId = `${input.knId || 'auto_rec'}_${chunk.index}`;
      const embedding = embeddings[i] || [];
      if (embedding.length > 0) {
        vectorStore.upsert(chunkId, embedding);
        embeddedCount++;
      }
    }

    const result = { chunks: chunkResult.chunks.length, embeddingsCount: embeddedCount };

    _hq.push({
      operation_type: 'module_vector_align', duration_ms: Date.now() - _hstart,
      status: 'success', timestamp: new Date().toISOString(),
      payload_size: content.length,
    }).catch(() => {});

    return result;
  }
}
