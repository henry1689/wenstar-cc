/**
 * BArchiveReader — B 链路「沉睡卷宗」的**唯一单点读取入口**（P145 批 B）
 * ======================================================================
 * 职责三件：
 *   ① 单点读取：`getByGroupId(groupId)` 返回整块卷宗（原文 + 摘要 + 40D 快照 + 追加日志 + 完整性校验）
 *   ② 高保真回放：`render(record)` 把整块原文渲染成带真实说话人的文本
 *   ③ 消费计数：`recordConsume(groupId, kind)` 区分 USER_CONSUME / OPS_BACKFILL
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 为什么「单点」是**结构性**保证，而不是约定
 *
 *   本类**只有**一个查询入口 `getByGroupId(groupId)`，签名里必须给 groupId；
 *   没有任何 `search` / `list` / `scan` 方法。想按组遍历就必须绕过本类，
 *   而绕过就要显式写 SQL —— 那一层由 `assertAnchoredRead` 在下面堵。
 *
 *   这是 P145 微调 2 三段式的实现：
 *     ✅ 允许：带字面命中的倒排召回（在 DialogGroupAdapter，已过 UUID 过滤）
 *     ❌ 禁止：无锚点全表扫描 / 向量检索 / 按组遍历
 *     ✅ 唯一例外：深度回忆经 groupId 单点读取（就是本类）
 *
 * 🔴 为什么 `assertAnchoredRead` 只认 `dialog_group_id = ?`
 *
 *   危险的不是「查了 dialog_groups」，而是「不知道查哪一个」。
 *   只要 WHERE 里钉死了主键，单次读取的代价与组数无关。
 *   断言写在 SQL 常量旁边（模块内自检），任何后续改动把锚点去掉都会在**调用时立刻抛错**，
 *   而不是悄悄退化成全表扫描。
 *
 * 🔴 会晤安全：`audienceUuid`
 *
 *   块内的 conversations 行按 `belong_entity_uuid` 归属。会晤模式下块内所有**公开**轮次
 *   都属于当前会晤实体，而**耳语**轮的归属是听众（persistence-stage 的「按一对一方式记录」）。
 *   故渲染时只保留 `belong_entity_uuid` 为空或等于听众的行 ——
 *   把「耳语给别人」的轮次挡在回放之外。传 undefined/null = 不过滤（户主场景）。
 *
 *   调用方责任：会晤态若解析不出当前发言人 UUID，应当**不做深度回忆**（fail-closed），
 *   而不是不传 audienceUuid（那等于放开过滤）。该判定在 b-archive-recall.ts 里做。
 *
 * 🔴 消费计数为什么改 `block_calcium_score`
 *
 *   T002 Phase 2 的块级钙化公式：`block_calcium = α·组召回次数 + β·情感峰值 + γ·时间衰减 + δ·消费次数`。
 *   前四项在闭组时由 BlockValueScorer 一次算定；δ 项只能在「真的被深度回忆消费」之后累加。
 *   故本类是 δ 的唯一写入点：
 *     · USER_CONSUME：δ = 0.3，最多计 10 次（最多 +3.0），`block_calcium_score` 封顶 10
 *     · OPS_BACKFILL：只记日志、**不改钙分**（运维回填不是用户真实兴趣的证据）
 *   基准分可还原：`base = block_calcium_score − 0.3 × min(consume_count, 10)`，
 *   因为 consume_count 与 δ 都落库（v32 列）。
 *
 * 🔴 不写 `updated_at`
 *
 *   消费不是对块内容的修改。`updated_at` 被 BlockSummaryService / BlockArchiveService
 *   用来表达「块数据变了」，消费改了它会让下游误判需要重新摘要或重新归档。
 */

import { appendGroupLog, makeLogEntry, parseAppendLog } from './bArchiveLog.js';
import type { AppendLogEntry } from './bArchiveLog.js';
import { computeContentHash, computeSummaryHash } from './bArchiveHash.js';

// ══════════════════════════════════════════════════════════════
// 常量（口径收拢处）
// ══════════════════════════════════════════════════════════════

