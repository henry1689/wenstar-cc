import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  diffCalcium,
  runCalciumWatchTick,
  startCalciumWatch,
  persistChanges,
  trimCalciumLog,
  CALCIUM_WATCH_DEFAULTS,
  _resetBaselineForTest,
} from '../calciumWatch.js';

/**
 * P0-5b′ 回归（2026-10-07）：钙化变更溯源（方案乙·快照差分）。
 *
 * 为什么需要这个模块：P0-5b 用实测证明「钙化凭什么爬到 10」**无法事后反推** ——
 * memories 只存当前值、没有变更历史，来源字段的值域又被污染。
 * 本模块补的就是「变更历史」这个缺口。
 *
 * 断言策略：差分逻辑做成纯函数，直接单测；落库用桩捕获 writeRaw 的参数，
 * 避免启动整个 SQLiteAdapter（那会加载 271MB 生产库）。
 */

/** 只录 queryAll / writeRaw 的桩 */
function mkStub(rows: Array<{ id: string; calcium_score: unknown }>) {
  const written: Array<{ sql: string; params: any[] }> = [];
  const stub = {
    rows,
    written,
    sqlite: {
      queryAll: () => rows,
      writeRaw: (sql: string, params: any[]) => { written.push({ sql, params }); },
    } as never,
  };
  return stub;
}

beforeEach(() => { _resetBaselineForTest(); });

describe('P0-5b′ · diffCalcium（纯函数）', () => {
  it('首次运行（prev=null）→ 只建基线，不产出任何变更', () => {
    const d = diffCalcium(null, [{ id: 'a', calcium_score: 1 }, { id: 'b', calcium_score: 2 }]);
    expect(d.isBaseline).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.next.get('a')).toBe(1);
  });

  it('🔴 新增行**不**计为「钙化变更」（否则新记忆出生会淹没真正的爬升信号）', () => {
    const prev = new Map([['a', 1]]);
    const d = diffCalcium(prev, [{ id: 'a', calcium_score: 1 }, { id: 'brand_new', calcium_score: 0.5 }]);
    expect(d.changes).toEqual([]);
    expect(d.next.has('brand_new')).toBe(true);   // 但基线里要收下它，供下一拍比对
  });

  it('值变化 → 产出 old/new', () => {
    const prev = new Map([['a', 1], ['b', 5]]);
    const d = diffCalcium(prev, [{ id: 'a', calcium_score: 3.5 }, { id: 'b', calcium_score: 5 }]);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toEqual({ id: 'a', oldValue: 1, newValue: 3.5 });
  });

  it('下降同样记录（衰减也是一种变更，两侧都要看得见）', () => {
    const prev = new Map([['a', 8]]);
    const d = diffCalcium(prev, [{ id: 'a', calcium_score: 2 }]);
    expect(d.changes[0]).toEqual({ id: 'a', oldValue: 8, newValue: 2 });
  });

  it('NULL / 缺失的 calcium_score 归一为 0，不产生 NaN', () => {
    const prev = new Map([['a', 1]]);
    const d = diffCalcium(prev, [{ id: 'a', calcium_score: null }]);
    expect(d.next.get('a')).toBe(0);
    expect(d.changes[0].newValue).toBe(0);
  });

  it('超过 maxChanges 时截断，并如实报告截断了多少行', () => {
    const prev = new Map<string, number>();
    const curr: Array<{ id: string; calcium_score: number }> = [];
    for (let i = 0; i < 10; i++) { prev.set('m' + i, 1); curr.push({ id: 'm' + i, calcium_score: 2 }); }
    const d = diffCalcium(prev, curr, 4);
    expect(d.changes).toHaveLength(4);
    expect(d.truncated).toBe(6);
  });
});

