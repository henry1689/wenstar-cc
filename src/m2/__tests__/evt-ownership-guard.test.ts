/**
 * evt-ownership-guard.test.ts — P0-2D：evt_* 写入路径归属权威戳守卫（2026-10-17）
 * ============================================================
 * 被守的缺陷（实测基线，生产库 2026-10-17）：
 *   FusionStorageAdapter.write() 只按 entity_genes 人名推 FG UUID，人名不在户籍（如「妈」）
 *   ⇒ belong_entity_uuid 恒 NULL。全库 435 条 evt_* 无归属，按月恶化：
 *   2026-07:10 → 08:14 → 09:90 → 10:477（含当日新增 31 条，仍在持续产生）。
 *   同一条消息的 mem_* 路（persistence-stage）有权威兜底、evt_* 路没有 —— P0-2 只修了一半。
 *
 * 修复契约（本测试锁定的三条不变量）：
 *   I1. dna.belong_entity_uuid（chat.ts 权威戳）优先于 FG 人名推断 —— 戳在，FG 必须不覆盖；
 *   I2. 戳缺失时保留 FG 人名推断兜底（旧行为不回退）；
 *   I3. 两者皆无 ⇒ NULL（户籍法 fail-closed —— 绝不硬编码兜底实体）。
 *   C1. chat.ts 必须在 workingMemory.push 之前盖章（覆盖「即时毕业」同步写路径）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FusionStorageAdapter } from '../FusionStorageAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 完整 24D 感知（与 structure-guard 同构，满足 computeCalcium） */
const P24 = { pleasure: 0.5, arousal: 0.5, dominance: 0.5, aggression: 0.5, sincerity: 0.5, humor: 0.5, factual: 0.5, logical: 0.5, certainty: 0.5, abstract: 0.5, temporal_focus: 0.5, self_ref: 0.5, intimacy: 0.5, power_diff: 0.5, dependency: 0.5, moral_judgment: 0.5, etiquette: 0.5, belonging: 0.5, sexual_attraction: 0.5, sensory_craving: 0.5, energy_merge: 0.5, possessiveness: 0.5, ecstasy: 0.5, safety: 0.5 } as const;

/** 桩 DNA —— 「妈」是实测命中缺陷的典型：person 基因但不在 FG 户籍 */
function makeDna(overrides: Record<string, unknown> = {}) {
  return {
    branch_id: 'evt_test_001',
    seq_pos: 1,
    raw_input: '妈我叫你呢回答我一下',
    entity_genes: [{ name: '妈', type: 'person', allele: '妈', phenotype: 'neutral', knowledge_type: 'private' }],
    locus_path: 'chat',
    leaf_zone: 'language_semantic_zone',
    global_uid: 'guid_test_001',
    ...overrides,
  } as any;
}

/**
 * 桩写路径：绕过 initialize（生产库锁 + schema 全量加载），只捕获 sqlite.write 收到的 record。
 * 不碰任何真实数据文件 —— 与 write-channel-single-source 的桩法同源。
 */
function makeAdapterCapturingWrites(opts: { fg?: { getUUIDByName(n: string): string | null } | null } = {}) {
  const adapter = new FusionStorageAdapter(join(REPO, 'data', '__evt_guard__', 'unused'), { enableJsonZone: false });
  const captured: any[] = [];
  (adapter as any).initialized = true;
  (adapter as any).sqlite = {
    write: (record: any) => { captured.push(record); },
    getMaxSeqPos: () => 0,
    isSeqPosTaken: () => false,
  };
  (adapter as any).familyGraph = opts.fg ?? null;
  return { adapter, captured };
}

