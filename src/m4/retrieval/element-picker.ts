/**
 * MemSym 通路 B · 要素检索器（批γ-a 基础设施）
 * ================================================
 * 蓝皮书契约（docs/blueprint/memsym-bluebook-v1.0.0.md §三）：
 * I011 结构根治（2026-11-01）：要素池 = **memsym_elements 专表**（v30，蓝皮书「要素池沙箱」本义）。
 *   原载体 knowledge_base 的 FTS 去重命中即静默 UPDATE 旧条目（不插新行）——元素内容为真实
 *   记忆文本必然撞中，导致落池申报N/插入0。专表与文档管道（去重/cabinet/隐私守卫）彻底解耦。
 *   - 主客体归属/跨实体校验（entity_uuid 硬过滤）——隐患三（"错爱"窜台）防线。
 *   - 软遗忘过滤（impression ≤ 阈值不选）——隐患五防线。
 *   - 未沉淀元素（tags 含 'pending-element'）：settled=false，fitScore ×0.5——隐患四防线。
 *   - fitScore = 40D 余弦（可选）+ 元素标签匹配 + 上下文重合——隐患二多源加权。
 *
 * 批δ 接线：主旨判定器判定为"当下对话"时调用 pickElements → PickedElement 素材包注入生成层。
 */
import { cosineSimilarity40D } from '../../m2/PerceptionVector40DCodec.js';

/** 元素标签（蓝皮书契约 allowedElementTags） */
export type ElementTag = 'preference' | 'mood' | 'style' | 'intimate_cue';

export interface ElementPickRequest {
  entityUuid: string;                 // 户口主体（跨实体硬过滤）
  currentContext: string;             // 当前会话内容（上下文重合度）
  purpose: 'enrich_empathy';          // 固定标记：元素复用通路（区别于 recall_query）
  allowedElementTags: Set<ElementTag>;
  context40d?: number[];              // 当前感知 40D（可选，提供则启用余弦分量）
  threshold?: number;                 // fitScore 阈值（默认 0.6，灰度校准）
  limit?: number;                     // 最大拾取数（默认 4）
}

export interface PickedElement {
  sourceAnchorUUID?: string;          // 来源记忆锚点（审计溯源）
  subjectUUID?: string;               // 主客体归属（指称级校验，M7 萃取时标注）
  objectUUID?: string;
  content: string;                    // 单一原子元素（非完整事件）
  fitScore: number;                   // 与当下场景适配度（0~1）
  settled: boolean;                   // 是否已沉淀（false=新鲜素材，权重减半）
  tags: ElementTag[];
}

/** 最小知识库接口（便于测试注入 mock；生产用 sqlite 适配器天然满足） */
export interface ElementStore {
  queryAll(sql: string, params: unknown[]): Array<Record<string, unknown>>;
}

/** 软遗忘阈值：impression ≤ 此值视为已软遗忘 */
export const SOFT_FORGOTTEN_THRESHOLD = 0.15;
export const MEMSYM_ELEMENT_TAG = 'memsym-element';

/** 中文 2-gram 重合度（上下文与元素内容的语义近似，零依赖） */
function contextOverlap(context: string, content: string): number {
  const ctx = (context || '').replace(/\s+/g, '');
  const cnt = (content || '').replace(/\s+/g, '');
  if (ctx.length < 2 || cnt.length < 2) return 0;
  const grams = new Set<string>();
  for (let i = 0; i < ctx.length - 1; i++) grams.add(ctx.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < cnt.length - 1; i++) if (grams.has(cnt.slice(i, i + 2))) { hit++; i++; } // 非重叠计数
  return hit / Math.max(1, Math.floor(cnt.length / 2));
}

/**
 * 通路 B 要素拾取（召回层只读沙箱）。
 * 过滤链：跨实体硬过滤 → 软遗忘过滤 → 标签白名单 → fitScore 计算与阈值 → 排序截断。
 */
