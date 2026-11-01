/**
 * GapLedger 巡检与告警 —— 任务书 §S5-A2 / §S5-B5 回归
 * ===========================================================
 * 覆盖：开关停写跳过 · 断档扫描（含多日断电与 00:05 写入宽限窗）· 24h 告警去重 ·
 *       自检失败告警 · 基线缺失告警 · 复算不符且不推进状态 ·
 *       🔴 F-33「跨日复算不得拿今天总量比昨天快照」。
 *
 * 🔴 全部走临时目录，**绝不写生产台账**（台账 append-only，测试污染无法事后删除）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GAP_LEDGER_ENV,
  type GapLedgerDb,
  type GapLedgerRecord,
  type PatrolOptions,
  pendingReconcileDates,
  patrolLedger,
  readAlerts,
  readPatrolState,
  reconcileDate,
} from '../GapLedger.js';

// 业主 C 盘铁律：优先 D:\tmp；该目录缺失时才回落系统临时目录（与仓库既有测试一致）
const TMP_ROOT = process.platform === 'win32' && existsSync('D:/tmp') ? 'D:/tmp' : tmpdir();

let work = '';
let files: Required<Pick<PatrolOptions, 'ledgerFile' | 'metaFile' | 'alertsFile' | 'stateFile'>>;
const savedEnv = process.env[GAP_LEDGER_ENV];

function O(): PatrolOptions { return { ...files }; }

function rec(
  date: string,
  n = 10,
  cum = 10,
  total = 100,
  note = '',
): GapLedgerRecord {
  return {
    date,
    s1_started_at: '2026-10-27T02:53:29.000Z',
    n_gap: n,
    cum_gap: cum,
    conversations_total: total,
    expected_total: total,
    first_gap_id: '1',
    last_gap_id: '10',
    verifier: 'v',
    note,
  };
}

function writeRecords(records: GapLedgerRecord[]): void {
  writeFileSync(
    files.ledgerFile,
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    'utf-8',
  );
}

function writeMeta(): void {
  writeFileSync(files.metaFile, JSON.stringify({
    s1_started_at: '2026-10-27T02:53:29.000Z',
    s1_start_conversations_total: 100,
    created_at: '2026-10-27T02:53:29.000Z',
  }), 'utf-8');
}

/** 假库：按 SQL 形状回话，避免把真库拉进单测 */
function fakeDb(o: { n_gap: number; total: number; first?: string; last?: string }): GapLedgerDb {
  return {
    queryAll(sql: string): Array<Record<string, unknown>> {
      // countGap：`... WHERE ... NOT EXISTS (...)`
      if (sql.includes('NOT EXISTS')) {
        return [{ n: o.n_gap, first_id: o.first ?? '1', last_id: o.last ?? '10' }];
      }
      // countConversations：`SELECT COUNT(*) AS total FROM conversations`
      if (sql.includes('FROM conversations')) return [{ total: o.total }];
      return [];
    },
  } as unknown as GapLedgerDb;
}

beforeEach(() => {
  work = mkdtempSync(join(TMP_ROOT, 'gap-ledger-patrol-'));
  files = {
    ledgerFile: join(work, 'gap-ledger.jsonl'),
    metaFile: join(work, 'gap-ledger.meta.json'),
    alertsFile: join(work, 'alerts.jsonl'),
    stateFile: join(work, 'patrol-state.json'),
  };
  process.env[GAP_LEDGER_ENV] = 'true';
});

afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[GAP_LEDGER_ENV];
  else process.env[GAP_LEDGER_ENV] = savedEnv;
});

