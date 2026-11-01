/**
 * BlockArchiveService — B 链路「沉睡卷宗」归档服务（P145 批 A2）
 * ================================================================
 * 职责：为 `dialog_groups` 补 `content_hash` 与 `append_log`，使卷宗具备
 *       「可校验 + 可追溯」两项基本能力（T002 Phase 3 / P145 微调 4·5）。
 *
 * 🔴 为什么在后台而不是闭组热路径
 *   闭组（flushDialogGroup）时 conversations 可能还没写完最后一轮 ⇒ 此刻算出来的
 *   哈希会漏内容，而哈希一旦写进去就不可逆。后台按「content_hash IS NULL」扫描，
 *   届时原文已完整。这也天然覆盖**存量回填**：老组没有哈希，下一批就被扫到。
 *
 * 🔴 断点续传靠数据库，不靠内存队列
 *   同 BlockSummaryService：扫描条件本身就是进度，进程重启自动接着跑。
 *
 * 🔴 不伪造数据
 *   没有 conversations 的组不写哈希（保持 NULL），只在 append_log 记一条 skipped 原因。
 *
 * 🔴 写入必须经运行中的服务
 *   只通过传入的 SQLiteAdapter 写入（writeRaw 触发防抖落盘）。
 *   禁止另起 sql.js 实例离线改库 —— 内存库 flush 会覆盖磁盘（本仓有 229MB→3.9MB 事故）。
 *
 * 哈希口径（P145 微调 4，**不可再改**）：
 *   只覆盖 conversations 原文，按 seq_pos ASC（同序再按 timestamp ASC），
 *   每行拼接 `seq_pos  role  content`，行间用  分隔，sha256 取前 32 hex。
 *   **不含** block_summary —— 摘要会重生成，混在一算则每次都要全量重算，
 *   且无法区分「原文变了」还是「摘要变了」。摘要由 summary_hash 独立承载（后续批次）。
 *
 * 🔴 40D 快照不在此服务内
 *   perception_40d_snapshot 需要先理清 memories.perception_40d 的编码格式与逐轮关联，
 *   另立 A3 批次。本服务只负责哈希与日志，两者解耦，各自可独立验证。
 */

import { createHash } from 'node:crypto';
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';

export interface BlockArchiveServiceOptions {
  /** 惰性取 SQLiteAdapter（server 初始化期 storage 才赋值） */
  getSql: () => SQLiteAdapter | null;
  /** 后台扫描间隔，默认 10 分钟 */
  intervalMs?: number;
  /** 单批最多处理多少组，默认 100 */
  batchSize?: number;
  /** 首次启动延迟，默认 60 秒（避开启动高峰） */
  initialDelayMs?: number;
}

export interface BlockArchiveBatchResult {
  scanned: number;
  filled: number;
  skipped: number;
  failed: number;
}

/** append_log 条目（P145 微调 5） */
interface AppendLogEntry {
  ts: string;
  type: string;
  actor: string;
  detail: Record<string, unknown>;
}