/** USER_CONSUME 单次回写的钙分增量（δ 因子） */
export const CONSUME_DELTA = 0.3;
/** USER_CONSUME 最多计多少次（超过后仍记日志与计数，但不再加钙分） */
export const CONSUME_MAX_COUNTED = 10;
/** 同组 USER_CONSUME 的最小间隔：30 分钟内只计一次（防一句话触发多轮注入刷分） */
export const CONSUME_THROTTLE_MS = 30 * 60_000;
/** 块级钙分上限（与 BlockValueScorer 的 SCORE_MAX 同标度） */
export const CALCIUM_SCORE_MAX = 10;
/** 单次回放的正文长度上限（超出则截断并显式告知未展开轮数） */
export const RENDER_MAX_CHARS = 12000;

/** 消费种类（T002 Phase 3 要求区分） */
export type ConsumeKind = 'USER_CONSUME' | 'OPS_BACKFILL';

/** 数据源（结构类型） */
export interface BArchiveSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
  writeRaw(sql: string, ...params: unknown[]): void;
}

// ══════════════════════════════════════════════════════════════
// 守卫
// ══════════════════════════════════════════════════════════════

/**
 * 断言：凡读取 `dialog_groups` 的语句必须钉死主键。
 *
 * 不查 dialog_groups 的语句直接放行；查了但 WHERE 里没有 `dialog_group_id = ?` ⇒ 抛错。
 * 这是**运行期**守卫（不是注释约定）——改坏了在第一次调用就炸，而不是上线后悄悄扫全表。
 */
export function assertAnchoredRead(sqlText: string): void {
  if (!/from\s+dialog_groups/i.test(sqlText)) return;
  if (!/dialog_group_id\s*=\s*\?/i.test(sqlText)) {
    throw new Error('[BArchiveGuard] 禁止对 dialog_groups 做无锚点读取（缺少 dialog_group_id = ?）：' + sqlText);
  }
}

// ══════════════════════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════════════════════

/** 组级 40D 聚合快照（批 A 写入，这里只读） */
export interface BArchiveSnapshot {
  dims?: number;
  agg?: string;
  dim_version?: string;
  generated_at?: string;
  rounds?: number;
  reason?: string;
  vector?: number[] | null;
}

/** 卷宗内一轮原文 */
export interface BArchiveConversation {
  id: number | null;
  role: string;
  content: string;
  timestamp: string;
  seqPos: number | null;
  belongEntityUuid: string | null;
}

/** 完整性校验结果（null = 该字段尚无记录，无法校验） */
export interface BArchiveIntegrity {
  contentHashMatches: boolean | null;
  summaryHashMatches: boolean | null;
}

/** 一次单点读取的完整结果 */
export interface BArchiveRecord {
  dialogGroupId: string;
  belongEntityUuid: string | null;
  narrativeTag: string | null;
  /** 对话类别（BlockDecayClass），由 narrative_tag 承载 */
  primaryEmotion: string | null;
  lifecycleState: string | null;
  blockCalciumScore: number;
  consumeCount: number;
  lastConsumedAt: string | null;
  turnCount: number;
  firstTs: string | null;
  lastTs: string | null;
  blockCloseReason: string | null;
  summaryState: string | null;
  summary: string | null;
  contentHash: string | null;
  summaryHash: string | null;
  snapshot: BArchiveSnapshot | null;
  appendLog: AppendLogEntry[];
  /** 可见原文（已按 audienceUuid 过滤） */
  conversations: BArchiveConversation[];
  /** uuid → 显示名（回放用；缺项时回退「玉瑶」） */
  speakerNames: Record<string, string>;
  integrity: BArchiveIntegrity;
}

/** getByGroupId 选项 */
export interface GetByGroupIdOptions {
  /**
   * 听众 UUID。给定 ⇒ 只保留 belong_entity_uuid 为空或等于它的行（会晤安全）。
   * 省略/null ⇒ 不过滤（户主场景，单个实体自有历史）。
   */
  audienceUuid?: string | null;
}

/** 消费计数结果 */
export interface ConsumeResult {
  counted: boolean;
  reason?: 'empty_group_id' | 'group_not_found' | 'throttled' | 'error';
  consumeCount?: number;
  calciumScore?: number;
}

