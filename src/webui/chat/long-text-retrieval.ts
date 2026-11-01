/**
 * long-text-retrieval — 长文直取 + 概要/详细展开（V23）
 * ============================================================
 * 用户与角色聊天产生几百到几千字长文（角色写的纪实/小说）。
 * 当前检索注入时每条被两层截断（检索层200/800字 + MemoryInjector 250字），
 * LLM 只能复述开头，复述不了中部/结尾。
 *
 * 本模块：
 *   - detectDetailLevel: 按消息意图判断"概要/详细"
 *   - fetchLongText:     命中长文候选时直接 SQL 拉全文（绕过截断管线，不过滤 is_compacted）
 *   - buildLongTextFragment: 按级别构造注入片段（分段全文 / 摘要）+ 铁律标记
 */

/** 注入级别：一字不漏(full) > 详细(detail) > 简要(auto/summary) */
export type DetailLevel = 'detail' | 'summary' | 'auto' | 'full';

/** 长文阈值（>800字视为长文，需完整返回） */
export const LONG_TEXT_THRESHOLD = 800;

/** 分段大小（每段 ~1500 字，2-3 段覆盖全文） */
export const LONG_TEXT_CHUNK = 1500;

/** 摘要模式：首段 + 中段 + 尾段各取窗口 */
const SUMMARY_WINDOW = 200;

/**
 * 🔴 S2-R7: 检测消息的"详细程度"意图 — 从自然口语映射到还原度级别。
 * 用户日常不说"简要/详细/一字不漏/30%"，而是说"你说说/你仔细说说/再详细一点"等口语。
 * 系统根据提问语义推断还原度:
 * - full(100%):   越细越好/一字不漏/全部/从头到尾/再详细点/说全/每个细节
 * - detail(60%):  仔细说说/详细说说/展开/具体点/说细点/好好讲讲
 * - summary(30%): 说说/讲讲/简单说说/大概/概述/提一下
 * - auto:         普通问题，不确定意图
 */
export function detectDetailLevel(message: string): DetailLevel {
  const msg = (message || '').trim();
  if (msg.length < 2) return 'auto';

  // 🔴 S2-S1: 自我介绍/你是谁 → full（100% 完整档案 + 铁律，杜绝自我介绍时编造细节填充）
  if (/介绍一下|你是谁|自我介绍|你叫什么|说说你自己|讲讲自己|介绍自己|我是个什么样/.test(msg)) return 'full';
  // 🔴 最高还原（100%）：明确要极细/完整
  if (/越细越好|一字不漏|全部|从头到尾|逐字|原原本本|一字不差|念一遍|背一遍|复述|通篇|整篇|原文|再详细|再具体|说全|每个细节|完整/.test(msg)) return 'full';
  // 高还原（60%）：仔细/详细/展开
  if (/仔细|详细|展开|具体|细讲|讲清楚|好好说说|好好讲讲|每一段|每一句|全过程|详情|说细点/.test(msg)) return 'detail';
  // 中还原（30%）：说说/讲讲/简单/大概
  if (/概要|总结|简单|概括|简述|大概|概述|一句话|梗概|说说|讲讲|提一下|简单说/.test(msg)) return 'summary';
  return 'auto';
}

/**
 * 🔴 S2-R7: 从消息语义推断还原度百分比（0-100），供 sliceByPercent 使用。
 * 系统体会用户提问意图 → 推断还原度，而非用户直接说百分比。
 * 若消息明确说"30%/六成/一半"等，尊重显式数字；否则从口语程度推断。
 * @returns 还原度 0-100；无意图返回 null
 */
export function inferDetailPercent(message: string): number | null {
  const msg = (message || '').trim();
  if (msg.length < 2) return null;

  // 显式数字 + %（如 30%、60%、100%）— 用户明确指定
  const pctMatch = msg.match(/(\d{1,3})\s*%/);
  if (pctMatch) return Math.max(0, Math.min(100, parseInt(pctMatch[1], 10)));
  // 成数（六成/三成/十成）
  const cheng = msg.match(/([一二三四五六七八九十]+)成/);
  if (cheng) {
    const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const s = cheng[1];
    let n = cn[s] ?? 0;
    if (s.length === 2) n = (cn[s[0]] ?? 0) * 10 + (cn[s[1]] ?? 0);
    return Math.max(0, Math.min(100, n * 10));
  }

  // 从口语程度推断
  const level = detectDetailLevel(msg);
  if (level === 'full') return 100;
  if (level === 'detail') return 60;
  if (level === 'summary') return 30;
  return null;
}

