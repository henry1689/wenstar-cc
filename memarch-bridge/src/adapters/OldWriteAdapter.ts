/**
 * OldWriteAdapter.ts — 旧 m2/ 在线写入 → 新 M2 MemoryWriter
 *
 * 【适配关系】
 *   旧：src/m2/MemoryWriteGateway.ts / DualHelixWriter / ConversationDB
 *   新：memarch-v2/online_write/MemoryWriter.write(WriteMessageInput)
 *
 * 【关键点】
 *   1. 自动从 NamespaceContext 取 namespace（杜绝漏传串台）
 *   2. 旧接口字段 → 新 WriteMessageInput 的字段映射
 *   3. WriteResult 反序列化回旧系统期望的形状
 *   4. 同时保留旧实现的引用，FeatureFlag 决定走哪条
 */

import type Database from 'better-sqlite3';
import { MemoryWriter } from '../../../memarch-v2/online_write/index.js';
import { NamespaceContext } from '../namespace/NamespaceContext.js';
import type {
  MemoryWritePort,
  MemoryEntry,
  WritePortResult,
} from '../core/MemoryPort.js';
import type { FeatureFlag } from '../core/FeatureFlag.js';

/**
 * 旧 m2 的写入接口形状（基于 src/m2/MemoryWriteGateway.ts 推断）
 * 【需对齐全局快照后再落盘】：此处签名为假设，对齐后调整
 */
export interface LegacyWriteGateway {
  write(opts: {
    messageId: string;
    role: string;
    content: string;
    tsUtc?: number;
    namespace?: string;
    roleplayChar?: string;
  }): Promise<unknown>;
  recover?(): Promise<unknown>;
}

export class OldWriteAdapter implements MemoryWritePort {
  private v2Writer: MemoryWriter;
  private legacyGateway: LegacyWriteGateway | null;

  constructor(
    db: Database.Database,
    private readonly flag: FeatureFlag,
    legacyGateway?: LegacyWriteGateway
  ) {
    this.v2Writer = new MemoryWriter(db);
    this.legacyGateway = legacyGateway ?? null;
  }

  async write(entry: MemoryEntry): Promise<WritePortResult> {
    // 1. 从上下文取 namespace（调用方没传就强制取上下文的）
    const ctx = NamespaceContext.require();
    const namespace = entry.namespace ?? ctx.namespace;
    if (!namespace) {
      throw new Error('[write] namespace 既未在 entry 传入，也不在上下文中');
    }

    // 2. FeatureFlag 决策走新还是旧
    const decision = this.flag.route(namespace, entry.messageId);

    if (decision.target === 'v2') {
      return this.writeViaV2(entry, namespace);
    } else if (this.legacyGateway) {
      return this.writeViaLegacy(entry, namespace);
    } else {
      throw new Error(`[write] 路由到 legacy 但 legacyGateway 未注入。ns=${namespace}`);
    }
  }

  // ============================================================
  // 新 M2 路径
  // ============================================================

  private async writeViaV2(entry: MemoryEntry, namespace: string): Promise<WritePortResult> {
    const t0 = Date.now();
    // 🔴 契约对齐：MemoryEntry（端口契约）没有 arousal/valence/semanticEmbedding
    //   顶层字段，只有 `metadata?: Record<string, unknown>` 扩展口；
    //   而 M2 的 WriteMessageInput 需要这三个。因此**从 metadata 取并做类型守卫**，
    //   取不到就不传（而不是 cast 一个不存在的属性）。
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const asNumArr = (v: unknown): number[] | undefined =>
      (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : undefined);

    const result = await this.v2Writer.write({
      message_id: entry.messageId,
      namespace,
      role: entry.role,
      content: entry.content,
      ts_utc: entry.tsUtc,
      arousal: asNum(meta.arousal),
      valence: asNum(meta.valence),
      semantic_embedding: asNumArr(meta.semanticEmbedding),
      roleplay_char: entry.roleplayChar,
      sensitivity: entry.sensitivity ?? 0,
    });

    return {
      conversationId: result.conversation_id,
      gate: result.gate,
      salience: result.salience,
      episodeId: result.episode_id,
      traceId: result.trace_id,
      latencyMs: Date.now() - t0,
    };
  }

  // ============================================================
  // 旧 m2 路径（保留旧代码不删）
  // ============================================================

  private async writeViaLegacy(entry: MemoryEntry, namespace: string): Promise<WritePortResult> {
    const t0 = Date.now();
    const raw = await this.legacyGateway!.write({
      messageId: entry.messageId,
      role: entry.role,
      content: entry.content,
      tsUtc: entry.tsUtc,
      namespace,
      roleplayChar: entry.roleplayChar,
    });
    // 旧结果形状适配回 Port 视图
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      conversationId: (r.conversation_id as number) ?? 0,
      gate: (r.gate as WritePortResult['gate']) ?? 'WRITE',
      salience: (r.salience as number) ?? 0.5,
      episodeId: r.episode_id as string | undefined,
      traceId: r.trace_id as string | undefined,
      latencyMs: Date.now() - t0,
    };
  }

  async writeBatch(entries: MemoryEntry[]): Promise<WritePortResult[]> {
    const results: WritePortResult[] = [];
    for (const e of entries) results.push(await this.write(e));
    return results;
  }

  async recover(): Promise<{ recovered: number; failed: number }> {
    return this.v2Writer.recover();
  }

  getGateStats(): { write: number; rawOnly: number; discard: number; total: number } {
    return this.v2Writer.getGateStats();
  }
}