// ══════════════════════════════════════════════════════════════
// SQL（锚点已钉死，改动须同步 assertAnchoredRead）
// ══════════════════════════════════════════════════════════════

const SQL_META =
  'SELECT dialog_group_id, belong_entity_uuid, narrative_tag, primary_emotion, ' +
  'lifecycle_state, block_calcium_score, consume_count, last_consumed_at, turn_count, ' +
  'first_ts, last_ts, block_close_reason, summary_state, block_summary, ' +
  'content_hash, summary_hash, perception_40d_snapshot, append_log ' +
  'FROM dialog_groups WHERE dialog_group_id = ?';

/**
 * 🔴 ORDER BY 必须与 `BlockArchiveService` 算哈希时**逐字一致**
 *   （seq_pos ASC, timestamp ASC）—— 否则同一组两处算出的哈希不同，
 *   存量块会被误判成「被篡改」。
 */
const SQL_CONVERSATIONS =
  'SELECT id, role, content, timestamp, seq_pos, belong_entity_uuid ' +
  'FROM conversations WHERE dialog_group_id = ? AND (is_test IS NULL OR is_test = 0) ' +
  'ORDER BY seq_pos ASC, timestamp ASC';

const SQL_CONSUME_READ =
  'SELECT consume_count, last_consumed_at, block_calcium_score ' +
  'FROM dialog_groups WHERE dialog_group_id = ?';

const SQL_CONSUME_WRITE =
  'UPDATE dialog_groups SET consume_count = ?, last_consumed_at = ?, block_calcium_score = ? ' +
  'WHERE dialog_group_id = ?';

// ══════════════════════════════════════════════════════════════
// 读取器
// ══════════════════════════════════════════════════════════════

interface MetaRow {
  dialog_group_id: string;
  belong_entity_uuid: string | null;
  narrative_tag: string | null;
  primary_emotion: string | null;
  lifecycle_state: string | null;
  block_calcium_score: number | null;
  consume_count: number | null;
  last_consumed_at: string | null;
  turn_count: number | null;
  first_ts: string | null;
  last_ts: string | null;
  block_close_reason: string | null;
  summary_state: string | null;
  block_summary: string | null;
  content_hash: string | null;
  summary_hash: string | null;
  perception_40d_snapshot: string | null;
  append_log: string | null;
}

interface ConversationRow {
  id: number | null;
  role: string;
  content: string | null;
  timestamp: string;
  seq_pos: number | null;
  belong_entity_uuid: string | null;
}

export class BArchiveReader {
  constructor(private readonly sql: BArchiveSqlSource) {}

