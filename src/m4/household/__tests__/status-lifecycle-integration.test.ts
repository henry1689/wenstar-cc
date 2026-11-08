/**
 * 生命周期状态机 · 集成测试（批3 退役改造）
 *
 * 原文件验证「candidate 超期回收 + applyJudgments」；批3（2026-11-08，ADR-021）
 * 已物理删除观察区与离线终审，本文件改为验证：
 *   ① 新写入的 person 直接 active（不再进观察区）
 *   ② active → dormant 的长周期流转不受影响
 *   ③ 历史库残留的 candidate 行不再被状态机自动 void（由批5 按业主确认处置）
 *   ④ applyJudgments / collectCandidateItems 已不存在（防死灰复燃）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_PATH_MOD = '../FamilyGraph.js';
const REPO = join(HERE, '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

const DAY = 86400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe('生命周期状态机 · 集成（批3 退役改造）', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    if (!existsSync(FG_SRC)) {
      throw new Error('[生命周期测试] 缺少真实 FG 库：' + FG_SRC);
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'b3-lifecycle-'));
    const copy = join(tmpDir, 'family_graph.db');
    copyFileSync(FG_SRC, copy);
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copy);
    await fg.initialize();
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const statusOf = (name: string): string | null => {
    const r = fg.query("SELECT status FROM nodes WHERE type='person' AND name = ?", [name]);
    return r.length ? (r[0] as any).status : null;
  };
  const idOf = (name: string): string | null => {
    const r = fg.query("SELECT id FROM nodes WHERE type='person' AND name = ?", [name]);
    return r.length ? (r[0] as any).id : null;
  };
  const setMentionedDaysAgo = (name: string, days: number) => {
    const id = idOf(name)!;
    const r = fg.query('SELECT properties FROM nodes WHERE id = ?', [id]);
    const props = JSON.parse((r[0] as any).properties || '{}');
    props.last_mentioned = iso(days);
    fg.run('UPDATE nodes SET properties = ? WHERE id = ?', [JSON.stringify(props), id]);
  };

  it('① 新写入 person 直接 active（不再进观察区）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'b3-act-new', type: 'person', name: '生命周期甲' });
    expect(statusOf('生命周期甲')).toBe('active');
  });

  it('② active + 91 天 → dormant；active + 89 天 → 不变', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'b3-act-1', type: 'person', name: '生命周期丙' });
    fg.run("UPDATE nodes SET status='active' WHERE name='生命周期丙'");
    setMentionedDaysAgo('生命周期丙', 91);

    await fg.addNode({ id: 'b3-act-2', type: 'person', name: '生命周期丁' });
    fg.run("UPDATE nodes SET status='active' WHERE name='生命周期丁'");
    setMentionedDaysAgo('生命周期丁', 89);

    fg.runDailyHouseholdMaintenance();

    expect(statusOf('生命周期丙')).toBe('dormant');
    expect(statusOf('生命周期丁')).toBe('active');
  });

  it('③ 遗留 candidate 行不再被状态机自动 void（交批5）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'b3-legacy-cand', type: 'person', name: '生命周期戊' });
    fg.run("UPDATE nodes SET status='candidate' WHERE name='生命周期戊'");
    setMentionedDaysAgo('生命周期戊', 40);
    fg.runDailyHouseholdMaintenance();
    expect(statusOf('生命周期戊')).toBe('candidate');
  });

  it('④ applyJudgments / collectCandidateItems 已物理删除', () => {
    expect(fg.applyJudgments).toBeUndefined();
    expect(fg.collectCandidateItems).toBeUndefined();
  });
});
