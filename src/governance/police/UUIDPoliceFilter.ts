/**
 * UUIDPoliceFilter — UUID 公安过滤器内核（户籍管理法 · 五道闸门唯一判定源）
 * ============================================================
 * 依据：《UUID户籍管理法 WS-HUKOU-LAW-V1.0》+ 太虚境户籍管理法 V2.1
 *
 * 职责：
 *   - SQL 子句唯一来源（收编全部 6 处复制 SQL：SQLiteAdapter._entityUuidClause、
 *     UnifiedSearchEngine×4、KnowledgeEngine、retrieval-stage）
 *   - 行级 deny-by-default（不在白名单 = 拒绝）
 *   - 文本级过滤（memoryFragments/recentConversations）
 *   - 最终闸门筛子（LLM 边界 + HTTP 响应）
 *   - 最高权限钥匙断言（跨实体调取）
 *
 * 🔴 铁律：
 *   - deny-by-default：不在白名单 = 拒绝；无归属记录仅户主钥匙可见
 *   - fail-closed：空白名单 → AND 1=0（宁拒不放）
 *   - 纯函数、无副作用、无 FG 依赖（测试友好）
 */

/** 可见性策略快照（请求开始时从 gatekeeper 拷贝，杜绝运行中白名单变动竞态） */
export interface PolicePolicy {
  /** 有效白名单（base + session + temp 合并快照） */
  visibleUuids: ReadonlySet<string>;
  /** 无归属记录（belong_entity_uuid IS NULL/''）是否可见。默认 false：
   *  仅户主钥匙场景（无会晤实体激活，仅我+玉瑶）允许。 */
  allowUnowned?: boolean;
  /** 默认 true；false 时返回全部（仅供离线巡检探针用） */
  enforce?: boolean;
}

/** 文本片段（带源 UUID 或纯文本） */
export interface TextItem {
  uuid?: string | null;
  text: string;
}

function _clampParam(uuid: string): string {
  return String(uuid ?? '').trim();
}

/** 判断单条记录的 UUID 是否放行（行级 deny-by-default） */
export function passes(uuid: string | null | undefined, p: PolicePolicy): boolean {
  if (p.enforce === false) return true;
  const u = _clampParam(uuid ?? '');
  if (!u) {
    // 无归属记录：仅户主钥匙场景（allowUnowned=true）可见
    return p.allowUnowned === true;
  }
  return p.visibleUuids.has(u);
}

/**
 * 构建 SQL 过滤子句（唯一公共来源）。
 * 空白名单 → AND 1=0（fail-closed，永不返回空 clause）。
 */
export function buildSqlClause(p: PolicePolicy): { clause: string; params: string[] } {
  if (p.enforce === false) return { clause: '', params: [] };
  const uuids = [...p.visibleUuids].filter(Boolean);
  if (uuids.length === 0) {
    // fail-closed：无白名单 → 拒绝一切
    return { clause: ' AND 1=0', params: [] };
  }
  const phs = uuids.map(() => '?').join(',');
  if (p.allowUnowned) {
    return {
      clause: ` AND (belong_entity_uuid IN (${phs}) OR belong_entity_uuid IS NULL OR belong_entity_uuid = '')`,
      params: uuids,
    };
  }
  return {
    clause: ` AND belong_entity_uuid IN (${phs})`,
    params: uuids,
  };
}

/** 行级过滤（memories/conversations/kb/bd 记录数组） */
export function filterRows<T extends { belong_entity_uuid?: string | null }>(
  rows: T[],
  p: PolicePolicy,
): T[] {
  if (!rows || rows.length === 0) return rows;
  return rows.filter(r => passes(r.belong_entity_uuid, p));
}

/** 文本级过滤（memoryFragments/recentConversations）— 按片段携带的源 UUID 判定 */
export function filterText(items: TextItem[], p: PolicePolicy): string[] {
  if (!items || items.length === 0) return [];
  return items
    .filter(item => passes(item.uuid, p))
    .map(item => item.text);
}

/**
 * 最终闸门筛子：扫描【标签】前缀文本片段并过滤。
 * 对 `【XX的记忆】/【金库记忆】/【对话·XX】/【珍藏记忆】` 等标签片段，
 * 若片段携带的实体不在白名单 → 剔除（fail-closed）。
 * 无标签的普通文本（系统指令/用户消息）不处理，保留。
 *
 * P2-A6 接线: 支持 entityNameToUuid 映射，解析【XX的记忆/对话·XX】标签中的实体名，
 *   对齐到 UUID 后按 passes() deny-by-default 过滤。没有映射时保守保留（避免误删）。
 */
export function screenContext(
  text: string,
  p: PolicePolicy,
  entityNameToUuid?: (name: string) => string | null,
): string {
  if (!text || p.enforce === false) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let filteredCount = 0;
  for (const line of lines) {
    // 只处理带实体名的标签片段（【XX的记忆】/【对话·XX】/【XX的档案】等）
    const tagMatch = line.match(/^【([^】]*?)的?(?:记忆|对话·|档案|金库|珍藏|重要记忆|知识|简介|资料)】/);
    if (tagMatch && entityNameToUuid) {
      // 解析标签中的实体名：如 "徐诗雨的记忆" → 徐诗雨；"对话·徐诗雨" → 徐诗雨
      const rawName = tagMatch[1] || '';
      const entityName = rawName.replace(/^对话·/, '').trim();
      if (entityName && entityName !== '对话') {
        const uuid = entityNameToUuid(entityName);
        if (uuid) {
          // 实体已解析到 UUID → 按白名单 deny-by-default 过滤
          if (!passes(uuid, p)) {
            filteredCount++;
            continue;  // 剔除他人实体片段
          }
        }
        // UUID 解析失败 → 保守保留
      }
      // 标签无实体名（如"重要记忆"）→ 保留
      kept.push(line);
      continue;
    }
    // 普通文本或无标签 → 保留
    kept.push(line);
  }
  if (filteredCount > 0) {
    console.log(`[UUIDPolice] screenContext 过滤 ${filteredCount} 行`);
  }
  return kept.join('\n');
}