export class BlockArchiveService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly initialDelayMs: number;

  constructor(private readonly opts: BlockArchiveServiceOptions) {
    this.intervalMs = opts.intervalMs ?? 10 * 60_000;
    this.batchSize = opts.batchSize ?? 100;
    this.initialDelayMs = opts.initialDelayMs ?? 60_000;
  }

  /** 启动后台定时器（幂等）。定时器 unref，不阻止进程退出。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runBatch().catch((e) => console.warn('[BlockArchive] 批处理异常:', (e as Error)?.message));
    }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();

    this.initialTimer = setTimeout(() => {
      void this.runBatch().catch((e) => console.warn('[BlockArchive] 首轮异常:', (e as Error)?.message));
    }, this.initialDelayMs);
    (this.initialTimer as unknown as { unref?: () => void }).unref?.();
    console.log(`[BlockArchive] 已启动（每 ${Math.round(this.intervalMs / 60000)} 分钟一批 ${this.batchSize} 组）`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
  }

  /**
   * 跑一批：扫描 content_hash 为空的组 → 计算哈希 → 写库 → 追加日志。
   * 同一时刻只允许一个批次；重叠时直接返回空结果。
   */
  async runBatch(): Promise<BlockArchiveBatchResult> {
    const empty: BlockArchiveBatchResult = { scanned: 0, filled: 0, skipped: 0, failed: 0 };
    if (this.running) return empty;
    const sql = this.opts.getSql();
    if (!sql || typeof sql.queryAll !== 'function') return empty;

    this.running = true;
    let filled = 0, skipped = 0, failed = 0, scanned = 0;
    try {
      const rows = sql.queryAll<{ dialog_group_id: string }>(
        'SELECT dialog_group_id FROM dialog_groups ' +
        'WHERE content_hash IS NULL ORDER BY first_ts ASC LIMIT ?',
        [this.batchSize],
      );
      scanned = rows.length;

      for (const row of rows) {
        const dgId = String(row.dialog_group_id);
        try {
          const outcome = this.fillOne(sql, dgId);
          if (outcome === 'filled') filled++;
          else skipped++;
        } catch (e) {
          failed++;
          console.warn(`[BlockArchive] ${dgId} 归档失败:`, (e as Error)?.message);
        }
      }

      if (scanned > 0) {
        console.log(`[BlockArchive] 批完成: 扫描${scanned} 成功${filled} 跳过${skipped} 失败${failed}`);
      }
      return { scanned, filled, skipped, failed };
    } finally {
      this.running = false;
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private fillOne(sql: SQLiteAdapter, dgId: string): 'filled' | 'skipped' {
    const convs = sql.queryAll<{ role: string; content: string | null; seq_pos: number | null }>(
      'SELECT role, content, seq_pos FROM conversations ' +
      'WHERE dialog_group_id = ? AND (is_test IS NULL OR is_test = 0) ' +
      'ORDER BY seq_pos ASC, timestamp ASC',
      [dgId],
    ) || [];

    // 空组不伪造哈希：保持 NULL，只留一条可审计的跳过原因
    if (convs.length === 0) {
      this.appendLog(sql, dgId, {
        ts: new Date().toISOString(),
        type: 'content_hashed',
        actor: 'BlockArchiveService',
        detail: { skipped: 'no_conversations' },
      });
      return 'skipped';
    }

    const payload = convs
      .map((c) => `${c.seq_pos ?? ''}${c.role ?? ''}${c.content ?? ''}`)
      .join('');
    const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);

    const now = new Date().toISOString();
    sql.writeRaw(
      'UPDATE dialog_groups SET content_hash = ?, updated_at = ? WHERE dialog_group_id = ? AND content_hash IS NULL',
      [hash, now, dgId],
    );
    this.appendLog(sql, dgId, {
      ts: now,
      type: 'content_hashed',
      actor: 'BlockArchiveService',
      detail: { rounds: convs.length, hash_prefix: hash.slice(0, 8) },
    });
    return 'filled';
  }

  /**
   * 追加一条日志。**只追加、永不修改既有条目**（P145 微调 5）。
   * 解析失败以空数组重建（不抛）—— 损坏的旧日志不能阻断归档。
   */
  private appendLog(sql: SQLiteAdapter, dgId: string, entry: AppendLogEntry): void {
    try {
      const rows = sql.queryAll<{ append_log: string | null }>(
        'SELECT append_log FROM dialog_groups WHERE dialog_group_id = ?',
        [dgId],
      ) || [];
      let log: AppendLogEntry[] = [];
      const raw = rows[0]?.append_log;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) log = parsed as AppendLogEntry[];
        } catch { log = []; }
      }
      log.push(entry);
      sql.writeRaw(
        'UPDATE dialog_groups SET append_log = ?, updated_at = ? WHERE dialog_group_id = ?',
        [JSON.stringify(log), entry.ts, dgId],
      );
    } catch (e) {
      console.warn(`[BlockArchive] ${dgId} 日志追加失败（不阻断归档）:`, (e as Error)?.message);
    }
  }
}
