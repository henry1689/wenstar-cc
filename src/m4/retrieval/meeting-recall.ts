/**
 * meeting-recall — 会晤实体记忆召回共享工具
 * ==========================================
 * 修复两大缺陷（2026-09-09 会晤失忆实锤：徐诗雨 6:05《蒹葭》引诗记忆 calcium 0.70
 * 排当天 55/257，被 4:45-5:14 高钙 ANCHOR(1.6-2.05) 挤出近期槽 TOP8 → 17:03 续聊接不上）：
 *   1. 纯钙化分排序 ≠ 用户关心的内容 → 增加"消息关键词内容相关召回"，钙化分只作保底；
 *   2. 压缩标记(is_compacted=1)隔离对话原文 → 新增"压缩原文取回"（原文永久留存原则，
 *      压缩仅是内存窗口标记，原始对话只增不删，召回侧永远可原文直取）。
 *
 * 🔴 V34(2026-09-25) 兜底入口去门槛（架构级）：
 *   `recallOriginalConversations` 原先受**两道关键词门槛**（函数内 `!keywords.length` +
 *   调用点 `_topicKw.length > 0`）⇒ 不提触发词就压根不查砂金库，砂金库的"兜底层"职责形同虚设。
 *   现改为：关键词**加权**（命中排前）+ **时间窗无条件兜底**（近 N 天原文总能取回）。
 *   时间窗天数由调用方传 `MEMORY_CONFIG.compaction.sandboxRecallWindowDays`（配置单一事实源）。
 *
 * 🔴 V34 #3(2026-09-25) 兜底改为「倒排索引查询驱动 + 时间窗采样兜底」两段式：
 *   原兜底是 `content LIKE '%词%'` + `ORDER BY timestamp DESC LIMIT N` —— 对高频实体，
 *   "最新 N 条"必然落在**已被上下文覆盖**的区间内 ⇒ 兜底层空转（实测：池内 546 条只取 12 条，
 *   落在 43分钟~2.4小时，而上下文已覆盖 3.9 小时）。且字面匹配对"说计划、原文写方案"无能为力。
 *   现改为：① 先用本仓**已有**的 search_index 倒排索引按查询取候选（相关性驱动）；
 *   ② 索引无命中才按时间窗采样兜底；③ 两路都只取**比当前上下文更早**的原文（`beforeTs` 上界），
 *   从结构上保证"兜的是没看到的，不是刚看过的"。
 *
 * retrieval-stage 会晤隔离墙与 MeetingWallAdapter 共用本模块，杜绝同构漂移。
 * 🔴 V34 起本模块**不再零 import** —— 复用同层 `buildNgrams`（m4 内聚，非反向依赖），
 *   以保证切词口径与写入索引时**同源**（切词漂移会让索引查不到）。
 */

// 🔴 V34: 切词与写入 search_index 时**同源**（同层复用，非反向依赖）。口径漂移 = 索引查不到。
import { buildNgrams } from '../SearchIndexBuilder.js';

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

/** C: 候选稀疏门槛 — 召回候选低于此数即触发 LLM 兜底挑选（业主 2026-09-12 定） */
export const RECALL_SPARSE_THRESHOLD = 3;

/**
 * C 兜底挑选触发判定（2026-09-12）—— 回忆问句 **或** 候选稀疏，两者取或（业主 2026-09-12 定）。
 *
 * 背景：会晤召回已有「近期槽 + 历史槽 + 回忆问句追加最早 + 关键词 LIKE + 原文取回」五路，
 *   但 ① 候选稀少时没有任何补强；② 候选池无论多少都直接注入，未按"与本次问题相关性"挑选。
 *   关键词/情感向量都拿不准的场景即在此处兜底 —— 交 LLM 从候选中挑选（见 retrieval-stage.pickRelevantByLlm）。
 *
 * 纯函数、零依赖，供 retrieval-stage 与 MeetingWallAdapter 共用（与 RECALL_TRIGGER_RE 同源，防漂移）。
 */