/** 最高权限钥匙断言：跨实体调取抛错（用户在户主钥匙上下文的 UUID） */
export function assertMasterKey(
  uuid: string | null | undefined,
  p: PolicePolicy,
  masterKeyUuid?: string,
): void {
  if (p.enforce === false) return;
  const u = _clampParam(uuid ?? '');
  // 无归属 + allowUnowned（户主钥匙场景）→ 放行
  if (!u && p.allowUnowned) return;
  // 在白名单内 → 放行（会晤当前实体 / 用户自己）
  if (p.visibleUuids.has(u)) return;
  throw new Error(
    `[UUIDPolice] 最高权限钥匙校验失败: 越权访问 UUID=${u || '(unowned)'}，` +
    `白名单=${[...p.visibleUuids].join(',') || '(empty)'}`,
  );
}

// ════════════════════════════════════════════════════════════
// 写侧授权（户籍管理法 · 写入门户收口）
// ════════════════════════════════════════════════════════════

/**
 * 写策略快照 — 判定「能否写某实体档案/关系」所需的会话状态。
 * 与读侧 PolicePolicy 区分：读侧管「能看到谁的」，写侧管「能写谁」。
 */
export interface WritePolicy {
  /** 会晤实体 UUID（非会晤为 null/undefined） */
  meetingEntityUuid?: string | null;
  /** 会晤实体名（非会晤为 null/undefined） */
  meetingEntityName?: string | null;
}

/**
 * 判断能否写某实体的档案/关系（写侧软拦截——返回判定而非 throw）。
 *
 * 语义（会晤写隔离）：
 *   - 非会晤（meetingEntityName 为空）→ 一律允许（用户自己的世界，自由录入）
 *   - 会晤中 → 只允许写「会晤实体本人」或「主 FG 中尚不存在的新实体」；
 *     主 FG 已有的其他实体（会晤来源可能编造污染）→ 拒绝。
 *
 * @param targetName  待写入的目标实体名
 * @param policy      写策略（会晤状态）
 * @param fg          主 FG 查询器（用于判断 target 是否已存在于主 FG）
 * @returns { allowed, reason }——denied 时由调用方记录日志并跳过写，不阻断对话
 */
export function canWriteEntity(
  targetName: string,
  policy: WritePolicy,
  fg: { getUUIDByName(name: string): string | null },
): { allowed: boolean; reason?: string } {
  const name = (targetName ?? '').trim();
  if (!name) return { allowed: false, reason: '目标名为空' };

  // 非会晤 → 一律允许（用户自由录入）
  if (!policy?.meetingEntityName) {
    return { allowed: true };
  }

  // 会晤中：写会晤实体本人 → 允许
  if (name === policy.meetingEntityName) {
    return { allowed: true };
  }

  // 会晤中：target 不在主 FG（新实体）→ 允许
  const existingUuid = fg?.getUUIDByName?.(name) ?? null;
  if (!existingUuid) {
    return { allowed: true };
  }

  // 会晤中：主 FG 已有的其他实体 → 拒绝（防会晤编造污染）
  return {
    allowed: false,
    reason: `会晤"${policy.meetingEntityName}"中尝试写入主FG已有实体"${name}" — 已拦截`,
  };
}

/**
 * 2026-09-09 记忆碎片化修复(共性): 会晤注入边界逐段判定（整段保留，不拆行）。
 * 原 chat.ts 闸门把多段记忆 join('\n')→screenContext→split('\n')，将每段多行记忆拆成
 * ~40 字行碎片 → MemoryInjector 按 priority 只留 10 行 → LLM 只见 ~900 字无上下文碎片。
 * 本函数对每段整体判定：段首标签标识归属实体 → 非白名单实体整段剔除；白名单/无标签整段保留。
 */
export function screenMeetingSegments(
  segments: string[],
  p: PolicePolicy,
  entityNameToUuid?: (name: string) => string | null,
): string[] {
  if (!segments || segments.length === 0) return segments;
  const kept: string[] = [];
  for (const seg of segments) {
    if (!seg || !seg.trim()) continue;
    // 段首标签即段归属：首行【XX的记忆/对话·XX/…】→ 解析实体名对会晤白名单 deny-by-default，
    // 非白名单实体 → **整段剔除**（不再依赖 screenContext 行过滤——那只剔标签行、正文行全留，
    // 会让他人段以"无标签正文"残留，整段判定失效）。无标签段保守保留。
    const firstLine = (seg.split('\n', 1)[0] || '').trim();
    const tagMatch = firstLine.match(/^【([^】]*?)的?(?:记忆|对话·|档案|金库|珍藏|重要记忆|知识|简介|资料)】/);
    if (tagMatch && entityNameToUuid) {
      const rawName = (tagMatch[1] || '').replace(/^对话·/, '').trim();
      if (rawName && rawName !== '对话') {
        const uuid = entityNameToUuid(rawName);
        if (uuid) {
          if (!passes(uuid, p)) continue;  // 他人实体段整段剔除
        }
        // UUID 解析失败 → 保守保留
      }
    }
    kept.push(seg);
  }
  return kept;
}
