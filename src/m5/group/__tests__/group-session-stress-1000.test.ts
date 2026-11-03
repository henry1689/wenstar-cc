import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EntityMeeting } from '../../../m4/household/EntityMeeting.js';
import { GroupSession } from '../GroupSession.js';

/**
 * T013 Phase 3 压测 · 结构轨 1000 轮（P072/P079 四不变式 + 新架构附加不变式）
 * ============================================================
 * 与 Phase 1 骨架（m4/household/__tests__/meeting-stress-1000.test.ts，只压意图层）的区别：
 *   本轨压**切主后的完整状态链**：detectIntent → chat.ts 决策表（镜像）→ GroupSession.dispatch
 *   → EntityMeeting.inferSpeaker（经 P078 只读视图读 GroupSession 状态）。
 *
 * 断言（P072 §任务E 四不变式 + ADR-013 数据保护）：
 *   I1  1000 轮零抛错
 *   I2  明确指令 100% 正确（点名/@点名/加人/散会/唤醒 → 状态精确变化）
 *   I3  模糊指令零误操作（提及多人/闲聊/无入口句式 → 状态引用不变）
 *   I4  发言人推断：提及唯一非当前参会者 → 判对该人（>99%）；零提及 → 粘性不崩
 *   I5  speakerUuid 恒在 participants 内或 null（防半错状态→检索白名单错→串档）
 *   I6  散会后 mode=yuyao 且玉瑶现场槽（uuid=null）仍在栈上（弹栈不归零）
 *   I7  R1：serialize → 新实例 restore → 状态深等（落盘往返无损）
 *
 * 🔵 路由镜像说明：chat.ts 是重量级模块不可 import（仓内惯例），本文件的 `routeRound`
 *    逐分支镜像 chat.ts 状态机区域（WAKE/JOIN/SPEAK/deny/normal+infer）。
 *    末尾的源码守卫锁住 chat.ts 对应分支形态 —— chat.ts 路由一变，守卫先红，防镜像漂移。
 *
 * 🔵 P078 交叉验证（P079 任务1）：inferSpeaker 经 `setSessionView` 只读视图读状态 ——
 *    本轨 1000 轮同时压测方案 C 的读视图转发（若视图断裂，I4 率会崩）。
 *
 * 🔵 已知现状缺口（压测按现状设计，不虚构能力）：**减人无生产入口** ——
 *    chat.ts 只 dispatch 无 target 的 LEAVE（散会）；「X先走吧」句式被 detectIntent 判 normal。
 *    故减人类按 I3（零误操作）断言，而非「参与者减少」。详见 P080 报告。
 */

const ENTITIES = ['徐诗雨', '阿珍', '王全芬', '熊梓铭', '安琪', '徐诗韵', '张小龙', '熊梓玥'];
const ALIAS = new Map<string, string>([
  ['诗雨', '徐诗雨'], ['阿芬', '王全芬'], ['梓铭', '熊梓铭'], ['韵韵', '徐诗韵'],
]);
const uuidOf = (n: string): string => {
  const i = ENTITIES.indexOf(n);
  return i >= 0 ? `TXS-${String(i).padStart(9, '0')}` : `TXS-UNKNOWN-${n}`;
};

/** 会晤态上下文（chat.ts 决策表所需的 gs/em 组合） */
function mkDeps(): { em: EntityMeeting; gs: GroupSession } {
  const fg: any = {
    getUUIDByName: (n: string) => (ENTITIES.includes(n) ? uuidOf(n) : null),
    getEntityByUUID: () => ({ category: 'G' }),
    // 🔴 2026-11-02 旧状态机根除：会晤状态保存类方法随 845ec7a 删除，不再向 mock 提供（不复述名称）。
  };
  const em = new EntityMeeting(fg);
  const gs = new GroupSession();
  // P078 方案C：注入 GroupSession 只读视图（chat.ts 创建点同款接线）
  em.setSessionView({
    isAvailable: () => true,
    isActive: () => gs.active,
    isMulti: () => gs.multi,
    getSpeakerUuid: () => gs.speakerUuid,
    getParticipants: () => gs.getParticipants().map((p) => ({ uuid: p.uuid, name: p.name, category: p.category })),
  });
  return { em, gs };
}

const yuyaoSlot = () => ({
  uuid: null as null,
  emotion: { pleasure: 0, arousal: 0, intimacy: 0 },
  sceneAnchor: null,
  contextMemory: null,
  savedRole: 'secretary' as const,   // 需字面量型 RoleType（tsc 真命令抓出）
  savedAt: Date.now(),
});