export function shouldEscalateToLlmPicker(
  message: string,
  candidateCount: number,
  threshold: number = RECALL_SPARSE_THRESHOLD,
): boolean {
  if (RECALL_TRIGGER_RE.test(message || '')) return true;
  return candidateCount < threshold;
}

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
 * 压缩原文取回（核心修复）：从 conversations 表检索实体对话**原文**，
 * 刻意**不**带 is_compacted = 0 过滤 —— 压缩仅是维护期对内存窗口的标记，原始对话
 * 遵循只增不删永久留存，召回侧必须能原文直取，否则"压缩 = 永久失忆"。
 *
 * 🔴 V34(2026-09-25) 结构修复：关键词从「**门槛**」降级为「**加权**」，新增**时间窗兜底**。
 *
 * 原实现的致命缺陷 —— `if (!keywords.length) return hits;` + 调用点 `if (_topicKw.length > 0)`：
 *   两层门槛叠加 ⇒ **不提"记得/之前/上次"这类触发词，就压根不去砂金库找**；
 *   即使找了也是 2/3 字滑窗的字面 LIKE（说"计划"而原文写"方案" ⇒ 捞不到）。
 *   这与原设计「回忆时内存上下文找不到 → 到砂金库找」的**兜底层职责**背道而驰：
 *   兜底路径不该有"先猜对关键词"这个前置条件。
 *
 * 现语义（两段，前者优先入列）：
 *   ① 关键词路径 —— 命中者**排前**（加权，非门槛）；
 *   ② 时间窗路径 —— **无条件执行**（关键词为空、或关键词全未命中，照样取回），
 *      取 `timestamp >= now - windowDays` 的最近原文，补齐剩余名额。
 *      这正是"近 N 天聊过的可被召回"的实现。
 *
 * @param keywords    话题关键词（可为空数组 —— 空则只走时间窗路径）
 * @param limit       总条数上限（关键词命中 + 时间窗兜底合计）
 * @param maxChars    单条截断长度
 * @param windowDays  🔴 时间窗天数。**调用方必须显式传入**
 *                    `MEMORY_CONFIG.compaction.sandboxRecallWindowDays`（配置单一事实源）。
 *                    本模块不直接读配置（供检索侧与会晤隔离墙共用，防同构漂移），
 *                    故由调用方传入。传 0 / 省略 / 非法值 ⇒ 时间窗路径**关闭**，退回旧行为
 *                    （纯关键词，仅关键字面匹配）。
 * @param beforeTs    🔴 V34 新增**上界（不含）**：只取比它更早的原文。传「当前上下文最旧一轮的时间」
 *                    可保证兜底取回的是**上下文之外**的内容，不与已注入的上下文重复。
 *                    省略/null ⇒ 无上界（旧行为）。
 */
export function recallOriginalConversations(
  src: RecallSource,
  entityUuid: string,
  keywords: string[],
  limit = 12,
  maxChars = 300,
  windowDays = 0,
  beforeTs: string | null = null,
): RecallConversationRow[] {
  const hits: RecallConversationRow[] = [];
  // 边界防护：非法 limit/maxChars 回落到安全值，避免 NaN/负数进 SQL 变成无限制全表扫描
  const _limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
  const _maxChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 300;
  const _push = (r: RecallConversationRow): boolean => {
    const c = String(r.content || '').substring(0, _maxChars);
    if (c.length > 4 && !hits.some((h) => h.content === c)) {
      hits.push({ role: r.role, content: c, timestamp: r.timestamp });
    }
    return hits.length >= _limit;
  };

  // ── ① 关键词路径（加权优先，非门槛）──
  for (const kw of (keywords || [])) {
    if (hits.length >= _limit) break;
    if (!kw) continue;
    const rows = (
      src.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? AND content LIKE ? AND LENGTH(content) > 150
         ORDER BY timestamp DESC LIMIT 3`,
        [entityUuid, `%${kw}%`],
      ) || []
    ) as RecallConversationRow[];
    for (const r of rows) {
      if (_push(r)) return hits;
    }
  }

  // ── ② 时间窗路径（无条件兜底；关键词为空/全未命中时靠它取回）──
  const _days = Number(windowDays);
  if (!Number.isFinite(_days) || _days <= 0) return hits;  // 未接入配置 ⇒ 关闭（旧行为）
  if (hits.length >= _limit) return hits;
  try {
    const since = new Date(Date.now() - _days * 86400000).toISOString();
    const _upper = typeof beforeTs === 'string' && beforeTs ? ' AND timestamp < ?' : '';
    const _params: unknown[] = [entityUuid, since];
    if (_upper) _params.push(beforeTs);
    _params.push(_limit);
    const rows = (
      src.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? AND timestamp >= ?${_upper} AND LENGTH(content) > 40
         ORDER BY timestamp DESC LIMIT ?`,
        _params,
      ) || []
    ) as RecallConversationRow[];
    for (const r of rows) {
      if (_push(r)) break;
    }
  } catch {
    // 时间窗取回失败不阻塞 —— 关键词路径结果照常返回（兜底降级）
  }
  return hits;
}

