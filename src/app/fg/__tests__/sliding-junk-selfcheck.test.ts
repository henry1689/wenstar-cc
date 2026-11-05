import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { FGHealthCheck } from '../FGHealthCheck.js';
import { copyRealDbForTest } from '../../../__tests__/helpers/safe-db-copy.js';

/**
 * 滑窗自检通道B 正负样本双向锁定（2026-11-05 C 阶段，业主批准 A→C→B）
 * ============================================================
 * 背景：13 个已确认滑窗垃圾 active 全部漏过通道A（尾字集刻意保守 + contexts≤1 过严）。
 * 本测试锁定新增通道B（⑤前缀扩展 / ⑥计数倒挂 / ⑦单句低证）的检出面与误报面：
 *   正样本：每类垃圾必须被检出，且 hitChannel 标注正确；
 *   负样本：真实人名（有档案 / 高提及 / 无 evidence 字段的存量真人）必须零误报。
 * 只预警不自动 void —— 本测试不断言状态变更，只断言清单内容。
 */

const FG_SRC = join(process.cwd(), 'data', 'webui', 'knowledge', 'family_graph.db');
const FG_MOD = '../../../m4/household/FamilyGraph.js';
describe('FGHealthCheck.detectSlidingWindowJunk — 通道B 正负样本', () => {
  let fg: any = null;
  let tmpDir = '';

  const upsert = (name: string, props: Record<string, unknown>, status = 'active', aliases: string[] = []) => {
    const now = new Date().toISOString();
    fg.run(
      `INSERT OR REPLACE INTO nodes (id, type, name, aliases, properties, created_at, updated_at, status, uuid)
       VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)`,
      [`t-${name}`, name, JSON.stringify(aliases), JSON.stringify(props), now, now, status, `TXS-T-${name}`],
    );
  };

  beforeAll(async () => {
    // 🔴 复用 candidate-zone 同款受控复制（校验+重试，防服务全量导出期 torn read）；
    // 库缺失/空库一律失败，不允许零断言假通过
    const copied = await copyRealDbForTest(FG_SRC, { prefix: 'sliding-junk-' });
    tmpDir = copied.dir;
    const { FamilyGraph } = await import(FG_MOD);
    fg = new FamilyGraph(copied.path);
    await fg.initialize();
    const rows = fg.query('SELECT COUNT(*) AS c FROM nodes') as Array<{ c: number }>;
    if (!rows.length || Number(rows[0].c) <= 0) {
      throw new Error('[滑窗自检测试] 夹具库 nodes 为空 — 判定失败');
    }
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const detect = (): Array<{ name: string; hitChannel: string; mentions: number }> => {
    if (!fg) throw new Error('[滑窗自检测试] FamilyGraph 夹具未就绪 — 判定失败');
    return new FGHealthCheck(fg).detectSlidingWindowJunk();
  };

  const channelOf = (list: Array<{ name: string; hitChannel: string }>, name: string): string | null =>
    list.find(s => s.name === name)?.hitChannel ?? null;

  it('正样本⑤ 前缀扩展：真名+1~2字切片被 B5 检出（阿珍→阿珍一 形态）', () => {
    upsert('测试真名甲', { mention_count: 300, description: '真实人物档案' }, 'active', ['阿测']);
    upsert('阿测一', { mention_count: 176, evidence: { count: 11, contexts: ['找阿测一起聊聊', '找阿测一起聊聊', '找阿测一起说说'] } });
    const list = detect();
    expect(channelOf(list, '阿测一')).toContain('B5');
    // 前缀集含别名（阿测 是测试真名甲 的别名）
    expect(channelOf(list, '阿测一')).toMatch(/B5/);
  });

  it('正样本⑥ 计数倒挂：mention≥3×evidence 且≥8 被 B6 检出', () => {
    upsert('倒挂样本', { mention_count: 48, evidence: { count: 1, contexts: ['单句引入语境'] } });
    const list = detect();
    expect(channelOf(list, '倒挂样本')).toContain('B6');
  });

  it('正样本⑦ 单句低证：evidence 存在且 count≤2 ctx≤2 被 B7 检出', () => {
    upsert('低证样本', { mention_count: 3, evidence: { count: 1, contexts: ['单句'] } });
    const list = detect();
    expect(channelOf(list, '低证样本')).toContain('B7');
  });

  it('正样本通道A 回归：尾字+单句原判据仍工作（防改动破坏旧通道）', () => {
    // 尾字 '了' 在 NON_NAME_TAIL_CHARS，无 contexts → 通道A
    upsert('学习了', { mention_count: 5 });
    const list = detect();
    expect(channelOf(list, '学习了')).toContain('A');
  });

  it('负样本 真实人名有档案：零误报', () => {
    upsert('真实有档', { mention_count: 7056, description: '真人档案', relation_to_user: '同学' });
    const list = detect();
    expect(channelOf(list, '真实有档')).toBeNull();
  });

  it('负样本 存量真人无 evidence 字段（陈锋华形态）：⑦ 不得按 count=0 误报', () => {
    // 15/16 active 存量真人无 evidence 字段 —— ⑦ 要求 evidence 存在才评估
    // ⚠️ 样本名尾刻意不用『人』（它在 NON_NAME_TAIL_CHARS，会撞通道A——与⑦无关）
    upsert('存量真名', { mention_count: 11 });
    const list = detect();
    expect(channelOf(list, '存量真名')).toBeNull();
  });

  it('负样本 高提及无倒挂：mc≥8 但 mc<3×ev 不触发 B6', () => {
    upsert('正常高频', { mention_count: 100, description: '有档案', evidence: { count: 90, contexts: ['a', 'b', 'c'] } });
    const list = detect();
    // 有 description → ② 直接排除
    expect(channelOf(list, '正常高频')).toBeNull();
  });

  it('hitChannel 可叠加标注（同时命中多通道用 + 连接）', () => {
    // 前缀扩展 + 计数倒挂 + 单句低证 三通道同时命中
    upsert('多通道真名基', { mention_count: 10, description: '基座真人' }, 'active', ['多测']);
    upsert('多测X', { mention_count: 40, evidence: { count: 1, contexts: ['单句'] } });
    const list = detect();
    const ch = channelOf(list, '多测X');
    expect(ch).toBeTruthy();
    expect(ch).toContain('B5');
    expect(ch!.split('+').length).toBeGreaterThanOrEqual(2);
  });
});