describe('GapLedger 巡检 — 开关与断档', () => {
  it('开关未开时直接跳过，不产生任何告警（S3 回捞验收后关闭属正常态）', () => {
    delete process.env[GAP_LEDGER_ENV];
    const rep = patrolLedger(null, new Date('2026-10-28T09:00:00'), O());
    expect(rep.skipped).toBe(true);
    expect(rep.ok).toBe(true);
    expect(rep.alerts).toHaveLength(0);
  });

  it('连续无断档且自检通过 ⇒ 零告警', () => {
    writeMeta();
    writeRecords([rec('2026-10-26'), rec('2026-10-27')]);
    const rep = patrolLedger(null, new Date('2026-10-28T09:00:00'), O());
    expect(rep.ok).toBe(true);
    expect(rep.missing_dates).toEqual([]);
    expect(readAlerts(files.alertsFile)).toHaveLength(0);
  });

  it('缺昨日记录 ⇒ ledger_missing', () => {
    writeMeta();
    writeRecords([rec('2026-10-25')]);
    const rep = patrolLedger(null, new Date('2026-10-27T09:00:00'), O());
    expect(rep.ok).toBe(false);
    expect(rep.missing_dates).toEqual(['2026-10-26']);
    expect(rep.alerts[0]?.kind).toBe('ledger_missing');
    expect(rep.alerts[0]?.date).toBe('2026-10-26');
  });

  it('多日断电折成**一条**告警，不逐日刷屏', () => {
    writeMeta();
    writeRecords([rec('2026-10-20')]);
    const rep = patrolLedger(null, new Date('2026-10-27T09:00:00'), O());
    expect(rep.missing_dates).toEqual([
      '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26',
    ]);
    expect(rep.alerts.filter((a) => a.kind === 'ledger_missing')).toHaveLength(1);
    expect(readAlerts(files.alertsFile)).toHaveLength(1);
  });

  it('00:00–00:10 是每日写入任务的窗口，不得把昨天判成断档', () => {
    writeMeta();
    writeRecords([rec('2026-10-25')]);
    // 宽限窗内：应写的是 10-25，尚未到期 ⇒ 不误报
    expect(patrolLedger(null, new Date('2026-10-27T00:03:00'), O()).ok).toBe(true);
    // 宽限窗过了：应写的是 10-26，缺失 ⇒ 报
    const after = patrolLedger(null, new Date('2026-10-27T00:12:00'), O());
    expect(after.ok).toBe(false);
    expect(after.missing_dates).toEqual(['2026-10-26']);
  });
});

describe('GapLedger 巡检 — 告警去重', () => {
  it('同一异常 24h 内只落一条告警，但每轮巡检都仍判定失败（文件不刷屏 + 任务持续报红）', () => {
    writeMeta();
    writeRecords([rec('2026-10-25')]);
    patrolLedger(null, new Date('2026-10-27T09:00:00'), O());
    patrolLedger(null, new Date('2026-10-27T09:20:00'), O());
    patrolLedger(null, new Date('2026-10-27T09:40:00'), O());
    expect(readAlerts(files.alertsFile)).toHaveLength(1);
    expect(patrolLedger(null, new Date('2026-10-27T09:45:00'), O()).ok).toBe(false);
  });

  it('不同 kind/detail 的告警互不遮蔽', () => {
    writeMeta();
    // 只留 10-25：既缺 10-26（断档），又带写入时自检失败的 note ⇒ 两类告警并存
    writeRecords([rec('2026-10-25', 10, 10, 100, '[SELFCHECK_FAIL] 总量不为零')]);
    patrolLedger(null, new Date('2026-10-27T09:00:00'), O());
    const kinds = readAlerts(files.alertsFile).map((a) => a.kind).sort();
    expect(kinds).toEqual(['ledger_missing', 'ledger_selfcheck']);
  });
});

describe('GapLedger 巡检 — 结构与自检', () => {
  it('记录带写入时自检失败的 note ⇒ ledger_selfcheck', () => {
    writeMeta();
    writeRecords([rec('2026-10-27', 10, 10, 100, '[SELFCHECK_FAIL] 总量不为零')]);
    const rep = patrolLedger(null, new Date('2026-10-28T09:00:00'), O());
    const hit = rep.alerts.find((a) => a.kind === 'ledger_selfcheck');
    expect(hit?.date).toBe('2026-10-27');
    expect(hit?.detail).toContain('SELFCHECK_FAIL');
  });

  it('有台账记录却无基线 ⇒ ledger_broken（expected_total 无从对账）', () => {
    writeRecords([rec('2026-10-27')]); // 刻意不写 meta
    const rep = patrolLedger(null, new Date('2026-10-28T09:00:00'), O());
    expect(rep.alerts.some((a) => a.kind === 'ledger_broken')).toBe(true);
  });
});

