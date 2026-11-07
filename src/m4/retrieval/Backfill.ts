/**
 * Backfill — 检索架构 v11 §S3 A4 退化区间专项回捞
 * ============================================================
 * S1.1 退化窗口内**新产生但未进旧索引**的对话，逐条用新链路反查，
 * 产出命中率报告。**100% 命中是 S3 的竣工资格**（任务书 §S3 B6），
 * 不是准入门槛 —— 未通过则须继续回捞/修复，**不得宣布 S3 完成**。
 *
 * 【输入清单的唯一来源】`data/retrieval-v11/gap-ledger.jsonl`
 * （`ΣN_gap` 与 `[first_gap_id, last_gap_id]` 区间，蓝皮书 §8.2）。
 *
 * 【红线】
 *   1. 🔴 **台账只读**：不写、不改、不平滑（任务书 §S1.1-D2 / §S5-D2）。
 *      本模块对台账文件只有 `readFileSync`，没有任何写路径。
 *   2. 🔴 **按 id 逐条核，非抽样**（任务书 §S3-B6）。禁止「抽 100 条看看」。
 *   3. 🔴 **不伪造命中**：判据是「该 conversation id 出现在新链路
 *      `domain='conversation'` 的精排结果集里」。查不到就是查不到。
 *      🔴 **判据集合 = 精排结果集本身**（`scoreAndRank` 的全返回集），
 *      **不是**它的 top-K 截断。截断是生产注入量约束，与「能不能召回」是两件事：
 *      一条结果排在第 53 位，说明新链路召得回它，只是没排进注入窗口 ——
 *      这与「查不到」完全不同。2026-10-28 实测 id=14694 精排第 53/500 位
 *      曾被 `slice(0, topK)` 切掉而误判未命中（与同日修复的 §7.1 同源）。
 *   4. 🔴 **无归属的对话无法形成 UUID 白名单** ⇒ 不得放行（红线 14）。
 *      这类行单独计入 `no_uuid_scope` 并写入 notes，**不计为命中也不静默丢弃**。
 *   5. 🔴 **只读打开数据库**：用 better-sqlite3 的 `readonly: true` 连接（SqlJsCompat），
 *      本模块没有任何写路径。2026-11-07 起不再用 sql.js —— 它读的是**文件快照**，
 *      WAL 模式下看不到 -wal 里尚未 checkpoint 的最新写入；只读原生连接走 WAL，读到的是一致的当前状态。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FUSION_MEMORY_DB } from '../../common/const/paths.js';
// 🔴 2026-11-02 业主裁决「甲」（拆除计划 §3.2）：缺口台账模块（GapLedger.ts）已整体下线。
//   本文件仍保留**只读**解析历史台账的能力 —— 它是 S3-B6 回捞验收的唯一输入清单来源，
//   文件本身按「只增不删」原则保留在磁盘上。台账写入方随 n-gram 拆除下线后，
//   这里不再产生新记录；台账缺失时按「无待核清单」处理，跳过而非报失败。
const LEDGER_FILE = resolve(process.cwd(), 'data', 'retrieval-v11', 'gap-ledger.jsonl');

/** 历史台账单日记录（只保留回捞核验实际用到的字段） */
interface GapLedgerRecord {
  date: string;
  n_gap: number;
  first_gap_id: string;
  last_gap_id: string;
  [k: string]: unknown;
}
import { recallByStructured, scoreAndRank } from './StructuredRecall.js';
import { buildNgrams } from '../SearchIndexBuilder.js';
import { RERANK_TOP_K } from './Flags.js';

/** 最小数据库形状（与 StructuredRecall / GapLedger 同源，避免双实现漂移） */
export interface BackfillDb {
  queryAll?: (sql: string, ...params: unknown[]) => Array<Record<string, unknown>>;
}

/** 单日回捞结果 */
export interface BackfillDayReport {
  date: string;
  /** 台账记的当日缺口条数 */
  n_gap: number;
  /** 实际逐条核过的条数 */
  checked: number;
  hit: number;
  /** 未命中的 conversation id（按 id 逐条列，非抽样） */
  missed: string[];
  /** 无归属、无法形成 UUID 白名单的条数（不计命中，见红线 4） */
  no_uuid_scope: number;
}