describe('P0-2D evt_* 归属权威戳（FusionStorageAdapter.write 消费 dna.belong_entity_uuid）', () => {
  // ── I1: 权威戳优先，FG 推断不得覆盖 ──
  it('I1: dna 带权威戳 + FG 人名也能推出 UUID ⇒ 用戳（FG 不覆盖权威）', async () => {
    const { adapter, captured } = makeAdapterCapturingWrites({
      fg: { getUUIDByName: () => 'TXS-FG-SHOULD-NOT-WIN' },
    });
    const dna = makeDna({ belong_entity_uuid: 'TXS-AUTHORITATIVE' });
    const result = await adapter.write(dna as any, { ...P24 } as any);
    expect(result.success).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0].belongEntityUuid).toBe('TXS-AUTHORITATIVE');
  });

  // ── I2: 戳缺失 ⇒ 保留 FG 人名推断兜底（旧行为不回退）──
  it('I2: dna 无戳 + FG 能按人名推出 UUID ⇒ 用 FG 推断（旧兜底保留）', async () => {
    const { adapter, captured } = makeAdapterCapturingWrites({
      fg: { getUUIDByName: (n: string) => (n === '张小龙' ? 'TXS-FG-INFERRED' : null) },
    });
    const dna = makeDna({ entity_genes: [{ name: '张小龙', type: 'person', allele: '张小龙', phenotype: 'neutral', knowledge_type: 'private' }] }); // ≥2字人名才能过 FG 推断过滤器
    await adapter.write(dna as any, { ...P24 } as any);
    expect(captured[0].belongEntityUuid).toBe('TXS-FG-INFERRED');
  });

  // ── I2′（批3 语义变更）：单字人名推断被跳过 ⇒ 无归属 ⇒ **拒写**（不再落 NULL）──
  it('I2′: dna 无戳 + 单字人名（「妈」）⇒ 拒写（success=false，无记录捕获）', async () => {
    const { adapter, captured } = makeAdapterCapturingWrites({
      fg: { getUUIDByName: (n: string) => (n === '妈' ? 'TXS-SHOULD-HAVE-MATCHED' : null) },
    });
    const dna = makeDna(); // 「妈」单字 person 基因（生产 435 条 NULL 即此形态）
    const result = await adapter.write(dna as any, { ...P24 } as any);
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  // ── I3（批3 语义变更）：两者皆无 ⇒ 拒写（fail-closed，绝不硬编码兜底实体）──
  it('I3: dna 无戳 + 人名不在户籍 ⇒ 拒写（missing_belong）', async () => {
    const { adapter, captured } = makeAdapterCapturingWrites({
      fg: { getUUIDByName: () => null }, // 人名查无此人
    });
    const dna = makeDna();
    const result = await adapter.write(dna as any, { ...P24 } as any);
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('I3′: dna 无戳 + FG 完全不可用 ⇒ 拒写且不抛错', async () => {
    const { adapter, captured } = makeAdapterCapturingWrites({ fg: null });
    const dna = makeDna();
    const result = await adapter.write(dna as any, { ...P24 } as any);
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// C1: chat.ts 盖章时序能力断言（源码级 —— 与 no-text-inferred-belong 同款守法）
// ════════════════════════════════════════════════════════════════════
describe('C1: chat.ts 盖章时序（能力断言）', () => {
  const src = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');

  it('盖章①（push 前）必须存在于 workingMemory.push 之前 —— 否则「即时毕业」同步写路径拿不到戳', () => {
    const stampA = src.indexOf('const _stampA =');
    const push = src.indexOf('ctx.workingMemory.push(dna');
    expect(stampA).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(stampA).toBeLessThan(push);
  });

  it('盖章②（会晤状态落定后）必须存在 —— 否则 WorkingMemory 缓冲路径（60s flush）拿不到最终归属', () => {
    expect(src.indexOf('const _stampB =')).toBeGreaterThan(-1);
  });

  it('盖章表达式与 persistence-stage 同源：会晤实体 > 退出实体 > 玉瑶', () => {
    // 两处盖章 + persistence-stage 的 belongUUID 都必须以「getEntityUUID → _exitEntityUuid → 玉瑶」为序
    const stamps = src.split('const _stamp').length - 1;
    expect(stamps).toBeGreaterThanOrEqual(2);
    const entityMeetingFirst = /_stamp[AB] = ctx\._entityMeeting\?\.getEntityUUID\?\.\(\)\s*\?\?\s*\(ctx as any\)\._exitEntityUuid\s*\?\?\s*_fgOwn[AB]\?\.getUUIDByName\?\.\('玉瑶'\)/;
    const matches = src.match(new RegExp(entityMeetingFirst.source, 'g')) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('C1: 会晤路由指令必须同时跳过 evt_* 路（push 门控）—— 否则 skip 只关半扇门（S4 评审 P1）', () => {
    // workingMemory.push 必须在 _skipEvtRoute 的 else 分支内（非无条件执行）
    // 🔴 2026-11-02：原判据 `} else \{\s*\n\s*ctx\.workingMemory\.push` 被 2026-10-30 加的
    //   三行注释（evt 行独立号 / seq_pos 撞车背景 / reserveNextSeq 配套）插断 ⇒ 恒不匹配。
    //   放宽为「空白或整行注释」—— push **仍是 else 块的第一条语句**，判据不削弱：
    //   中间只允许注释，任何真实语句插进来仍会红。
    expect(src).toMatch(/if \(_skipEvtRoute\) \{[\s\S]{0,400}?\} else \{(?:\s|\/\/[^\n]*)*\s*ctx\.workingMemory\.push\(dna/);
    // 预判判据必须与状态机同源：同一 detectIntent 静态方法
    expect(src).toMatch(/EntityMeeting\.detectIntent\(message, _namesR, ctx\._entityMeeting\.isActive\(\), _aliasR\)/);
  });

  // 🔴 2026-11-02 旧状态机根除（业主：「连根拔出，哪怕一个代码都不留」）：
  //   原锚（第三层拆除前的会晤退出调用）随 845ec7a 第三层拆除删除 ⇒ indexOf 恒 -1。
  //   🔴 不复述该方法名：根除要求连名字都不留，复述即重新成为可被照抄的调用入口。
  //   新架构的会晤状态退出 = GroupSession dispatch LEAVE —— 状态唯一真源（ADR-013 硬约束②），
  //   EntityMeeting 已降级为纯副作用执行器，退出状态由 dispatch 落定、再由
  //   endMeetingSideEffects() 跑纪要/门卫/清轮次。断言语义**不变**：盖章②仍必须在退出状态落定之后。
  it('盖章②必须在会晤退出状态落定（LEAVE dispatch）之后 —— 否则缓冲路径拿到的是进/出前的旧戳', () => {
    const exitBranch = src.indexOf("_gs!.dispatch({ type: 'LEAVE'");
    const stampB = src.indexOf('const _stampB =');
    expect(exitBranch, '会晤退出 dispatch 锚点必须存在（旧状态机退出调用已删）').toBeGreaterThan(-1);
    expect(stampB, '盖章② 必须存在').toBeGreaterThan(-1);
    expect(stampB).toBeGreaterThan(exitBranch);
  });

  it('会晤进入/退出结构信号必须传入 persistConversation（P0-2.1 消费前提）', () => {
    expect(src).toMatch(/isMeetingEntry:\s*_meetingEntered/);
    expect(src).toMatch(/isMeetingExit:\s*_meetingExited/);
  });
});
