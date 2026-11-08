/**
 * evidence-layer — 证据层统一收集器（FG 档案 / 作品 / 记事）
 * ============================================================
 * MEM-UNIFY-V1 批2B（任务书 §三「证据层」/ §六批2B）
 *
 * 定位：
 *   `knowledge_base` / FG dossier / `works` / notes 同属**证据层**，与经历记忆
 *   （memories / black_diamond）分开：它们是"关于某实体的事实材料"，不是"某实体经历"。
 *   本模块把三类 owned 证据收进一个入口，统一：
 *     1. owned 语义（`policyFor('private', …)` 单一判定源，会晤 strict / 户主 ownerMode）；
 *     2. 并行执行 + 行级兜底（`runAdapter` → `policeFilterHits`）；
 *     3. 去重（同 `domain:id` 只留一条）。
 *
 * 使用方：
 *   批2B 只交付收集器与 owned 隔离；深度回忆的 `sweepAllStores` 扩展按任务书属批4，
 *   届时直接调用 `collectEvidenceLayer` 即可，无需再写第二套 SQL。
 *
 * 🔴 安全边界：
 *   - 会晤态：只返回会晤实体自己的档案/作品/记事（无归属 deny）；
 *   - 户主态：白名单内实体 + 无归属（历史数据）可见，白名单外实体一律拒绝；
 *   - 空白名单 + 户主钥匙：enforce:false（全库最高权限，与会话主链语义一致）。
 */

import { runAdapter } from './adapter.js';
import type { RetrievalContext, SearchHit } from './types.js';
import type { PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';
import { policyFor } from '../../governance/police/UUIDPoliceFilter.js';
import { NoteAdapter, type NoteSqlSource } from './adapters/NoteAdapter.js';
import { WorkAdapter, type WorkSqlSource } from './adapters/WorkAdapter.js';
import { FamilyGraphAdapter, type FamilyGraphSource } from './adapters/FamilyGraphAdapter.js';

/** 证据层数据源 */
export interface EvidenceLayerDeps {
  sqlite: NoteSqlSource & WorkSqlSource;
  /** FG 只读数据源（缺省时跳过档案路） */
  familyGraph?: FamilyGraphSource;
}

/** 收集选项 */
export interface EvidenceLayerOptions {
  /** 会晤实体 UUID；有值 ⇒ strict 隔离（无归属证据一律拒绝） */
  meetingUuid?: string | null;
  /** 户主态可见实体白名单（活跃实体 / 本体） */
  visibleUuids?: readonly string[];
  /** 户主态是否放行无归属历史证据；默认 true。会晤态恒为 false */
  ownerMode?: boolean;
  /** 每路返回上限，默认 3 */
  limit?: number;
  mode?: RetrievalContext['mode'];
  nowMs?: number;
}

/** 证据层策略（导出供测试与批4复用） */
export function buildEvidencePolicy(opts: EvidenceLayerOptions = {}): PolicePolicy {
  const meeting = typeof opts.meetingUuid === 'string' ? opts.meetingUuid.trim() : '';
  if (meeting) {
    // 会晤：deny-by-default，仅会晤实体本人
    return policyFor('private', [meeting], { enforce: true });
  }
  const uuids = (opts.visibleUuids ?? []).filter(Boolean);
  if (uuids.length === 0 && opts.ownerMode !== false) {
    // 户主钥匙：无白名单 = 最高权限（与会话主链 buildPolicePolicy 同语义）
    return policyFor('private', [], { enforce: false, ownerMode: true });
  }
  return policyFor('private', uuids, { ownerMode: opts.ownerMode !== false });
}

/**
 * 收集 owned 证据（档案 / 作品 / 记事）。
 * 单路异常由 runAdapter 隔离，不影响其它路。
 */
export async function collectEvidenceLayer(
  query: string,
  deps: EvidenceLayerDeps,
  opts: EvidenceLayerOptions = {},
): Promise<SearchHit[]> {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];

  const policy = buildEvidencePolicy(opts);
  const meeting = typeof opts.meetingUuid === 'string' && opts.meetingUuid.trim();
  // WorkAdapter 内部按 ctx.entityUuids 做自有作品判定 —— 会晤给会晤实体；
  // 户主态交给 policy（enforce:false 时为空数组 ⇒ 不做额外限制）。
  const entityUuids = meeting ? [meeting.trim()] : [];

  const rctx: RetrievalContext = {
    query: q,
    policy,
    entityUuids,
    mode: opts.mode ?? 'balanced',
    limit: opts.limit ?? 3,
    nowMs: opts.nowMs ?? Date.now(),
  };

  const adapters = [
    new NoteAdapter(deps.sqlite),
    new WorkAdapter(deps.sqlite),
    ...(deps.familyGraph ? [new FamilyGraphAdapter(deps.familyGraph)] : []),
  ];

  const groups = await Promise.all(adapters.map((a) => runAdapter(a, rctx)));
  const merged = new Map<string, SearchHit>();
  for (const hit of groups.flat()) {
    const key = `${hit.domain}:${hit.id}`;
    const prev = merged.get(key);
    if (!prev || hit.score > prev.score) merged.set(key, hit);
  }
  return [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
}

/** 证据片段标签（供注入层统一格式，避免各调用点各写一套前缀） */
export function evidenceFragment(hit: SearchHit): string {
  const label = hit.domain === 'work' ? '【作品】'
    : hit.domain === 'family_graph' ? '【档案】'
    : hit.domain === 'note' ? '【记事】'
    : '【证据】';
  return label + hit.text;
}
