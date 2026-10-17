/**
 * cross-entity-anchor-guard.test.ts — 跨实体锚点污染守卫（2026-10-18，业主批准A+B+C）
 * ============================================================
 * 被守的缺陷（生产实锤 2026-10-18）：
 *   用户报「与阿珍聊天时把问玉瑶的天气窜到了阿珍记忆里」。取证链：
 *   ① 对话组闭合原因有 meeting_exit 无 meeting_entry ⇒ 实测 92 个组横跨两实体
 *      （例 DG_11824：玉瑶轮次含"天气真好"问答 + 阿珍轮次同组）；
 *   ② resolveAnchorOwnership 第一优先级是 dg.entities（组内**提及**过的人名）取第一个有 UUID 的
 *      ⇒ 用户说"叫阿珍来"→ 阿珍进 entities → 整组锚点归阿珍（实测 32 个锚点归属与组内多数矛盾）；
 *   ③ 锚点文本把全部轮次签名替换为归属实体名 ⇒ 玉瑶说的天气被改签成"阿珍说的"。
 *   端到端：错标锚点含天气轮 + belong=阿珍 ⇒ 会晤召回按 UUID 过滤"正确地"捞出错标行
 *   —— 检索侧隔离机制本身健全，穿透点在**写入侧归属**。
 *
 * 本测试锁定（C 层）：
 *   X1. 闭组必须含 meeting_entry（能力断言 —— 防对话组再次跨实体）；
 *   X2. 锚点归属主判据 = conversations 逐轮归属**多数决**（提及降为末位）——行为断言；
 *   X3. 确定性：同数归属取最早轮（GROUP BY ORDER BY cnt DESC, first_seq ASC）——行为断言；
 *   X4. 单实体组行为不变（多数决 = 唯一实体）；脏值 'null' 不入锚点；
 *   X5. 防回退：resolveAnchorOwnership 源码中提及路径不得再是第一优先级。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnchorOwnership } from '../dialog-group-stage.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// ─── 桩依赖 ────────────────────────────────────────────
/** 桩 sql：按 seq_pos 归属行回答多数决查询（模拟 conversations 表） */
function stubSql(rows: Array<{ seq_pos: number; belong_entity_uuid: string }>) {
  return {
    queryAll: (sql: string) => {
      if (!/GROUP BY belong_entity_uuid/.test(sql)) {
        throw new Error('锚点归属查询必须走多数决（GROUP BY belong_entity_uuid），不得单行 LIMIT 1: ' + sql);
      }
      // 从 IN (...) 提取 seq 集合
      const m = sql.match(/seq_pos IN \(([^)]+)\)/);
      const seqs = new Set((m ? m[1].split(',').map(Number) : []));
      const hit = rows.filter((r) => seqs.has(r.seq_pos) && r.belong_entity_uuid && r.belong_entity_uuid !== 'null');
      const by = new Map<string, { cnt: number; first: number }>();
      for (const r of hit) {
        const e = by.get(r.belong_entity_uuid) ?? { cnt: 0, first: Number.MAX_SAFE_INTEGER };
        e.cnt += 1; e.first = Math.min(e.first, r.seq_pos);
        by.set(r.belong_entity_uuid, e);
      }
      const sorted = [...by.entries()].sort((a, b) => b[1].cnt - a[1].cnt || a[1].first - b[1].first);
      return sorted.map(([uuid, e]) => ({ belong_entity_uuid: uuid, cnt: e.cnt, first_seq: e.first }));
    },
  };
}

const FG = { getUUIDByName: (n: string) => ({ 阿珍: 'TXS-A', 徐诗雨: 'TXS-B' } as Record<string, string>)[n] ?? null };
const FALLBACK = { meetingUuid: null, yuyaoUuid: 'TXS-Y', characterName: null };
const dgWith = (seqs: number[], entities: string[] = []) => ({
  rounds: seqs.map((s) => ({ seqPos: s })), entities: ['我', '玉瑶', ...entities],
});

