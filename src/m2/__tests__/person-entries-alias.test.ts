/**
 * `loadFgPersonEntries` 的能力断言：**别名不再被姓氏过滤误杀**（2026-09-22 修复）
 *
 * 背景（实测）：该函数原先把姓氏过滤（`hasSurname`）也套在**别名**上。
 * 姓氏过滤的本意是滤掉**滑窗垃圾节点**——那是**节点级**判断；
 * 对别名再套一次，会把"诗雨"（徐诗雨的别名，无姓氏）这类合法别名全部丢掉
 * ⇒ 只写"诗雨"的记忆永远匹配不上 ⇒ 基因回填实测只填 **3 条**
 * （修正口径后正确值：可回填 **39 条**；未套节点级姓氏过滤的 149 属高估，不作数）。
 *
 * 要证明的能力：
 * 1. 合法人物的**无姓氏别名**必须被收录，且映射回主名；
 * 2. 主名**不被姓氏谓词接受**的节点仍被排除（谓词驱动，不硬编码猜测）；
 * 3. `status='void'` 的节点仍被排除。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { loadFgPersonEntries } from '../MigrationManager.js';
import { hasSurname } from '../../config/app-identity.js';

const WORK = mkdtempSync(join(tmpdir(), 'fg-entries-test-'));
afterAll(() => {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 由**真实谓词**推导出一个"没姓氏"的名字（不靠人肉猜测：周末/宿舍的"周/宿"其实都是姓氏） */
function pickGarbageName(): string {
  const cand = ['苹果某某', '天气某某', '今天某某', '☆某某'];
  return String(cand.find((n) => !hasSurname(n)) ?? cand[cand.length - 1]);
}

/** 造一个最小 FG（只含本函数需要的列与行） */
function makeFg(path: string, garbageName: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, status TEXT, uuid TEXT, aliases TEXT)');
  const ins = db.prepare('INSERT INTO nodes (id,type,name,status,uuid,aliases) VALUES (?,?,?,?,?,?)');
  ins.run('n1', 'person', '徐诗雨', 'active', 'TXS-000000007', JSON.stringify(['诗雨'])); // 主名有姓氏、别名无姓氏
  ins.run('n2', 'person', garbageName, 'active', 'TXS-000009999', JSON.stringify([]));    // 主名无姓氏 ⇒ 应被挡
  ins.run('n3', 'person', '谢诗雨', 'void', 'TXS-000000099', JSON.stringify([]));        // void ⇒ 应被挡
  db.close();
}

describe('FG 人名库加载（别名不再被姓氏过滤误杀）', () => {
  it('无姓氏别名必须收录并映射回主名；无姓氏节点与 void 节点仍被排除', async () => {
    const garbageName = pickGarbageName();
    const fgPath = join(WORK, 'family_graph.db');
    makeFg(fgPath, garbageName);

    const entries = await loadFgPersonEntries(fgPath);
    const keys = entries.map((e) => e.key);

    expect(hasSurname(garbageName), `用例前提：${garbageName} 应无姓氏`).toBe(false);
    expect(keys, '主名应被收录').toContain('徐诗雨');
    expect(keys, '无姓氏别名「诗雨」必须被收录（本次修复点）').toContain('诗雨');
    expect(keys, `无姓氏节点「${garbageName}」不得被收录`).not.toContain(garbageName);
    expect(keys, 'void 节点「谢诗雨」不得被收录').not.toContain('谢诗雨');

    const alias = entries.find((e) => e.key === '诗雨');
    expect(alias?.primary, '别名应映射回主名').toBe('徐诗雨');
    expect(alias?.uuid).toBe('TXS-000000007');
  });

  it('路径缺失/不存在 ⇒ 返回空数组（不抛错）', async () => {
    expect(await loadFgPersonEntries(undefined)).toEqual([]);
    expect(await loadFgPersonEntries(join(WORK, 'no-such.db'))).toEqual([]);
  });
});