/**
 * 直取对话全文（绕过 is_compacted 归档过滤）。
 * 🔴 S4-评审修复: 归属校验下沉到取数层 — SQL 带 belong_entity_uuid 白名单过滤，
 * 与 UUIDPoliceFilter.passes 语义一致（deny-by-default），杜绝 id 碰撞误取他人对话。
 * @param sqlite SQLiteAdapter（有 queryAll）
 * @param id     conversations.id
 * @param allowedUuids 允许的 belong_entity_uuid 白名单（空 = 不限定，户主最高权限）
 * @returns 全文 content（找不到或越权返回 null）
 */
export function fetchLongText(
  sqlite: any,
  id: string | number,
  allowedUuids?: string[],
): string | null {
  try {
    if (!sqlite || typeof sqlite.queryAll !== 'function') return null;
    let sql = 'SELECT content, belong_entity_uuid FROM conversations WHERE id = ?';
    const params: any[] = [String(id)];
    if (allowedUuids && allowedUuids.length > 0) {
      const marks = allowedUuids.map(() => '?').join(',');
      sql += ` AND belong_entity_uuid IN (${marks})`;
      params.push(...allowedUuids);
    }
    sql += ' LIMIT 1';
    const rows = sqlite.queryAll(sql, params) as any[];
    if (rows && rows.length > 0 && rows[0]?.content) {
      const text = String(rows[0].content);
      return text.length > LONG_TEXT_THRESHOLD ? text : null;  // 仅长文走直取
    }
  } catch { /* 直取失败返回 null，回落截断路径 */ }
  return null;
}

/**
 * 构造长文注入片段。
 * @param content 长文全文
 * @param level   注入级别
 * @returns 注入片段（带铁律标记）
 */
export function buildLongTextFragment(content: string, level: DetailLevel): string {
  const text = (content || '').trim();
  if (text.length <= LONG_TEXT_THRESHOLD) {
    return '【对话原文·权威记录】' + text +
      '\n（以上为当时对话原文——【记得】档权威记录。可自然口语化复述，但原文没有的人物/情节/时间不得新增提及。）';
  }

  let body: string;
  if (level === 'detail') {
    body = _chunkFull(text);
  } else if (level === 'full') {
    // 🔴 S2-R5: 一字不漏 → 原文直引
    body = text;
  } else {
    // summary / auto → 分段摘要（首+中+尾）
    body = _summaryOf(text);
  }

  // 铁律标记：过去发生的事绝对不得编造——以原文为唯一事实来源
  // 即使记忆/知识库/之前对话里提过其他人物或情节，只要原文没有，就不得提及（无中生有即违规）。
  return '【对话原文·权威记录】' + body +
    '\n\n🔴 铁律（关于过去的记忆，绝对不得违反）：\n' +
    '1. 以上是检索到的这篇纪实的真实原文记录，是你回答的唯一事实来源。\n' +
    '2. 原文中没有出现的人物、情节、数据、章节，一律不得提及或编造——即使你的记忆、知识库或之前对话里提过，也不得使用（那是当时没有发生的）。\n' +
    '3. 如果用户问到原文中没有的内容，如实回答"当时记录的原文里没有这部分"。\n' +
    '4. 严格按原文顺序和内容复述，不得增删改。';
}

/**
 * 🔴 S2-R6: 检测消息中的"还原度百分比"意图。
 * 用户要求还原对话/档案到指定比例（如"30%还原""还原六成""只要一半""100%完整"）。
 * 返回还原度百分比 0-100；未识别返回 null。
 * 识别: 数字+%(30%/100%)、成数(六成/三成/十成)、一半/半数、全部/完整(100%)、一点点/大概(低还原)。
 */
export function detectDetailPercent(message: string): number | null {
  const msg = (message || '').trim();
  if (msg.length < 2) return null;

  // 数字 + %（如 30%、60%、100%）
  const pctMatch = msg.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    return Math.max(0, Math.min(100, parseInt(pctMatch[1], 10)));
  }
  // 成数（六成/三成/十成/八成）
  const cheng = msg.match(/([一二三四五六七八九十]+)成/);
  if (cheng) {
    const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const s = cheng[1];
    let n = cn[s] ?? 0;
    if (s.length === 2) n = (cn[s[0]] ?? 0) * 10 + (cn[s[1]] ?? 0);
    return Math.max(0, Math.min(100, n * 10));
  }
  // 一半/半数/半个/五成 → 50%
  if (/一半|半数|半个|五成/.test(msg)) return 50;
  // 全部/完整/从头到尾/一字不漏/全文/整篇 → 100%
  if (/全部|完整|从头到尾|一字不漏|全文|整篇/.test(msg)) return 100;
  // 一点点/大概/粗略/梗概/概述/简要 → 30%
  if (/一点点|大概|粗略|梗概|概述|简要/.test(msg)) return 30;
  return null;
}