/**
 * chat.ts 状态机决策表镜像（chat.ts ~890-1080）：
 *   !active: wake/add/switch 带 target → WAKE（≥2 多人 / 1 单人）
 *   active + exit → LEAVE（散会）
 *   active + multi + addParticipant(单目标) → JOIN
 *   active + multi + switch(单目标) → SPEAK
 *   active + wake/switch/add（其余）→ 门卫拒绝（状态不变）
 *   normal + multi + active → inferSpeaker → 命中且≠当前 → SPEAK
 */
async function routeRound(gs: GroupSession, em: EntityMeeting, msg: string): Promise<string> {
  const intent = EntityMeeting.detectIntent(msg, ENTITIES, gs.active, ALIAS);
  const active = gs.active;
  const multi = gs.multi;
  const now = Date.now();
  const seed = (n: string) => ({ uuid: uuidOf(n), name: n, category: '' });

  if (!active) {
    const targets = intent.kind === 'wake' ? intent.targets
      : (intent.kind === 'addParticipant' || intent.kind === 'switch') && intent.targets.length > 0 ? intent.targets
      : [];
    if (targets.length >= 2) { gs.dispatch({ type: 'WAKE', targets: targets.map(seed), now, slot: yuyaoSlot() }); return 'WAKE'; }
    if (targets.length === 1) { gs.dispatch({ type: 'WAKE', targets: [seed(targets[0])], now, slot: yuyaoSlot() }); return 'WAKE'; }
    return 'NONE';
  }
  if (intent.kind === 'exit') { gs.dispatch({ type: 'LEAVE', now }); return 'LEAVE'; }
  if (multi && intent.kind === 'addParticipant' && intent.targets.length === 1) {
    gs.dispatch({ type: 'JOIN', target: seed(intent.targets[0]), now }); return 'JOIN';
  }
  if (multi && intent.kind === 'switch' && intent.targets.length === 1) {
    gs.dispatch({ type: 'SPEAK', target: intent.targets[0], now }); return 'SPEAK';
  }
  if (intent.kind === 'wake' || intent.kind === 'switch' || intent.kind === 'addParticipant') return 'DENY';
  if (multi && active) {
    const inferred = await em.inferSpeaker(msg, ALIAS, undefined); // 无 LLM → 提及命中/默认 null
    const cur = gs.getSpeaker()?.name ?? null;
    if (inferred && inferred !== cur) { gs.dispatch({ type: 'SPEAK', target: inferred, now }); return 'SPEAK-INFER'; }
  }
  return 'NONE';
}

/** 确定性压测输入生成器（可复现）。类别受当前状态约束 —— 生成时查询 gs。
 *  🔴 唤醒轮转用独立计数器 wakeVisit（每进一次玉瑶态 +1）：
 *    若与全局 visit 共用模运算，单人态的短会话（chatter→exit 两轮）会让模位与状态错拍，
 *    wake-multi 永远轮不到（自检实测 mention 样本量=0 即此因）。 */
type Kind = 'vocative' | 'at-vocative' | 'mention' | 'add' | 'remove-probe' | 'mention-multi' | 'chatter' | 'exit' | 'wake-single' | 'wake-multi' | 'same-person-probe';

function genRound(gs: GroupSession, visit: number, counters: { wakeVisit: number }): { msg: string; kind: Kind } {
  const parts = gs.getParticipants();
  const names = parts.map((p) => p.name);
  const speaker = gs.getSpeaker()?.name ?? null;
  const others = names.filter((n) => n !== speaker);
  const outsiders = ENTITIES.filter((n) => !names.includes(n));

  // ── 玉瑶态：独立轮转 单唤醒/多唤醒/闲聊（保证多人态周期性出现）──
  if (!gs.active) {
    const n = counters.wakeVisit++;
    const step = n % 3;
    if (step === 1) return { msg: `叫${ENTITIES[n % 4]}和${ENTITIES[4 + (n % 4)]}过来开会`, kind: 'wake-multi' };
    if (step === 2) return { msg: `嗯嗯${'好'.repeat(n % 5)}`, kind: 'chatter' };
    return { msg: `找${ENTITIES[n % ENTITIES.length]}聊聊`, kind: 'wake-single' };
  }

  // ── 会晤态：加权类别池（mention/vocative 双份，保证推断样本量）──
  const pool: Kind[] = [];
  if (others.length >= 1) {
    pool.push('vocative', 'vocative', 'at-vocative', 'mention', 'mention', 'same-person-probe', 'remove-probe');
  }
  if (gs.multi && outsiders.length >= 1) pool.push('add');
  if (names.length >= 2) pool.push('mention-multi');
  pool.push('chatter', 'exit');
  const kind = pool[visit % pool.length];

  const pickOther = () => others[visit % others.length];
  const pickOutsider = () => outsiders[visit % outsiders.length];
  const two = names.length >= 2 ? [names[visit % names.length], names[(visit + 1) % names.length]] : [names[0], outsiders[0] ?? names[0]];

  switch (kind) {
    case 'vocative': return { msg: `${pickOther()}，你在干嘛`, kind };
    case 'at-vocative': return { msg: `@${pickOther()} 今天忙不忙`, kind };
    case 'mention': return { msg: `${pickOther()}最近状态不错吧`, kind };
    case 'same-person-probe': return { msg: `${speaker ?? names[0]}，你说对吧`, kind };
    case 'add': return { msg: `叫${pickOutsider()}也来`, kind };
    case 'remove-probe': return { msg: `${pickOther()}先走吧`, kind };
    case 'mention-multi': return { msg: `${two[0]}和${two[1]}都是好帮手`, kind };
    case 'chatter': return { msg: `嗯嗯${'好'.repeat(visit % 5)}`, kind };
    case 'exit': return { msg: visit % 2 === 0 ? '散会' : '再见', kind };
    // 会晤态不可达（玉瑶态分支已拦截），兜底防未返
    case 'wake-single': case 'wake-multi': return { msg: '散会', kind: 'exit' };
  }
}

