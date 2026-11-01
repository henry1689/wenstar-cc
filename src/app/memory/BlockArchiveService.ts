/**
 * BlockArchiveService — B 链路「沉睡卷宗」归档服务（P145 批 A2 + A3）
 * ====================================================================
 * 职责：为 `dialog_groups` 补三项卷宗化数据（T002 Phase 3 / P145 微调 1·4·5）：
 *   · content_hash            —— 组内 conversations 原文的 sha256（可校验）
 *   · perception_40d_snapshot —— 组级 40D 聚合快照（可高保真回放）
 *   · append_log              —— 只追加的事件日志（可追溯）
 *
 * 🔴 为什么在后台而不是闭组热路径
 *   闭组（flushDialogGroup）时 conversations 可能还没写完最后一轮 ⇒ 此刻算出来的
 *   哈希会漏内容，而哈希一旦写进去就不可逆。后台按「哈希或快照为空」扫描，
 *   届时原文已完整。这也天然覆盖**存量回填**：老组没有这些列值，下一批就被扫到。
 *
 * 🔴 断点续传靠数据库，不靠内存队列
 *   同 BlockSummaryService：扫描条件本身就是进度，进程重启自动接着跑。
 *
 * 🔴 不伪造数据
 *   没有 conversations 的组不写哈希（保持 NULL），只在 append_log 记跳过原因。
 *   没有 40D 数据的组写 `agg:'none'` 的**显式占位**（而不是 NULL）——
 *   写 NULL 会导致该组每批都被重新扫到，无限循环。
 *
 * 🔴 写入必须经运行中的服务
 *   只通过传入的 SQLiteAdapter 写入（writeRaw 触发防抖落盘）。
 *   禁止另起 sql.js 实例离线改库 —— 内存库 flush 会覆盖磁盘（本仓有 229MB→3.9MB 事故）。
 *
 * 哈希口径（P145 微调 4，**口径一经落地不可再改**）：
 *   只覆盖 conversations 原文：按 seq_pos ASC（同序再按 timestamp ASC），
 *   每行拼接 `seq_pos  role  content`，行间用 `` 分隔，
 *   sha256 取前 32 hex。**不含** block_summary —— 摘要会重生成，混在一算则每次都要
 *   全量重算，且无法区分「原文变了」还是「摘要变了」。摘要由 summary_hash 独立承载。
 *
 * 40D 快照口径（P145 微调 1）：
 *   数据源 = `memories.perception_40d`（组内逐轮）。逐维**等权平均**（agg='mean'）。
 *   P145 原写「按钙分加权」，但对话组结构内未保留逐轮钙分（dg 只有 perceptions 数组
 *   与 maxCalcium 峰值）；为实现可解释且不伪造，本批采用等权平均并如实标注。
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

/** 哈希字段分隔符 / 行分隔符 —— 具名常量，避免再次写丢不可见字符 */
const SEP_FIELD = '';
const SEP_ROW = '';

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
   * 跑一批：扫描「哈希或快照为空」的组 → 计算 → 写库 → 追加日志。
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
        'WHERE content_hash IS NULL OR perception_40d_snapshot IS NULL ' +
        'ORDER BY first_ts ASC LIMIT ?',
        [this.batchSize],
      );
      scanned = rows.length;

      for (const row of rows) {
        const dgId = String(row.dialog_group_id);
        try {
          const outcome = await this.fillOne(sql, dgId);
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

  private async fillOne(sql: SQLiteAdapter, dgId: string): Promise<'filled' | 'skipped'> {
    let did = false;

    // 幂等前提：已有值不重算（否则每批都会重写一遍）
    const cur = sql.queryAll<{ content_hash: string | null; perception_40d_snapshot: string | null }>(
      'SELECT content_hash, perception_40d_snapshot FROM dialog_groups WHERE dialog_group_id = ?',
      [dgId],
    ) || [];
    const needHash = !cur[0]?.content_hash;
    const needSnap = !cur[0]?.perception_40d_snapshot;

    if (needHash) {
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
      } else {
        const payload = convs
          .map((c) => `${c.seq_pos ?? ''}${SEP_FIELD}${c.role ?? ''}${SEP_FIELD}${c.content ?? ''}`)
          .join(SEP_ROW);
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
        did = true;
      }
    }

    // ── 组级 40D 快照（P145 微调 1）──
    if (needSnap) {
      if (await this.fillSnapshot(sql, dgId)) did = true;
    }

    return did ? 'filled' : 'skipped';
  }

  /**
   * 组级 40D 聚合快照。
   *
   * 🔴 数据源：`memories.perception_40d`（组内逐轮 40D）。
   * 🔴 聚合：逐维等权平均（agg='mean'），如实标注，不伪造「钙分加权」。
   * 🔴 无 40D 的组写 `agg:'none'` 显式占位（不是 NULL）—— 否则每批都会被重新扫到。
   *
   * @returns true = 本次写了快照（含 none 占位）
   */
  private async fillSnapshot(sql: SQLiteAdapter, dgId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const writeSnapshot = (obj: Record<string, unknown>): void => {
      sql.writeRaw(
        'UPDATE dialog_groups SET perception_40d_snapshot = ?, updated_at = ? ' +
        'WHERE dialog_group_id = ? AND perception_40d_snapshot IS NULL',
        [JSON.stringify(obj), now, dgId],
      );
    };

    try {
      const rows = sql.queryAll<{ perception_40d: string | null }>(
        'SELECT perception_40d FROM memories WHERE dialog_group_id = ? AND perception_40d IS NOT NULL',
        [dgId],
      ) || [];

      const { decodePerceptionV40 } = await import('../../m2/PerceptionVector40DCodec.js');
      const { PERCEPTION_40D_DIM, PERCEPTION_40D_KEYS } = await import('../../m3/types/perception-40d.js');

      const vectors: number[][] = [];
      for (const r of rows) {
        try {
          const p = decodePerceptionV40(r.perception_40d) as unknown as Record<string, number> | null;
          if (!p) continue;
          const arr = PERCEPTION_40D_KEYS.map((k) => Number((p as Record<string, unknown>)[k as string]) || 0);
          if (arr.length === PERCEPTION_40D_DIM) vectors.push(arr);
        } catch { /* 单条解码失败跳过，不影响整组 */ }
      }

      if (vectors.length === 0) {
        // 🔴 2026-11-02 格式修正：`dims` 必须是**数组**，`decodePerceptionV40` 才走 v2 分支。
        //   原写法 `dims: 40`（数字）会让 hasV2Shape 判 false → 落 v0 命名键分支
        //   → 静默解出全零向量，违反《40D 量纲统一法令》第四条「不得填 0 冒充」。
        //   无数据时写**空数组**：parseV2Dims 长度校验失败 ⇒ 解码返回 null（正确的「无向量」语义）。
        writeSnapshot({
          dims: [], agg: 'none', dim_version: 'v1', generated_at: now,
          reason: 'no_40d_data',
        });
        this.appendLog(sql, dgId, {
          ts: now, type: 'snapshot_created', actor: 'BlockArchiveService',
          detail: { skipped: 'no_40d_data', rows: rows.length },
        });
        return true;
      }

      const avg = new Array<number>(PERCEPTION_40D_DIM).fill(0);
      for (const v of vectors) for (let i = 0; i < PERCEPTION_40D_DIM; i++) avg[i] += v[i];
      for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
        avg[i] = Math.round((avg[i] / vectors.length) * 10000) / 10000;
      }

      // 🔴 2026-11-02：`dims` 直接放 40 维数组（原为数字 40 + 独立的 vector 字段，
      //   decodePerceptionV40 只认 dims 数组，原格式会被静默解析成全零）。
      writeSnapshot({
        dims: avg, agg: 'mean', dim_version: 'v1', generated_at: now,
        rounds: vectors.length,
      });
      this.appendLog(sql, dgId, {
        ts: now, type: 'snapshot_created', actor: 'BlockArchiveService',
        detail: { agg: 'mean', rounds: vectors.length },
      });
      return true;
    } catch (e) {
      console.warn(`[BlockArchive] ${dgId} 40D 快照生成失败:`, (e as Error)?.message);
      return false;
    }
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
