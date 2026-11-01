/**
 * GapLedger — 检索架构 v11 §S1.1 每日缺口台账
 * =======================================================
 * 方案②「明示接受退化」的四条强制配套之一（业主 2026-10-27 选定）。
 *
 * 【它记什么】
 * S1 停掉了 conversation 写入 n-gram 倒排索引 ⇒ 退化窗口内新产生的对话
 * 无法被旧链路字面召回。本模块把**每天新增且未进旧索引**的对话条数逐日留痕，
 * 作为 S3 切换后「专项回捞」的输入清单（回捞命中率要求 100%）。
 *
 * 【红线（蓝皮书 8.2 / 任务书 §S1.1 D）】
 *   - 文件：`data/retrieval-v11/gap-ledger.jsonl`，**一行一天，追加写，永不覆盖**；
 *   - 不得伪造 / 补写 / 平滑台账，`n_gap` 不得改成抽样或估算（必须精确对账）；
 *   - 进程重启不补写历史日期 —— 断档本身就是验收失败的证据，必须可见；
 *   - 本模块**只读** conversations / search_index，从不写库、从不 save()。
 *
 * 【调度】
 * `RETRIEVAL_V11_GAP_LEDGER=true` 时启用；由操作系统级定时任务每日 00:05 执行
 * `scripts/v11-gap-audit.ts --write-yesterday`（业主 2026-10-27 确认的接线方式：
 * 不改 server.ts —— 该文件在高风险清单且 CK-07 对 import>20 恒定报 warn）。
 *
 * 【字段（蓝皮书 §8.2 原文口径）】
 * date / s1_started_at / n_gap / cum_gap / conversations_total / expected_total /
 * first_gap_id / last_gap_id / verifier / note
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../../common/const/paths.js';

// ─── 落点 ───
const LEDGER_DIR = join(DATA_DIR, 'retrieval-v11');
export const LEDGER_FILE = join(LEDGER_DIR, 'gap-ledger.jsonl');
/** S1 起点基线（s1_started_at + 基线总行数），写入一次后只读 */
export const META_FILE = join(LEDGER_DIR, 'gap-ledger.meta.json');
/** 巡检告警落点（append-only，一行一条；**同 kind+date+detail 24h 内只落一条**防刷屏） */
export const ALERTS_FILE = join(LEDGER_DIR, 'alerts.jsonl');
/** 巡检状态：最近一次**库复算完成**的日期（避免高频巡检反复把 sql.js 库整个载入内存） */
export const PATROL_STATE_FILE = join(LEDGER_DIR, 'patrol-state.json');

/** 台账总开关（蓝皮书 8.2）：S1 起置 true，S3 专项回捞验收后置 false */
export const GAP_LEDGER_ENV = 'RETRIEVAL_V11_GAP_LEDGER';
/** S1 生效时刻（ISO8601，本地时区写入 .env）；缺省取首次写入时刻 */
export const S1_START_ENV = 'RETRIEVAL_V11_S1_START';

/** 台账单日记录 */
export interface GapLedgerRecord {
  /** 统计日 YYYY-MM-DD（本地时区） */
  date: string;
  /** S1 落地时刻，全程不变 */
  s1_started_at: string;
  /** 当日新增且**未进旧索引**的 conversation 条数 */
  n_gap: number;
  /** 自 s1_started_at 起的累计缺口 */
  cum_gap: number;
  /** 当日末的 conversations 表总行数 */
  conversations_total: number;
  /** s1_start_conversations_total + cum_gap */
  expected_total: number;
  /** 当日缺口区间首/尾 id（回捞用） */
  first_gap_id: string;
  last_gap_id: string;
  /** 可复现的校验命令 */
  verifier: string;
  /** 空串或自检失败/断档说明 */
  note: string;
}

/** S1 起点基线 */
export interface GapLedgerMeta {
  s1_started_at: string;
  s1_start_conversations_total: number;
  created_at: string;
}

/**
 * 本模块接受的最小数据库形状：优先走 `queryAll`（SQLiteAdapter 系），
 * 缺失时回退 sql.js 的 `exec`（脚本/测试直开库场景），避免两套取数实现漂移。
 */
export interface GapLedgerDb {
  queryAll?: (sql: string, ...params: unknown[]) => Array<Record<string, unknown>>;
  exec?: (sql: string, params?: unknown[]) => Array<{ columns: string[]; values: unknown[][] }>;
}