export interface BackfillReport {
  from: string;
  to: string;
  ledgerDays: number;
  /** 台账 ΣN_gap */
  totalGap: number;
  checked: number;
  hit: number;
  /** `hit / checked`，保留 4 位小数 */
  hitRate: number;
  /** 竣工资格：命中率 100% 且无遗漏 */
  ok: boolean;
  /** 可复现的校验命令 */
  verifier: string;
  notes: string[];
  days: BackfillDayReport[];
}

export interface BackfillOptions {
  /**
   * 围栏候选池的放大倍率基数（默认 `RERANK_TOP_K`）。
   *
   * 🔴 **只影响围栏捞多少，不参与命中判据**（红线 3）：
   * 围栏取 `max(topK * 10, 200)` 条进精排，命中判据看的是精排**全集**。
   * 调大只会让围栏捞得更多（更宽松），但它**不会**把原本未召回的条目变成命中。
   */
  topK?: number;
  /** 只回捞指定日期区间（YYYY-MM-DD 闭区间）；缺省回捞台账全部日期 */
  fromDate?: string;
  toDate?: string;
}

// ══════════════════════════════════════════════════════════════════
// 底层适配：sql.js 只读库 → queryAll
// ══════════════════════════════════════════════════════════════════

/**
 * 把 sql.js 的 `exec` 适配成 `queryAll`。
 * **只读**：适配层不含任何写方法，物理上无法 save()（红线 5）。
 */
/** 适配层只需要这两种能力；带参查询要求 prepare（缺了就必须报错，不能静默丢参） */
interface QueryRawCapability {
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  prepare?: (sql: string) => {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown> | undefined;
    free(): void;
  };
}

/**
 * 🔴 形状归一（2026-10-28 · S3-B6 回捞恒 0% 的根因修复）
 *   本文件里存在**两种**调用约定，而适配层原先只认其中一种：
 *     · `fetchGapRows` → `queryAll(sql, first, last)`      传**标量**
 *     · `recallByStructured` → `queryAll(sql, params)`     传**数组**（生产签名见 StructuredRecallDb）
 *   可变参数会把数组多包一层 → 绑定失效 → 围栏恒返回 0 行。
 *   实测：同一库同一查询，正确绑定 hits=1649/2237/3016/88/2946，双层包裹全为 0，
 *   于是 B6 报 0/421 —— **判据没坏，是适配层把参数喂错了**。
 *   两种形状都无歧义（SQLite 参数位只放标量，不会出现「单个参数本身是数组」），
 *   故在此归一，让两侧调用方都拿到正确绑定。
 */
function normalizeQueryParams(params: unknown[]): unknown[] {
  return params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
}

/** 把语句壳跑完，一次取回全部行（行数由查询自身的 LIMIT 约束） */
function collectStatementRows(stmt: {
  step(): boolean;
  getAsObject(): Record<string, unknown> | undefined;
}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  while (stmt.step()) out.push(stmt.getAsObject() ?? {});
  return out;
}

/**
 * 带参查询：🔴 2026-11-07 存储底座收尾（ADR-017）—— 必须走 prepare/bind。
 *   sql.js 的 `exec(sql, params)` 支持绑定，而 better-sqlite3 / SqlJsCompat 的 exec
 *   **只接受单参数**，直接 `exec(sql, flat)` 会把参数静默丢弃，
 *   与 2026-10-28「回捞恒 0%」是同一类事故（判据没坏，是参数没喂进去）。
 */
function queryWithParams(
  raw: QueryRawCapability,
  sql: string,
  flat: unknown[],
): Array<Record<string, unknown>> {
  if (typeof raw.prepare !== 'function') {
    throw new Error('asQueryAll: 带参数的查询需要 prepare/bind 能力');
  }
  const stmt = raw.prepare(sql);
  try {
    stmt.bind(flat);
    return collectStatementRows(stmt);
  } finally {
    stmt.free();
  }
}