  /**
   * 单点读取一个卷宗。组不存在 ⇒ null（不抛，调用方按「无卷宗」处理）。
   *
   * 任何异常都向上抛 —— 读取是用户主动触发的深度回忆，静默吞掉会让调用方
   * 误以为「这组没内容」。真正的兜底放在调用方（回退截断正文）。
   */
  getByGroupId(groupId: string, opts?: GetByGroupIdOptions): BArchiveRecord | null {
    const gid = String(groupId ?? '').trim();
    if (!gid) return null;

    assertAnchoredRead(SQL_META);
    assertAnchoredRead(SQL_CONVERSATIONS);

    const metas = this.sql.queryAll<MetaRow>(SQL_META, [gid]) || [];
    const meta = metas[0];
    if (!meta) return null;

    // 🔴 必须保留**原始数据库行**（字段名 seq_pos）：
    //   内容哈希口径按 seq_pos 拼接，若拿映射后的驼峰对象去算（seq_pos 为 undefined），
    //   写入侧与校验侧就会算出两个不同的值 ⇒ 所有存量块被误判为「被篡改」。
    //   本轮实测即此 bug（单测首跑 3 条红）：校验侧一律用 rawRows。
    const rawRows = this.sql.queryAll<ConversationRow>(SQL_CONVERSATIONS, [gid]) || [];
    const allRows = rawRows
      .map((r) => ({
        id: r.id ?? null,
        role: String(r.role ?? ''),
        content: String(r.content ?? ''),
        timestamp: String(r.timestamp ?? ''),
        seqPos: r.seq_pos ?? null,
        belongEntityUuid: r.belong_entity_uuid ?? null,
      }));

    // 会晤安全：只保留「公开轮次（无归属）」与「归属=听众」的行
    const audience = opts?.audienceUuid ? String(opts.audienceUuid).trim() : '';
    const visible = audience
      ? allRows.filter((r) => !r.belongEntityUuid || r.belongEntityUuid === audience)
      : allRows;

    return {
      dialogGroupId: String(meta.dialog_group_id),
      belongEntityUuid: meta.belong_entity_uuid ?? null,
      narrativeTag: meta.narrative_tag ?? null,
      primaryEmotion: meta.primary_emotion ?? null,
      lifecycleState: meta.lifecycle_state ?? null,
      blockCalciumScore: Number(meta.block_calcium_score) || 0,
      consumeCount: Number(meta.consume_count) || 0,
      lastConsumedAt: meta.last_consumed_at ?? null,
      turnCount: Number(meta.turn_count) || allRows.length,
      firstTs: meta.first_ts ?? null,
      lastTs: meta.last_ts ?? null,
      blockCloseReason: meta.block_close_reason ?? null,
      summaryState: meta.summary_state ?? null,
      summary: meta.block_summary ?? null,
      contentHash: meta.content_hash ?? null,
      summaryHash: meta.summary_hash ?? null,
      snapshot: parseSnapshot(meta.perception_40d_snapshot),
      appendLog: parseAppendLog(meta.append_log),
      conversations: visible,
      speakerNames: this.resolveSpeakerNames(visible),
      // 🔴 完整性校验必须用**全量行**（含不可见轮次）—— 存量哈希是按全量算的。
      //   用可见行去校验，会晤场景下必然「不匹配」，那是假警报。
      integrity: {
        contentHashMatches: meta.content_hash ? computeContentHash(rawRows) === meta.content_hash : null,
        summaryHashMatches: meta.summary_hash ? computeSummaryHash(meta.block_summary) === meta.summary_hash : null,
      },
    };
  }

  /**
   * 渲染高保真回放文本（带真实说话人）。
   *
   * 空卷宗返回 ''（调用方据此回退截断正文）。
   * 超出 `RENDER_MAX_CHARS` 时截断并显式告知未展开轮数 —— 不静默丢弃。
   */
  render(record: BArchiveRecord, opts?: { maxChars?: number }): string {
    const rows = record.conversations || [];
    if (rows.length === 0) return '';

    const max = Number(opts?.maxChars) > 0 ? Number(opts?.maxChars) : RENDER_MAX_CHARS;
    const date = String(record.firstTs || '').slice(0, 10) || '未知日期';
    const tag = record.narrativeTag || record.primaryEmotion || '对话';
    const head = `【卷宗回放 · ${date} · ${tag}】共 ${rows.length} 轮`;
    const summaryPart = record.summary ? `\n【摘要】${record.summary}` : '';

    const parts: string[] = [head + summaryPart];
    let used = head.length + summaryPart.length;
    let truncated = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const who = r.role === 'user'
        ? '用户'
        : (r.belongEntityUuid ? (record.speakerNames[r.belongEntityUuid] ?? '玉瑶') : '玉瑶');
      const chunk = `\n【第 ${i + 1} 轮】\n${who}：${r.content}`;
      if (used + chunk.length > max) { truncated = rows.length - i; break; }
      parts.push(chunk);
      used += chunk.length;
    }

