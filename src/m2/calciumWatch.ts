/**
 * calciumWatch — 钙化变更溯源（P0-5b′ · 方案乙「快照差分」）
 * ================================================================
 * 为什么需要它（P0-5b 的死胡同）：
 *   《P0-5 钙化升级机制调查报告》§4 用实测证明，**事后取证不可能查明「钙化凭什么爬到 10」**：
 *     ① `memories` 只存当前值，**没有任何钙化变更的历史**；
 *     ② 两个来源字段的值域已被污染（`promotion_reason` 的 7 种值里混着 `locus_path` 风格的值）；
 *     ③ id 反查只对 7/35 条有效。
 *   本模块补的就是缺口① —— 让「哪一行、在哪个时段、涨/跌了多少」第一次可被看到。
 *
 * 设计要点（为什么是「差分」而不是「快照」）：
 *   - 内存保留上一拍 `Map<id, calcium_score>`，每 15 分钟扫一次全表 `(id, calcium_score)`，
 *     与上一拍**差分**，**只把发生变化的行**写进 `calcium_change_log`。
 *     成本 = 「每个采样间隔真正变动的行数」，而不是每次 9597 行 —— 后者会迅速撑大库并拖慢落盘
 *     （本库是全量序列化写回，每次约 271MB）。
 *   - 这同时让「方案甲（精确事件埋点）」天然复用同一张表：日后只需在各加钙点补写 `source` 标签，
 *     不必另起炉灶。本批写入的行 `source='snapshot_diff'`，语义是「观测到变了，但不知是谁改的」。
 *
 * 已知边界（不冒充能力）：
 *   - 进程启动后的**第一拍只建基线、不记差分** ⇒ 重启会丢掉一拍。这是刻意取舍：宁可漏一拍，
 *     也不要把「重启后全体行都算作变化」这种假数据灌进日志。
 *   - 同一采样间隔内有多个加钙点运行时，归属只能靠**时间窗 + 各站点自身的 console 日志**推断
 *     （AQC `[SandQC]`、双向同步 `[BiSync]`、睡眠巩固 `[SleepTime]` 本来就会打印）。
 *     要精确归属需方案甲的事件埋点，属后续增量。
 *
 * 本模块**只读 memories、只写新表**：不改任何钙化值、不改表结构、不删数据、不参与检索。
 */
import type { SQLiteAdapter } from './SQLiteAdapter.js';

/** 观测到的变更行 */
export interface CalciumChange {
  id: string;
  oldValue: number;
  newValue: number;
}

export interface CalciumWatchOptions {
  /** 采样间隔（毫秒），默认 15 分钟 */
  intervalMs?: number;
  /** 每个 memory_id 保留的最近条数，默认 30 */
  keepPerMemory?: number;
  /** 全局保留天数，默认 90 天 */
  keepDays?: number;
  /** 单次 tick 最多落库的变更行数（防异常尖峰一次性灌爆），默认 500 */
  maxChangesPerTick?: number;
}

export const CALCIUM_WATCH_DEFAULTS = {
  intervalMs: 15 * 60 * 1000,
  keepPerMemory: 30,
  keepDays: 90,
  maxChangesPerTick: 500,
} as const;

/** 差分结果（纯数据，便于单测直接断言） */
export interface CalciumDiff {
  changes: CalciumChange[];
  next: Map<string, number>;
  /** true = 本次只是建基线，changes 恒为空 */
  isBaseline: boolean;
  /** 因为 maxChangesPerTick 被截断而**未落库**的行数（0 表示没丢） */
  truncated: number;
}

/**
 * 纯函数：对比上一拍基线与本拍快照，求出变化行。
 *
 * 刻意做成不依赖数据库的纯函数 —— 差分逻辑是本模块唯一有判断的地方，
 * 必须能脱离 sql.js 直接单测（本仓「防线依赖的判据要有测试」的教训见 P0-4）。
 *
 * @param prev 上一拍基线；null 表示首次运行（只建基线）
 * @param curr 本拍快照
 * @param maxChanges 单次最多产出的变更数
 */
export function diffCalcium(
  prev: Map<string, number> | null,
  curr: Array<{ id: string; calcium_score: unknown }>,
  maxChanges: number = CALCIUM_WATCH_DEFAULTS.maxChangesPerTick,
): CalciumDiff {
  const next = new Map<string, number>();
  for (const r of curr) next.set(String(r.id), Number(r.calcium_score) || 0);

  if (prev === null) {
    return { changes: [], next, isBaseline: true, truncated: 0 };
  }

  const all: CalciumChange[] = [];
  for (const [id, newValue] of next) {
    const oldValue = prev.get(id);
    // 新增行（上一拍不存在）不计为「钙化变更」—— 它是新记忆出生，不是存量被人改动。
    // 这一条很重要：否则每次对话产生的新记忆都会灌进日志，淹没真正的「爬升」信号。
    if (oldValue === undefined) continue;
    if (oldValue !== newValue) all.push({ id, oldValue, newValue });
  }

  const truncated = Math.max(0, all.length - maxChanges);
  return { changes: truncated > 0 ? all.slice(0, maxChanges) : all, next, isBaseline: false, truncated };
}