describe('T013 压测 · 结构轨1000轮（切主后状态链：意图→决策表→GroupSession→推断）', () => {
  it('I1~I7：1000 轮全量不变式', async () => {
    const { em, gs } = mkDeps();
    const crash: string[] = [];
    const wrongClear: string[] = [];      // I2
    const misOp: string[] = [];           // I3
    const speakerOk: string[] = [];       // I4 明细
    let mentionTotal = 0, mentionOk = 0, chatterTotal = 0, chatterOk = 0;
    const isolation: string[] = [];       // I5
    const stackGone: string[] = [];       // I6
    const r1Diff: string[] = [];          // I7
    let sessionExitCount = 0;
    const counters = { wakeVisit: 0 };   // 玉瑶态独立轮转计数（防模位与状态错拍）
    let visit = 0;   // 会晤态类别轮转计数

    for (let seq = 0; seq < 1000; seq++) {
      const { msg, kind } = genRound(gs, visit++, counters);
      const before = gs.getState();
      const beforeRef = gs.getState();
      const beforeNames = before.participants.map((p) => p.name).join(',');
      const beforeSpeaker = before.speakerUuid;
      let action = 'NONE';
      try {
        action = await routeRound(gs, em, msg);

        // ── I2 明确指令 ──
        if (kind === 'exit' && action === 'LEAVE') {
          if (gs.active) wrongClear.push(`seq=${seq} exit后仍会晤`);
          sessionExitCount++;
          // I6：散会后玉瑶现场槽仍在栈上（WAKE 时压入的 uuid=null 槽）
          if (!gs.getState().contextStack.some((s) => s.uuid === null)) stackGone.push(`seq=${seq} 玉瑶槽丢失`);
          // I7：R1 往返
          const json = gs.serialize();
          const fresh = new GroupSession();
          if (!fresh.restore(json)) r1Diff.push(`seq=${seq} restore失败`);
          else if (JSON.stringify(fresh.getState()) !== JSON.stringify(gs.getState())) r1Diff.push(`seq=${seq} 往返状态不等`);
        }
        if (kind === 'wake-single' && action === 'WAKE' && gs.participantCount !== 1) wrongClear.push(`seq=${seq} 单唤醒后人数=${gs.participantCount} msg=${msg}`);
        if (kind === 'wake-multi' && action === 'WAKE' && gs.participantCount !== 2) wrongClear.push(`seq=${seq} 多唤醒后人数=${gs.participantCount} msg=${msg}`);
        if (kind === 'add' && action === 'JOIN' && gs.participantCount !== before.participants.length + 1) wrongClear.push(`seq=${seq} 加人后人数=${gs.participantCount} msg=${msg}`);
        if (kind === 'vocative' && action === 'SPEAK') {
          const expect = msg.split('，')[0];
          if (gs.getSpeaker()?.name !== expect) wrongClear.push(`seq=${seq} 点名后speaker=${gs.getSpeaker()?.name} 期望=${expect}`);
        }
        if (kind === 'at-vocative' && action === 'SPEAK') {
          const expect = msg.slice(1).split(' ')[0];
          if (gs.getSpeaker()?.name !== expect) wrongClear.push(`seq=${seq} @点名后speaker=${gs.getSpeaker()?.name} 期望=${expect}`);
        }

        // ── I3 模糊/无入口零误操作 ──
        // chatter / same-person-probe：严格零变化（状态引用不变 = 未 dispatch 或同人 SPEAK 无变化）。
        // remove-probe（「X先走吧」，无生产入口）与 mention-multi（提及多人）：
        //   断言**参与者集合不变**（不得误 JOIN/LEAVE/WAKE）；发言人经推断切换属合法行为
        //   （被提及的非当前人被推断接手），不计入误操作（P072 I3 针对加减人/换人状态误触）。
        if (kind === 'chatter' || kind === 'same-person-probe') {
          if (gs.getState() !== beforeRef) {
            misOp.push(`seq=${seq} ${kind} 触发了状态变化 action=${action} msg=${msg}`);
          }
        }
        if (kind === 'remove-probe' || kind === 'mention-multi') {
          const afterUuids = gs.getParticipants().map((p) => p.uuid).sort().join(',');
          const beforeUuids = before.participants.map((p) => p.uuid).sort().join(',');
          if (afterUuids !== beforeUuids) {
            misOp.push(`seq=${seq} ${kind} 参与者集合被改 action=${action} msg=${msg}`);
          }
        }

        // ── I4 发言人推断 ──
        if (kind === 'mention') {
          mentionTotal++;
          const expect = msg.replace('最近状态不错吧', '');
          if (before.participants.length >= 2 && action === 'SPEAK-INFER' && gs.getSpeaker()?.name === expect) mentionOk++;
          else if (before.participants.length >= 2 && action !== 'SPEAK-INFER') speakerOk.push(`seq=${seq} mention未推断 action=${action} msg=${msg}`);
        }
        if (kind === 'chatter' && before.participants.length >= 2) {
          chatterTotal++;
          if (gs.speakerUuid === beforeSpeaker) chatterOk++;
        }

        // ── I5 隔离结构不变式 ──
        const su = gs.speakerUuid;
        if (su !== null && !gs.getParticipants().some((p) => p.uuid === su)) isolation.push(`seq=${seq} speakerUuid=${su} 不在参与者内`);
        // 栈内 uuid 必须是当前参与者或 null（玉瑶）
        for (const s of gs.getState().contextStack) {
          if (s.uuid !== null && !gs.getParticipants().some((p) => p.uuid === s.uuid)) isolation.push(`seq=${seq} 栈内孤儿uuid=${s.uuid}`);
        }
      } catch (e) {
        crash.push(`seq=${seq} kind=${kind} msg=${msg} → ${(e as Error).message}`);
      }
      void beforeNames;
    }

    expect(crash, 'I1 零抛错').toEqual([]);
    expect(wrongClear, 'I2 明确指令100%正确').toEqual([]);
    expect(misOp, 'I3 模糊/无入口零误操作').toEqual([]);
    expect(mentionTotal, 'I4 mention 样本量').toBeGreaterThan(30);   // n≥30 有统计意义；>99% 判对率在该量级即要求全对
    expect(mentionOk / mentionTotal, `I4 提及唯一判对率(${mentionOk}/${mentionTotal})`).toBeGreaterThan(0.99);
    expect(speakerOk, 'I4 推断失败明细').toEqual([]);
    expect(chatterTotal, 'I4 chatter 样本量').toBeGreaterThan(30);
    expect(chatterOk / chatterTotal, `I4 零提及粘性保持率(${chatterOk}/${chatterTotal})`).toBeGreaterThan(0.99);
    expect(isolation, 'I5 speakerUuid/栈uuid 隔离结构').toEqual([]);
    expect(stackGone, 'I6 玉瑶现场槽不归零').toEqual([]);
    expect(sessionExitCount, 'I6 散会样本量').toBeGreaterThan(10);
    expect(r1Diff, 'I7 R1 序列化往返无损').toEqual([]);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════
// 路由镜像守卫：chat.ts 决策表形态锁定（镜像漂移探测）
// ═══════════════════════════════════════════════════════════════
describe('路由镜像守卫（chat.ts 决策表形态）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const chatSrc = readFileSync(join(HERE, '..', '..', '..', 'webui', 'chat.ts'), 'utf8');

  it('四类 dispatch + 门卫拒绝 + normal推断 分支均在', () => {
    expect(chatSrc, 'WAKE dispatch').toContain("type: 'WAKE'");
    expect(chatSrc, 'JOIN dispatch').toContain("type: 'JOIN'");
    expect(chatSrc, 'SPEAK dispatch').toContain("type: 'SPEAK'");
    expect(chatSrc, 'LEAVE dispatch').toContain("type: 'LEAVE'");
    expect(chatSrc, '门卫拒绝分支').toContain('门卫拒绝');
    expect(chatSrc, 'inferSpeaker 调用').toContain('inferSpeaker');
    // 决策依赖 _isMulti（镜像的 multi 前提）
    expect(chatSrc, 'multi 判定').toContain('_isMulti');
  });
});