/** 砂金库两段式召回的调用参数 */
export interface SandboxRecallOptions {
  /** 总条数上限（倒排路径 + 时间窗兜底合计） */
  limit?: number;
  /** 单条原文截断长度 */
  maxChars?: number;
  /** 时间窗天数（调方传 MEMORY_CONFIG.compaction.sandboxRecallWindowDays） */
  windowDays?: number;
  /** 🔴 上界（不含）：只取比它更早的原文。传「当前上下文最旧一轮的时间」⇒ 只兜上下文之外 */
  beforeTs?: string | null;
  /** 单条原文最小长度（噪声门槛） */
  minContentLen?: number;
  /** 倒排查询最大词数 */
  maxTerms?: number;
  /**
   * 🔴 V35-C(2026-10-05): 时间窗兜底的**条数封顶**（真正的最后手段，不是默认填充）。
   *   默认 2 —— 原实现走兜底时按 `limit` 取满（实测每次 12 条），把记忆预算吃掉了 66.7%。
   */
  fallbackLimit?: number;
}

/**
 * 🔴 V34 #3 砂金库召回**两段式**（原设计「砂金库=回忆兜底层」的落地）：
 *
 * ```
 * ① 倒排索引（查询驱动）—— 用"你问的这句话"去 search_index 找相关的历史原文
 *    命中了 → 取原文（相关性驱动；同一话题即使措辞不同也能命中，因为切的是 n-gram）
 * ② 时间窗采样（兜底）—— ① 无命中时才按时间跨度取
 *    措辞与原文完全不同（或用户没提任何实词）时，至少还能看到历史轮廓
 * ```
 *
 * 两路共同约束 `beforeTs`：**只取比当前上下文更早的原文**。
 * 这条约束同时充当"触发判据" —— 若上下文已覆盖整个窗口（低频实体），
 * 区间为空 ⇒ 自然不注入，无需任何关键词或阈值判断，也就不会"一会东一会西"。
 *
 * 🔴 隐私 fail-closed：`entityUuid` 为空 ⇒ **直接返回空**，绝不发起跨角色检索。
 *   过滤依据是 `conversations.belong_entity_uuid`（权威字段）——
 *   `search_index.belong_entity_uuid` 仅 27.5% 非空，**不可**作为过滤依据。
 */
