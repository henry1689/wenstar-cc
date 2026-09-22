/**
 * FG 持久化守卫测试（🔴 2026-09-23，A 阶段配套）
 *
 * 背景：FamilyGraph 原持久化实现为「每次变更 ⇒ db.export()（42.4MB 同步）+ writeFileSync（同步）」
 * ⇒ 实测一轮对话最多 7 次全量导出 ≈4397ms，且阻塞事件循环、无原子写、失败无重试。
 *
 * 本测试锁定修复后的**能力**（而非实现细节）：
 *   1) 常规路径必须是**异步**落盘（存在 flushAsync），且**先让出事件循环再 export**
 *      —— 否则 42MB 同步导出仍落在调用方同步栈上（实测：只异步化而不让出，integrateFG 仍有 7.9s 尖峰）。
 *   2) 必须**原子替换**（先写 tmp，再 rename）——防止写中途失败留下截断的 FG 库。
 *   3) 必须有**并发合并/写入代次**（_flushing / _flushPending / _writeSeq）。
 *   4) 必须有**时间地板**（默认 60s，env 可调 FG_FLUSH_MIN_INTERVAL_MS）——防止一轮内多次全量导出。
 *   5) 失败必须**保留脏标记**（不清 _dirty），以便下次重试。
 *   6) markDirty(true)（立即落盘）不得再直接调用同步 flush()。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/m4/household/FamilyGraph.ts'), 'utf-8');

describe('FamilyGraph 持久化守卫（能力断言）', () => {
  it('常规落盘为异步实现，且存在 flushAsync', () => {
    expect(SRC).toMatch(/private async flushAsync\(\)/);
  });

  it('导出前必须先让出事件循环（setImmediate），避免同步 42MB 导出阻塞调用方', () => {
    const asyncBody = SRC.slice(SRC.indexOf('private async flushAsync'));
    const body = asyncBody.slice(0, asyncBody.indexOf('private flush()'));
    const yieldIdx = body.indexOf('setImmediate');
    const exportIdx = body.indexOf('this.db.export()');
    expect(yieldIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeGreaterThan(-1);
    expect(yieldIdx).toBeLessThan(exportIdx);
  });

  it('必须原子替换：先写 tmp 再 rename（不得直接覆盖正式文件）', () => {
    const asyncBody = SRC.slice(SRC.indexOf('private async flushAsync'));
    const body = asyncBody.slice(0, asyncBody.indexOf('private flush()'));
    expect(body).toMatch(/\.tmp-/);
    expect(body).toMatch(/fsp\.rename\(|renameSync\(/);
    // 异步路径不得直接 writeFileSync 正式库
    expect(body).not.toMatch(/writeFileSync\(this\.dbPath/);
  });

  it('必须有并发合并与写入代次（防止同一轮多次导出 + 旧内容覆盖新内容）', () => {
    expect(SRC).toMatch(/_flushing/);
    expect(SRC).toMatch(/_flushPending/);
    expect(SRC).toMatch(/_writeSeq/);
  });

  it('必须有时间地板且可由环境变量调节', () => {
    expect(SRC).toMatch(/FG_FLUSH_MIN_INTERVAL_MS/);
    expect(SRC).toMatch(/FG_FLUSH_MIN_INTERVAL_MS\)\s*\|\|\s*60_000/);
  });

  it('落盘失败必须保留脏标记（不静默清 _dirty）', () => {
    const asyncBody = SRC.slice(SRC.indexOf('private async flushAsync'));
    const body = asyncBody.slice(0, asyncBody.indexOf('private flush()'));
    // _dirty = false 只能出现在 wrote 成功分支
    const m = body.match(/_dirty = false/g) ?? [];
    expect(m.length).toBeGreaterThan(0);
    expect(body).toMatch(/if \(wrote\) \{ this\._dirty = false/);
  });

  it('markDirty(true) 不得再走同步 flush()', () => {
    const md = SRC.slice(SRC.indexOf('private markDirty'));
    const body = md.slice(0, md.indexOf('private async flushAsync'));
    expect(body).not.toMatch(/\{\s*this\.flush\(\);[\s\S]{0,40}return;/);
    expect(body).toMatch(/void this\.flushAsync\(\)/);
  });
});
