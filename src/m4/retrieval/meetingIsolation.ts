/**
 * meetingIsolation — 会晤 UUID 过滤咽喉（T013 R6 / 第三层记忆检索隔离）
 * ============================================================
 * ADR-013 第三层。I007 串档根因 = 某检索路径 `policy.enforce=false` 致 UUID 子句空串
 * → 五路适配器全库召回 → 他人记忆泄漏进会晤。本模块把 UUID 过滤收口为**单一强制入口**，
 * 所有会晤检索路径必须过它，deny-by-default，杜绝绕过。
 *
 * 铁律：
 *  - 无 uuid → 空白名单（不召回他人），绝不 enforce:false
 *  - 只有会晤 UUID 在白名单内（strict）
 *  - verifyMeetingHits 供调用后断言（防回归：任何 hit 泄漏非会晤实体即告警）
 */
import type { PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';

/**
 * 生成会晤检索策略（deny-by-default）。
 * @param uuid 当前会晤实体 UUID（speakerUuid）。null/空 = 无会晤实体 → 空白名单（不召回他人）。
 */
export function applyMeetingUuidFilter(uuid: string | null | undefined): PolicePolicy {
  const clean = typeof uuid === 'string' ? uuid.trim() : '';
  if (!clean) {
    // deny-by-default：无 uuid 不召回任何归属记忆（宁缺勿泄）
    return { visibleUuids: new Set<string>(), searchScope: 'strict', enforce: true };
  }
  return {
    visibleUuids: new Set([clean]),
    searchScope: 'strict',
    allowUnowned: false,
    enforce: true,
  };
}

/** 会晤命中实体 UUID（供调用方传给 applyMeetingUuidFilter）——从会议状态取当前发言者 uuid */
export function meetingSpeakerUuid(state: { speakerUuid?: string | null } | null | undefined): string | null {
  const u = state?.speakerUuid;
  return typeof u === 'string' && u.trim() ? u.trim() : null;
}

export interface LeakReport {
  leaked: string[];   // 泄漏的非会晤实体 UUID（应为空）
  ok: boolean;
}

/**
 * 调用后校验：会晤检索命中的所有归属实体必须 === 会晤 UUID（防 I007 复发）。
 * 返回泄漏清单；调用方应据此告警（结构轨压测断言 ok===true）。
 */
export function verifyMeetingHits(
  hits: Array<{ entityUuid?: string | null }>,
  meetingUuid: string | null,
): LeakReport {
  const leaked = new Set<string>();
  const meet = meetingUuid?.trim() || '';
  for (const h of hits || []) {
    const eu = typeof h?.entityUuid === 'string' ? h.entityUuid.trim() : '';
    // 无归属（空）记录：由 PolicePolicy.allowUnowned 决定，此处只报「有归属但非会晤实体」的泄漏
    if (eu && eu !== meet) leaked.add(eu);
  }
  return { leaked: [...leaked], ok: leaked.size === 0 };
}