/** 无参查询：exec 的单结果集形态 → 对象数组 */
function queryWithoutParams(raw: QueryRawCapability, sql: string): Array<Record<string, unknown>> {
  const res = raw.exec(sql);
  if (!res?.length || !res[0]?.columns || !res[0]?.values) return [];
  const cols = res[0].columns;
  return res[0].values.map((vals) => Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
}

export function asQueryAll(raw: QueryRawCapability): BackfillDb {
  return {
    queryAll(sql: string, ...params: unknown[]) {
      const flat = normalizeQueryParams(params);
      return flat.length > 0 ? queryWithParams(raw, sql, flat) : queryWithoutParams(raw, sql);
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// 台账读取（只读）
// ══════════════════════════════════════════════════════════════════

function readLedgerNotes(): { records: GapLedgerRecord[]; notes: string[] } {
  const notes: string[] = [];
  if (!existsSync(LEDGER_FILE)) {
    // 🔴 2026-11-02：台账模块已下线，缺失不再是「验收失败」，而是「无待核清单」。
    notes.push(`[INFO] 台账文件不存在: ${LEDGER_FILE}（缺口台账已随 n-gram 拆除下线，无待核清单，跳过）`);
    return { records: [], notes };
  }
  const lines = readFileSync(LEDGER_FILE, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const records: GapLedgerRecord[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as GapLedgerRecord;
      if (rec && typeof rec.date === 'string') records.push(rec);
    } catch (e) {
      // 坏行：原样保留，不删除、不修补（红线 1）
      notes.push(`[WARN] 台账存在无法解析的行（未删除）: ${(e as Error).message}`);
    }
  }
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { records, notes };
}

// ══════════════════════════════════════════════════════════════════
// 单日回捞
// ══════════════════════════════════════════════════════════════════

/** 取台账某日缺口区间的对话行（含归属 UUID），只读 */
function fetchGapRows(db: BackfillDb, rec: GapLedgerRecord): Array<Record<string, unknown>> {
  const first = Number(rec.first_gap_id);
  const last = Number(rec.last_gap_id);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  return db.queryAll!(
    `SELECT id, content, timestamp, belong_entity_uuid
       FROM conversations
      WHERE id >= ? AND id <= ?
      ORDER BY id ASC`,
    first, last,
  ) ?? [];
}

/**
 * 逐条反查单日缺口。
 *
 * 判据（红线 2/3）：以该对话正文切出的分片为查询词，走 `domain='conversation'`
 * 结构化围栏 + 四权重精排，看该对话 id 是否在**精排结果集**里。
 *
 * 🔴 「结果集」= `scoreAndRank` 的全返回集，**不是 top-K**。
 * `topK` 只决定围栏捞多少（`max(topK*10, 200)`），不参与判定 ——
 * 把 top-K 当判据会让「召得回但排得靠后」被误记成「召不回」。
 *
 * 归属白名单取该对话自身的 `belong_entity_uuid` —— 这正是它真实的可见边界，
 * 问的是「新链路能不能把它召回到它的主人面前」。
 */
async function backfillDay(
  db: BackfillDb,
  rec: GapLedgerRecord,
  topK: number,
): Promise<BackfillDayReport> {
  const rows = fetchGapRows(db, rec);
  const report: BackfillDayReport = {
    date: rec.date,
    n_gap: rec.n_gap,
    checked: 0,
    hit: 0,
    missed: [],
    no_uuid_scope: 0,
  };
  const nowMs = Date.now();

  for (const row of rows) {
    const id = row['id'] == null ? '' : String(row['id']);
    if (!id) continue;

    const uuid = row['belong_entity_uuid'] == null ? '' : String(row['belong_entity_uuid']).trim();
    if (!uuid) {
      // 红线 4：无归属 ⇒ 无法形成白名单 ⇒ 围栏 fail-closed，**不得计为命中**
      report.no_uuid_scope++;
      report.checked++;
      continue;
    }

    const content = row['content'] == null ? '' : String(row['content']);
    const keywords = buildNgrams(content).slice(0, 40);
    report.checked++;

    try {
      // 🔴 必须真 await：`recallByStructured` 是 async，即便内部全是同步取数，
      //    `.then` 回调也排在微任务队列里，同步读取返回值只会拿到空数组 ——
      //    那会让整批回捞假报「0 命中」。
      const hits = await recallByStructured(db, {
        domain: 'conversation',
        entityUuids: [uuid],
        keywords,
        limit: Math.max(topK * 10, 200),
      });
      // 🔴 红线 3 判据集合 = 精排结果集（全返回集），不得再截断 top-K。
      //    2026-10-28：此处原为 `scoreAndRank(hits, nowMs).slice(0, topK)`，
      //    导致排在第 53/500 位的 id=14694 被误判未命中（B6 卡在 413/414）。
      const ranked = scoreAndRank(hits, nowMs);
      if (ranked.some((h) => h.id === id)) report.hit++;
      else report.missed.push(id);
    } catch (e) {
      report.missed.push(id);
      void e; // 单条失败不中断整批，计入 missed 供逐条复核
    }
  }
  return report;
}

// ══════════════════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════════════════

const VERIFIER_CMD = 'node node_modules/tsx/dist/cli.mjs src/m4/retrieval/Backfill.ts';

export async function runBackfill(db: BackfillDb, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const topK = opts.topK && opts.topK > 0 ? opts.topK : RERANK_TOP_K;
  const { records, notes } = readLedgerNotes();

  const picked = records.filter((r) => {
    if (opts.fromDate && r.date < opts.fromDate) return false;
    if (opts.toDate && r.date > opts.toDate) return false;
    return true;
  });

  const days: BackfillDayReport[] = [];
  for (const rec of picked) days.push(await backfillDay(db, rec, topK));

  const totalGap = days.reduce((s, d) => s + d.n_gap, 0);
  const checked = days.reduce((s, d) => s + d.checked, 0);
  const hit = days.reduce((s, d) => s + d.hit, 0);
  const noUuid = days.reduce((s, d) => s + d.no_uuid_scope, 0);
  const hitRate = checked > 0 ? Number((hit / checked).toFixed(4)) : 0;

  if (picked.length === 0) notes.push('[WARN] 台账无可用记录，回捞清单为空 —— 这不是「全部命中」，是「没有可核的东西」');
  if (noUuid > 0) {
    notes.push(`[WARN] ${noUuid} 条对话无 belong_entity_uuid，无法形成 UUID 白名单（红线 14），未计为命中也未丢弃，见 days[].no_uuid_scope`);
  }

  return {
    from: picked[0]?.date ?? '',
    to: picked[picked.length - 1]?.date ?? '',
    ledgerDays: picked.length,
    totalGap,
    checked,
    hit,
    hitRate,
    // 竣工资格：核过的每一条都命中（no_uuid_scope 单列，不混入命中率）
    ok: picked.length > 0 && checked > 0 && hit === checked,
    verifier: VERIFIER_CMD,
    notes,
    days,
  };
}

// ══════════════════════════════════════════════════════════════════
// 命令行入口
// ══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flagOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dbPath = resolve(flagOf('--db') ?? FUSION_MEMORY_DB);
  const asJson = args.includes('--json');

  if (!existsSync(dbPath)) {
    console.error(`❌ 库文件不存在: ${dbPath}`);
    process.exit(2);
  }

  // 🔴 2026-11-07 存储底座收尾（ADR-017）：只读连接改 better-sqlite3（SqlJsCompat）。
  //   原 sql.js 读的是**文件快照**，WAL 模式下看不到最新写入（-wal 尚未 checkpoint 的部分）；
  //   原生只读连接走 WAL，读到的是一致的当前状态，且依然无任何写路径。
  const { SqlJsCompat } = await import('../../m2/SqlJsCompat.js');
  const raw = new SqlJsCompat(dbPath, { readonly: true, fileMustExist: true });
  const db = asQueryAll(raw);

  const report = await runBackfill(db, {
    topK: Number(flagOf('--topk') ?? RERANK_TOP_K),
    fromDate: flagOf('--from'),
    toDate: flagOf('--to'),
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n=== 检索架构 v11 · 退化区间专项回捞（§S3 B6 竣工资格）===`);
    console.log(`区间: ${report.from} ~ ${report.to}（${report.ledgerDays} 天）`);
    console.log(`台账 ΣN_gap: ${report.totalGap} | 逐条核过: ${report.checked} | 命中: ${report.hit}`);
    console.log(`命中率: ${(report.hitRate * 100).toFixed(2)}%  ${report.ok ? '✅ 竣工达标' : '❌ 未达标（须继续回捞/修复，不得宣布 S3 完成）'}`);
    for (const d of report.days) {
      const flag = d.missed.length === 0 ? '✅' : '❌';
      console.log(`  ${flag} ${d.date}  n_gap=${d.n_gap} checked=${d.checked} hit=${d.hit} no_uuid_scope=${d.no_uuid_scope}` +
        (d.missed.length ? `  未命中 id: ${d.missed.slice(0, 20).join(',')}${d.missed.length > 20 ? ` …共${d.missed.length}条` : ''}` : ''));
    }
    for (const n of report.notes) console.log(`  ⚠️ ${n}`);
    console.log(`\n复算命令: ${report.verifier}`);
  }
  process.exit(report.ok ? 0 : 1);
}

// 仅当作为脚本直接运行时才执行（被 import 时不产生任何副作用）
const invokedDirectly = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && /Backfill\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => { console.error('❌ 回捞执行失败:', e); process.exit(3); });
}