/** 读全表快照（只取两列，9597 行量级开销可忽略） */
export function snapshotCalcium(sqlite: SQLiteAdapter): Array<{ id: string; calcium_score: unknown }> {
  return sqlite.queryAll<{ id: string; calcium_score: unknown }>(
    'SELECT id, calcium_score FROM memories',
  );
}

/** 落库：只写变化行 */
export function persistChanges(
  sqlite: SQLiteAdapter,
  changes: readonly CalciumChange[],
  at: string,
  source = 'snapshot_diff',
): void {
  for (const c of changes) {
    try {
      sqlite.writeRaw(
        'INSERT OR REPLACE INTO calcium_change_log (memory_id, changed_at, old_value, new_value, source) VALUES (?, ?, ?, ?, ?)',
        [c.id, at, c.oldValue, c.newValue, source],
      );
    } catch { /* 单行失败不阻塞本拍 */ }
  }
}

/**
 * 裁剪日志表。
 * 照 `decay_log` 既有做法（窗口函数单遍扫描，sql.js 1.11 支持；避免相关子查询 O(N²)）。
 * 依据：`SQLiteAdapter` 中 decay_log 的注释已踩过坑 —— 日志表无界增长会撑大库、拖慢落盘。
 */
export function trimCalciumLog(sqlite: SQLiteAdapter, keepPerMemory: number, keepDays: number): void {
  try {
    sqlite.writeRaw(
      `DELETE FROM calcium_change_log WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY changed_at DESC) AS rn
           FROM calcium_change_log
         ) WHERE rn > ?
       )`,
      [keepPerMemory],
    );
  } catch (e) { console.warn('[CalciumWatch] 按行裁剪失败(非阻塞):', (e as Error)?.message); }

  if (keepDays > 0) {
    try {
      const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
      sqlite.writeRaw('DELETE FROM calcium_change_log WHERE changed_at < ?', [cutoff]);
    } catch (e) { console.warn('[CalciumWatch] 按天裁剪失败(非阻塞):', (e as Error)?.message); }
  }
}

/** 模块级基线 —— 进程内单例，随进程重启自然重置（见文件头「已知边界」） */
let _baseline: Map<string, number> | null = null;

/** 仅供测试重置内部状态 */
export function _resetBaselineForTest(): void { _baseline = null; }

/**
 * 执行一拍。导出为独立函数以便单测与手工触发，不依赖定时器。
 * @returns 本拍实际落库的变更数
 */
export function runCalciumWatchTick(sqlite: SQLiteAdapter, opts: CalciumWatchOptions = {}): number {
  const o = { ...CALCIUM_WATCH_DEFAULTS, ...opts };
  const snap = snapshotCalcium(sqlite);
  const diff = diffCalcium(_baseline, snap, o.maxChangesPerTick);
  _baseline = diff.next;

  if (diff.isBaseline) {
    console.log(`[CalciumWatch] 基线建立: ${diff.next.size} 行（首拍不记差分）`);
    return 0;
  }
  if (diff.changes.length === 0) return 0;

  const at = new Date().toISOString();
  persistChanges(sqlite, diff.changes, at);

  const up = diff.changes.filter((c) => c.newValue > c.oldValue).length;
  const down = diff.changes.length - up;
  console.log(`[CalciumWatch] 本拍钙化变更 ${diff.changes.length} 行（升 ${up} / 降 ${down}）`);
  if (diff.truncated > 0) {
    console.warn(`[CalciumWatch] ⚠️ 变更数超上限，本拍有 ${diff.truncated} 行未落库（上限 ${o.maxChangesPerTick}）—— 请上调上限，否则日志有缺口`);
  }

  trimCalciumLog(sqlite, o.keepPerMemory, o.keepDays);
  return diff.changes.length;
}

/**
 * 启动监视器。
 *
 * 刻意接收 `addTimer` 而不是自带 `setInterval`：与其余所有后台定时器**同规**，
 * 在 `WS_LAZY_TIMERS` 省 token 模式下一起停摆 —— 不允许存在"一个偷偷跑的定时器"。
 */
export function startCalciumWatch(
  sqlite: SQLiteAdapter,
  addTimer: (t: NodeJS.Timeout) => unknown,
  opts: CalciumWatchOptions = {},
): void {
  const o = { ...CALCIUM_WATCH_DEFAULTS, ...opts };
  addTimer(setInterval(() => {
    try { runCalciumWatchTick(sqlite, o); }
    catch (e) { console.warn('[CalciumWatch] tick 失败(非阻塞):', (e as Error)?.message); }
  }, o.intervalMs));
  console.log(`  钙化变更溯源已启动 ✓ (每 ${Math.round(o.intervalMs / 60000)} 分钟采样一次)`);
}