describe('GapLedger 巡检 — 库复算与状态推进', () => {
  it('pendingReconcileDates 纯文件判断即可用（无需载库）', () => {
    writeMeta();
    writeRecords([rec('2026-10-26'), rec('2026-10-27')]);
    expect(pendingReconcileDates(new Date('2026-10-28T09:00:00'), O()))
      .toEqual(['2026-10-26', '2026-10-27']);
  });

  it('复算通过 ⇒ 状态前进，后续巡检不再要求载库', () => {
    writeMeta();
    writeRecords([rec('2026-10-27', 10, 10, 100)]);
    const db = fakeDb({ n_gap: 10, total: 100 });
    const rep = patrolLedger(db, new Date('2026-10-28T09:00:00'), O());
    expect(rep.ok).toBe(true);
    expect(rep.reconciled).toEqual(['2026-10-27']);
    expect(readPatrolState(files.stateFile)?.last_reconciled_date).toBe('2026-10-27');
    expect(pendingReconcileDates(new Date('2026-10-28T09:15:00'), O())).toEqual([]);
  });

  it('复算不符 ⇒ ledger_mismatch，且**不推进状态**（下一轮必须重试，不得静默跳过）', () => {
    writeMeta();
    writeRecords([rec('2026-10-27', 10, 10, 100)]); // 台账 n_gap=10
    const db = fakeDb({ n_gap: 7, total: 100 });    // 复算得 7 ⇒ 不符
    const rep = patrolLedger(db, new Date('2026-10-28T09:00:00'), O());
    expect(rep.ok).toBe(false);
    expect(rep.alerts.some((a) => a.kind === 'ledger_mismatch')).toBe(true);
    expect(readPatrolState(files.stateFile)).toBeNull();
    expect(pendingReconcileDates(new Date('2026-10-28T09:15:00'), O())).toEqual(['2026-10-27']);
  });

  it('db 传 null = 本轮不复算（CLI 据 pendingReconcileDates 决定是否载库）', () => {
    writeMeta();
    writeRecords([rec('2026-10-27')]);
    const rep = patrolLedger(null, new Date('2026-10-28T09:00:00'), O());
    expect(rep.reconciled).toEqual([]);
    expect(rep.ok).toBe(true);
  });
});

describe('🔴 F-33 — 跨日复算不得拿今天总量比昨天快照', () => {
  it('快照域（conversations_total）只在 snapshot 模式下比对', () => {
    const r = rec('2026-10-27', 10, 10, 100);
    const db = fakeDb({ n_gap: 10, total: 999 }); // 库总量已经涨到 999
    // 当日人工核验：总量不符 → 不通过（B4 语义）
    expect(reconcileDate(db, '2026-10-27', { records: [r] }).ok).toBe(false);
    // 巡检复核历史日期：总量必然漂移，只比日期域 → 通过
    const rep = reconcileDate(db, '2026-10-27', { records: [r], snapshot: false });
    expect(rep.ok).toBe(true);
    expect(rep.diffs).toEqual([]);
  });

  it('日期域字段（n_gap / 首尾 id）不符时，两种模式都必须判失败', () => {
    const r = rec('2026-10-27', 10, 10, 100);
    const db = fakeDb({ n_gap: 7, total: 100 });
    const rep = reconcileDate(db, '2026-10-27', { records: [r], snapshot: false });
    expect(rep.ok).toBe(false);
    expect(rep.diffs[0]).toContain('n_gap');
  });

  it('B4 零误差是记录**自身**的账，任何模式都要查', () => {
    const bad: GapLedgerRecord = { ...rec('2026-10-27', 10, 10, 100), expected_total: 120 };
    const db = fakeDb({ n_gap: 10, total: 100 });
    const rep = reconcileDate(db, '2026-10-27', { records: [bad], snapshot: false });
    expect(rep.ok).toBe(false);
    expect(rep.diffs.join('')).toContain('B4');
  });
});