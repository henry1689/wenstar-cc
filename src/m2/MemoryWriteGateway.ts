/**
 * MemoryWriteGateway — memory 写入统一门户（V12.6）
 * ==========================================================
 * 职责：
 *   1. 统一所有 memory INSERT 路径（替代分散的 writeRaw + 补齐缺失列）
 *   2. 五要素值守卫：entity_genes 为空时拒绝写入（非 roleplay）
 *   3. 自动派生 fgEntityNames（从 entityGenes 同源）
 *
 * 背景：
 *   - persistence-stage.ts 已使用 SQLiteAdapter.writeMemory()，但缺少值守卫
 *   - dialog-group-stage.ts 直接使用 sql.writeRaw("INSERT...") 绕过 writeMemory，
 *     列清单不全（缺 entity_genes / fg_entity_names / global_uid 等身份关键列）
 *   - 本 Gateway 在调用 writeMemory 前加值守卫，并统一 dialog-group-stage 的写入路径
 *
 * 守卫生效规则：
 *   - entityGenes 为空（且 memoryKind !== 'roleplay'）→ 返回 false，记录警告
 *   - roleplay 豁免（对话扮演记忆设计上不建基因）→ 允许空 genes
 *   - fgEntityNames 由 Gateway 从 entityGenes 同源派生，调用方无需手动传
 */

import type { SQLiteAdapter } from './SQLiteAdapter.js';
import { isMetaDiscourse } from '../config/ingestion-guard.js';

export interface MemoryWriteOpts {
  id: string;
  seqPos: number;
  createdAt: string;
  perceptionJson?: string | null;
  perceptionV40?: string | null;
  calciumScore: number;
  calciumLevel: number;
  locusPath: string;
  leafZone: string;
  rawInput: string;
  primaryEmotion: string;
  memoryType?: string;
  memoryKind?: string;
  lifecycleState?: string;
  confidenceScore?: number;
  stabilityScore?: number;
  threadId?: string | null;
  sessionId?: string | null;
  sourceConversationIds?: number[] | null;
  dialogGroupId?: string | null;
  topicLabel?: string | null;
  dnaRootId?: string | null;
  entityGenes?: any[] | null;
  globalUid?: string | null;        // V13: 全局唯一 ID（从 dna.global_uid 透传）
  locationFingerprint?: string | null;
  belongEntityUuid?: string | null;
  isForesight?: boolean;
  validUntilMs?: number | null;
  foresightStatus?: string | null;
  namespace?: string | null;
  timePeriod?: string | null;
  season?: string | null;
  lunarTerm?: string | null;
  anchorScore?: number | null;
  scarType?: string | null;
  subType?: string | null;
}

export class MemoryWriteGateway {
  constructor(private sqlite: SQLiteAdapter) {}

  /**
   * 写入一条记忆（含五要素值守卫）
   * @returns true = 写入成功；false = 被守卫拒绝或写入失败
   */
  write(opts: MemoryWriteOpts): boolean {
    // 🔴 2026-09-16 数据卫生: 元对话/自我陈述不写入记忆（对话落库统一收口）
    //    本 Gateway 是对话类 memory 写入的统一门户 —— dialog-group-stage（闭组锚点/碎片）
    //    与 persistence-stage（逐轮写入）两条路径均经此处。在源头拦截后，
    //    砂金→金库→黑钻→地标 整条升级链自然断开，也覆盖未来新增调用方。
    if (isMetaDiscourse(opts.rawInput)) {
      console.log(`[MemoryWriteGateway] 🚫 元对话拦截: 命中 metaDiscourse 规则，拒绝写入 id=${opts.id} dg=${opts.dialogGroupId ?? 'none'}`);
      return false;
    }

    // 五要素守卫生效：entity_genes 为空时拒绝（roleplay 豁免）
    const isRoleplay = opts.memoryKind === 'roleplay';
    if (!isRoleplay && (!opts.entityGenes || opts.entityGenes.length === 0)) {
      console.warn(
        `[MemoryWriteGateway] 🚫 拒绝写入：entity_genes 为空（五要素守护）id=${opts.id} zone=${opts.leafZone} dg=${opts.dialogGroupId ?? 'none'}`
      );
      return false;
    }

    // 自动派生 fgEntityNames（从 entityGenes 同源，过滤 self）
    const fgEntityNames = opts.entityGenes
      ? opts.entityGenes
          .filter((g: any) => g && g.type !== 'self' && g.name)
          .map((g: any) => String(g.name))
          .join(',') || null
      : null;

    return this.sqlite.writeMemory({
      ...opts,
      fgEntityNames,
      memoryType: opts.memoryType ?? 'dialog',
      globalUid: opts.globalUid ?? undefined,
      locationFingerprint: opts.locationFingerprint ?? undefined,
    });
  }
}

/** 工厂函数：从 ctx.storage 快速获取 Gateway 实例 */
export function createMemoryWriteGateway(ctx: { storage: { getSQLite: () => SQLiteAdapter } }): MemoryWriteGateway {
  return new MemoryWriteGateway(ctx.storage.getSQLite());
}