    if (truncated > 0) {
      parts.push(`\n（本卷宗共 ${rows.length} 轮，受单次回放上限 ${max} 字限制，余 ${truncated} 轮未展开）`);
    }
    return parts.join('');
  }

  /**
   * 记一次消费并（视种类）回写块级钙化 δ 因子。
   *
   * · USER_CONSUME：30 分钟内同组只计一次；加 0.3 钙分，最多计 10 次；封顶 10
   * · OPS_BACKFILL：只记日志与计数，不改钙分
   *
   * 失败一律返回 `{counted:false}` 并告警 —— 消费计数绝不能让回放本身失败。
   */
  recordConsume(groupId: string, kind: ConsumeKind): ConsumeResult {
    const gid = String(groupId ?? '').trim();
    if (!gid) return { counted: false, reason: 'empty_group_id' };

    try {
      assertAnchoredRead(SQL_CONSUME_READ);
      const rows = this.sql.queryAll<{
        consume_count: number | null;
        last_consumed_at: string | null;
        block_calcium_score: number | null;
      }>(SQL_CONSUME_READ, [gid]) || [];
      const row = rows[0];
      if (!row) return { counted: false, reason: 'group_not_found' };

      const oldCount = Number(row.consume_count) || 0;
      const oldCalcium = Number(row.block_calcium_score) || 0;
      const now = new Date().toISOString();

      // 节流只作用于用户侧：运维回填是显式批量操作，不该被「刚消费过」挡住
      // 🔴 只算出标记、**不在此处 return** —— 留痕必须先于节流分支（见下）
      let throttled = false;
      if (kind === 'USER_CONSUME' && row.last_consumed_at) {
        const last = Date.parse(String(row.last_consumed_at));
        if (Number.isFinite(last) && Date.now() - last < CONSUME_THROTTLE_MS) throttled = true;
      }

      // 🔴 唤醒留痕（P145 微调 5）：`awakened` 与 `consumer_counted` 是**两个独立事件**
      //   · awakened        = 卷宗被唤醒（每次回放都记，**含节流期**）
      //   · consumer_counted = 消费计数与钙分回写（只在实际计数时记）
      //   若把留痕放到节流 return 之后，节流窗口内的回放将完全无痕 ——
      //   「这卷宗被唤醒过几次」就永久不可追溯，与「append_log 可追溯」的意图相悖。
      appendGroupLog(this.sql, gid, makeLogEntry('awakened', 'BArchiveReader', {
        kind,
        throttled,
        consume_count: oldCount,
      }, now));

      if (throttled) {
        return { counted: false, reason: 'throttled', consumeCount: oldCount, calciumScore: oldCalcium };
      }

      const capped = kind === 'USER_CONSUME' && oldCount >= CONSUME_MAX_COUNTED;
      const counted = kind === 'USER_CONSUME' && !capped;
      const delta = counted ? CONSUME_DELTA : 0;
      const newCount = oldCount + 1;
      const newCalcium = Math.round(Math.min(CALCIUM_SCORE_MAX, oldCalcium + delta) * 100) / 100;

      assertAnchoredRead(SQL_CONSUME_WRITE);
      this.sql.writeRaw(SQL_CONSUME_WRITE, [newCount, now, newCalcium, gid]);

      appendGroupLog(this.sql, gid, makeLogEntry('consumer_counted', 'BArchiveReader', {
        kind,
        delta,
        consume_count: newCount,
        calcium_score: newCalcium,
        capped,
      }, now));

      return { counted, consumeCount: newCount, calciumScore: newCalcium };
    } catch (e) {
      console.warn('[BArchiveReader] 消费计数失败（不影响回放）:', (e as Error)?.message);
      return { counted: false, reason: 'error' };
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** 批量解析 uuid → 显示名（只读 nodes，不参与检索；失败一律回退） */
  private resolveSpeakerNames(rows: readonly BArchiveConversation[]): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const uuids = [...new Set(
        rows.map((r) => r.belongEntityUuid).filter((u): u is string => typeof u === 'string' && u.length > 0),
      )];
      if (uuids.length === 0) return out;
      const rows2 = this.sql.queryAll<{ uuid: string; name: string }>(
        `SELECT uuid, name FROM nodes WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
        uuids,
      ) || [];
      for (const r of rows2) {
        if (r && typeof r.uuid === 'string' && typeof r.name === 'string' && r.name) out[r.uuid] = r.name;
      }
    } catch { /* nodes 表缺失/查询失败 ⇒ 回放回退「玉瑶」 */ }
    return out;
  }
}

/** 解析 40D 快照 JSON（非法 ⇒ null，不伪造） */
function parseSnapshot(raw: unknown): BArchiveSnapshot | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as BArchiveSnapshot;
  } catch {
    return null;
  }
}