/**
 * 🔴 S2-R6: 按还原度百分比截取长文本。
 * 均匀采样：从头到尾按比例取，保证头/中/尾覆盖，而非只取开头。
 * 🔴 个人世界隐私法: 内容为个人世界真实记录(共同过去)，不因现实伦常过滤内容——
 * 只按百分比截取，保留原文真实性。
 * @param text   全文
 * @param percent 还原度 0-100
 * @returns 截取后的文本（含【已按XX%还原】标记）
 */
export function sliceByPercent(text: string, percent: number): string {
  const t = (text || '').trim();
  if (!t) return '';
  const p = Math.max(0, Math.min(100, percent));
  if (p >= 100) return t;
  if (p <= 0) return '';

  const total = t.length;
  const target = Math.floor(total * p / 100);
  // 均匀取点覆盖全文（头/中/尾），避免只取开头丢结尾
  const pieces: string[] = [];
  const segCount = Math.max(1, Math.ceil(p / 30));  // 每30%至少1段，保证头中尾
  const segLen = Math.max(1, Math.floor(target / segCount));
  for (let i = 0; i < segCount; i++) {
    const start = Math.floor(i * total / segCount);
    const piece = t.substring(start, Math.min(total, start + segLen));
    if (piece) pieces.push((i > 0 ? '\n…（接上）\n' : '') + piece);
  }
  return pieces.join('') + `\n（已按 ${p}% 还原度截取，原文共 ${total} 字，内容为个人世界真实记录）`;
}

/**
 * 🔴 S2-R5: 构造知识库档案注入片段（按级别：full=原文直引 / detail=分段全文 / auto|summary=摘要）。
 * 复用内部 _chunkFull/_summaryOf。MemoryInjector 按前缀【知识库档案】路由独立预算。
 */
export function buildKnowledgeArchiveFragment(
  title: string,
  content: string,
  level: DetailLevel,
): string {
  const text = (content || '').trim();
  const isFull = level === 'full';
  let body: string;
  if (isFull) body = text;
  else if (level === 'detail') body = _chunkFull(text);
  else body = _summaryOf(text);

  const header = isFull ? '【知识库档案·权威记录】' : '【知识库档案】';
  const iron = isFull
    ? '\n\n🔴 铁律（知识库档案·权威记录，绝对不得违反）：\n' +
      '1. 以上是该档案的完整原文，是你回答"过去事件/人物经历"的唯一事实来源。\n' +
      '2. 原文中没有的经历、人物、时间、地点、情节，一律不得提及或编造。\n' +
      '3. 严格按原文顺序和内容复述，不得增删改、不得润色虚构。'
    : level === 'detail'
      ? '\n\n（以上为档案分段原文。按原文顺序组织你的回答，原文没有的内容不得编造。）'
      : '\n（以上为档案简要摘要。用自己的话概括，不得编造原文没有的内容。）';
  return header + (title ? '《' + title + '》\n' : '') + body + iron;
}

/** 分段全文（每段 ~1500 字，覆盖全文） */
function _chunkFull(text: string): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += LONG_TEXT_CHUNK) {
    parts.push(text.substring(i, i + LONG_TEXT_CHUNK));
  }
  return parts.join('\n…（接上）\n');
}

/** 分段摘要（首段 + 中段 + 尾段，覆盖梗概） */
function _summaryOf(text: string): string {
  const total = text.length;
  const head = text.substring(0, SUMMARY_WINDOW);
  const mid = text.substring(Math.floor(total / 2) - SUMMARY_WINDOW / 2, Math.floor(total / 2) + SUMMARY_WINDOW / 2);
  const tail = text.substring(Math.max(0, total - SUMMARY_WINDOW));
  const parts: string[] = [];
  if (head) parts.push('【开头】' + head);
  if (mid && mid !== head) parts.push('【中段】' + mid);
  if (tail && tail !== head && tail !== mid) parts.push('【结尾】' + tail);
  return parts.join('\n');
}