/**
 * dialog-group-lifecycle.test.ts — A2/Phase2.1 组级生命周期回归测试
 * ============================================================
 * 被守的契约（R016 任务A2 / 业主裁决）：
 *   状态机 active → consolidating → archived
 *   · block_calcium_score >= 5 → consolidating
 *   · 创建 > 30 天 且 score < 2 → archived
 *   · 沉淀窗 30 分钟内不做任何流转
 *   · 归档不删除（只增不减），状态是纯函数派生（重启幂等）
 *
 * 判据单一真源：DialogGroupLifecycle.ts（规则常量 + computeDialogGroupLifecycle +
 * advanceDialogGroupLifecycle）。本测试直接消费同一模块，防规则漂移。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  DG_LIFECYCLE_RULE,
  computeDialogGroupLifecycle,
  advanceDialogGroupLifecycle,
} from '../DialogGroupLifecycle.js';

const MIN = 60 * 1000;
const DAY_MIN = 24 * 60;

describe('computeDialogGroupLifecycle — 纯函数规则', () => {
  it('沉淀窗：不足 30 分钟返回 null（不流转，保持现值）', () => {
    expect(computeDialogGroupLifecycle(9, 0)).toBeNull();     // 刚闭组，高钙也不动
    expect(computeDialogGroupLifecycle(0, DG_LIFECYCLE_RULE.settlingWindowMinutes - 1)).toBeNull();
  });

  it('沉淀窗边界：满 30 分钟即开始按规则流转', () => {
    expect(computeDialogGroupLifecycle(5, DG_LIFECYCLE_RULE.settlingWindowMinutes)).toBe('consolidating');
    expect(computeDialogGroupLifecycle(0, DG_LIFECYCLE_RULE.settlingWindowMinutes)).toBe('active');
  });

  it('高钙：calcium >= 5 → consolidating（与组龄无关）', () => {
    expect(computeDialogGroupLifecycle(5, 60)).toBe('consolidating');            // 恰好 5
    expect(computeDialogGroupLifecycle(7.5, 60)).toBe('consolidating');
    // 老组 + 高钙：consolidating 优先（archived 要求 score<2，两规则无交集）
    expect(computeDialogGroupLifecycle(5, 40 * DAY_MIN)).toBe('consolidating');
  });

  it('归档：创建 > 30 天 且 score < 2 → archived', () => {
    expect(computeDialogGroupLifecycle(1.5, 31 * DAY_MIN)).toBe('archived');
    // 边界：恰好 30 天不算「超过」
    expect(computeDialogGroupLifecycle(1.5, 30 * DAY_MIN)).toBe('active');
    // 边界：score 恰好 2 不满足 < 2
    expect(computeDialogGroupLifecycle(2, 40 * DAY_MIN)).toBe('active');
  });

  it('中间地带保持 active（不够老 或 钙分在 [2,5)）', () => {
    expect(computeDialogGroupLifecycle(3, 10 * DAY_MIN)).toBe('active');       // 中钙未老
    expect(computeDialogGroupLifecycle(4.9, 40 * DAY_MIN)).toBe('active');      // 老但钙分>=2
    expect(computeDialogGroupLifecycle(0, 10 * DAY_MIN)).toBe('active');        // 低钙但不够老
  });

  it('异常输入安全：NaN/负钙分错底为 0（不抛错、不误档）', () => {
    expect(computeDialogGroupLifecycle(NaN, 60)).toBe('active');
    expect(computeDialogGroupLifecycle(-1, 60)).toBe('active');       // 负值→0，未老→active
    expect(computeDialogGroupLifecycle(-1, 40 * DAY_MIN)).toBe('archived'); // 负值→0，够老→archived（规则使然）
  });
});

/** 夹具：最小 dialog_groups 表 + run/exec 适配层（把 better-sqlite3 包装成生产 sql.js 同形接口） */
function makeFixtureDb(): any {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dialog_groups (
    dialog_group_id TEXT PRIMARY KEY, block_calcium_score REAL NOT NULL DEFAULT 0,
    created_at TEXT, lifecycle_state TEXT, updated_at TEXT)`);
  return {
    _raw: db,
    run: (sql: string, ...params: any[]) => { db.prepare(sql).run(...params); },
    exec: (sql: string) => {
      const rows = db.prepare(sql).raw(true).all();
      return rows.length ? [{ columns: [], values: rows }] : [];
    },
  };
}
function ins(db: any, id: string, calcium: number, ageMinutes: number, state = 'active', now = new Date()): void {
  db._raw.prepare('INSERT INTO dialog_groups (dialog_group_id, block_calcium_score, created_at, lifecycle_state, updated_at) VALUES (?,?,?,?,?)')
    .run(id, calcium, new Date(now.getTime() - ageMinutes * MIN).toISOString(), state, now.toISOString());
}

describe('advanceDialogGroupLifecycle — 表级流转（幂等/只增不减）', () => {
  const NOW = new Date('2026-10-19T12:00:00Z');

  it('存量初始化：按规则分流，分布非全 active', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_HIGH', 6, 100, 'active', NOW);      // 高钙 → consolidating
    ins(db, 'DG_OLDLOW', 1, 40 * DAY_MIN, 'active', NOW); // 老低钙 → archived
    ins(db, 'DG_FRESH', 9, 5, 'active', NOW);       // 沉淀窗内 → 不动（active）
    ins(db, 'DG_MID', 3, 10 * DAY_MIN, 'active', NOW);    // 中间地带 → active
    const r = advanceDialogGroupLifecycle(db, NOW);
    expect(r.scanned).toBe(4);
    expect(r.transitions).toBe(2);
    expect(r.skippedSettling).toBe(1);
    const q = (id: string) => db._raw.prepare('SELECT lifecycle_state FROM dialog_groups WHERE dialog_group_id=?').get(id).lifecycle_state;
    expect(q('DG_HIGH')).toBe('consolidating');
    expect(q('DG_OLDLOW')).toBe('archived');
    expect(q('DG_FRESH')).toBe('active');           // 沉淀窗内保持原值
    expect(q('DG_MID')).toBe('active');
    db._raw.close();
  });

  it('幂等：第二次执行零流转、分布不变（重启幂等，R016 验收项）', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_HIGH', 6, 100, 'active', NOW);
    ins(db, 'DG_OLDLOW', 1, 40 * DAY_MIN, 'active', NOW);
    advanceDialogGroupLifecycle(db, NOW);
    const second = advanceDialogGroupLifecycle(db, NOW);
    expect(second.transitions).toBe(0);
    expect(second.distribution).toEqual({ active: 0, consolidating: 1, archived: 1 });
    db._raw.close();
  });

  it('只增不减：archived 只改状态，绝不删行', () => {
    const db = makeFixtureDb();
    for (let i = 0; i < 5; i++) ins(db, 'DG_OLD_' + i, 0, 40 * DAY_MIN, 'active', NOW);
    advanceDialogGroupLifecycle(db, NOW);
    const cnt = db._raw.prepare('SELECT COUNT(*) c FROM dialog_groups').get().c;
    expect(cnt).toBe(5); // 行数不变
    const arch = db._raw.prepare("SELECT COUNT(*) c FROM dialog_groups WHERE lifecycle_state='archived'").get().c;
    expect(arch).toBe(5);
    db._raw.close();
  });

  it('时钟注入：组随时间老去，下次扫描才收敛（组龄跨边界由后续启动流转）', () => {
    const db = makeFixtureDb();
    const t0 = new Date('2026-10-01T00:00:00Z');
    ins(db, 'DG_AGE', 1, 10 * DAY_MIN, 'active', t0); // t0 时仅 10 天 → active
    const r1 = advanceDialogGroupLifecycle(db, t0);
    expect(r1.distribution.active).toBe(1);
    // 25 天后：总龄 35 天 > 30 → archived
    const t1 = new Date(t0.getTime() + 25 * DAY_MIN * MIN);
    const r2 = advanceDialogGroupLifecycle(db, t1);
    expect(r2.transitions).toBe(1);
    expect(db._raw.prepare('SELECT lifecycle_state FROM dialog_groups WHERE dialog_group_id=?').get('DG_AGE').lifecycle_state).toBe('archived');
    db._raw.close();
  });
});
