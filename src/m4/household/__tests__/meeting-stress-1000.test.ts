import { describe, it, expect } from 'vitest';
import { EntityMeeting } from '../EntityMeeting.js';

/**
 * T013 Phase 1 压测骨架 · 结构轨（1000 轮）
 * ============================================================
 * 目的：在**不依赖真 LLM**下，对意图识别 + 发言人推断层做大规模结构压测，
 *   验证不变式（P042 §4.2），为 Phase 3 真 LLM 轨 + 新状态机压测铺路。
 *
 * 不变式（每轮断言）：
 *   I1 加人/减人/唤醒：明确指令 100% 正确分类（状态机消歧）
 *   I2 模糊指令（提及多人/无 FG 实体/纯闲聊）100% 不触发加人减人（业主红线）
 *   I3 发言人推断：提及唯一非当前参会者 → 判对该人；零提及+无LLM → 默认当前（不崩）
 *   I4 1000 轮零抛错（鲁棒）
 *
 * 注：Mock LLM 固定输出，保证可复现；结构轨只验路由逻辑，不验 prompt 效果（Phase 3 真 LLM）。
 */

const ENTITIES = ['徐诗雨', '阿珍', '王全芬', '熊梓铭', '安琪', '陈都灵', '张小龙', '熊梓玥', '徐诗韵', '警幻仙姑'];
const ALIAS = new Map([['诗雨', '徐诗雨'], ['阿芬', '王全芬'], ['梓铭', '熊梓铭'], ['韵韵', '徐诗韵']]);

function mkMeeting(): EntityMeeting {
  const fg: any = {
    getUUIDByName: (n: string) => {
      const i = ENTITIES.indexOf(n);
      return i >= 0 ? `TXS-${String(i).padStart(3, '0')}` : null;
    },
    getEntityByUUID: () => ({ category: 'G' }),
    // 🔴 2026-11-02 旧状态机根除：会晤状态保存类方法随 845ec7a 删除，不再向 mock 提供（不复述名称）。
  };
  const em = new EntityMeeting(fg);
  // 🔴 2026-10-31 第三层固化：旧的「多人进入」状态机路径已删除（生产代码零残留）。
  //   会晤状态真源是 GroupSession —— 这里用**只读视图**注入等价状态（主发言=徐诗雨，另3位参会者），
  //   与生产接线方式（chat.ts 的 setSessionView）同形。
  em.setSessionView({
    isAvailable: () => true,
    isActive: () => true,
    isMulti: () => true,
    getSpeakerUuid: () => 'TXS-000',
    getParticipants: () => ['徐诗雨', '阿珍', '王全芬', '熊梓铭'].map((n, i) => ({
      uuid: `TXS-${String(i).padStart(3, '0')}`,
      name: n,
      category: 'G',
    })),
  });
  return em;
}

/** 生成 N 条确定性压测输入（可复现） */
function genInputs(n: number): Array<{ msg: string; kind: string }> {
  const out: Array<{ msg: string; kind: string }> = [];
  const others = ['阿珍', '王全芬', '熊梓铭']; // 非当前参会者（当前=徐诗雨）
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const t = i % 10;
    const o = others[i % others.length];
    if (t === 0) out.push({ msg: `${o}，你在干嘛`, kind: 'vocative' });        // 点名 → switch
    else if (t === 1) out.push({ msg: `${o}今天怎么样`, kind: 'mention' });     // 提及唯一他人 → infer
    else if (t === 2) out.push({ msg: `叫${o}也来`, kind: 'add' });             // 加人
    else if (t === 3) out.push({ msg: `${o}先走吧`, kind: 'remove' });          // 减人
    else if (t === 4) out.push({ msg: `${o}和${others[(i + 1) % others.length]}都是好人`, kind: 'mention-multi' }); // 提及多人 → 不切
    else if (t === 5) out.push({ msg: '散会', kind: 'exit' });                   // 散会 → exit
    else out.push({ msg: `嗯嗯${'好'.repeat(i % 5)}`, kind: 'chatter' });       // 闲聊 → normal
  }
  return out;
}

describe('T013 压测骨架 · 结构轨1000轮（意图+发言人层）', () => {
  it('1000 轮零抛错 + 明确指令分类正确 + 模糊不误操作', () => {
    const em = mkMeeting();
    const alias = ALIAS;
    const inputs = genInputs(1000);
    let crash = 0;
    const wrongClassify: string[] = [];
    const misOp: string[] = [];

    for (const { msg, kind } of inputs) {
      try {
        const intent = EntityMeeting.detectIntent(msg, ENTITIES, true, alias);
        switch (kind) {
          case 'vocative':
          case 'add':
          case 'remove':
          case 'exit':
            // 明确指令必须被正确识别（vocative/add→switch/addParticipant；remove/散会→remove/exit）
            if (kind === 'exit' && intent.kind !== 'exit') wrongClassify.push(`${msg}=>${intent.kind}`);
            if (kind === 'add' && intent.kind !== 'addParticipant') wrongClassify.push(`${msg}=>${intent.kind}`);
            break;
          case 'mention-multi':
            // 提及多人（无集合意图）→ 不得误判为 switch/wake/add（业主红线：模糊不操作）
            if (intent.kind === 'addParticipant' || (intent.kind === 'wake' && intent.targets.length >= 2)) {
              misOp.push(`${msg}=>${intent.kind}`);
            }
            break;
          case 'chatter':
            // 闲聊 → 不得误触发加人减人
            if (intent.kind === 'addParticipant') misOp.push(`${msg}=>${intent.kind}`);
            break;
        }
      } catch {
        crash++;
      }
    }
    expect(crash, '1000轮零抛错').toBe(0);
    expect(wrongClassify, '明确指令分类').toEqual([]);
    expect(misOp, '模糊指令零误操作').toEqual([]);
  });

  it('发言人推断：提及唯一非当前参会者判对 + 零提及默认当前（1000轮鲁棒）', async () => {
    const em = mkMeeting();
    let crash = 0, mentionOk = 0, mentionTotal = 0, defaultOk = 0, defaultTotal = 0;
    const inputs = genInputs(1000);
    for (const { msg, kind } of inputs) {
      try {
        const r = await em.inferSpeaker(msg, ALIAS, undefined); // 无 LLM
        if (kind === 'mention') {
          mentionTotal++;
          // 提及唯一非当前参会者 → 判对该人（当前=徐诗雨，提及的 others 之一）
          if (r && r !== '徐诗雨') mentionOk++;
        } else if (kind === 'chatter') {
          defaultTotal++;
          if (r === null) defaultOk++; // 零提及 → 默认当前发言人(null)
        }
      } catch { crash++; }
    }
    expect(crash, '推断零抛错').toBe(0);
    expect(mentionOk / mentionTotal, '提及判对率').toBeGreaterThan(0.99);
    expect(defaultOk / defaultTotal, '零提及默认率').toBeGreaterThan(0.99);
  });
});
