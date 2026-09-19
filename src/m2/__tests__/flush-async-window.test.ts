/**
 * C1-a / C1-b 能力断言：**落盘不再阻塞事件循环** + **10 秒防抖窗口真的生效**
 *
 * 背景（实测）：同步落盘（writeSync+fsyncSync）会在每次落盘期间冻结整个服务 1–2 秒
 * （正常响应 30ms → 落盘当秒均值 807ms、峰值 2033ms）；且 150ms 窗口合并不上一轮对话
 * 分散在 ~2 秒间隔的写入（实测一轮 19 次整库重写 = 4.16GB）。
 *
 * 要证明的能力：
 * 1. 异步落盘期间，事件循环**仍在推进**（定时器照常触发）——这是"不卡"的判据；
 * 2. 对照：同步落盘期间事件循环**必然停止**（证明差异真实存在，而非测量噪声）；
 * 3. 防抖窗口默认 10 秒、可被 `TIANQUAN_FLUSH_INTERVAL_MS` 覆盖；
 * 4. 窗口内不落盘、超窗后落盘（并且落盘后能再次排程，不会"卡死后永不再写"）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { SQLiteAdapter } from '../SQLiteAdapter.js';

const WORK = mkdtempSync(join(tmpdir(), 'flush-async-test-'));
afterAll(() => {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 造一个"只有裸必要字段"的适配器实例（不加载真库，避免内存与 IO 成本） */
function fakeAdapter(dbPath: string, payloadMB = 48): any {
  const a: any = Object.create(SQLiteAdapter.prototype);
  a.dbPath = dbPath;
  // 假 db：export() 返回指定大小的缓冲；exec() 抛错 ⇒ 空库守卫取 -1 ⇒ 放行（不误伤）
  a.db = {
    export: () => Buffer.alloc(payloadMB * 1024 * 1024, 7),
    exec: () => { throw new Error('stub'); },
  };
  a._dirtyCount = 1;
  a._flushing = false;
  a._flushPending = false;
  a._writeSeq = 0;
  a._flushTimer = null;
  a._FLUSH_BATCH = 50;
  a._FLUSH_INTERVAL = 10000; // 纯字面量默认值（与源码一致）
  return a;
}

describe('落盘不阻塞事件循环（C1-a）', () => {
  it('异步落盘期间定时器照常触发（事件循环未被冻结）', async () => {
    const a = fakeAdapter(join(WORK, 'async.db'));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      await a.flushNowAsync();
    } finally {
      clearInterval(timer);
    }
    expect(existsSync(a.dbPath), '异步落盘应真的写出文件').toBe(true);
    expect(ticks, `异步写 48MB 期间事件循环应持续推进，实际 tick=${ticks}`).toBeGreaterThanOrEqual(3);
    expect(statSync(a.dbPath).size).toBe(48 * 1024 * 1024);
  });

  it('对照：同步落盘期间定时器必然无法触发（差异真实存在）', () => {
    const a = fakeAdapter(join(WORK, 'sync.db'));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      const ok = a._safeWriteDbFile(Buffer.alloc(48 * 1024 * 1024, 9), 'unit-test-sync');
      expect(ok).toBe(true);
    } finally {
      clearInterval(timer);
    }
    // 单线程：同步写期间 JS 无机会执行定时器回调
    expect(ticks, '同步落盘期间事件循环必须被阻塞').toBe(0);
  });
});

describe('防抖窗口（C1-b）', () => {
  it('默认 10 秒（纯字面量）；可用 TIANQUAN_FLUSH_INTERVAL_MS 运行期覆盖', () => {
    const a = fakeAdapter(join(WORK, 'default.db'));
    expect(a._FLUSH_INTERVAL, '默认窗口应为 10 秒').toBe(10000);
    expect(a._flushIntervalMs(), '未设 env 时应回落默认').toBe(10000);

    const prev = process.env.TIANQUAN_FLUSH_INTERVAL_MS;
    try {
      process.env.TIANQUAN_FLUSH_INTERVAL_MS = '3000';
      expect(a._flushIntervalMs(), 'env 覆盖应生效').toBe(3000);
    } finally {
      if (prev === undefined) delete process.env.TIANQUAN_FLUSH_INTERVAL_MS;
      else process.env.TIANQUAN_FLUSH_INTERVAL_MS = prev;
    }
  });

  it('字面量形态必须可被 health-check 静态提取（防止联动误报致命）', () => {
    // 教训：曾把窗口写成 `Number(process.env.X ?? 10_000)`，导致
    // `src/cli/health-check.ts` 的正则提取不到 ⇒ 运维检查报“配置超出安全区间”致命。
    // 本断言把“必须能静态提取”固化成回归防线。
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'SQLiteAdapter.ts'), 'utf-8');
    const m = src.match(/_FLUSH_INTERVAL\s*=\s*(\d+)/);
    expect(m, '必须能从 SQLiteAdapter 静态提取 _FLUSH_INTERVAL（纯数字字面量）').not.toBeNull();
    const v = Number(m![1]);
    expect(v, '提取值应为 10 秒级（与源码一致）').toBe(10000);
    // 与 health-check 的安全区间保持一致（上限 60000）
    expect(v).toBeGreaterThanOrEqual(50);
    expect(v).toBeLessThanOrEqual(60000);
  });

  it('窗口内不落盘、超窗后落盘；且落盘后仍能再次排程（不会卡死）', async () => {
    const dbPath = join(WORK, 'window.db');
    const a = fakeAdapter(dbPath);
    a._FLUSH_INTERVAL = 300; // 测试用短窗口

    a.save(); // private，测试内直呼
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(dbPath), '窗口内不应落盘（防抖生效）').toBe(false);
    expect(a._flushTimer, '窗口内应有待触发的计时器').not.toBeNull();

    await new Promise((r) => setTimeout(r, 700));
    expect(existsSync(dbPath), '超窗后应已落盘').toBe(true);
    expect(a._flushTimer, '落盘后计时器应已清空（否则后续写入永不排程）').toBeNull();
    expect(a._dirtyCount, '成功落盘后脏计数应清零').toBe(0);

    // 再次写入 → 必须能重新排程并落盘（回归：曾出现"计时器非空导致不再排程"）
    a.db = {
      export: () => Buffer.alloc(1024 * 1024, 3),
      exec: () => { throw new Error('stub'); },
    };
    a.save();
    await new Promise((r) => setTimeout(r, 700));
    expect(statSync(dbPath).size, '第二次落盘应写出新内容（1MB）').toBe(1024 * 1024);
  });
});
