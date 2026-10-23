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
// Phase 2.2 (B1): 高钙阈值 / 沉淀窗从配置单一事实源读取（不硬编码魔法数字）
import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';

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

/** 🔴 T013 亲密话题召回（A+C，2026-10-23）：亲密记忆实测召回不到（数据在、钙分不低，但问"亲热的事"字面只命中1个组）。
 *  ① INTIMATE_TOPIC_RE：查询是否涉亲密话题；② 命中则把整组亲密词注入召回，让"亲热"能匹配含"亲密/暧昧/床上"等的组，扩大命中面（治本+扩词）。 */
export const INTIMATE_TOPIC_RE =
  /(?:亲热|亲密|暧昧|床上|上床|做爱|性爱|抚摸|高潮|脱光|脱衣|裸|情事|房事|那方面|那档子|第一次亲热|亲热的事|亲热过|亲热的)/;
/** 亲密词集（命中亲密话题时全量注入召回匹配，覆盖同义/近义表述） */
export const INTIMATE_KEYWORDS =
  ['亲热', '亲密', '暧昧', '床上', '上床', '做爱', '性爱', '抚摸', '高潮', '脱', '裸', '情事', '房事', '身体', '身子'];

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
  // 🔴 T013 A+C 亲密话题召回：查询涉亲密话题时，把整组亲密词前置注入，
  //   让"亲热"类查询能匹配含"亲密/暧昧/床上"等的组（实测仅字面"亲热"只命中1个组 → 召回不到那段记忆）。
  if (INTIMATE_TOPIC_RE.test(query || '')) {
    const intimate = INTIMATE_KEYWORDS.filter((w) => !excl.has(w));
    if (intimate.length > 0) return intimate.slice(0, Math.max(limit, intimate.length));
  }
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

/** 近期槽候选池倍数：先按钙化取 pool 倍，再按「钙化 + 近因」重排取 limit */
const RECENT_SLOT_POOL_FACTOR = 2.5;

/**
 * 近期槽打分（P0-1）：钙化（归一）× 0.6 + 24 小时线性近因 × 0.4。
 *
 * 🔴 钙化归一用 `min(1, calcium)` 而**不是** `calcium / 10`：
 *   实测全表 95.8%（9186/9593）记忆钙化 < 1、绝大多数落在 0.2~1。若除以 10，
 *   钙化项整体缩到 0.007~0.036，而近因项上限 0.4 ⇒ 近因压倒性主导，
 *   近期槽会退化成「纯最新 8 条」，把"当天重要的事"这个信号整个丢掉。
 */
function recentSlotScore(row: RecallMemoryRow, nowMs: number): number {
  const calciumNorm = Math.min(1, Math.max(0, Number(row.calcium_score) || 0));
  const ts = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const ageHours = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 3_600_000) : 24;
  const recency = Math.max(0, 1 - ageHours / 24);
  return calciumNorm * 0.6 + recency * 0.4;
}

/**
 * 近期槽：当日(<1天)记忆 —— **候选池扩容后按「钙化 + 时间近因」重排**（P0-1）。
 *
 * 原实现：`ORDER BY calcium_score DESC LIMIT 8` —— 纯钙化序，同钙化时退化为"最新优先"，
 *   当天的高钙旧内容会压住新内容。
 *
 * @param nowMs 注入当前时间（纯函数化，便于确定性测试；缺省取真实时间）
 */