// ─── X2/X3: 多数决主判据 ──────────────────────────────
describe('X2 — 锚点归属主判据 = conversations 逐轮归属多数决', () => {
  it('混合组（玉瑶5轮+阿珍2轮，组内提及阿珍）⇒ 归玉瑶 —— 提及不得劫持', () => {
    const rows = [
      { seq_pos: 1, belong_entity_uuid: 'TXS-Y' }, { seq_pos: 2, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 3, belong_entity_uuid: 'TXS-Y' }, { seq_pos: 4, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 5, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 6, belong_entity_uuid: 'TXS-A' }, { seq_pos: 7, belong_entity_uuid: 'TXS-A' },
    ];
    const r = resolveAnchorOwnership(dgWith([1, 2, 3, 4, 5, 6, 7], ['阿珍']), stubSql(rows), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-Y'); // 天气案例的精确反转：多数轮=玉瑶 ⇒ 锚点归玉瑶
  });

  it('反向：阿珍5轮+玉瑶2轮 ⇒ 归阿珍（多数决双向成立，非硬编码玉瑶）', () => {
    const rows = [
      { seq_pos: 1, belong_entity_uuid: 'TXS-A' }, { seq_pos: 2, belong_entity_uuid: 'TXS-A' },
      { seq_pos: 3, belong_entity_uuid: 'TXS-A' }, { seq_pos: 4, belong_entity_uuid: 'TXS-A' },
      { seq_pos: 5, belong_entity_uuid: 'TXS-A' }, { seq_pos: 6, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 7, belong_entity_uuid: 'TXS-Y' },
    ];
    const r = resolveAnchorOwnership(dgWith([1, 2, 3, 4, 5, 6, 7]), stubSql(rows), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-A');
  });

  it('X3 确定性：同数归属（3:3）⇒ 取最早轮的归属（first_seq 小者）', () => {
    const rows = [
      { seq_pos: 1, belong_entity_uuid: 'TXS-A' }, { seq_pos: 2, belong_entity_uuid: 'TXS-A' },
      { seq_pos: 3, belong_entity_uuid: 'TXS-A' },
      { seq_pos: 4, belong_entity_uuid: 'TXS-Y' }, { seq_pos: 5, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 6, belong_entity_uuid: 'TXS-Y' },
    ];
    const r = resolveAnchorOwnership(dgWith([1, 2, 3, 4, 5, 6]), stubSql(rows), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-A'); // 首轮属 A
  });
});

// ─── X4: 不变性与脏值 ─────────────────────────────────
describe('X4 — 单实体组不变 + 脏值隔离', () => {
  it('单实体组（全部玉瑶轮）⇒ 归玉瑶（与旧行为一致）', () => {
    const rows = [{ seq_pos: 1, belong_entity_uuid: 'TXS-Y' }, { seq_pos: 2, belong_entity_uuid: 'TXS-Y' }];
    const r = resolveAnchorOwnership(dgWith([1, 2]), stubSql(rows), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-Y');
  });

  it("脏值 'null' 不得当选（SQL 层已排除，桩再次确认语义）", () => {
    const rows = [
      { seq_pos: 1, belong_entity_uuid: 'TXS-Y' },
      { seq_pos: 2, belong_entity_uuid: 'null' }, { seq_pos: 3, belong_entity_uuid: 'null' },
    ];
    const r = resolveAnchorOwnership(dgWith([1, 2, 3]), stubSql(rows), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-Y');
  });

  it('conversations 无数据时才降级提及推断（提及=末位）', () => {
    const r = resolveAnchorOwnership(dgWith([1, 2], ['阿珍']), stubSql([]), FG, FALLBACK);
    expect(r.uuid).toBe('TXS-A'); // 无逐轮数据时提及兜底仍工作（历史组兼容）
  });

  it('全解析失败 ⇒ 守链兑底玉瑶；无兑底 ⇒ null（宁拒不放）', () => {
    expect(resolveAnchorOwnership(dgWith([]), stubSql([]), FG, { ...FALLBACK }).uuid).toBe('TXS-Y');
    expect(resolveAnchorOwnership(dgWith([]), stubSql([]), FG, { meetingUuid: null, yuyaoUuid: null, characterName: null }).uuid).toBeNull();
  });
});

// ─── X1/X5: 源码级能力断言（防回退）──────────────────
describe('X1/X5 — 闭组与判据次序（能力断言）', () => {
  const chatSrc = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');
  const src = readFileSync(join(REPO, 'src', 'webui', 'chat', 'dialog-group-stage.ts'), 'utf8');

  it('X1: 闭组原因必须含 meeting_entry（镜像 meeting_exit）', () => {
    expect(chatSrc).toMatch(/_meetingEntered \? 'meeting_entry'/);
  });

  it('X1: 进入指令轮不得新建对话组（防新组把指令轮划给新实体）', () => {
    expect(chatSrc).toMatch(/if \(!_dg && !_meetingExited && !_meetingEntered\) \{/);
  });

  it('X5: 归属查询必须是多数决形态（GROUP BY + cnt DESC），且提及路径在 conversations 之后', () => {
    expect(src).toMatch(/GROUP BY belong_entity_uuid ORDER BY cnt DESC, first_seq ASC LIMIT 1/);
    const convIdx = src.indexOf('多数决');
    const mentionIdx = src.indexOf('提及降为末位');
    expect(convIdx).toBeGreaterThan(-1);
    expect(mentionIdx).toBeGreaterThan(-1);
    expect(convIdx).toBeLessThan(mentionIdx); // 权威判据在前，提及在后
  });
});
