/**
 * memory-identity — 记忆身份键与写入强制字段（MEM-UNIFY-V1 批3）
 * ================================================================
 * 单一判据模块：
 *   1. `normalizeMemoryText` —— 归一文本（NFKC + 零宽清理 + 空白折叠 + trim）；
 *   2. `deriveMemoryRole` —— 角色（user / assistant / note / dialog / roleplay / knowledge_vault）；
 *      角色取代 leaf_zone 的 taxonomy 分区作为去重作用域：同角色跨 taxonomy zone 同文即重复，
 *      但 user 与 assistant 仍互不拦截（保留 2026-10-30 业主裁决：两条独立证据）。
 *   3. `buildDedupeKey` —— (belong_uuid, role, normalized_text) 统一键；
 *   4. `validateMemoryWriteFields` —— 任务书 4.2 强制字段矩阵（纯函数，可单测）。
 *
 * 🔴 本模块不依赖 SQLite / FG / 日志 —— 只做判定，写侧负责执行与健康计数。
 */

export type MemoryRole =
  | 'user'
  | 'assistant'
  | 'note'
  | 'dialog'
  | 'roleplay'
  | 'knowledge_vault';

export interface MemoryRoleInput {
  leafZone?: string | null;
  memoryType?: string | null;
  memoryKind?: string | null;
  sourceType?: string | null;
}

/** 归一文本：全半角统一、去零宽、空白折叠、trim。不做任何相似度处理。 */
export function normalizeMemoryText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 角色判定：
 *   - roleplay / knowledge_vault 优先（隔离域）；
 *   - note（记事子系统）；
 *   - leaf_zone=user|assistant 直接作为角色；
 *   - 其余 taxonomy zone（language/emotion/social/…）= dialog。
 */
export function deriveMemoryRole(input: MemoryRoleInput): MemoryRole {
  const kind = String(input.memoryKind ?? '');
  if (kind === 'roleplay') return 'roleplay';
  if (kind === 'knowledge_vault' || String(input.sourceType ?? '') === 'knowledge_vault') {
    return 'knowledge_vault';
  }
  if (String(input.memoryType ?? '') === 'note' || String(input.leafZone ?? '') === 'note_zone') {
    return 'note';
  }
  const z = String(input.leafZone ?? '');
  if (z === 'user' || z === 'assistant') return z;
  return 'dialog';
}

/** 统一去重键（不可直接用于 SQL；SQL 侧按 role 映射谓词，见 SQLiteAdapter） */
export function buildDedupeKey(
  belongEntityUuid: string | null | undefined,
  role: MemoryRole,
  text: unknown,
): string {
  return [String(belongEntityUuid ?? '').trim(), role, normalizeMemoryText(text)].join('');
}

// ─────────────────────────────────────────────────────────────
// 强制字段校验（任务书 §4.2）
// ─────────────────────────────────────────────────────────────

export interface MemoryWriteFieldInput {
  rawInput?: string;
  belongEntityUuid?: string | null;
  dnaRootId?: string | null;
  dialogGroupId?: string | null;
  threadId?: string | null;
  entityGenes?: unknown[] | null;
  memoryKind?: string | null;
  memoryType?: string | null;
  sourceType?: string | null;
  sourceConversationIds?: number[] | null;
  perceptionV40?: string | null;
  globalUid?: string | null;
}

export interface MemoryWriteFieldValidation {
  allowed: boolean;
  reason?: 'missing_belong' | 'invalid_belong_format' | 'missing_entity_genes' | 'missing_source_anchor' | 'missing_perception_40d' | 'missing_dna_root';
  /** 校验通过时的派生值（写侧采用，避免第二份实现） */
  derived?: { dnaRootId: string | null };
}

const BELONG_FORMAT = /^TXS-\d{6,}$/;

/**
 * 强制字段矩阵。
 *
 * 豁免：
 *   - `knowledge_vault`（证据文档，非语义块）—— 允许 unowned、无 genes/锚点/40D；
 *   - `note` —— 记事子系统，无 genes/40D 要求，但 belong 必须存在（D9 写侧）。
 * roleplay 只豁免 entity_genes，其余（belong/锚点/40D）不豁免。
 */
export function validateMemoryWriteFields(f: MemoryWriteFieldInput): MemoryWriteFieldValidation {
  const kind = String(f.memoryKind ?? '');
  const isEvidence = kind === 'knowledge_vault' || String(f.sourceType ?? '') === 'knowledge_vault';
  const isNote = String(f.memoryType ?? '') === 'note';
  const isRoleplay = kind === 'roleplay';

  if (!isEvidence) {
    const belong = String(f.belongEntityUuid ?? '').trim();
    if (!belong) return { allowed: false, reason: 'missing_belong' };
    // 户籍 UUID 形式校验；FG 存在性由写侧可插拔校验器负责（生产接线在 server.ts）
    if (!BELONG_FORMAT.test(belong)) return { allowed: false, reason: 'invalid_belong_format' };
  }

  const dnaRootId = String(f.dnaRootId ?? f.dialogGroupId ?? f.threadId ?? '').trim() || null;

  if (!isEvidence && !isNote) {
    if (!isRoleplay && (!Array.isArray(f.entityGenes) || f.entityGenes.length === 0)) {
      return { allowed: false, reason: 'missing_entity_genes' };
    }
    const hasAnchor =
      (Array.isArray(f.sourceConversationIds) && f.sourceConversationIds.length > 0) ||
      !!String(f.dialogGroupId ?? '').trim();
    if (!hasAnchor) return { allowed: false, reason: 'missing_source_anchor' };
    if (!f.perceptionV40) return { allowed: false, reason: 'missing_perception_40d' };
    if (!dnaRootId) return { allowed: false, reason: 'missing_dna_root' };
  }

  if (!isEvidence && !isNote && !dnaRootId) {
    return { allowed: false, reason: 'missing_dna_root' };
  }

  return { allowed: true, derived: { dnaRootId } };
}
