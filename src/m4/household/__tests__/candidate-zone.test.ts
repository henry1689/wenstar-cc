/**
 * 批12: FG 观察区(candidate)机制回归测试
 *
 * 背景：L3 弱证据实体（无姓氏、仅长度达标的 3 字以上滑窗片段）原先直接建档 active，
 * 导致 FG 中堆积 3 字噪声（明伶俐/后找男/谢想法…）。本机制让全部 L3 先进观察区，
 * 靠行为证据（提及次数 / 上下文）晋升，避免误伤真人（不遗漏）又不引入噪声。
 *
 * 覆盖：
 *  1. 纯函数层：StatusRules 的 candidate→void 流转、分级器的 L3 证据强度
 *  2. 集成层（DB 副本）：L3 进观察区 / 已知真人保持 active / 证据累积晋升 / 上下文立即晋升
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { copyRealDbForTest } from '../../../__tests__/helpers/safe-db-copy.js';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { computeTargetStatus, STATUS_THRESHOLDS } from '../shared/StatusRules.js';
import { gradeEntity } from '../../../app/entity/EntityCandidateGrader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_PATH_MOD = '../FamilyGraph.js';
const REPO = join(HERE, '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

// ─────────────────────────── 1. 纯函数层 ───────────────────────────

describe('批12 · StatusRules: candidate(观察区) 生命周期', () => {
  it('candidate 超期(>30天)无提及 → void（判定为非真人实体）', () => {
    const r = computeTargetStatus('candidate', STATUS_THRESHOLDS.CANDIDATE_EXPIRE_DAYS + 1);
    expect(r.changed).toBe(true);
    if (r.changed) {
      expect(r.from).toBe('candidate');
      expect(r.to).toBe('void');
    }
  });

  it('candidate 期内(<30天) → 不变（给证据累积留时间）', () => {
    const r = computeTargetStatus('candidate', 10);
    expect(r.changed).toBe(false);
  });

  it('candidate 边界值(恰好30天) → 不变（用 > 而非 >=）', () => {
    const r = computeTargetStatus('candidate', STATUS_THRESHOLDS.CANDIDATE_EXPIRE_DAYS);
    expect(r.changed).toBe(false);
  });

  it('candidate 不走 dormant/archived 路径（专属流转）', () => {
    const r = computeTargetStatus('candidate', 200);
    expect(r.changed).toBe(true);
    if (r.changed) expect(r.to).toBe('void'); // 非 dormant，也非 archived
  });

  it('active 的长周期规则不受影响（回归保护）', () => {
    const r = computeTargetStatus('active', STATUS_THRESHOLDS.DORMANT_AFTER_DAYS + 1);
    expect(r.changed).toBe(true);
    if (r.changed) expect(r.to).toBe('dormant');
  });
});

describe('批12 · 分级器: L3 证据强度细分', () => {
  it('L3 一律 grade=3（放行行为不变）', () => {
    expect(gradeEntity('明伶俐').grade).toBe(3);
    expect(gradeEntity('张小龙').grade).toBe(3);
    expect(gradeEntity('观察区甲').grade).toBe(3);
  });

  it('带 evidenceLevel 标注（供日志/调试，不决定准入）', () => {
    // 有姓氏 → strong；无姓氏仅长度 → weak
    expect(gradeEntity('张小龙').evidenceLevel).toBe('strong');
    expect(gradeEntity('观察区甲').evidenceLevel).toBe('weak');
  });

  it('🔴 关键事实：字面判据不可靠 —— 噪声也会被判 strong', () => {
    // 这正是「全部 L3 进观察区」而非「strong 直接 active」的原因：
    // 明/后/谢/国/家/米/盖/麻/方/计/水/安 都是罕见姓氏字
    expect(gradeEntity('明伶俐').evidenceLevel).toBe('strong');
    expect(gradeEntity('后找男').evidenceLevel).toBe('strong');
    expect(gradeEntity('谢想法').evidenceLevel).toBe('strong');
    // 反例：真名「警幻仙姑」反被判 weak
    expect(gradeEntity('警幻仙姑').evidenceLevel).toBe('weak');
  });

  it('非 L3 不带 evidenceLevel（L0/L1/L2 不受影响）', () => {
    expect(gradeEntity('关系').evidenceLevel).toBeUndefined();
    expect(gradeEntity('关系').grade).toBe(0);
  });
});

// ─────────────────────────── 2. 集成层（DB 副本）───────────────────────────

describe('批12 · FamilyGraph 观察区集成', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    // 🔵 批12(P1-5): 库缺失时【失败】而非静默 return —— 原先 8 个集成用例会在 CI
    // 无库环境下零断言通过（假测试），掩盖真实缺陷。
    if (!existsSync(FG_SRC)) {
      throw new Error('[批12测试] 缺少真实 FG 库，无法验证观察区集成：' + FG_SRC);
    }
    // 🔴 2026-09-20：改用受控复制（校验 + 重试）。服务可能正在全量导出该库，
    // 裸 copyFileSync 会复制到**半写文件**（torn read）⇒ 夹具坏、红绿不定（实测过）。
    const copied = await copyRealDbForTest(FG_SRC, { prefix: 'v27b12-candidate-' });
    tmpDir = copied.dir;
    const copy = copied.path;
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copy);
    await fg.initialize();
    // 🔴 夹具必须**真的可用**：否则判定失败（不允许"打开成功但内容不可读"的假夹具）
    const rows = fg.query('SELECT COUNT(*) AS c FROM nodes') as Array<{ c: number }>;
    if (!rows.length || Number(rows[0].c) <= 0) {
      throw new Error('[批12测试] 夹具库 nodes 为空 —— 判定失败（不允许静默通过）');
    }
  }, 90_000);

  // 🔴 2026-09-20：不变式 —— 每个用例开跑前夹具必须就绪。
  // 原先散在各用例的 `if (!fg) return;` 是"静默通过"形态（夹具缺失时零断言变绿）；
  // 此处把它变成**硬失败**，使那条静默路径在运行时不可达。
  beforeEach(() => {
    if (!fg) throw new Error('[批12测试] FamilyGraph 夹具未就绪 —— 判定失败（不允许静默通过）');
  });

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const statusOf = (name: string): string | null => {
    // 批15: 加 ORDER BY —— 批14 清洗后「明伶俐」等名字在库中同时存在 void 旧节点与
    // candidate 新节点，无排序会随机取到 void 那条，导致本测试红绿不定（真实发生过）。
    // 取最近更新的一条，语义即"该名字当前的有效状态"。
    const rows = fg.query(
      "SELECT status FROM nodes WHERE type='person' AND name = ? ORDER BY updated_at DESC LIMIT 1",
      [name],
    );
    return rows.length ? (rows[0] as any).status : null;
  };

  it('L3 新人名 → 进观察区(candidate)，而非直接 active', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-1', type: 'person', name: '观察区甲' });
    expect(statusOf('观察区甲'), 'L3 应进观察区').toBe('candidate');
  });

  it('🔴 P0-1 端到端回归：首次提及即带介绍句 → 应晋升 active', async () => {
    if (!fg) return;
    // 走真实链路（不经私有方法），复现评审 P0-1：
    // 修复前 _accumulateCandidateEvidence 在 persons 循环【前】调用，
    // 首次提及时候选节点尚不存在 → 首次证据丢失 → 介绍句无法触发晋升。
    const gene = {
      name: '批12验证壬',
      type: 'person',
      allele: '我姐姐叫批12验证壬',
      phenotype: 'neutral',
      knowledge_type: 'family',
    } as any;
    // 批15: 改用库中必然不存在的名字。「明伶俐」在批14 已被判为噪声并 void，
    // 用它会让本用例受存量数据影响（同名 void 节点干扰），失去"首次提及"语义。
    await fg.integrateFromEntity([gene], '我姐姐叫批12验证壬');
    expect(statusOf('批12验证壬'), '首次提及带介绍句必须立即晋升（P0-1）').toBe('active');
  });

  it('🔴 P1-4 回归：已 void 的名字再次出现不应直接 active', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-void-1', type: 'person', name: '观察区庚' });
    expect(statusOf('观察区庚')).toBe('candidate');
    // 手动置 void（模拟 30 天超期回收）
    fg.run("UPDATE nodes SET status='void' WHERE name='观察区庚'");
    // 再次出现：不应因 existingNames 命中 grade 4 而直接 active
    await fg.addNode({ id: 'v27b12-void-2', type: 'person', name: '观察区庚' });
    const st = statusOf('观察区庚');
    expect(st, 'void 名再出现不得绕过观察区').not.toBe('active');
  });

  it('🔴 不遗漏保障：已在 FG 的真人（grade 4 已知）→ 保持 active', async () => {
    if (!fg) return;
    // 从真实库中取一个已知真人名
    const known = fg.query("SELECT name FROM nodes WHERE type='person' AND status='active' LIMIT 1") as Array<{ name: string }>;
    if (known.length === 0) return;
    const name = known[0].name;
    // 再次 addNode（已知实体路径）不应降级为 candidate
    await fg.addNode({ id: 'v27b12-known-1', type: 'person', name });
    expect(statusOf(name), '已知真人不得被降级').toBe('active');
  });

  it('candidate 被提及 3 次 → 晋升 active', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-2', type: 'person', name: '观察区乙' });
    expect(statusOf('观察区乙')).toBe('candidate');

    const internals = fg as any;
    await internals._accumulateCandidateEvidence(['观察区乙'], '一句无关的话');
    await internals._accumulateCandidateEvidence(['观察区乙'], '另一句无关的话');
    expect(statusOf('观察区乙'), '2 次还不够').toBe('candidate');
    await internals._accumulateCandidateEvidence(['观察区乙'], '第三句话');
    expect(statusOf('观察区乙'), '3 次应晋升').toBe('active');
  });

  it('candidate 有称谓动词（弱上下文）→ 需累积 2 次（P2-6）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-3', type: 'person', name: '观察区丙' });
    expect(statusOf('观察区丙')).toBe('candidate');

    const internals = fg as any;
    // P2-6: 「名字紧邻称谓动词」属弱上下文 —— 候选片段是 rawInput 的连续子串，
    // 前后邻字本就可能是任意高频字，单次命中不足以判定真人 → 需累积 2 次。
    await internals._accumulateCandidateEvidence(['观察区丙'], '观察区丙说明天来找我');
    expect(statusOf('观察区丙'), '单次弱上下文不足以晋升').toBe('candidate');

    await internals._accumulateCandidateEvidence(['观察区丙'], '观察区丙讲了件事');
    expect(statusOf('观察区丙'), '2 次弱上下文应晋升').toBe('active');
  });

  it('candidate 有强上下文（介绍句/关系词）→ 1 次即晋升（P2-6）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-3b', type: 'person', name: '观察区辛' });
    expect(statusOf('观察区辛')).toBe('candidate');
    const internals = fg as any;
    // 介绍句误报率极低 → 单次即晋升
    await internals._accumulateCandidateEvidence(['观察区辛'], '我同事观察区辛来了');
    expect(statusOf('观察区辛'), '强上下文应 1 次晋升').toBe('active');
  });

  it('candidate 有介绍句式 → 立即晋升（"这是我的朋友XX"）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-4', type: 'person', name: '观察区丁' });
    const internals = fg as any;
    await internals._accumulateCandidateEvidence(['观察区丁'], '这是我的朋友观察区丁');
    expect(statusOf('观察区丁'), '关系词上下文应晋升').toBe('active');
  });

  it('🔴 反向用例：名字仅作宾语（无自身上下文）→ 不晋升', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-6', type: 'person', name: '观察区己' });
    const internals = fg as any;
    // "说" 属于前面的「张小龙」，观察区己只是宾语 → 不应被当作称谓上下文
    await internals._accumulateCandidateEvidence(['观察区己'], '张小龙说观察区己明天来');
    expect(statusOf('观察区己'), '宾语位置不应晋升').toBe('candidate');
  });

  it('candidate 无上下文且提及不足 → 留在观察区（不噪声）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b12-cand-5', type: 'person', name: '观察区戊' });
    const internals = fg as any;
    await internals._accumulateCandidateEvidence(['观察区戊'], '今天天气不错');
    expect(statusOf('观察区戊'), '无证据应留观察区').toBe('candidate');
  });

  it('证据累积只作用于 candidate —— 不触碰 active/dormant/void', async () => {
    if (!fg) return;
    const active = fg.query("SELECT name FROM nodes WHERE type='person' AND status='active' LIMIT 1") as Array<{ name: string }>;
    if (active.length === 0) return;
    const name = active[0].name;
    const internals = fg as any;
    await internals._accumulateCandidateEvidence([name], name + '说话了');
    expect(statusOf(name), 'active 不应被观察区逻辑改动').toBe('active');
  });
});