describe('P0-5b′ · runCalciumWatchTick', () => {
  it('🔴 首拍只建基线、**不写库**（重启后不得把全体行灌成假变更）', () => {
    const s = mkStub([{ id: 'a', calcium_score: 1 }]);
    const n = runCalciumWatchTick(s.sqlite);
    expect(n).toBe(0);
    expect(s.written).toHaveLength(0);
  });

  it('第二拍把变化行写进 calcium_change_log，参数为 [id, at, old, new, source]', () => {
    const s = mkStub([{ id: 'a', calcium_score: 1 }]);
    runCalciumWatchTick(s.sqlite);                    // 建基线
    s.rows[0] = { id: 'a', calcium_score: 9 };        // 模拟被抬高到 9
    const n = runCalciumWatchTick(s.sqlite);

    expect(n).toBe(1);
    const ins = s.written.find((w) => w.sql.includes('INSERT OR REPLACE INTO calcium_change_log'));
    expect(ins).toBeDefined();
    expect(ins!.params[0]).toBe('a');
    expect(ins!.params[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);   // ISO 时间戳
    expect(ins!.params[2]).toBe(1);
    expect(ins!.params[3]).toBe(9);
    expect(ins!.params[4]).toBe('snapshot_diff');            // 乙的语义：观测到变了，但不知是谁改的
  });

  it('无变化的一拍不写库（差分≠快照，静默时零成本）', () => {
    const s = mkStub([{ id: 'a', calcium_score: 1 }]);
    runCalciumWatchTick(s.sqlite);
    const n = runCalciumWatchTick(s.sqlite);
    expect(n).toBe(0);
    expect(s.written).toHaveLength(0);
  });

  it('每拍结束后执行裁剪（保留策略生效，防日志无界增长拖慢落盘）', () => {
    const s = mkStub([{ id: 'a', calcium_score: 1 }]);
    runCalciumWatchTick(s.sqlite);
    s.rows[0] = { id: 'a', calcium_score: 2 };
    runCalciumWatchTick(s.sqlite);
    expect(s.written.some((w) => w.sql.includes('ROW_NUMBER() OVER (PARTITION BY memory_id'))).toBe(true);
    expect(s.written.some((w) => w.sql.includes('DELETE FROM calcium_change_log WHERE changed_at <'))).toBe(true);
  });
});

describe('P0-5b′ · 辅助函数与启动', () => {
  it('persistChanges 单行失败不阻塞其余行', () => {
    const written: any[] = [];
    let call = 0;
    const sqlite = {
      writeRaw: (sql: string, params: any[]) => {
        call++;
        if (call === 1) throw new Error('boom');
        written.push(params);
      },
    } as never;
    persistChanges(sqlite, [
      { id: 'a', oldValue: 1, newValue: 2 },
      { id: 'b', oldValue: 1, newValue: 2 },
    ], '2026-10-07T00:00:00.000Z');
    expect(written).toHaveLength(1);   // 第一行抛错，第二行照写
  });

  it('trimCalciumLog 抛错不向上传播（裁剪失败不阻塞观测）', () => {
    const sqlite = { writeRaw: () => { throw new Error('boom'); } } as never;
    expect(() => trimCalciumLog(sqlite, 30, 90)).not.toThrow();
  });

  it('startCalciumWatch 用注入的 addTimer 注册（与其余后台定时器同规）', () => {
    const s = mkStub([]);
    const timers: unknown[] = [];
    startCalciumWatch(s.sqlite, (t) => { timers.push(t); return t; });
    expect(timers).toHaveLength(1);
    clearInterval(timers[0] as NodeJS.Timeout);
  });

  it('默认参数符合设计（15 分钟 / 每行 30 条 / 90 天）', () => {
    expect(CALCIUM_WATCH_DEFAULTS.intervalMs).toBe(15 * 60 * 1000);
    expect(CALCIUM_WATCH_DEFAULTS.keepPerMemory).toBe(30);
    expect(CALCIUM_WATCH_DEFAULTS.keepDays).toBe(90);
  });

  it('🔴 tick 内抛异常被定时器回调吞掉（非阻塞契约，用假定时器真触发）', () => {
    vi.useFakeTimers();
    try {
      const sqlite = { queryAll: () => { throw new Error('db gone'); } } as never;
      // 函数本身会抛（这是有意的：调用方负责兜底）
      expect(() => runCalciumWatchTick(sqlite)).toThrow('db gone');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const timers: unknown[] = [];
      startCalciumWatch(sqlite, (t) => { timers.push(t); return t; });

      // 真推进定时器 → 回调真的被执行；若没有 try/catch，异常会从这里冒出来
      expect(() => vi.advanceTimersByTime(15 * 60 * 1000)).not.toThrow();
      expect(warn).toHaveBeenCalled();     // 且必须留下告警，不做无声失败
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('tick 失败');

      warn.mockRestore();
      for (const t of timers) clearInterval(t as NodeJS.Timeout);
    } finally {
      vi.useRealTimers();
    }
  });
});
