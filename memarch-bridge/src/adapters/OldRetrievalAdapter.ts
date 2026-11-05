/**
 * OldRetrievalAdapter.ts — 旧 m4/MemoryRetriever → 新 M4 Retriever
 *
 * 【适配关系】
 *   旧：src/m4/MemoryRetriever.ts（碎片化 RAG，8 路召回但无物理命名空间隔离）
 *   新：memarch-v2/retrieval/Retriever.retrieve(rawQuery)
 *
 * 【关键修复点】
 *   1. 旧 RAG 没有强制 namespace 过滤 → 跨角色串台根因
 *   2. 新 M4 的 recall legs 已经按 namespace 索引隔离，但适配器仍要显式注入
 *   3. Evidence 形状映射：新 M4 Evidence → Port.RetrievedEvidence
 */

import type Database from 'better-sqlite3';
import { Retriever } from '../../../memarch-v2/retrieval/index.js';
import { NamespaceContext } from '../namespace/NamespaceContext.js';
import type {
  MemoryRetrievePort,
  RetrieveResult,
  RetrieveContext,
  RetrievedEvidence,
  Namespace,
} from '../core/MemoryPort.js';
import type { FeatureFlag } from '../core/FeatureFlag.js';

/**
 * 旧 MemoryRetriever 接口形状（基于 src/m4/MemoryRetriever.ts 推断）
 * 【需对齐全局快照后再落盘】
 */
export interface LegacyRetriever {
  search(query: string, opts?: { namespace?: string; topK?: number }): Promise<{
    results: Array<{ uuid: string; content: string; score: number }>;
  }>;
}

export class OldRetrievalAdapter implements MemoryRetrievePort {
  private v2Retriever: Retriever;
  private legacyRetriever: LegacyRetriever | null;

  constructor(
    db: Database.Database,
    private readonly flag: FeatureFlag,
    legacyRetriever?: LegacyRetriever
  ) {
    this.v2Retriever = new Retriever(db);
    this.legacyRetriever = legacyRetriever ?? null;
  }

  async retrieve(query: string, ctx: RetrieveContext): Promise<RetrieveResult> {
    const scope = NamespaceContext.current();
    const namespace = ctx.namespace ?? scope?.namespace;
    if (!namespace) {
      throw new Error('[retrieve] 缺少 namespace。请通过 ctx.namespace 或 NamespaceContext 传入。');
    }

    // 🔴 forcePathway 优先于灰度比例 —— 这个字段在 MemoryPort 契约里定义了很久
    //   却零实现，导致灰度 0% 时运维自检和主流程接入都拿不到 v2 结果。
    //   'B' = MemArch v2，'A' = 旧 RAG。
    //
    //   🔴 KILL SWITCH 优先级最高：紧急回滚不能被诊断通道或接入通道绕过。
    //   否则「回滚」就成了一个可以被代码绕开的口号。
    const base = this.flag.route(namespace, query.slice(0, 32));
    const killed = this.flag.snapshot().globalKillSwitch;
    const target = !killed && ctx.forcePathway
      ? (ctx.forcePathway === 'B' ? 'v2' : 'legacy')
      : base.target;

    if (target === 'v2') {
      return this.retrieveViaV2(query, namespace, ctx);
    } else if (this.legacyRetriever) {
      return this.retrieveViaLegacy(query, namespace, ctx);
    } else {
      throw new Error(`[retrieve] 路由到 legacy 但 legacyRetriever 未注入。ns=${namespace}`);
    }
  }

  private async retrieveViaV2(
    query: string,
    namespace: string,
    ctx: RetrieveContext
  ): Promise<RetrieveResult> {
    // 🔴 2026-11-04 契约对齐：namespace 现在是 M4 的**显式参数**（第二参），
    //   不再是"假设 db 已按 ns 打开视图"。各 recall leg 的 SQL 已加
    //   `AND m.namespace = @ns`，隔离边界在查询里可读。
    // 🔴 ctx.topK 必须透传：此前只在 legacy 分支用了它，v2 分支直接忽略，
    //   导致调用方传 topK: 8 也照样返回预算里的 20 条。
    const result = await this.v2Retriever.retrieve(
      query,
      namespace,
      ctx.topK != null ? { topK: ctx.topK } : undefined,
    );

    // 字段映射以 M4 `Evidence` 的真实结构为准（memory_id/text/source_namespace/
    // strength/activation/timestamp/recall_sources）。M4 没有 summary / pathway /
    // lifecycle 三列 —— 对应字段是**可选**的，此处不编造，直接省略。
    const evidence: RetrievedEvidence[] = result.evidence.map((e) => ({
      uuid: e.memory_id,
      // 用 evidence 自带的 source_namespace（真实归属），而不是请求入参 ——
      // 若哪天出现跨 ns 命中，这里会如实暴露而不是被入参掩盖。
      namespace: (e.source_namespace || namespace) as Namespace,
      rawText: e.text,
      score: e.score,
      consolidation: e.strength,
      tsUtc: e.timestamp,          // M4 timestamp(epoch ms) → 端口 tsUtc；下游据它算 recency
      recallLeg: Array.isArray(e.recall_sources) ? e.recall_sources.join(',') : undefined,
    }));

    return {
      evidence,
      metrics: {
        totalMs:
          result.metrics.phase_ms.query_understand +
          result.metrics.phase_ms.recall_total +
          result.metrics.phase_ms.rerank,
        recallLegMs: result.metrics.recall_leg_ms as Record<string, number | null>,
        degradedLegs: result.metrics.degraded_legs,
        rerankSkipped: result.metrics.rerank_skipped,
        finalCount: result.metrics.final_count,
      },
    };
  }

  private async retrieveViaLegacy(
    query: string,
    namespace: string,
    ctx: RetrieveContext
  ): Promise<RetrieveResult> {
    const t0 = Date.now();
    const raw = await this.legacyRetriever!.search(query, { namespace, topK: ctx.topK });
    return {
      evidence: raw.results.map((r) => ({
        uuid: r.uuid,
        namespace,
        rawText: r.content,
        score: r.score,
      })),
      metrics: {
        totalMs: Date.now() - t0,
        recallLegMs: {},
        degradedLegs: [],
        rerankSkipped: false,
        finalCount: raw.results.length,
      },
    };
  }
}