export function pickElements(store: ElementStore, req: ElementPickRequest): PickedElement[] {
  const threshold = req.threshold ?? 0.6;
  const limit = req.limit ?? 4;
  const rows = (store.queryAll(
    `SELECT id, content, tags, impression, source_anchor_id
     FROM memsym_elements
     WHERE entity_uuid = ?
     ORDER BY impression DESC LIMIT 60`,
    [req.entityUuid],
  ) || []) as Array<Record<string, unknown>>;

  const out: PickedElement[] = [];
  for (const r of rows) {
    // 隐患三：跨实体硬过滤（窜台防线，deny-by-default——查询已过滤，此处双保险）
    if ((r.entity_uuid ?? req.entityUuid) !== req.entityUuid) continue;
    // 隐患五：软遗忘过滤
    const impression = Number(r.impression ?? 0.5);
    if (impression <= SOFT_FORGOTTEN_THRESHOLD) continue;

    const content = String(r.content || '').trim();
    if (!content) continue;
    const tags = String(r.tags || '').split(/[,、\s]+/).filter(Boolean) as ElementTag[];
    const tagHit = tags.some((t) => req.allowedElementTags.has(t)) ? 0.30 : 0;

    // fitScore 多源加权（隐患二：40D 盲区 → 标签+重合度兜底）
    let cosinePart = 0;
    let hasCosine = false;
    if (req.context40d && Array.isArray(req.context40d) && req.context40d.length === 40) {
      try {
        const ev = JSON.parse(String(r.emotion_vector || '[]')) as number[];
        if (Array.isArray(ev) && ev.length === 40) {
          cosinePart = 0.35 * ((cosineSimilarity40D(req.context40d as never, ev as never) + 1) / 2);
          hasCosine = true;
        }
      } catch { /* 40D 缺失/损坏 → 退化为标签+重合度，不阻塞 */ }
    }
    const overlapPart = Math.min(0.25, contextOverlap(req.currentContext, content) * 0.5);
    const base = 0.15;
    let fit = tagHit + overlapPart + cosinePart + base;
    if (!hasCosine && tagHit === 0) fit += 0.10; // 无余弦无标签命中时的重合度补偿（防全贴地）

    // 隐患四：未沉淀素材权重减半（随口一说不固化成偏好）
    const settled = !(tags as string[]).includes('pending-element');
    if (!settled) fit *= 0.5;

    if (fit >= threshold) {
      out.push({ sourceAnchorUUID: String(r.id || ''), content, fitScore: Math.min(1, fit), settled, tags });
    }
  }
  out.sort((a, b) => b.fitScore - a.fitScore);
  const picked = out.slice(0, limit);
  if (picked.length > 0) {
    console.log(`[MemSym·元素拾取] ${req.entityUuid} → ${picked.length} 条: ` +
      picked.map((p) => `${p.content.slice(0, 12)}(${p.fitScore.toFixed(2)}${p.settled ? '' : ',未沉淀'})`).join(' | '));
  }
  return picked;
}

/** 元素写入唯一入口（在线轻萃取经此落池；M7 离线萃取直写专表——同为召回/离线层，生成层禁入） */
export interface ElementWriter {
  addEntry(e: { id: string; entity_uuid: string; content: string; tags: string; source_anchor_id: string | null }): void;
}

/** 要素落池（在线入口）：写入 memsym_elements 专表（v30，与文档管道解耦） */
export function ingestElement(
  store: ElementStore, writer: ElementWriter,
  e: { entityUuid: string; content: string; tags?: ElementTag[]; pending?: boolean; sourceAnchorUUID?: string },
): boolean {
  const rowId = e.sourceAnchorUUID ? `me-${e.sourceAnchorUUID}` : `me-${Date.now()}`;
  const before = store.queryAll('SELECT id FROM memsym_elements WHERE id = ?', [rowId]);
  if (before && before.length > 0) return false;
  const tagList: string[] = [MEMSYM_ELEMENT_TAG, ...(e.tags || [])];
  if (e.pending) tagList.push('pending-element');
  writer.addEntry({
    id: rowId, entity_uuid: e.entityUuid, content: e.content,
    tags: tagList.join(','), source_anchor_id: e.sourceAnchorUUID ?? null,
  });
  console.log(`[MemSym·元素落池] ${e.entityUuid} « ${e.content.slice(0, 16)}… »${e.pending ? '（未沉淀）' : ''}`);
  return true;
}
