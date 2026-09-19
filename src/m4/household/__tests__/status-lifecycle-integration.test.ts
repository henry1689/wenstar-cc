/**
 * 批13 · 状态机统一 + applyJudgments 的【集成】测试（评审 F6 补强）
 *
 * 评审指出：status-machine-unified.test.ts 只测纯函数 computeTargetStatus，
 * 而 runDailyHouseholdMaintenance 的 SQL 循环、status 过滤、void 删边副作用
 * 以及 applyJudgments 的「只动 candidate」不变式**一行都没覆盖**。
 * 本文件用真实库副本做集成验证（沿用 candidate-zone.test.ts 的手法）。
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

describe('批13 · 状态机统一 + applyJudgments 集成（F6）', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    if (!existsSync(FG_SRC)) {
      throw new Error('[批13测试] 缺少真实 FG 库，无法验证生命周期集成：' + FG_SRC);
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'v27b13-lifecycle-'));
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
  const edgeCountOf = (id: string): number => {
    const r = fg.query('SELECT COUNT(*) as c FROM edges WHERE source_id = ? OR target_id = ?', [id, id]);
    return (r[0] as any).c as number;
  };
  const setMentionedDaysAgo = (name: string, days: number) => {
    const id = idOf(name)!;
    const r = fg.query('SELECT properties FROM nodes WHERE id = ?', [id]);
    const props = JSON.parse((r[0] as any).properties || '{}');
    props.last_mentioned = iso(days);
    fg.run('UPDATE nodes SET properties = ? WHERE id = ?', [JSON.stringify(props), id]);
  };

  // ── ① candidate 超期回收（含删边副作用）──
  it('candidate + 40 天无提及 → void 且关联边被清理', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b13-cand-1', type: 'person', name: '生命周期甲' });
    expect(statusOf('生命周期甲')).toBe('candidate');
    const id = idOf('生命周期甲')!;
    // 造一条边（用 addEdge —— edges 表 created_at/updated_at 为 NOT NULL，裸 INSERT 会失败）
    await fg.addEdge({
      id: 'v27b13-edge-1',
      source_id: fg.userNodeId || idOf('我') || id,
      target_id: id,
      relation: 'acquaintance_of',
    } as any);
    const before = edgeCountOf(id);
    expect(before).toBeGreaterThan(0);

    setMentionedDaysAgo('生命周期甲', 40);
    fg.runDailyHouseholdMaintenance();

    expect(statusOf('生命周期甲')).toBe('void');
    expect(edgeCountOf(id), 'void 必须清理关联边（否则 health-check fatal）').toBe(0);
  });

  // ── ② 未超期不动 ──
  it('candidate + 10 天 → 保持观察（不误回收）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b13-cand-2', type: 'person', name: '生命周期乙' });
    setMentionedDaysAgo('生命周期乙', 10);
    fg.runDailyHouseholdMaintenance();
    expect(statusOf('生命周期乙')).toBe('candidate');
  });

  // ── ③ active 的长周期流转（回归批13 部分1 的等价性）──
  it('active + 91 天 → dormant；active + 89 天 → 不变', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b13-act-1', type: 'person', name: '生命周期丙' });
    fg.run("UPDATE nodes SET status='active' WHERE name='生命周期丙'");
    setMentionedDaysAgo('生命周期丙', 91);

    await fg.addNode({ id: 'v27b13-act-2', type: 'person', name: '生命周期丁' });
    fg.run("UPDATE nodes SET status='active' WHERE name='生命周期丁'");
    setMentionedDaysAgo('生命周期丁', 89);

    fg.runDailyHouseholdMaintenance();

    expect(statusOf('生命周期丙')).toBe('dormant');
    expect(statusOf('生命周期丁')).toBe('active');
  });

  // ── ④ applyJudgments 的「只动 candidate」不变式（评审要求）──
  it('🔴 applyJudgments 只改 candidate —— active/dormant/void 的 status 与 properties 不变', async () => {
    if (!fg) return;
    // 准备三种非 candidate 状态
    await fg.addNode({ id: 'v27b13-safe-1', type: 'person', name: '不变式甲' });
    fg.run("UPDATE nodes SET status='active' WHERE name='不变式甲'");
    await fg.addNode({ id: 'v27b13-safe-2', type: 'person', name: '不变式乙' });
    fg.run("UPDATE nodes SET status='dormant' WHERE name='不变式乙'");
    await fg.addNode({ id: 'v27b13-safe-3', type: 'person', name: '不变式丙' });
    fg.run("UPDATE nodes SET status='void' WHERE name='不变式丙'");

    const snap = (name: string) => {
      const r = fg.query('SELECT status, properties FROM nodes WHERE name = ?', [name]);
      return JSON.stringify(r[0]);
    };
    const before = ['不变式甲', '不变式乙', '不变式丙'].map(snap);

    // 强行对非 candidate 发起「提升」
    fg.applyJudgments({ promote: ['不变式甲', '不变式乙', '不变式丙'], annotate: [] }, 'test');

    const after = ['不变式甲', '不变式乙', '不变式丙'].map(snap);
    expect(after).toEqual(before);
  });

  // ── ⑤ applyJudgments 提升 candidate + 审计 ──
  it('applyJudgments 提升 candidate 并写入 _changeHistory 审计', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b13-cand-3', type: 'person', name: '终审提升甲' });
    expect(statusOf('终审提升甲')).toBe('candidate');

    const r = fg.applyJudgments({ promote: ['终审提升甲'], annotate: [] }, 'dream-judge');
    expect(r.promoted).toBe(1);
    expect(statusOf('终审提升甲')).toBe('active');

    const row = fg.query("SELECT properties FROM nodes WHERE name='终审提升甲'");
    const props = JSON.parse((row[0] as any).properties || '{}');
    expect(Array.isArray(props._changeHistory)).toBe(true);
    const last = props._changeHistory[props._changeHistory.length - 1];
    expect(last.field).toBe('status');
    expect(last.newValue).toBe('active');
    expect(props._judge?.verdict).toBe('person');
  });

  // ── ⑥ noise 只标注、不改 status（保守边界）──
  it('🔴 noise 标注后 status 仍为 candidate（永不自动回收）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b13-cand-4', type: 'person', name: '终审噪声甲' });
    const r = fg.applyJudgments(
      { promote: [], annotate: [{ name: '终审噪声甲', confidence: 0.95, reason: '滑窗片段' }] },
      'dream-judge',
    );
    expect(r.annotated).toBe(1);
    expect(statusOf('终审噪声甲'), '标注不得改变状态').toBe('candidate');
    const row = fg.query("SELECT properties FROM nodes WHERE name='终审噪声甲'");
    const props = JSON.parse((row[0] as any).properties || '{}');
    expect(props._judge?.verdict).toBe('noise');
    expect(props._judge?.autoReclaimed).toBe(false);
  });

  // ── ⑦ collectCandidateItems 排除已标注 noise（F5 回归）──
  it('collectCandidateItems 不再返回已判 noise 的候选（防重复计费）', async () => {
    if (!fg) return;
    const names = fg.collectCandidateItems(200).map((x: any) => x.name);
    expect(names).not.toContain('终审噪声甲');
  });
});
