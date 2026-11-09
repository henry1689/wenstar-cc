/**
 * bArchiveLog — `dialog_groups.append_log` 的**唯一追加实现**（P145 批 B 抽离）
 * ======================================================================
 * 微调 5 定稿：append_log 是 JSON 数组 TEXT，条目形态
 *   `{ "ts": ISO, "type": <枚举>, "actor": string, "detail": object }`
 *
 * 🔴 只追加，永不修改既有条目
 *   勘误走 `erratum` 新条目，**不回改**旧条目 —— 日志的价值在于「当时确实这么记了」。
 *   连「条数太多」也不允许裁剪：裁剪最老条目同样是修改，日志必须能回答
 *   「当时到底发生过什么」。增长控制靠**上游节流**（消费计数 30 分钟内同组只记一次），
 *   触碰 `WARN_ENTRIES` 水位应当告警排查，而不是静默丢弃证据。
 *
 * 🔴 为什么单独成模块
 *   B 链路的写日志点分散在归档服务（BlockArchiveService）、摘要服务（BlockSummaryService）、
 *   唤醒读取器（BArchiveReader）。若各自内联一份「读—parse—push—写」，
 *   任一处改了容错口径（空串 / 非法 JSON / 非数组）就会产生三种行为。
 *   本仓不变量 #7：同一业务规则禁止多处实现。
 *
 * 🔴 解析失败以空数组重建、不抛
 *   损坏的旧日志不能阻断归档与唤醒 —— 截断写入是真实可能发生的（进程被杀 / 磁盘满）。
 *   重建时**不静默**：先补一条 `erratum` 记录原值前缀，使损失可追溯。
 *
 * 🔴 `type` 枚举只增不改（微调 5）。本文件即枚举的唯一声明处。
 *   `content_hashed` 是批 A 落地时**新增**的条目类型（T002 原文未列），
 *   记于此并在 P145 任务书留痕 —— 属于「只增」范围内的扩展，不是改名。
 */

// 🔴 依赖单向：业务层 → memwen 核心库（ADR-024）；链原语唯一实现落 memwen
import { chainHash, sha256Hex, MW_GENESIS } from '../../memwen/hash-chain.js';
import { stableStringify } from '../../memwen/canon.js';

/** append_log 条目类型（枚举只增不改） */
export type BArchiveLogType =
  | 'snapshot_created'      // 闭组生成 40D 快照
  | 'content_hashed'        // 批 A 新增：原文内容哈希落库
  | 'summary_generated'     // 摘要首次生成
  | 'summary_regenerated'   // 摘要重生成
  | 'calcium_promoted'      // 组级钙化晋升
  | 'lifecycle_changed'     // 生命周期流转
  | 'awakened'              // 深度回忆单点唤醒
  | 'consumer_counted'      // 消费计数（USER_CONSUME / OPS_BACKFILL）
  | 'erratum';              // 勘误

/** 一条日志 */
export interface AppendLogEntry {
  ts: string;
  type: BArchiveLogType;
  actor: string;
  detail: Record<string, unknown>;
  /**
   * 归档事件链（ADR-024 附录 v2 §6.1 分段链，段=组）：
   * C_i = chainHash(C_{i-1}, sha256(stableStringify({ts,type,actor,detail})))
   * - 仅**新追加**的条目携带（旧条目不回改 —— append-only 语义不变）；
   * - 链头自取（末条 entry 的 chain，无则 MW_GENESIS），无全局单点；
   * - 验证见 BArchiveReader.verifyAppendChain。
   */
  chain?: string;
}

/**
 * 日志条数告警水位（**只告警、不裁剪**）。
 *
 * 触碰水位说明上游节流失效，或该组被异常高频消费 —— 此时应当告警排查，
 * 而不是静默丢弃证据（见文件头「只追加」）。
 */
export const WARN_ENTRIES = 200;

/** 只读+写 数据源（结构类型，够用即可，不引入 SQLiteAdapter 全量契约） */
export interface AppendLogSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
  writeRaw(sql: string, ...params: unknown[]): unknown;
}

/** 解析 append_log 文本为数组（非法 / 非数组 ⇒ 空数组） */
export function parseAppendLog(raw: unknown): AppendLogEntry[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AppendLogEntry[]) : [];
  } catch {
    return [];
  }
}
/**
 * 追加一条日志。
 *
 * 结构上**不可能**修改既有条目：只做 `log.push(entry)` 后整体写回，
 * 既有元素的字段一个都不动（不重排、不补齐、不裁剪）。
 *
 * @returns true = 已写入；false = 写入失败（已告警，调用方不必处理）
 */
export function appendGroupLog(
  sql: AppendLogSqlSource,
  dgId: string,
  entry: AppendLogEntry,
): boolean {
  try {
    const rows = sql.queryAll<{ append_log: string | null }>(
      'SELECT append_log FROM dialog_groups WHERE dialog_group_id = ?',
      [dgId],
    ) || [];
    const raw = rows[0]?.append_log;
    const log = parseAppendLog(raw);

    // 损坏重建时留痕（损失可追溯，且不阻断本次追加）
    if (typeof raw === 'string' && raw.length > 0 && log.length === 0) {
      log.push({
        ts: entry.ts,
        type: 'erratum',
        actor: 'bArchiveLog',
        detail: { reason: 'append_log_unparsable', raw_prefix: raw.slice(0, 120) },
      });
    }

    log.push(entry);
    // 🔴 链值计算（fail-open：链失败不阻断追加，与本模块告警风格一致）
    //   旧条目无 chain → 新链从本条起算（prev=GENESIS）；有则续链。
    try {
      const prev = log.length >= 2 ? (log[log.length - 2]!.chain ?? MW_GENESIS) : MW_GENESIS;
      const body = { ts: entry.ts, type: entry.type, actor: entry.actor, detail: entry.detail };
      entry.chain = chainHash(prev, sha256Hex(stableStringify(body)));
    } catch (e) {
      console.warn(`[BArchiveLog] ${dgId} 链值计算失败（条目仍写入，链自下条续）:`, (e as Error)?.message);
    }
    if (log.length >= WARN_ENTRIES) {
      console.warn(`[BArchiveLog] ${dgId} 日志条数 ${log.length} 已达告警水位 ${WARN_ENTRIES}（不裁剪，请排查上游节流）`);
    }

    sql.writeRaw(
      'UPDATE dialog_groups SET append_log = ?, updated_at = ? WHERE dialog_group_id = ?',
      [JSON.stringify(log), entry.ts, dgId],
    );
    return true;
  } catch (e) {
    console.warn(`[BArchiveLog] ${dgId} 日志追加失败（不阻断主流程）:`, (e as Error)?.message);
    return false;
  }
}

/** 便捷构造（ts 默认当前时间） */
export function makeLogEntry(
  type: BArchiveLogType,
  actor: string,
  detail: Record<string, unknown> = {},
  ts?: string,
): AppendLogEntry {
  return { ts: ts ?? new Date().toISOString(), type, actor, detail };
}
