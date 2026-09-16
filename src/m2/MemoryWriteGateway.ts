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
    // 🔴 守卫检查（复用 checkWriteGuard）
    const guard = checkWriteGuard({
      rawInput: opts.rawInput,
      entityGenes: opts.entityGenes,
      memoryKind: opts.memoryKind,
      id: opts.id,
      leafZone: opts.leafZone,
      dialogGroupId: opts.dialogGroupId,
    });
    if (!guard.allowed) {
      console.warn(`[MemoryWriteGateway] 🚫 ${guard.reason}`);
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

// ── 守卫逻辑导出（供 FusionStorageAdapter 等外部路径复用） ──

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 五要素守卫生效检查
 * @returns allowed=true 放行；allowed=false 拒绝 + reason 说明
 */
export function checkWriteGuard(opts: {
  rawInput: string;
  entityGenes?: any[] | null;
  memoryKind?: string;
  id?: string;
  leafZone?: string;
  dialogGroupId?: string | null;
}): GuardResult {
  // 🔴 元对话拦截
  if (isMetaDiscourse(opts.rawInput)) {
    return { allowed: false, reason: `元对话拦截: id=${opts.id ?? 'unknown'}` };
  }
  // 🔴 五要素守护：entity_genes 为空时拒绝（roleplay 豁免）
  const isRoleplay = opts.memoryKind === 'roleplay';
  if (!isRoleplay && (!opts.entityGenes || opts.entityGenes.length === 0)) {
    return { allowed: false, reason: `entity_genes 为空（五要素守护）id=${opts.id ?? 'unknown'} zone=${opts.leafZone ?? 'unknown'}` };
  }
  return { allowed: true };
}