export function recallSandboxConversations(
  src: RecallSource,
  entityUuid: string,
  query: string,
  opts: SandboxRecallOptions = {},
): RecallConversationRow[] {
  const hits: RecallConversationRow[] = [];
  if (!entityUuid) return hits;   // fail-closed：无归属不检索

  const _limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.floor(opts.limit as number) : 12;
  const _maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars as number) > 0 ? Math.floor(opts.maxChars as number) : 300;
  const _days = Number(opts.windowDays);
  const _minLen = Number.isFinite(opts.minContentLen) && (opts.minContentLen as number) > 0 ? Math.floor(opts.minContentLen as number) : 40;
  const _maxTerms = Number.isFinite(opts.maxTerms) && (opts.maxTerms as number) > 0 ? Math.floor(opts.maxTerms as number) : 40;
  const _beforeTs = typeof opts.beforeTs === 'string' && opts.beforeTs ? opts.beforeTs : null;
  const _since = Number.isFinite(_days) && _days > 0 ? new Date(Date.now() - _days * 86400000).toISOString() : null;

  const _push = (r: RecallConversationRow): boolean => {
    const c = String(r?.content || '').substring(0, _maxChars);
    if (c.length > 4 && !hits.some((h) => h.content === c)) {
      hits.push({ role: r.role, content: c, timestamp: r.timestamp });
    }
    return hits.length >= _limit;
  };

  // ── ① 倒排索引（查询驱动）──
  const terms = buildNgrams(String(query || '')).slice(0, _maxTerms);
  if (terms.length > 0) {
    try {
      const phs = terms.map(() => '?').join(',');
      const conds = [
        "s.source_type = 'conversation'",
        `s.term IN (${phs})`,
        'c.belong_entity_uuid = ?',                 // 权威隐私过滤
        '(c.is_test IS NULL OR c.is_test = 0)',
        'LENGTH(c.content) > ?',
      ];
      const params: unknown[] = [...terms, entityUuid, _minLen];
      if (_beforeTs) { conds.push('c.timestamp < ?'); params.push(_beforeTs); }
      if (_since) { conds.push('c.timestamp >= ?'); params.push(_since); }
      const rows = (
        src.queryAll(
          `SELECT c.role, c.content, c.timestamp
           FROM search_index s
           JOIN conversations c ON c.id = CAST(s.source_id AS INTEGER)
           WHERE ${conds.join(' AND ')}
           GROUP BY s.source_id
           ORDER BY COUNT(DISTINCT s.term) DESC, c.timestamp DESC
           LIMIT ?`,
          [...params, _limit],
        ) || []
      ) as RecallConversationRow[];
      for (const r of rows) {
        if (_push(r)) return hits;
      }
    } catch {
      // 索引路径不可用（表缺失/查询失败）→ 落到 ② 时间窗兜底，不阻断对话
    }
  }

  // ── ② 时间窗采样兜底（**① 无命中时**才走 —— 见本函数头注释的原始设计）──
  // 🔴 V35-C(2026-10-05): 原触发条件是 `hits.length < _limit`（"不满额"），
  //   而倒排索引几乎永远凑不满 `_limit`(=12) ⇒ **每一轮都兜底**。
  //   实测：109 次触发**全部返回满额 12 条**，占用记忆预算均值 66.7%（峰值 84%）；
  //   且这批是**与当前话题无关**的旧对话原文 —— 正是 2026-08-21
  //   「早期无关记忆默认注入 ⇒ 一会东一会西」那次事故的同源复发
  //   （当时靠关键词门槛压住，后被改为无条件执行，防护失效）。
  //   后果：记忆块体量压过对话本身（8836 vs 4740 字符），模型注意力被"过去的素材"带走，
  //   表现为话题惯性弱、说几句就漂到别的事上。
  //   现改回文档声明的意图：「① 无命中时才按时间跨度取」，并把兜底条数封顶
  //   —— 给出历史轮廓即可，不是把 12 条旧原文倒进提示词。
  if (hits.length === 0 && _since) {
    const _fallbackLimit = Number.isFinite(opts.fallbackLimit) && (opts.fallbackLimit as number) > 0
      ? Math.floor(opts.fallbackLimit as number)
      : 2;
    // 关键词传空：①已做过查询驱动的匹配，这里只走时间窗（避免重复的 LIKE 扫描）
    const fb = recallOriginalConversations(
      src, entityUuid, [], _fallbackLimit, _maxChars, _days, _beforeTs,
    );
    for (const r of fb) {
      if (_push(r)) break;
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
