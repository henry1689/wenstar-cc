/**
 * deep-recall-stage — 深度回忆接线阶段（MEM-UNIFY-V1 批4）
 * ====================================================
 * 职责边界：
 *   · 把 `deep_sweep` 配置翻译成 `sweepAllStores` / `organizeForQuestion` 的参数；
 *   · 把**证据层**（FG 档案 / 作品 / 记事）收集成与 sweep 同构的 `SweptFragment`，
 *     使两个分支（会晤 / 普通）共用一份收集与格式约定，不在 retrieval-stage 里写第二套；
 *   · 不拼提示词：`memFragWithTime` 与 `CRYSTAL_DIRECTIVE` 仍由 retrieval-stage 单源输出。
 *
 * 隔离：证据层一律按**当前检索主体**（会晤实体 / 玉瑶）strict 收集，
 *   与批2B `buildEvidencePolicy` 的会晤语义一致（无归属证据不返回）。
 *
 * 失败语义：单关键词 / 单路异常只丢该条，warn 后继续；不阻塞召回主链。
 */

import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';
import { collectEvidenceLayer } from '../../m4/retrieval/evidence-layer.js';
import { RETRIEVABLE_WHERE_SQL } from '../../app/knowledge/SourceTypePolicy.js';
import type { SweptFragment, SweepOptions } from '../../m4/retrieval/meeting-recall.js';
import type { FamilyGraphSource } from '../../m4/retrieval/adapters/FamilyGraphAdapter.js';
import type { NoteSqlSource } from '../../m4/retrieval/adapters/NoteAdapter.js';
import type { WorkSqlSource } from '../../m4/retrieval/adapters/WorkAdapter.js';

/** 深度素材包统一抬头（两个分支共用，避免两处文案漂移） */
export const DEEP_PACKAGE_HEADER =
  '【深度回忆素材包 · MemSym】以下是全部记忆仓（砂金/黑钻/知识/对话原文/档案/作品/记事）与该话题相关的碎片——整编组织，努力还原情景：\n';

/**
 * 从配置生成 sweep 参数。
 * 知识可检索谓词传 `SourceTypePolicy.RETRIEVABLE_WHERE_SQL()`（唯一来源策略），
 * 使 `dream_behavior` 等隔离区不会混入深度素材包（D6）。
 */
export function buildSweepOptions(): SweepOptions {
  const cfg = getRetrievalFusionConfig().deep_sweep;
  const kbWhereSql = RETRIEVABLE_WHERE_SQL();
  if (!cfg) return { kbWhereSql };
  return {
    memoriesPerKw: cfg.per_kw?.memories,
    diamondPerKw: cfg.per_kw?.diamond,
    kbPerKw: cfg.per_kw?.knowledge,
    kbSharedPerKw: cfg.per_kw?.shared_knowledge,
    conversationPerKw: cfg.per_kw?.conversation,
    perFragmentChars: cfg.per_fragment_chars,
    maxChars: cfg.max_chars,
    safetyMaxFrags: cfg.safety_max_frags,
    includeSharedKnowledge: cfg.include_shared_knowledge,
    includeConversations: cfg.include_conversations,
    kbWhereSql,
  };
}

/** 整编预算（与 sweep 参数同源，避免两处读不同字段） */
export function buildSweepBudget(): { maxChars?: number; safetyMaxFrags?: number } {
  const cfg = getRetrievalFusionConfig().deep_sweep;
  return { maxChars: cfg?.max_chars, safetyMaxFrags: cfg?.safety_max_frags };
}

type DeepSqlSource = NoteSqlSource & WorkSqlSource;

/** 证据域 → 素材包来源标签（未知域直接丢弃，不猜） */
function evidenceSource(domain: string): SweptFragment['source'] | null {
  switch (domain) {
    case 'family_graph': return '档案';
    case 'work': return '作品';
    case 'note': return '记事';
    default: return null;
  }
}

/**
 * 收集证据层碎片（档案 / 作品 / 记事）。
 * @param keywords 已清洗的主题词（只取配置允许的前 N 个）
 * @param entityUuid 当前检索主体（会晤实体 / 玉瑶）；为空则不做证据收集（fail-closed）
 */
export async function collectDeepEvidenceFragments(
  keywords: string[],
  sqlite: DeepSqlSource | null | undefined,
  familyGraph: FamilyGraphSource | null | undefined,
  entityUuid: string | null | undefined,
): Promise<SweptFragment[]> {
  const cfg = getRetrievalFusionConfig().deep_sweep?.evidence;
  const uuid = String(entityUuid || '').trim();
  if (!sqlite || !uuid || !cfg || cfg.enabled === false) return [];

  const perKeyword = Math.max(1, Math.min(10, Number(cfg.per_keyword) || 3));
  const maxKeywords = Math.max(1, Math.min(5, Number(cfg.max_keywords) || 2));
  const kws = (keywords || [])
    .map(k => String(k || '').trim())
    .filter(Boolean)
    .slice(0, maxKeywords);
  if (kws.length === 0) return [];

  const out: SweptFragment[] = [];
  const seen = new Set<string>();
  for (const kw of kws) {
    try {
      const hits = await collectEvidenceLayer(
        kw,
        { sqlite, ...(familyGraph ? { familyGraph } : {}) },
        { meetingUuid: uuid, ownerMode: false, limit: perKeyword },
      );
      for (const hit of hits) {
        const source = evidenceSource(String(hit.domain || ''));
        if (!source) continue;
        const text = String(hit.text || '').replace(/\s+/g, ' ').trim();
        const key = source + ':' + text.substring(0, 18);
        if (text.length < 8 || seen.has(key)) continue;
        seen.add(key);
        out.push({ source, content: text, ...(hit.createdAt ? { createdAt: hit.createdAt } : {}) });
      }
    } catch (e) {
      console.warn('[DeepSweep] 证据层收集失败（跳过该词）:', kw, (e as Error)?.message || e);
    }
  }
  return out;
}
