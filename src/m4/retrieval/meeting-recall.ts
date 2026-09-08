/**
 * meeting-recall — 会晤实体记忆召回共享工具
 * ==========================================
 * 修复两大缺陷（2026-09-09 会晤失忆实锤：徐诗雨 6:05《蒹葭》引诗记忆 calcium 0.70
 * 排当天 55/257，被 4:45-5:14 高钙 ANCHOR(1.6-2.05) 挤出近期槽 TOP8 → 17:03 续聊接不上）：
 *   1. 纯钙化分排序 ≠ 用户关心的内容 → 增加"消息关键词内容相关召回"，钙化分只作保底；
 *   2. 压缩标记(is_compacted=1)隔离对话原文 → 新增"压缩原文取回"（原文永久留存原则，
 *      压缩仅是内存窗口标记，原始对话只增不删，召回侧永远可原文直取）。
 *
 * retrieval-stage 会晤隔离墙与 MeetingWallAdapter 共用本模块，杜绝同构漂移。
 * 本模块零 import（仅依赖调用方传入的 queryAll 兼容源），不引入 M 层反向依赖。
 */

/** 最小 sqlite 查询源（SQLiteAdapter.queryAll 兼容形状: 返回行数组） */
export interface RecallSource {
  queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** memories 行召回最小形状 */
export interface RecallMemoryRow {
  id: string;
  raw_input: string;
  calcium_score: number;
  effective_strength: number;
  created_at?: string | null;
  perception_40d?: string | null;
}

/** conversations 原文取回行 */
export interface RecallConversationRow {
  role: string;
  content: string;
  timestamp?: string | null;
}

/**
 * 回忆问句 / 续聊引导统一触发正则。
 * 原 retrieval-stage._isRecallQuestion 与 MeetingWallAdapter.RECALL_QUESTION_RE 各自维护 →
 * 合并扩展为单一来源（含"还是X的事/继续说/接着刚才/再说说"等续聊引导，用户不写"记得/上次"
 * 也能触发原文兜底）。两处调用方必须 import 本常量，禁止本地复制（防漂移）。
 */
export const RECALL_TRIGGER_RE =
  /(?:记得|聊过|说过|之前|以前|上次|那件事|那次|回忆|是不是|上次说|聊起|什么内容|最早|第一次|当初|刚认识|还是.{1,10}(?:的|的?事)|继续说|接着说|接着聊|接着刚才|回到刚才|再说说|再聊聊|再讲讲|刚才说|刚才讲到)/;

/** 无关词/高频结构词/触发词 — 关键词抽取时过滤（防"还是诗韵的事"只抽出"还是""的事"） */
const STOP_KW = new Set([
  '我们', '你们', '他们', '那个', '这个', '什么', '怎么', '今天', '明天', '昨天',
  '时候', '还是', '一起', '但是', '因为', '如果', '不是', '就是', '记得', '聊过',
  '说过', '以前', '之前', '上次', '那件', '那次', '回忆', '自己', '咱们', '大家',
  '真的', '一直', '是不是', '没有', '知道', '你说', '我问', '们是', '是不', '是聊',
  '过树', '林具', '体怎', '么回', '回事', '具体', '还有', '然后', '后来', '那些',
  '别的', '其他', '的事', '我们是', '们是不', '是聊过', '聊过树', '过树林',
  '树林具', '林具体', '具体怎', '体怎么', '怎么回', '我们这', '说说', '接着', '刚才',
  '继续', '回到', '再聊', '讲讲',
]);

/**
 * 从消息中抽取 2/3 字中文话题关键词（排除停用词与传入的实体名集合）。
 * 实体名排除集 = 调用方动态传入（FG getAllPersonNames + 当前会晤实体 + 玉瑶），零硬编码人名。
 */
export function extractTopicKeywords(
  query: string,
  excludeNames: Iterable<string> = [],
  limit = 4,
  preferTopicNames: Iterable<string> = [],
): string[] {
  const excl = new Set(excludeNames);
  // 2 字词优先、3 字词靠后：3 字滑窗会产生结构噪声（如"还是徐/是徐诗"），
  // 而 2 字称呼（诗韵/都灵）在记忆 LIKE 召回中最有效——先收 2 字保位再补 3 字，
  // 防噪声把有效 2 字词挤出 limit（实测"诗雨，还是徐诗韵的事"抽词 bug）。
  const two: string[] = [];
  const three: string[] = [];
  for (let i = 0; i + 2 <= query.length; i++) {
    const s2 = query.slice(i, i + 2);
    if (/^[一-龥]{2}$/.test(s2) && !STOP_KW.has(s2) && !excl.has(s2)) two.push(s2);
  }
  for (let i = 0; i + 3 <= query.length; i++) {
    const s3 = query.slice(i, i + 3);
    if (/^[一-龥]{3}$/.test(s3) && !STOP_KW.has(s3) && !excl.has(s3)) three.push(s3);
  }
  const base = [...new Set(two), ...new Set(three)];
  // 🔴 话题锚前置：消息中提到的"他人 FG 全名"（如徐诗韵）的尾 2 字（诗韵）是真话题——
  //   排到宽泛词（当前实体自称诗雨/结构噪声是徐）之前，否则 topic 词被前序命中填满 limit 饿死。
  const prefer = new Set<string>();
  for (const n of preferTopicNames) {
    if (n.length < 3) continue;
    const tail = n.slice(-2);
    if (excl.has(tail)) continue;
    prefer.add(tail);
    if (query.includes(n) && three.includes(n)) prefer.add(n);
  }
  if (prefer.size > 0) {
    const front: string[] = [];
    const rest: string[] = [];
    for (const w of base) (prefer.has(w) ? front : rest).push(w);
    return [...front, ...rest].slice(0, limit);
  }
  return base.slice(0, limit);
}

/** 近期槽：当日(<1天)记忆按钙化分取 TOP（保底槽，内容相关召回不足时兜底） */
export function recentCalciumRows(
  src: RecallSource,
  entityUuid: string,
  limit = 8,
): RecallMemoryRow[] {
  return (
    src.queryAll(
      `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
       WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) < 1
       ORDER BY calcium_score DESC LIMIT ?`,
      [entityUuid, limit],
    ) || []
  ) as RecallMemoryRow[];
}

/** 历史槽：≥1天记忆按钙化分取 TOP（历史地标保底） */
export function historyCalciumRows(
  src: RecallSource,
  entityUuid: string,
  limit = 6,
): RecallMemoryRow[] {
  return (
    src.queryAll(
      `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
       WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) >= 1
       ORDER BY calcium_score DESC LIMIT ?`,
      [entityUuid, limit],
    ) || []
  ) as RecallMemoryRow[];
}

/**
 * 内容相关召回：当日记忆中 raw_input 含关键词的（LIKE），每个关键词取**最近 1 条**，遍历全部关键词。
 * 修复"钙化分低的近期关键记忆（如引诗/约定细节）被高钙情感 ANCHOR 挤出 TOP8"。
 * 🔴 排序用 created_at DESC（时间近因）而非 calcium DESC：续聊场景用户想接的是"上次聊到哪"
 *   ——高钙 ANCHOR(1.6-2.05) 若按钙化序仍占满每关键词首位，低钙但最新的细节记忆（6:05-6:10 引诗/描述）
 *   永远轮不到；时间近因 + 关键词话题圈定 = 注入"最近聊的相关内容"，语义贴合续聊。
 * 🔴 每关键词深度 1、全关键词广度遍历：防前序宽泛词（如"诗雨"）先命中高钙 ANCHOR
 *   填满 limit → 后序关键词（"诗韵"）来不及查询。
 */
export function keywordRecallMemories(
  src: RecallSource,
  entityUuid: string,
  keywords: string[],
  limit = 4,
): RecallMemoryRow[] {
  const out: RecallMemoryRow[] = [];
  if (!keywords.length) return out;
  for (const kw of keywords) {
    if (out.length >= limit) break;
    const rows = (
      src.queryAll(
        `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
         WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) < 1 AND raw_input LIKE ?
         ORDER BY created_at DESC, calcium_score DESC LIMIT 1`,
        [entityUuid, `%${kw}%`],
      ) || []
    ) as RecallMemoryRow[];
    for (const r of rows) {
      if (!out.some((o) => o.id === r.id)) out.push(r);
    }
  }
  return out;
}

/**
 * 压缩原文取回（核心修复）：从 conversations 表按关键词 LIKE 检索实体对话**原文**，
 * 刻意**不**带 is_compacted = 0 过滤 —— 压缩仅是维护期对内存窗口的标记，原始对话
 * 遵循只增不删永久留存，召回侧必须能原文直取，否则"压缩 = 永久失忆"。
 */
export function recallOriginalConversations(
  src: RecallSource,
  entityUuid: string,
  keywords: string[],
  limit = 3,
  maxChars = 300,
): RecallConversationRow[] {
  const hits: RecallConversationRow[] = [];
  if (!keywords.length) return hits;
  for (const kw of keywords) {
    const rows = (
      src.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? AND content LIKE ? AND LENGTH(content) > 150
         ORDER BY timestamp DESC LIMIT 3`,
        [entityUuid, `%${kw}%`],
      ) || []
    ) as RecallConversationRow[];
    for (const r of rows) {
      const c = String(r.content || '').substring(0, maxChars);
      if (c.length > 4 && !hits.some((h) => h.content === c)) {
        hits.push({ role: r.role, content: c, timestamp: r.timestamp });
      }
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** 按 id 去重（关键词相关召回在前、钙化保底在后的合并辅助） */
export function dedupeRowsById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
