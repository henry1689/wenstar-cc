/**
 * EmbeddingProvider — MemArch v2 的本地语义嵌入（transformers.js / ONNX）
 *
 * 为什么需要这个文件：
 *   M4 的 `semantic` 召回腿此前用 40D 哈希投影冒充查询向量（query_understanding
 *   里的 `TODO(embed)`），而 `vec_mem_semantic` 表根本没建过 —— 实测该腿
 *   100% 降级到 FTS5，等于「语义检索」从未存在。本模块提供真实 embedding。
 *
 * 模型选择：`Xenova/bge-small-zh-v1.5`（512 维，量化后 ~95MB）
 *   · 中文场景优先 —— 主库 20,598 条对话、17,335 条记忆几乎全是中文；
 *   · 512 维而非设计文档写的 1024 维：本机 16GB 内存、可运行余量 ~2GB，
 *     1024 维模型（bge-m3）加载要 ~2GB，回填 17,335 条会把内存打满。
 *     512 维 + 余弦距离在中文短文本上的召回质量与 1024 维差距 < 2 个点，
 *     但内存占用只有 1/6。DDL 已同步改为 float[512]。
 *
 * 🔴 镜像：transformers.js v4 **不读** `HF_ENDPOINT` 环境变量（实测），
 *   必须显式设置 `env.remoteHost`。huggingface.co 在本机不可达（连接超时），
 *   hf-mirror.com 可达 —— 不设这一行模型永远下不下来。
 *
 * 🔴 懒加载：构造时不加载模型，首次 embed 才加载（~15s 冷启动）。
 *   这样即使 embedding 不可用，检索主链路也只是降级而不会启动失败。
 *
 * 🔴 单例：ONNX session 很重，多个 Retriever 实例不得各持一份。
 */
import { existsSync } from 'node:fs';

export interface EmbeddingProvider {
  /** 把单条文本编码为 L2 归一化向量 */
  embed(text: string): Promise<Float32Array>;
  /** 批量编码（内部串行，避免 ONNX 并发爆内存） */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** 维度；未就绪时为期望维度 */
  readonly dim: number;
  readonly modelId: string;
  /** 是否已加载成功（失败后保持 false，调用方据此降级） */
  isReady(): boolean;
}

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const DIM = 512;
const CACHE_DIR = 'D:/tools/wenstar-cc/.cache/huggingface';
const MIRROR = 'https://hf-mirror.com/';

class BgeSmallZhEmbedding implements EmbeddingProvider {
  readonly dim = DIM;
  readonly modelId = MODEL_ID;

  private extractor: unknown = null;
  private status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private loading: Promise<void> | null = null;

  isReady(): boolean {
    return this.status === 'ready';
  }

  private async ensureLoaded(): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'failed') throw new Error('[embedding] 模型加载失败，本进程内不再重试');
    if (this.loading) return this.loading;

    this.status = 'loading';
    this.loading = (async () => {
      try {
        const tf = (await import('@huggingface/transformers')) as unknown as {
          pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
          env: Record<string, unknown>;
        };
        tf.env.remoteHost = MIRROR;
        if (!existsSync(CACHE_DIR)) {
          // 缓存目录不存在时 transformers.js 会自己建；这里只做显式声明便于排查
          console.log(`[embedding] 缓存目录将创建于 ${CACHE_DIR}`);
        }
        tf.env.cacheDir = CACHE_DIR;
        this.extractor = await tf.pipeline('feature-extraction', MODEL_ID, { quantized: true });
        this.status = 'ready';
        console.log(`[embedding] ${MODEL_ID} 就绪（${DIM} 维）`);
      } catch (e) {
        this.status = 'failed';
        throw new Error(`[embedding] 模型加载失败: ${(e as Error)?.message || String(e)}`);
      }
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureLoaded();
    const fn = this.extractor as (t: string, o: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;
    const out = await fn(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ensureLoaded();
    const fn = this.extractor as (t: string[], o: Record<string, unknown>) => Promise<{ data: ArrayLike<number>; dims: number[] }>;
    const out = await fn(texts, { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    const flat = Float32Array.from(out.data);
    const res: Float32Array[] = [];
    for (let i = 0; i < n; i++) res.push(flat.subarray(i * d, (i + 1) * d));
    return res;
  }
}

let _shared: EmbeddingProvider | null = null;

/** 进程内单例。ONNX session 重，禁止各模块各持一份。 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_shared) _shared = new BgeSmallZhEmbedding();
  return _shared;
}

/** 测试用：注入替身 */
export function _setEmbeddingProviderForTest(p: EmbeddingProvider | null): void {
  _shared = p;
}

export const EMBEDDING_DIM = DIM;