export function recentCalciumRows(
  src: RecallSource,
  entityUuid: string,
  limit = 8,
  nowMs: number = Date.now(),
): RecallMemoryRow[] {
  const pool = (src.queryAll(
    `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
     WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) < 1
     ORDER BY calcium_score DESC LIMIT ?`,
    [entityUuid, Math.max(limit, Math.ceil(limit * RECENT_SLOT_POOL_FACTOR))],
  ) || []) as RecallMemoryRow[];

  return pool
    .map((r) => ({ r, s: recentSlotScore(r, nowMs) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * 历史槽时间片配额（P0-1）：**每一片单独占名额**，取代"全历史按钙化抢 6 个位"。
 *
 * 为什么必须分层：实测 14 条 calcium=10 的记忆**全部来自 29~40 天前**
 * （2026-08-27/28、09-08，其中 4 条是 roleplay 地标），而最近 5 天的 176 条记忆
 * 在同一排序里**最好排名第 43** ⇒ 纯钙化序下「一两天前聊过的」永远进不了历史槽。
 */
const HISTORY_BUCKETS: ReadonlyArray<{ fromDays: number; toDays: number; quota: number }> = [
  { fromDays: 1, toDays: 3, quota: 2 },      // 1~3 天
  { fromDays: 3, toDays: 7, quota: 1 },      // 3~7 天
  { fromDays: 7, toDays: 30, quota: 2 },     // 7~30 天
  { fromDays: 30, toDays: 36500, quota: 1 }, // 30 天+（古老地标仍保留 1 席）
];

/**
 * 历史槽：≥1 天的记忆，**按时间片配额**取（P0-1）。
 *
 * 语义：
 *   ① 逐片按配额取，片内仍按钙化序（`calcium_score DESC, created_at DESC`）；
 *   ② 某片不足额时，**用"最近的"记忆补足**（`ORDER BY created_at DESC`）——
 *      刻意不用钙化序补，否则一有片空就又被古老地标填回，等于没分层。
 */
export function historyCalciumRows(
  src: RecallSource,
  entityUuid: string,
  limit = 6,
): RecallMemoryRow[] {
  const out: RecallMemoryRow[] = [];
  const seen = new Set<string>();

  for (const b of HISTORY_BUCKETS) {
    if (out.length >= limit) break;
    const rows = (src.queryAll(
      `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
       WHERE belong_entity_uuid = ?
         AND julianday('now') - julianday(created_at) >= ?
         AND julianday('now') - julianday(created_at) < ?
       ORDER BY calcium_score DESC, created_at DESC LIMIT ?`,
      [entityUuid, b.fromDays, b.toDays, b.quota],
    ) || []) as RecallMemoryRow[];
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }

  // ② 补足：按**时间近因**而非钙化 —— 空片不能让古老地标回填
  if (out.length < limit) {
    const fill = (src.queryAll(
      `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
       WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) >= 1
       ORDER BY created_at DESC LIMIT ?`,
      [entityUuid, limit],
    ) || []) as RecallMemoryRow[];
    for (const r of fill) {
      if (out.length >= limit) break;
      if (r.id && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }

  return out.slice(0, limit);
}

/**
 * 内容相关召回：raw_input 含关键词的记忆（LIKE），每个关键词取**最近 1 条**，遍历全部关键词。
 * 修复"钙化分低的近期关键记忆（如引诗/约定细节）被高钙情感 ANCHOR 挤出 TOP8"。
 * 🔴 排序用 created_at DESC（时间近因）而非 calcium DESC：续聊场景用户想接的是"上次聊到哪"
 *   ——高钙 ANCHOR(1.6-2.05) 若按钙化序仍占满每关键词首位，低钙但最新的细节记忆（6:05-6:10 引诗/描述）
 *   永远轮不到；时间近因 + 关键词话题圈定 = 注入"最近聊的相关内容"，语义贴合续聊。
 * 🔴 每关键词深度 1、全关键词广度遍历：防前序宽泛词（如"诗雨"）先命中高钙 ANCHOR
 *   填满 limit → 后序关键词（"诗韵"）来不及查询。
 *
 * @param windowDays 时间窗（天）。🔴 P0-1（2026-10-06 / ADR-011 P1-a）：原实现**硬编码 `< 1`**（当日），
 *   而 P0 诊断列出的四条通道里它是第三条 —— 用户隔天提起话题（"我们前几天说的国美"）时
 *   关键词路完全够不到，与"没有任何一条通道会取 1 天以上的记忆"是同一个洞。
 *   现与砂金库兜底**同窗**（`MEMORY_CONFIG.compaction.sandboxRecallWindowDays`，默认 7）。
 *   ⚠️ 本模块保持**零 import**（供检索侧与会晤隔离墙共用，防同构漂移）⇒ 缺省值 7 与配置默认同源，
 *   调用方若需不同窗口请显式传入（retrieval-stage 传 `SANDBOX_RECALL_WINDOW_DAYS`）。
 */
export function keywordRecallMemories(
  src: RecallSource,
  entityUuid: string,
  keywords: string[],
  limit = 4,
  windowDays = 7,
): RecallMemoryRow[] {
  const out: RecallMemoryRow[] = [];
  if (!keywords.length) return out;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
  for (const kw of keywords) {
    if (out.length >= limit) break;
    const rows = (
      src.queryAll(
        `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
         WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) < ? AND raw_input LIKE ?
         ORDER BY created_at DESC, calcium_score DESC LIMIT 1`,
        [entityUuid, days, `%${kw}%`],
      ) || []
    ) as RecallMemoryRow[];
    for (const r of rows) {
      if (!out.some((o) => o.id === r.id)) out.push(r);
    }
  }
  return out;
}

/**
 * 回忆问句·真·最早记忆（时间轴兑底，2026-10-18 修正）
 * ============================================================
 * 实测缺陷（阿珍压测轮4）：原兑底 `ORDER BY seq_pos ASC LIMIT 6` 取到的是
 *   **本轮对话自己的 5 条讨论锚点**（锚点 seq_pos 为负数 —— ADR-010 设计：锚点 seq = -首轮seq，
 *   负数在 ASC 序中排最前）—— 所谓"最早"实际是"最新讨论回声"，自我污染回路的第二条通道；
 *   且 legacy 行 seq 是 epoch-ms（1785990288000），seq 序 ≠ 时间序。
 * 修正：按**真实时间序**（created_at ASC）+ 排除锚点行（seq_pos > 0）——
 *   与 anchorRecallByKeywords 远端（ASC 原始事件）语义统一：时间轴兑底只供过去，不供当前对话回声。
 * 单源原则：retrieval-stage 与 MeetingWallAdapter 共用本函数（防同构分叉）。
 */
export function earliestMemoriesByTime(
  src: RecallSource,
  entityUuid: string,
  limit = 6,
): RecallMemoryRow[] {
  return (
    src.queryAll(
      `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
       WHERE belong_entity_uuid = ? AND seq_pos > 0
       ORDER BY created_at ASC LIMIT ?`,
      [entityUuid, limit],
    ) || []
  ) as RecallMemoryRow[];
}

/**
 * 回忆问句·锚点事件召回（2026-10-18，业主批准结构化改善）
 * ============================================================
 * 实测缺陷（阿珍压测）：问"还记得我俩的第一次吗"→ 她只敢说日期，细节靠用户提示才说出。
 * 根因：回忆问句的兑底通道取**最早 6 条**（时间轴头），而事件发生在记忆流**中段**
 *   （10-16 的"第一次"，实体记忆始于 8 月）——头尾两头都够不到；
 *   历史槽 1-3 天片 284 条按钙化序取 2，事件锚点（钙化 0.4-0.86）进不了前二。
 * ⇒ 事件的浓缩载体（闭组 ANCHOR 锚点，含完整 Q+A 语境）在回忆问句时**结构性缺席**。
 *
 * 本通道补上这个洞：回忆问句时按**问句关键词**直取锚点行（不看钙化、不看时间片），
 *   与近期槽/历史槽/关键词路并列成为第四召回通道。锚点是闭组时浓缩的事件摘要，
 *   正是"回忆过去"场景最需要的素材形态。
 * 判据单一源：触发由调用方用 RECALL_TRIGGER_RE 判定（与另三通道同源），本函数只管取数。
 */
export function anchorRecallByKeywords(
  src: RecallSource,
  entityUuid: string,
  keywords: string[],
  limit = 4,
  settleMinutes = 30,
): RecallMemoryRow[] {
  const out: RecallMemoryRow[] = [];
  if (!keywords.length) return out;
  const settleDays = (Number.isFinite(settleMinutes) && settleMinutes > 0 ? settleMinutes : 30) / 1440;
  for (const kw of keywords) {
    if (out.length >= limit) break;
    // 🔴 时间分层双端取数（与 P0-1 历史槽分层同款设计语言）：
    //   近端（沉淀窗后 DESC ×2）：最近的已沉淀讲述；
    //   远端（ASC ×2）：**原始事件记录**（事件发生当时的闭组锚点，细节最全）。
    //   中段的近期讨论锚点被刻意排除 —— 它们是"关于回忆的讨论"而非事件本身，
    //   注入只会强化"记不着"叙事（压测实锤：top3 全是讨论回声，原始事件锚点反而不可达）。
    const rows = (
      src.queryAll(
        `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
         WHERE belong_entity_uuid = ? AND id LIKE '%\\_ANCHOR' ESCAPE '\\' AND raw_input LIKE ?
           AND julianday('now') - julianday(created_at) > ?
         ORDER BY created_at DESC LIMIT 2`,
        [entityUuid, `%${kw}%`, settleDays],
      ) || []
    ) as RecallMemoryRow[];
    const oldRows = (
      src.queryAll(
        `SELECT id, raw_input, calcium_score, effective_strength, created_at, perception_40d FROM memories
         WHERE belong_entity_uuid = ? AND id LIKE '%\\_ANCHOR' ESCAPE '\\' AND raw_input LIKE ?
         ORDER BY created_at ASC LIMIT 2`,
        [entityUuid, `%${kw}%`],
      ) || []
    ) as RecallMemoryRow[];
    for (const r of [...rows, ...oldRows]) {
      if (!out.some((o) => o.id === r.id)) out.push(r);
    }
  }
  // 🔴 2026-10-18 压测修正（两轮迭代）：
  //   第一轮：每关键词 LIMIT 1→3 —— 四词全被同一高钙锚点垄断（覆盖优先于排序）。
  //   第二轮实测：即使 LIMIT 3，含"第一次"的 10 条锚点全部钙化>0.2，
  //   日期锚点（0.2）在 calcium DESC 序下排名 11/10 永久不可达。
  //   根因不是 LIMIT 大小是**排序依据**：事件召回通道的职责是**覆盖**（把事件素材带回来），
  //   钙化排序是钙化槽的职责 —— 在本通道复用钙化序 = 低钙事件锚点结构性死亡。
  //   改 ORDER BY created_at DESC：最近讲述优先（最新讲述通常含最全信息，且低钙可达），
  //   总量仍由 limit 封顶 + 去重循环短路，不膨胀注入预算。
  // 🔴 2026-10-18 压测第三层根因（沉淀窗）：时间倒序后 top3 全是**本轮压测自己刚产生的
  //   "记不着"讨论锚点**（压测间隔几分钟内闭组）——原始事件锚点（含日期）仍被挤出，
  //   且形成自我污染回路：她每说一次"记不着"就生成新锚点，下次召回又强化"记不着"叙事。
  //   结构本质：记忆通道在供给**当前对话自己的回声**——刚闭组的锚点就是这段对话的摘要，
  //   已在对话历史里，不该由记忆通道重复注入（重复注入=自我叙事强化）。
  //   结构判据 = **沉淀窗**（锚点年龄，非内容词表）：记忆通道只供给"过去的沉淀"，
  //   默认排除 30 分钟内的锚点（与对话组 idle timeout 同尺度）。
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

// ══════════════════════════════════════════════════════════════════════════
// Phase 2.2 (B1 / T004): 高钙对话组通道 —— A 链路块级钙化召回的**唯一真源**
// ══════════════════════════════════════════════════════════════════════════
// 为什么要有这条通道（S1 摸底实测，见 P012）：
//   会晤召回此前五路（近期/历史/关键词/最早/锚点）**全部基于单条 memories**，
//   `dialog_groups.block_calcium_score` 虽已算好（avg 3.85、257 组高钙）却零引用。
//   结果是「重要的那段对话」只有在字面命中时才可能被捞回 —— 与「重要对话不该被忘」相反。
// 设计要点（R016 §三 任务B / R017 §二）：
//   ① **独立配额**：候选池只按钙分 + 沉淀窗取，不与 memories 槽位抢名额（调用方独立计数）；
//   ② **沉淀窗**：闭组不足 N 分钟不参与（业主 2026-10-18 裁决），避免把"正在进行的对话"当记忆注入；
//   ③ **相关性门**：候选先用本轮打分词校验（摘要命中优先、组内原文命中次之），
//      有命中者按时间近因注入；**无命中时按近因保底 1 条** —— 否则高钙组只在字面命中时可达，
//      等于结构性永久失忆（那正是本通道要修的病）；
//   ④ 只取结构字段，不读取、不打印任何对话内容。

/** 高钙对话组候选行（相关性字段由本模块补齐） */
export interface HighCalciumGroupRow {
  dg_id: string;
  uuid: string | null;
  calcium: number;
  last_ts: string | null;
  summary: string | null;
  turns: number | null;
  reason: string | null;
  /** 本轮查询与该组相关（关键词命中摘要或组内原文） */
  relevant: boolean;
  /** 命中的关键词（仅诊断用；不含任何对话内容） */
  matched_terms: string[];
  /**
   * 命中强度 = Σ 命中词长度（相关者之间排序用）。
   *
   * 只按时间近因排相关者时，"聊过同一件事但更早的组"会被更近的同词组挤掉 ——
   * 离线实测 recall@3 因此停在 48.6%。命中强度先于近因 ⇒ 词越对得上越靠前。
   */
  match_score: number;
}

export interface HighCalciumGroupOptions {
  /** retrieval-stage 已做过对库校验的打分词（优先使用） */
  keywords?: string[];
  /** keywords 缺失时用它抽词 —— 避免"没抽到词就没有相关性判断" */
  query?: string;
  /** 钙分下限，默认读 config budget.high_calcium_floor（5） */
  floor?: number;
  /** 沉淀窗分钟数，默认读 config budget.high_calcium_settle_minutes（30） */
  settleMinutes?: number;
  /** 当前时间（可注入 → 纯函数可测） */
  nowMs?: number;
  /** 相关性筛选前的候选池倍数（默认 5，避免"最近但不相关"挤掉"更早但相关"） */
  poolFactor?: number;
  /** 相关性校验最多用几个关键词（控 SQL 次数，默认 6） */
  maxTermsForCheck?: number;
}

/** 池内原始行（相关性两字段尚未补齐） */
type HighCalciumPoolRow = Omit<HighCalciumGroupRow, 'relevant' | 'matched_terms'>;

/**
 * 高钙对话组召回（真源）。返回**已按（相关性 → 时间近因 → 钙分）排序**的候选，长度 ≤ limit。
 *
 * @param entityUuid 会晤实体 UUID（组级归属过滤，绝不跨实体串档）
 * @param limit      独立配额（调用方自己再裁；本函数保证不超过）
 */
export function highCalciumGroups(
  src: RecallSource,
  entityUuid: string,
  limit = 3,
  opts: HighCalciumGroupOptions = {},
): HighCalciumGroupRow[] {
  if (!entityUuid || !(limit > 0)) return [];

  const cfg = getRetrievalFusionConfig();
  const floor = Number.isFinite(opts.floor)
    ? (opts.floor as number)
    : (Number(cfg.budget.high_calcium_floor) || 5);
  const settleMin = Number.isFinite(opts.settleMinutes)
    ? (opts.settleMinutes as number)
    : (Number(cfg.budget.high_calcium_settle_minutes) || 30);
  const nowMs = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();
  const poolLimit = Math.max(limit, Math.ceil(limit * (opts.poolFactor ?? 5)));

  const pool = (src.queryAll(
    `SELECT dialog_group_id AS dg_id, belong_entity_uuid AS uuid, block_calcium_score AS calcium,
            last_ts, block_summary AS summary, turn_count AS turns, block_close_reason AS reason
     FROM dialog_groups
     WHERE belong_entity_uuid = ?
       AND COALESCE(block_calcium_score, 0) >= ?
       AND summary_state = 'done'
       AND block_summary IS NOT NULL AND TRIM(block_summary) != ''
       AND last_ts IS NOT NULL
       AND last_ts <= ?
     ORDER BY last_ts DESC, block_calcium_score DESC
     LIMIT ?`,
    [entityUuid, floor, new Date(nowMs - settleMin * 60000).toISOString(), poolLimit],
  ) || []) as HighCalciumPoolRow[];
  if (pool.length === 0) return [];

  // ── 相关性门：摘要命中优先，摘要没命中的再查组内原文 ──
  const matched = new Map<string, string[]>();
  const rawKw = (opts.keywords && opts.keywords.length > 0)
    ? opts.keywords
    : (opts.query ? extractTopicKeywords(opts.query) : []);
  const terms = rawKw
    .map((w) => String(w || '').trim())
    .filter((w) => w.length > 0)
    .slice(0, opts.maxTermsForCheck ?? 6);

  if (terms.length > 0) {
    for (const g of pool) {
      const s = String(g.summary || '');
      const hit = terms.filter((t) => s.indexOf(t) >= 0);
      if (hit.length > 0) matched.set(String(g.dg_id), hit);
    }
    const missIds = pool.filter((g) => !matched.has(String(g.dg_id))).map((g) => String(g.dg_id));
    if (missIds.length > 0) {
      const phs = missIds.map(() => '?').join(',');
      for (const t of terms) {
        try {
          const rows = src.queryAll<{ dg_id: string }>(
            `SELECT DISTINCT dialog_group_id AS dg_id FROM conversations
             WHERE dialog_group_id IN (${phs})
               AND (is_test IS NULL OR is_test = 0) AND content LIKE ?`,
            [...missIds, `%${t}%`],
          ) || [];
          for (const r of rows) {
            const id = String(r.dg_id);
            const arr = matched.get(id) || [];
            if (arr.indexOf(t) < 0) arr.push(t);
            matched.set(id, arr);
          }
        } catch {
          // 原文相关性校验失败 → 该组按"不相关"处理，不阻塞整条通道
        }
      }
    }
  }

  // ── 相关性驱动补选（B1 实测发现的结构性缺口）──
  //   近期池只取 `limit × 5` 条，且按时间近因取 ⇒「重要但更早」的高钙组**根本进不了池子**，
  //   相关性门在池外无从谈起（离线实测 recall@3 仅 41.4%，玉瑶 66.7% / 0007 仅 25%）。
  //   这里在**全部**高钙组上按摘要命中补选，补够 limit 条为止；只在有关键词判据时进行。
  if (terms.length > 0 && matched.size < limit) {
    const seen = new Set(pool.map((g) => String(g.dg_id)));
    const likePhs = terms.map(() => 'block_summary LIKE ?').join(' OR ');
    try {
      const extra = (src.queryAll(
        `SELECT dialog_group_id AS dg_id, belong_entity_uuid AS uuid, block_calcium_score AS calcium,
                last_ts, block_summary AS summary, turn_count AS turns, block_close_reason AS reason
         FROM dialog_groups
         WHERE belong_entity_uuid = ?
           AND COALESCE(block_calcium_score, 0) >= ?
           AND summary_state = 'done'
           AND block_summary IS NOT NULL AND TRIM(block_summary) != ''
           AND last_ts IS NOT NULL AND last_ts <= ?
           AND (${likePhs})
         ORDER BY last_ts DESC, block_calcium_score DESC
         LIMIT ?`,
        [entityUuid, floor, new Date(nowMs - settleMin * 60000).toISOString(),
         ...terms.map((t) => `%${t}%`), poolLimit],
      ) || []) as HighCalciumPoolRow[];
      for (const g of extra) {
        const id = String(g.dg_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const s = String(g.summary || '');
        matched.set(id, terms.filter((t) => s.indexOf(t) >= 0));
        pool.push(g);
      }
    } catch {
      // 补选失败不影响近期池结果（通道仍有近期池 + 保底）
    }
  }

  const tsOf = (lastTs: string | null): number => {
    const t = Date.parse(String(lastTs || ''));
    return isNaN(t) ? 0 : t;
  };
  const sortRows = (arr: HighCalciumGroupRow[]): HighCalciumGroupRow[] =>
    arr.sort((a, b) => (tsOf(b.last_ts) - tsOf(a.last_ts)) || (b.calcium - a.calcium));

  const rows: HighCalciumGroupRow[] = pool.map((g) => ({
    dg_id: String(g.dg_id),
    uuid: g.uuid ?? null,
    calcium: Number(g.calcium) || 0,
    last_ts: g.last_ts ?? null,
    summary: g.summary ?? null,
    turns: g.turns ?? null,
    reason: g.reason ?? null,
    relevant: matched.has(String(g.dg_id)),
    matched_terms: matched.get(String(g.dg_id)) || [],
    match_score: (matched.get(String(g.dg_id)) || []).reduce((a, t) => a + String(t).length, 0),
  }));

  // 三种情形（缺一不可，测试已锁）：
  //   ① 没有判据（既无 keywords 也抽不出 query 词）⇒ **不做相关性门**，按时间近因取满 limit；
  //      把这种情况也压成 1 条，等于"无判据就自我阉割"，会丢掉本该召回的高钙组。
  //   ② 有判据且有人命中 ⇒ 只注入命中者（按时间近因 + 钙分）；
  //   ③ 有判据但无人命中 ⇒ 按时间近因**保底 1 条**（设计要点 ③，防结构性失忆）。
  const byMatchThenRecency = (arr: HighCalciumGroupRow[]): HighCalciumGroupRow[] =>
    arr.sort((a, b) => (b.match_score - a.match_score)
      || (tsOf(b.last_ts) - tsOf(a.last_ts))
      || (b.calcium - a.calcium));

  if (terms.length === 0) return sortRows(rows).slice(0, limit);
  const relevant = rows.filter((r) => r.relevant);
  //   ② 相关者之间：**命中强度优先**（词越对得上越靠前），再时间近因、再钙分
  if (relevant.length > 0) return byMatchThenRecency(relevant).slice(0, limit);
  return sortRows(rows).slice(0, Math.min(1, limit));
}

/**
 * 自检观测：该实体**当前可被召回**的高钙组总数（与 `highCalciumGroups` 同一组谓词）。
 * 只读、不排序、不做相关性校验 —— 供启动自检与调用方日志打印「可召 / 总量」。
 */
export function countHighCalciumGroups(
  src: RecallSource,
  entityUuid: string,
  opts: Pick<HighCalciumGroupOptions, 'floor' | 'settleMinutes' | 'nowMs'> = {},
): number {
  if (!entityUuid) return 0;
  const cfg = getRetrievalFusionConfig();
  const floor = Number.isFinite(opts.floor)
    ? (opts.floor as number)
    : (Number(cfg.budget.high_calcium_floor) || 5);
  const settleMin = Number.isFinite(opts.settleMinutes)
    ? (opts.settleMinutes as number)
    : (Number(cfg.budget.high_calcium_settle_minutes) || 30);
  const nowMs = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();
  try {
    const rows = src.queryAll<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dialog_groups
       WHERE belong_entity_uuid = ?
         AND COALESCE(block_calcium_score, 0) >= ?
         AND summary_state = 'done'
         AND block_summary IS NOT NULL AND TRIM(block_summary) != ''
         AND last_ts IS NOT NULL AND last_ts <= ?`,
      [entityUuid, floor, new Date(nowMs - settleMin * 60000).toISOString()],
    ) || [];
    return Number(rows[0]?.n) || 0;
  } catch {
    return 0;
  }
}