// ══════════════════════════════════════════════════════════════════
// 取数底层（唯一实现，buildDailyRecord 与 reconcileDate 共用）
// ══════════════════════════════════════════════════════════════════

/** 兼容 queryAll / exec 两种取数接口，统一返回对象数组 */
function queryRows(db: GapLedgerDb, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  if (typeof db.queryAll === 'function') {
    const rows = db.queryAll(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  }
  if (typeof db.exec === 'function') {
    const res = db.exec(sql, params);
    if (!res?.length || !res[0]?.values || !res[0]?.columns) return [];
    const cols = res[0].columns;
    return res[0].values.map((vals) =>
      Object.fromEntries(cols.map((c, i) => [c, vals[i]])),
    );
  }
  throw new Error('GapLedger: 数据库对象既无 queryAll 也无 exec，无法取数');
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

/**
 * 统计某一天的缺口。
 * `n_gap` 用 `NOT EXISTS` 精确判定「该行未被 search_index 收录」——
 * 不抽样、不估算（红线 3）。走 idx_si_source(source_type, source_id)。
 *
 * 🔴 时间列是 `conversations.timestamp`（ISO UTC，如 2026-10-27T02:57:41.957Z），
 *   与 `dayRangeUtc()` 生成的边界同形 ⇒ 字典序比较等价于时序比较。
 *   本表**没有** `created_at` 列（2026-10-27 实跑 `--date` 报 no such column 后确认）；
 *   蓝皮书 §8.2 表述里的「created_at 区间」是文档措辞，勿照抄成代码。
 */
function countGap(db: GapLedgerDb, startIso: string, endIso: string): { n_gap: number; first_id: string; last_id: string } {
  const rows = queryRows(db, `
    SELECT COUNT(*) AS n, MIN(c.id) AS first_id, MAX(c.id) AS last_id
      FROM conversations c
     WHERE c.timestamp >= ? AND c.timestamp < ?
       AND NOT EXISTS (
         SELECT 1 FROM search_index s
          WHERE s.source_type = 'conversation' AND s.source_id = CAST(c.id AS TEXT)
       )`, [startIso, endIso]);
  const r = rows[0];
  if (!r) return { n_gap: 0, first_id: '', last_id: '' };
  return {
    n_gap: num(r['n']),
    first_id: r['first_id'] == null ? '' : String(r['first_id']),
    last_id: r['last_id'] == null ? '' : String(r['last_id']),
  };
}

function countConversations(db: GapLedgerDb): number {
  const rows = queryRows(db, 'SELECT COUNT(*) AS total FROM conversations');
  return num(rows[0]?.['total']);
}

// ══════════════════════════════════════════════════════════════════
// 日期工具（本地时区）
// ══════════════════════════════════════════════════════════════════

/** 本地日期 → YYYY-MM-DD */
export function fmtLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD 是否合法 */
export function isDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 本地时区下该日的 [00:00, 次日 00:00) 边界，转 UTC ISO（conversations.timestamp 存的是 UTC ISO） */
export function dayRangeUtc(dateStr: string): { startIso: string; endIso: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  const end = new Date(y, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** 传入日期的**前一日**（本地时区） */
export function prevDateOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmtLocalDate(new Date(y, (m ?? 1) - 1, (d ?? 1) - 1, 12, 0, 0, 0));
}

/** 传入日期的下一日（本地时区），用于日历连续性自检 */
export function nextDateOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmtLocalDate(new Date(y, (m ?? 1) - 1, (d ?? 1) + 1, 12, 0, 0, 0));
}

// ══════════════════════════════════════════════════════════════════
// 开关 / 读写落点
// ══════════════════════════════════════════════════════════════════

/** 台账开关：仅显式 `true` 才生效（未设 = 不写任何东西，零副作用） */
export function isGapLedgerEnabled(): boolean {
  return process.env[GAP_LEDGER_ENV] === 'true';
}

export function ensureLedgerDir(): void {
  if (!existsSync(LEDGER_DIR)) mkdirSync(LEDGER_DIR, { recursive: true });
}

/**
 * 读全部台账记录（坏行跳过并告警，不静默丢弃）。
 * 🔴 `file` 参数**仅供巡检单测注入临时目录** —— 生产一律用 `LEDGER_FILE`。
 *    刻意**不做成环境变量**：`HARNESS_EXEMPTIONS_FILE` 被改指别处是已发生过的事故，
 *    审计路径可被环境变量劫持 = 台账形同虚设。
 */
function readRecordsFrom(file: string): GapLedgerRecord[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const out: GapLedgerRecord[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as GapLedgerRecord;
      if (isDateStr(String(rec?.date))) out.push(rec);
    } catch (e) {
      console.error('[GapLedger] ⚠️ 台账存在无法解析的行（未删除，原样保留）:', (e as Error).message);
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 默认落点读取（生产唯一入口） */
export function readRecords(): GapLedgerRecord[] { return readRecordsFrom(LEDGER_FILE); }

function readMetaFrom(file: string): GapLedgerMeta | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as GapLedgerMeta;
  } catch (e) {
    console.error('[GapLedger] ⚠️ 基线文件损坏（不覆盖）:', (e as Error).message);
    return null;
  }
}

export function readMeta(): GapLedgerMeta | null { return readMetaFrom(META_FILE); }

export function writeMeta(meta: GapLedgerMeta): void {
  ensureLedgerDir();
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

// ══════════════════════════════════════════════════════════════════
// 台账构建 / 追加 / 自检
// ══════════════════════════════════════════════════════════════════

/** 唯一 CLI 入口（蓝皮书 §8.2 指定的可复现校验命令即本脚本） */
const CLI_CMD = 'node node_modules/tsx/dist/cli.mjs scripts/v11-gap-audit.ts';
const VERIFIER_CMD = `${CLI_CMD} --date`;

/**
 * 构建指定日期的台账记录（**不写盘**）。
 * 三条自检（蓝皮书 8.2「对账判据」）任一失败 ⇒ `note` 写明原因，
 * 记录照常返回给调用方落盘 —— 失败必须留痕，绝不能静默跳过。
 */
export function buildDailyRecord(db: GapLedgerDb, dateStr: string): GapLedgerRecord {
  if (!isDateStr(dateStr)) throw new Error(`GapLedger: 非法日期 "${dateStr}"（需 YYYY-MM-DD）`);
  const { startIso, endIso } = dayRangeUtc(dateStr);

  const gap = countGap(db, startIso, endIso);
  const conversations_total = countConversations(db);
  const prev = readRecords().filter((r) => r.date < dateStr).pop() ?? null;

  // 首日基线由 conversations_total − n_gap 反推：
  // 当日先于 S1 产生的行已在基线内且**已进旧索引**（被 NOT EXISTS 排除），
  // 故差值正好等于「S1 生效时的总行数」，保证 expected_total 可零误差对账。
  let meta = readMeta();
  const prevCum = prev ? prev.cum_gap : 0;
  const cum_gap = prevCum + gap.n_gap;
  if (!meta) {
    meta = {
      s1_started_at: process.env[S1_START_ENV] || new Date().toISOString(),
      s1_start_conversations_total: conversations_total - gap.n_gap,
      created_at: new Date().toISOString(),
    };
    writeMeta(meta);
    console.log(`[GapLedger] 初始化基线: s1_started_at=${meta.s1_started_at} 基线总行数=${meta.s1_start_conversations_total}`);
  }
  const expected_total = meta.s1_start_conversations_total + cum_gap;

  // ── 三条自检 ──
  const notes: string[] = [];
  if (gap.n_gap < 0) notes.push(`[SELFCHECK_FAIL] n_gap 为负 (${gap.n_gap})`);
  if (cum_gap !== prevCum + gap.n_gap) notes.push(`[SELFCHECK_FAIL] 算术不自洽: cum_gap(${cum_gap}) != prev.cum_gap(${prevCum}) + n_gap(${gap.n_gap})`);
  if (conversations_total !== expected_total) {
    notes.push(`[SELFCHECK_FAIL] 总量不为零: conversations_total(${conversations_total}) != expected_total(${expected_total})，差 ${conversations_total - expected_total}`);
  }
  if (prev && nextDateOf(prev.date) !== dateStr) {
    notes.push(`[SELFCHECK_FAIL] 日历断档: 上一条 ${prev.date} 与本日 ${dateStr} 不相邻`);
  }
  if (notes.length > 0) {
    console.error(`[GapLedger] 🔴 ${dateStr} 自检未通过（记录仍落盘留痕）:\n  ${notes.join('\n  ')}`);
  }

  return {
    date: dateStr,
    s1_started_at: meta.s1_started_at,
    n_gap: gap.n_gap,
    cum_gap,
    conversations_total,
    expected_total,
    first_gap_id: gap.first_id,
    last_gap_id: gap.last_id,
    verifier: `${VERIFIER_CMD} ${dateStr}`,
    note: notes.join('; '),
  };
}

/** 追加一条记录（append-only；已存在同日记录时拒绝写入，防重复） */
export function appendRecord(rec: GapLedgerRecord): void {
  ensureLedgerDir();
  const dup = readRecords().some((r) => r.date === rec.date);
  if (dup) {
    console.error(`[GapLedger] ⚠️ 拒绝追加：${rec.date} 已有记录（台账只增不改，禁止覆盖）`);
    return;
  }
  appendFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n', 'utf-8');
}

/**
 * 每日作业：写「前一日」记录。
 * **刻意不补写更早的历史日期**（蓝皮书 8.2「进程重启不补写」）——
 * 断档是必须暴露的验收失败，补写等于伪造证据。
 */
export function runDailyJob(db: GapLedgerDb, now: Date = new Date()): { written: boolean; date?: string; reason?: string } {
  if (!isGapLedgerEnabled()) return { written: false, reason: `${GAP_LEDGER_ENV} 未置 true，台账停写` };

  const today = fmtLocalDate(now);
  const target = prevDateOf(today);
  if (readRecords().some((r) => r.date === target)) {
    return { written: false, date: target, reason: `${target} 已写过，本次跳过（幂等）` };
  }
  const rec = buildDailyRecord(db, target);
  appendRecord(rec);
  console.log(
    `[GapLedger] ✅ ${rec.date} 已记录: n_gap=${rec.n_gap} cum_gap=${rec.cum_gap} ` +
    `total=${rec.conversations_total}/${rec.expected_total}` + (rec.note ? ` ⚠️ ${rec.note}` : ''),
  );
  return { written: true, date: rec.date };
}

/**
 * 单源复算核验：对指定日期重新从库里算一遍，与台账逐字段比对。
 * 供 B2（逐日无断档）/ B3（cum_gap 算术自洽）/ B4（总量零误差）人工核验。
 */
export interface ReconcileReport {
  date: string;
  ok: boolean;
  stored: GapLedgerRecord | null;
  recomputed: { n_gap: number; conversations_total: number; first_gap_id: string; last_gap_id: string };
  diffs: string[];
}

export interface ReconcileOptions {
  /**
   * 是否比对**快照域**（`conversations_total` 与当前库总量）。
   *
   * 🔴 F-33（2026-10-28 查实）：`conversations_total` 是**写入时刻的快照**，
   *    而库总量每天都在涨 —— 拿今天复算的总量比昨天的快照**必然不等**。
   *    那不是缺陷，是口径错位：B4「总量零误差」本来就是**写入前**的自检
   *    （`buildDailyRecord` 落盘前已跑过），不能事后倒查。
   * ⇒ `snapshot: false` 时只比**日期域**字段（`n_gap` / 首尾 id），
   *   它们对该日区间不可变，跨多久复算都成立。
   *   默认 `true`：用于 `--date` 当日人工核验。
   */
  snapshot?: boolean;
  /** 只读记录（巡检注入临时台账用；缺省 `readRecords()`） */
  records?: GapLedgerRecord[];
}

export function reconcileDate(
  db: GapLedgerDb,
  dateStr: string,
  opts: ReconcileOptions = {},
): ReconcileReport {
  const snapshot = opts.snapshot !== false;
  const { startIso, endIso } = dayRangeUtc(dateStr);
  const gap = countGap(db, startIso, endIso);
  const total = countConversations(db);
  const recs = opts.records ?? readRecords();
  const stored = recs.find((r) => r.date === dateStr) ?? null;
  const diffs: string[] = [];

  if (!stored) {
    diffs.push(`台账无 ${dateStr} 记录（B2 断档）`);
  } else {
    if (stored.n_gap !== gap.n_gap) diffs.push(`n_gap 台账=${stored.n_gap} 复算=${gap.n_gap}`);
    if (snapshot && stored.conversations_total !== total) {
      diffs.push(`conversations_total 台账=${stored.conversations_total} 复算=${total}`);
    }
    if (stored.first_gap_id !== gap.first_id) diffs.push(`first_gap_id 台账=${stored.first_gap_id} 复算=${gap.first_id}`);
    if (stored.last_gap_id !== gap.last_id) diffs.push(`last_gap_id 台账=${stored.last_gap_id} 复算=${gap.last_id}`);
    if (stored.expected_total !== stored.conversations_total) {
      diffs.push(`B4 未零误差: expected_total=${stored.expected_total} conversations_total=${stored.conversations_total}`);
    }
    if (stored.cum_gap < stored.n_gap) {
      diffs.push(`B3 不自洽: cum_gap(${stored.cum_gap}) 小于单日 n_gap(${stored.n_gap})`);
    }
    const idx = recs.findIndex((r) => r.date === dateStr);
    if (idx > 0) {
      const prev = recs[idx - 1];
      if (prev.cum_gap + stored.n_gap !== stored.cum_gap) {
        diffs.push(`B3 跨日不自洽: prev.cum_gap(${prev.cum_gap}) + n_gap(${stored.n_gap}) != cum_gap(${stored.cum_gap})`);
      }
      if (nextDateOf(prev.date) !== stored.date) diffs.push(`B2 日历断档: ${prev.date} → ${stored.date}`);
    }
  }

  return {
    date: dateStr,
    ok: diffs.length === 0,
    stored,
    recomputed: { n_gap: gap.n_gap, conversations_total: total, first_gap_id: gap.first_id, last_gap_id: gap.last_id },
    diffs,
  };
}

// ══════════════════════════════════════════════════════════════════
// 巡检与告警（任务书 §S5-A2「每日自动对账 + 异常告警」/ §S5-B5「告警可触发」）
// ══════════════════════════════════════════════════════════════════
//
// 【为什么必须有独立巡检】每日 00:05 的计划任务只在**写入那一刻**自检；
//   若任务根本没跑（机器未登录 / 计划任务被禁用），台账就静静缺一天，
//   没有任何输出会告诉任何人。断档是必须暴露的验收失败，不能靠人天天去翻文件。
//
// 【5 分钟送达怎么成立】巡检节拍 15 分钟，且**只做文件级检查时零 IO 成本**：
//   断档 / 自检 note / 基线缺失都只读一个几百字节的 jsonl；
//   只有「出现了新台账记录」才载库复算（sql.js 会把整个库读进内存，不能高频）。
//
// 【告警为什么去重】15 分钟一次 × 永久性异常 = 每天 96 条重复告警。
//   同 kind+date+detail 在 24h 内只落一条，但**本次巡检仍判定失败**（退出码 3），
//   即「文件不刷屏 + 任务持续报红」—— 问题一天不解决就一直红着。

export type AlertKind =
  /** 应写的台账日没有记录（断档：机器未登录 / 任务被禁用 / 台账被清） */
  | 'ledger_missing'
  /** 台账写入时自检未通过（记录的 `note` 非空） */
  | 'ledger_selfcheck'
  /** 台账与库复算不符（日期域字段被改、或数据被动过） */
  | 'ledger_mismatch'
  /** 结构性损坏：有记录无基线、或两者皆无但开关已开 */
  | 'ledger_broken'
  /** 巡检自身异常（库打不开 / 未预期异常） */
  | 'patrol_error';

export interface LedgerAlert {
  /** ISO 时间戳 */
  ts: string;
  kind: AlertKind;
  /** 相关台账日 `YYYY-MM-DD`；无则空串 */
  date: string;
  /** 一句话说明（**不含任何对话原文**，与影子日志同一条隐私红线） */
  detail: string;
  /** 可复现的核验命令 */
  verifier: string;
}

/** 同一 `kind+date+detail` 的告警在 24h 内只落一条 */
const ALERT_DEDUPE_MS = 24 * 3600_000;

/** 保证目标文件所在目录存在（巡检可注入临时目录，故按文件反推而非用默认 LEDGER_DIR） */
function ensureDirOf(file: string): void {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 读全部告警（坏行跳过；告警文件自身损坏不得反噬巡检） */
export function readAlerts(file: string = ALERTS_FILE): LedgerAlert[] {
  try {
    if (!existsSync(file)) return [];
    const out: LedgerAlert[] = [];
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const a = JSON.parse(line) as LedgerAlert;
        if (a && typeof a.ts === 'string' && typeof a.kind === 'string') out.push(a);
      } catch { /* 单行损坏跳过，不删除原行 */ }
    }
    return out;
  } catch (e) {
    console.error('[GapLedger] ⚠️ 告警文件读取失败（不阻断巡检）:', (e as Error)?.message);
    return [];
  }
}

/**
 * 追加一条告警。**永不抛出**（观测层不得打断巡检自身）。
 * @returns 是否真的写入；被 24h 去重时为 false —— 调用方仍应把该异常计入本次判定。
 */
export function appendAlert(alert: LedgerAlert, file: string = ALERTS_FILE): boolean {
  try {
    const now = Date.parse(alert.ts);
    const cutoff = Number.isFinite(now) ? now - ALERT_DEDUPE_MS : 0;
    const dup = readAlerts(file).some(
      (a) => a.kind === alert.kind
        && a.date === alert.date
        && a.detail === alert.detail
        && Date.parse(a.ts) >= cutoff,
    );
    if (dup) return false;
    ensureDirOf(file);
    appendFileSync(file, JSON.stringify(alert) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.error('[GapLedger] ⚠️ 告警落盘失败（本次判定仍继续）:', (e as Error)?.message);
    return false;
  }
}

/** 巡检状态：最近一次**库复算完成**到哪一天 */
export interface PatrolState {
  last_reconciled_date: string;
  last_reconciled_at: string;
}

export function readPatrolState(file: string = PATROL_STATE_FILE): PatrolState | null {
  try {
    if (!existsSync(file)) return null;
    const s = JSON.parse(readFileSync(file, 'utf-8')) as PatrolState;
    return isDateStr(String(s?.last_reconciled_date)) ? s : null;
  } catch {
    return null; // 状态文件坏了就当没状态 —— 最多多复算一次，不会误判
  }
}

function writePatrolState(state: PatrolState, file: string): void {
  try {
    ensureDirOf(file);
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[GapLedger] ⚠️ 巡检状态写入失败（下次会重复复算，不影响正确性）:', (e as Error)?.message);
  }
}

export interface PatrolOptions {
  /** 复算最近 N 条记录，默认 3；传 0 = 只做文件级检查，绝不载库 */
  reconcileDays?: number;
  /** 落点覆盖 —— **仅供单测注入临时目录**，生产一律走默认常量 */
  ledgerFile?: string;
  metaFile?: string;
  alertsFile?: string;
  stateFile?: string;
}

export interface PatrolReport {
  /** 全部检查项都通过（无任何异常） */
  ok: boolean;
  /** 台账停写期间的例行跳过（不是异常） */
  skipped: boolean;
  reason?: string;
  /** 断档日期清单 */
  missing_dates: string[];
  /** 本轮完成库复算的日期 */
  reconciled: string[];
  /** 本轮检出的全部异常（含被 24h 去重、未重复落盘的） */
  alerts: LedgerAlert[];
}

/**
 * 待复算日期（**纯文件判断，不碰库**）。
 * 供 CLI 先判断「值不值得把 sql.js 的整个库载进内存」。
 */
export function pendingReconcileDates(now: Date = new Date(), opts: PatrolOptions = {}): string[] {
  if (!isGapLedgerEnabled()) return [];
  const days = opts.reconcileDays ?? 3;
  if (days <= 0) return [];
  const records = readRecordsFrom(opts.ledgerFile ?? LEDGER_FILE);
  const since = readPatrolState(opts.stateFile ?? PATROL_STATE_FILE)?.last_reconciled_date ?? '';
  return records.slice(-days).filter((r) => r.date > since).map((r) => r.date);
}

/** 巡检自身异常落一条告警（供 CLI 的 catch 用；永不抛出） */
export function alertPatrolError(
  detail: string,
  now: Date = new Date(),
  file: string = ALERTS_FILE,
): void {
  appendAlert({
    ts: now.toISOString(),
    kind: 'patrol_error',
    date: fmtLocalDate(now),
    detail,
    verifier: `${CLI_CMD} --patrol`,
  }, file);
}

/**
 * 台账巡检（任务书 §S5-A2）。
 *
 * @param db 库句柄；传 `null` 表示「本轮不复算」（CLI 据 `pendingReconcileDates()` 决定是否载库）。
 *   🔴 本函数**从不写库**、从不 save()，与台账本身的只读红线一致。
 */
export function patrolLedger(
  db: GapLedgerDb | null,
  now: Date = new Date(),
  opts: PatrolOptions = {},
): PatrolReport {
  if (!isGapLedgerEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: `${GAP_LEDGER_ENV} 未置 true —— 台账停写（S3 专项回捞验收后关闭属正常，不告警）`,
      missing_dates: [],
      reconciled: [],
      alerts: [],
    };
  }

  const ledgerFile = opts.ledgerFile ?? LEDGER_FILE;
  const metaFile = opts.metaFile ?? META_FILE;
  const alertsFile = opts.alertsFile ?? ALERTS_FILE;
  const stateFile = opts.stateFile ?? PATROL_STATE_FILE;
  const records = readRecordsFrom(ledgerFile);
  const meta = readMetaFrom(metaFile);
  const alerts: LedgerAlert[] = [];

  const push = (kind: AlertKind, date: string, detail: string): void => {
    appendAlert({ ts: now.toISOString(), kind, date, detail, verifier: `${CLI_CMD} --patrol` }, alertsFile);
    alerts.push({ ts: now.toISOString(), kind, date, detail, verifier: `${CLI_CMD} --patrol` });
  };

  // ── ① 结构：有记录却无基线（基线文件被删/损坏 ⇒ expected_total 无从对账）──
  if (records.length > 0 && !meta) {
    push('ledger_broken', '', `台账已有 ${records.length} 条记录，但基线文件缺失或损坏: ${metaFile}`);
  }

  // ── ② 断档扫描 ──
  // 00:00–00:10 是每日 00:05 写入任务的执行窗口，此时把「昨天」判成断档是误报。
  const today = fmtLocalDate(now);
  const inGraceWindow = now.getHours() === 0 && now.getMinutes() < 10;
  const expectedLatest = inGraceWindow ? prevDateOf(prevDateOf(today)) : prevDateOf(today);
  // 起点：已有记录取首条日期；还没有记录但有基线时取基线创建日
  const start = records.length > 0
    ? records[0].date
    : (meta ? fmtLocalDate(new Date(meta.created_at)) : today);
  const present = new Set(records.map((r) => r.date));
  const missing: string[] = [];
  // 上限防呆：文件被清空或日期异常时不至于无限循环
  for (let d = start; d <= expectedLatest && missing.length < 400; d = nextDateOf(d)) {
    if (!present.has(d)) missing.push(d);
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(',') + (missing.length > 10 ? ' …' : '');
    push('ledger_missing', missing[missing.length - 1], `台账断档 ${missing.length} 天: ${shown}`);
  }

  // ── ③ 写入时自检未过（记录已落盘但 note 非空）──
  for (const r of records) {
    if (r.note) push('ledger_selfcheck', r.date, `台账自检未过: ${r.note}`);
  }

  // ── ④ 库复算（只对**新出现**的记录；只比日期域字段 —— 见 ReconcileOptions 注释）──
  const reconciled: string[] = [];
  const days = opts.reconcileDays ?? 3;
  if (db && days > 0) {
    const state = readPatrolState(stateFile);
    const since = state?.last_reconciled_date ?? '';
    const targets = records.slice(-days).filter((r) => r.date > since);
    let advanced = '';
    for (const r of targets) {
      const rep = reconcileDate(db, r.date, { snapshot: false, records });
      if (!rep.ok) {
        push('ledger_mismatch', r.date, `库复算不符: ${rep.diffs.join('; ')}`);
        break; // 停在此处：不前进状态 ⇒ 下一轮巡检重试，问题不被静默跳过
      }
      advanced = r.date;
      reconciled.push(r.date);
    }
    if (advanced) {
      writePatrolState(
        { last_reconciled_date: advanced, last_reconciled_at: now.toISOString() },
        stateFile,
      );
    }
  }

  return {
    ok: alerts.length === 0,
    skipped: false,
    missing_dates: missing,
    reconciled,
    alerts,
  };
}
