/**
 * T013 Phase 2 主体工程批A — 群聊状态机骨架回归测试
 *
 * 覆盖 ADR-013 的四条核心断言：
 *   ① reducer 是唯一写入口且为纯函数（不改入参、不操作返回同一引用）
 *   ② mode/isMulti 由 participants 派生，不是存库布尔（修掉漂移）
 *   ③ LEAVE 是**弹栈恢复**而非 reset 归零（修掉玉瑶基线丢失）
 *   ④ normalizeState 对结构异常**整份拒绝**（防半错状态导致检索白名单错→串档）
 * 外加：发言者分层（rule-first 零 LLM / 粘性 / 低置信不采信）与第七层输出校验。
 */
import { describe, it, expect } from 'vitest';
import {
  createSessionState, reduce, diffEffects, pushSlot, popSlot,
  normalizeState, deserializeState, serializeState,
  sessionMode, isMulti, isActive, speaker, findParticipant,
} from '../sessionReducer.js';
import type { Action, ContextSlot, SessionState } from '../types.js';
import { GROUP_SESSION_SCHEMA_VERSION } from '../types.js';
import {
  resolveSpeakerSync, resolveSpeakerLlm, ruleFindNamed, normalizeAliases,
  matchParticipantName, intentToAction, llmFallbackAllowed, parseSpeakerJson,
  SPEAKER_LLM_CONFIDENCE_FLOOR,
} from '../speakerResolver.js';
import {
  extractSpeakerHeader, validateReplyIdentity, detectSelfIdent, looksLikeRawJson, withSpeakerHeader,
} from '../outputGuard.js';
import { GroupSession, isGroupSessionEnabled, GROUP_SESSION_FLAG } from '../GroupSession.js';
import { resolveIdentityFromState } from '../identityFromState.js';

const T0 = 1_700_000_000_000;
const seed = (uuid: string, name: string) => ({ uuid, name, aliases: [name.slice(-2)], category: 'G' });
const A = seed('TXS-1', '徐诗雨');
const B = seed('TXS-2', '熊梓铭');
const C = seed('TXS-3', '王全芬');
const OTHER = seed('TXS-9', '阿珍');

const slot = (uuid: string | null, mood: string, at = T0): ContextSlot => ({
  uuid,
  emotion: { pleasure: 0.3, arousal: 0.2, intimacy: 0.1 },
  sceneAnchor: null,
  contextMemory: null,
  savedRole: 'secretary',
  savedAt: at,
  // 用 mood 字段区分现场（借 savedAt 之外的唯一性靠 uuid，此处借 emotion.pleasure 编码）
  ...({ mood } as object),
} as ContextSlot);

const wake = (targets: typeof A[], s?: SessionState, extra?: Partial<Extract<Action, { type: 'WAKE' }>>): Action =>
  ({ type: 'WAKE', targets, now: T0, ...extra } as Action);

describe('[批A] reducer — 纯函数与唯一写入口', () => {
  it('WAKE 单人：参与者=[1]，speakerUuid=该人，mode=meeting', () => {
    const s0 = createSessionState(T0);
    const s1 = reduce(s0, wake([A]));
    expect(s0.participants).toHaveLength(0);                 // 入参未被修改
    expect(s1.participants).toHaveLength(1);
    expect(s1.speakerUuid).toBe(A.uuid);
    expect(sessionMode(s1)).toBe('meeting');
    expect(isMulti(s1)).toBe(false);
  });

  it('WAKE 多人：同一入口（不需不同 action），isMulti 由数量派生', () => {
    const s1 = reduce(createSessionState(T0), wake([A, B]));
    expect(s1.participants).toHaveLength(2);
    expect(isMulti(s1)).toBe(true);
    expect(s1.speakerUuid).toBe(A.uuid);                    // 首位为主发言
  });

  it('WAKE 目标重复 uuid 去重', () => {
    const s1 = reduce(createSessionState(T0), wake([A, A, B]));
    expect(s1.participants.map(p => p.uuid)).toEqual(['TXS-1', 'TXS-2']);
  });

  it('WAKE 空 targets → 不操作（返回同一引用）', () => {
    const s0 = createSessionState(T0);
    expect(reduce(s0, wake([]))).toBe(s0);
  });

  it('JOIN 幂等：已在列则不操作', () => {
    const s0 = reduce(createSessionState(T0), wake([A]));
    expect(reduce(s0, { type: 'JOIN', target: A, now: T0 })).toBe(s0);
  });

  it('JOIN 从单人会话加人 → 自动变多人（isMulti 派生，非存库布尔）', () => {
    const s0 = reduce(createSessionState(T0), wake([A]));
    const s1 = reduce(s0, { type: 'JOIN', target: B, now: T0 });
    expect(s1.participants).toHaveLength(2);
    expect(isMulti(s1)).toBe(true);
    expect(s1.speakerUuid).toBe(A.uuid);                    // 主发言不因加人而变
  });

  it('SPEAK 切换主发言；非参与者 → 不操作', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B]));
    const s1 = reduce(s0, { type: 'SPEAK', target: OTHER.uuid, now: T0 });
    expect(s1).toBe(s0);                                    // 非参与者：同一引用
    const s2 = reduce(s0, { type: 'SPEAK', target: B.uuid, now: T0 });
    expect(s2.speakerUuid).toBe(B.uuid);
    expect(findParticipant(s2, B.uuid)!.turnCount).toBe(1);
  });

  it('SPEAK 切走的发言者现场按 uuid 原位保存，不新增层级', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B]));
    const s1 = reduce(s0, { type: 'SPEAK', target: B.uuid, slot: slot(A.uuid, 'A现场'), now: T0 });
    expect(s1.contextStack.filter(c => c.uuid === A.uuid)).toHaveLength(1);
    const s2 = reduce(s1, { type: 'SPEAK', target: A.uuid, slot: slot(B.uuid, 'B现场'), now: T0 });
    // A 与 B 各一份，且 A 的旧槽被原位覆盖（pushSlot 语义）
    expect(s2.contextStack).toHaveLength(2);
    expect(s2.contextStack.filter(c => c.uuid === A.uuid)).toHaveLength(1);
  });

  it('LEAVE 指定人 → 移除并把主发言交给剩余首位', () => {
    const s0 = reduce(createSessionState(T0), wake([A, B]));
    const s1 = reduce(s0, { type: 'LEAVE', target: A.uuid, now: T0 });
    expect(s1.participants.map(p => p.uuid)).toEqual(['TXS-2']);
    expect(s1.speakerUuid).toBe(B.uuid);
  });

  it('LEAVE 无 target（散会）→ 清空参与者，玉瑶现场仍在栈上（不归零）', () => {
    const s0 = reduce(createSessionState(T0), wake([A], undefined, { slot: slot(null, '玉瑶现场') }));
    const s1 = reduce(s0, { type: 'LEAVE', now: T0 });
    expect(s1.participants).toHaveLength(0);
    expect(sessionMode(s1)).toBe('yuyao');
    expect(s1.contextStack.some(c => c.uuid === null)).toBe(true);   // 基线未丢
    const fx = diffEffects(s0, s1);
    expect(fx.some(e => e.type === 'meetingEnded')).toBe(true);
    expect(fx.some(e => e.type === 'restoreSlot' && e.slot.uuid === null)).toBe(true);
  });

  it('IDLE 只刷新时间戳', () => {
    const s0 = reduce(createSessionState(T0), wake([A]));
    const s1 = reduce(s0, { type: 'IDLE', now: T0 + 1000 });
    expect(s1.lastActivityAt).toBe(T0 + 1000);
    expect(s1.participants).toEqual(s0.participants);
  });

  it('pushSlot / popSlot —— 找不到不动（不归零）', () => {
    const stack = pushSlot([], slot('TXS-1', 'x'));
    expect(popSlot(stack, 'TXS-2')).toEqual({ slot: null, rest: stack });   // 找不到：栈原样
    expect(popSlot(stack, 'TXS-1').slot!.uuid).toBe('TXS-1');
  });

  it('diffEffects：进会晤 → meetingStarted + speakerChanged', () => {
    const s0 = createSessionState(T0);
    const s1 = reduce(s0, wake([A]));
    const fx = diffEffects(s0, s1);
    expect(fx.some(e => e.type === 'meetingStarted')).toBe(true);
    expect(fx.some(e => e.type === 'speakerChanged' && e.to === A.uuid)).toBe(true);
    expect(diffEffects(s1, s1)).toEqual([]);                 // 无变化 → 零副作用
  });
});

describe('[批A] normalizeState — 整份拒绝，绝不半恢复', () => {
  const good = (): SessionState => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    return JSON.parse(serializeState(s));
  };

  it('合法状态往返无损', () => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    const rt = deserializeState(serializeState(s));
    expect(rt).not.toBeNull();
    expect(rt!.participants.map(p => p.uuid)).toEqual(['TXS-1', 'TXS-2']);
    expect(rt!.speakerUuid).toBe('TXS-1');
  });

  it('schemaVersion 不符 → 拒绝', () => {
    const bad = good();
    (bad as any).schemaVersion = GROUP_SESSION_SCHEMA_VERSION + 1;
    expect(normalizeState(bad, T0)).toBeNull();
  });

  it('speakerUuid 不在 participants 里 → 拒绝（防串档）', () => {
    const bad = good();
    bad.speakerUuid = 'TXS-404';
    expect(normalizeState(bad, T0)).toBeNull();
  });

  it('参与者缺 uuid / 重复 uuid → 拒绝', () => {
    const a = good(); (a.participants[0] as any).uuid = '';
    expect(normalizeState(a, T0)).toBeNull();
    const b = good(); (b.participants[1] as any).uuid = b.participants[0].uuid;
    expect(normalizeState(b, T0)).toBeNull();
  });

  it('栈里出现非参与者 uuid → 拒绝', () => {
    const bad = good();
    bad.contextStack = [slot('TXS-404', '幽灵现场')];
    expect(normalizeState(bad, T0)).toBeNull();
  });

  it('非法 JSON 字符串 → 返回 null 不抛', () => {
    expect(deserializeState('{oops')).toBeNull();
    expect(deserializeState('')).toBeNull();
  });

  it('RESUME 用合法状态恢复；用坏状态保持原样', () => {
    const s0 = reduce(createSessionState(T0), wake([A]));
    const bad = { ...s0, speakerUuid: 'TXS-404' } as SessionState;
    expect(reduce(s0, { type: 'RESUME', state: bad, now: T0 })).toBe(s0);      // 保持原样
    const good = JSON.parse(serializeState(s0));
    expect(reduce(s0, { type: 'RESUME', state: good, now: T0 }).participants).toHaveLength(1);
  });
});

describe('[批A] 发言者分层 — rule-first 零 LLM / 粘性 / 低置信不采信', () => {
  const twoPerson = () => reduce(createSessionState(T0), wake([A, B]));

  it('@某人 → rule 命中', () => {
    const d = resolveSpeakerSync('@徐诗雨 你怎么看', twoPerson());
    expect(d.source).toBe('rule');
    expect(d.speakerUuid).toBe(A.uuid);
  });

  it('"熊梓铭，…" 称呼点名 → rule 命中', () => {
    const d = resolveSpeakerSync('熊梓铭，你作业写完没', twoPerson());
    expect(d.source).toBe('rule');
    expect(d.speakerUuid).toBe(B.uuid);
  });

  it('"换徐诗雨" → rule 命中', () => {
    expect(resolveSpeakerSync('换徐诗雨', twoPerson()).speakerUuid).toBe(A.uuid);
  });

  it('别名归一：短名命中全名', () => {
    const s = twoPerson();
    expect(matchParticipantName('诗雨', s)).toBe('徐诗雨');
    const alias = new Map([['诗雨', '徐诗雨']]);
    expect(normalizeAliases('让诗雨说', alias)).toContain('徐诗雨');
    expect(ruleFindNamed(normalizeAliases('让诗雨说', alias), s)).toBeNull();  // 非强句式不判点名
  });

  it('无点名 → 粘性保持当前发言人（零 LLM）', () => {
    const d = resolveSpeakerSync('今天我们聊聊别的', twoPerson());
    expect(d.source).toBe('sticky');
    expect(d.speakerUuid).toBe(A.uuid);
  });

  it('玉瑶态（无参与者）→ source=none，不给发言人', () => {
    const d = resolveSpeakerSync('你好', createSessionState(T0));
    expect(d.source).toBe('none');
    expect(d.speakerUuid).toBeNull();
  });

  it('LLM 兜底只在多人会晤首轮允许', () => {
    expect(llmFallbackAllowed(twoPerson(), true)).toBe(true);
    expect(llmFallbackAllowed(twoPerson(), false)).toBe(false);
    expect(llmFallbackAllowed(reduce(createSessionState(T0), wake([A])), true)).toBe(false);  // 单人不调
    expect(llmFallbackAllowed(createSessionState(T0), true)).toBe(false);                     // 玉瑶态不调
  });

  it('LLM 低置信（<0.6）→ 不采信，回落粘性并标记 needsStickyHold', async () => {
    const d = await resolveSpeakerLlm('谁来说说', twoPerson(), [], {
      rawCall: async () => JSON.stringify({ speaker_name: '熊梓铭', confidence: 0.3, reason: '猜的' }),
    });
    expect(d.source).toBe('sticky');
    expect(d.needsStickyHold).toBe(true);
    expect(d.speakerUuid).toBe(A.uuid);
  });

  it('LLM 返回非参与者 → 不采信（结构上排除玉瑶/外部人）', async () => {
    const d = await resolveSpeakerLlm('谁来说说', twoPerson(), [], {
      rawCall: async () => JSON.stringify({ speaker_name: '玉瑶', confidence: 0.99, reason: '错的' }),
    });
    expect(d.speakerUuid).not.toBe('TXS-0');
    expect(d.needsStickyHold).toBe(true);
  });

  it('LLM 高置信且命中参与者 → 采纳', async () => {
    const d = await resolveSpeakerLlm('谁来说说', twoPerson(), [], {
      rawCall: async () => JSON.stringify({ speaker_name: '熊梓铭', confidence: 0.9, reason: '问他负责的事' }),
    });
    expect(d.source).toBe('llm');
    expect(d.speakerUuid).toBe(B.uuid);
  });

  it('无 LLM 依赖 → 回落粘性不抛', async () => {
    const d = await resolveSpeakerLlm('谁来说说', twoPerson(), []);
    expect(d.source).toBe('sticky');
    expect(d.needsStickyHold).toBe(true);
  });

  it('parseSpeakerJson：宽容包裹文本；坏输入返回空对象', () => {
    expect(parseSpeakerJson('好的：{"speaker_name":"徐诗雨","confidence":0.8}').confidence).toBe(0.8);
    expect(parseSpeakerJson('不合法')).toEqual({});
    expect(parseSpeakerJson('')).toEqual({});
    expect(SPEAKER_LLM_CONFIDENCE_FLOOR).toBe(0.6);
  });

  it('intentToAction 消歧：无会话的 add/wake/switch → WAKE；会晤中 switch → SPEAK；exit → LEAVE', () => {
    const empty = createSessionState(T0);
    const met = twoPerson();
    expect(intentToAction({ kind: 'addParticipant', targets: ['徐诗雨'] }, empty, [A])!.type).toBe('WAKE');
    expect(intentToAction({ kind: 'switch', targets: ['熊梓铭'] }, met, [B])!.type).toBe('SPEAK');
    expect(intentToAction({ kind: 'addParticipant', targets: ['王全芬'] }, met, [C])!.type).toBe('JOIN');
    expect(intentToAction({ kind: 'exit', targets: [] }, met, [])!.type).toBe('LEAVE');
    expect(intentToAction({ kind: 'normal', targets: [] }, met, [A])).toBeNull();     // normal 不动状态
    expect(intentToAction({ kind: 'wake', targets: ['X'] }, empty, [])).toBeNull();   // 解析失败 → 不操作
  });
});

describe('[批A] 第七层 outputGuard — 默认 +0 LLM', () => {
  it('解析结构化头：字段边界，正文保留', () => {
    const r = extractSpeakerHeader('speaker: 徐诗雨\n---\n你好呀');
    expect(r.speaker).toBe('徐诗雨');
    expect(r.body).toBe('你好呀');
    expect(r.present).toBe(true);
  });

  it('纯 JSON 正文整体跳过（V45 削坑防线）', () => {
    const json = '{"speaker":"徐诗雨","a":1,"b":[1,2,3]}';
    expect(looksLikeRawJson(json)).toBe(true);
    const r = extractSpeakerHeader(json);
    expect(r.present).toBe(false);
    expect(r.body).toBe(json);                              // 一字未削
  });

  it('无头输出不误判（正文里出现 speaker: 不算头）', () => {
    const body = '她说到speaker: xxx就停了。\n第二行';
    expect(extractSpeakerHeader(body).present).toBe(false);
  });

  it('validateReplyIdentity：头合法 → ok', () => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    const r = validateReplyIdentity(s, withSpeakerHeader('徐诗雨', '今天天气不错'));
    expect(r.ok).toBe(true);
    expect(r.speakerUuid).toBe('TXS-1');
    expect(r.body).toBe('今天天气不错');
  });

  it('头缺失 → 正文可用，按粘性归属，ok=true', () => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    const r = validateReplyIdentity(s, '今天天气不错');
    expect(r.ok).toBe(true);
    expect(r.assignedSpeaker).toBe('徐诗雨');
    expect(r.warn).toBeNull();
  });

  it('头声明非参与者 → 改按粘性归属 + 告警（不二次 LLM）', () => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    const r = validateReplyIdentity(s, withSpeakerHeader('阿珍', '我也来了'));
    expect(r.ok).toBe(false);
    expect(r.speakerUuid).toBe('TXS-1');
    expect(r.needsSecondaryCheck).toBe(false);
    expect(r.warn).toContain('不在参与者列表');
  });

  it('头与自称冲突 → needsSecondaryCheck=true', () => {
    const s = reduce(createSessionState(T0), wake([A, B]));
    const r = validateReplyIdentity(s, withSpeakerHeader('徐诗雨', '我是熊梓铭，叫我梓铭就行'));
    expect(r.needsSecondaryCheck).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('自称检测窄判据：正文提到别人的名字不算自称', () => {
    expect(detectSelfIdent('我和徐诗雨聊过天')).toEqual([]);            // 提及 ≠ 自称
    expect(detectSelfIdent('我是徐诗雨')).toEqual(['徐诗雨']);
    // 带白名单：句尾语气词被吃进来时按最长前缀归位（真实调用方都传白名单）
    expect(detectSelfIdent('你好，我叫熊梓铭呢', ['徐诗雨', '熊梓铭'])).toEqual(['熊梓铭']);
    // 不传白名单 → 原样返回捕获串（无从判断名字终点，宁可原样，不做词表裁剪）
    expect(detectSelfIdent('你好，我叫熊梓铭呢')).toEqual(['熊梓铭呢']);
  });
});

describe('[批A] GroupSession — 门面与回滚开关', () => {
  it('WS_GROUP_V2 默认关闭', () => {
    expect(isGroupSessionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isGroupSessionEnabled({ [GROUP_SESSION_FLAG]: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isGroupSessionEnabled({ [GROUP_SESSION_FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isGroupSessionEnabled({ [GROUP_SESSION_FLAG]: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(new GroupSession({ now: () => T0 }).isEnabled()).toBe(false);
    expect(new GroupSession({ enabled: true, now: () => T0 }).isEnabled()).toBe(true);
  });

  it('dispatch 更新状态并触发 onEnter / onSlot(save)', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    const enters: string[] = [];
    const slots: string[] = [];
    g.onEnter((p, n) => enters.push(`${p.participants.length}->${n.participants.length}`));
    g.onSlot((sl, kind) => slots.push(`${kind}:${sl.uuid ?? 'yuyao'}`));

    g.dispatch(wake([A], undefined, { slot: slot(null, '玉瑶现场') }));
    expect(g.active).toBe(true);
    expect(g.speakerUuid).toBe(A.uuid);
    expect(enters).toEqual(['0->1']);
    expect(slots).toEqual(['save:yuyao']);
  });

  it('无变化的 dispatch 不触发任何监听者（门卫拒绝路径零副作用）', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    let calls = 0;
    g.onEffect(() => { calls++; });
    g.dispatch({ type: 'JOIN', target: { uuid: '', name: '' }, now: T0 });   // 无效 uuid
    expect(calls).toBe(0);
  });

  it('serialize / restore 往返；坏数据拒绝且状态不变', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A, B]));
    const json = g.serialize();

    const g2 = new GroupSession({ enabled: true, now: () => T0 });
    expect(g2.restore(json)).toBe(true);
    expect(g2.participantCount).toBe(2);
    expect(g2.speakerUuid).toBe('TXS-1');

    expect(g2.restore('{"schemaVersion":99}')).toBe(false);
    expect(g2.participantCount).toBe(2);                    // 状态未被坏数据污染
  });

  it('动作审计轨迹（action 序列即日志）', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A, B]));
    g.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
    g.dispatch({ type: 'LEAVE', now: T0 });
    expect(g.getTrail().map(a => a.type)).toEqual(['WAKE', 'SPEAK', 'LEAVE']);
  });

  it('参与者查询辅助方法', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A, B]));
    expect(g.getParticipants().map(p => p.name)).toEqual(['徐诗雨', '熊梓铭']);
    expect(g.getParticipantByUuid('TXS-2')!.name).toBe('熊梓铭');
    expect(g.getSpeaker()!.uuid).toBe('TXS-1');
    g.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
    expect(g.getSpeaker()!.uuid).toBe('TXS-2');
  });
});

describe('[批A] identityFromState — 身份解析在状态之后（硬约束③）', () => {
  it('玉瑶态：mode=yuyao，speakerUuid=null，角色取入参', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    const id = resolveIdentityFromState(g.getState(), 'lover');
    expect(id.mode).toBe('yuyao');
    expect(id.isMeeting).toBe(false);
    expect(id.role).toBe('lover');
    expect(id.speakerUuid).toBeNull();
  });

  it('会晤态：一律 recaller（不可能出现会晤+玉瑶角色），speakerUuid 供 PI 接入', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A, B]));
    const id = resolveIdentityFromState(g.getState(), 'lover');   // 传错角色也被收口
    expect(id.role).toBe('recaller');
    expect(id.isMeeting).toBe(true);
    expect(id.speakerName).toBe('徐诗雨');
    expect(id.speakerUuid).toBe('TXS-1');                          // ← applyMeetingUuidFilter 的入参
    expect(id.identityClause).toContain('徐诗雨');
    expect(id.participantsDigest.map(p => p.name)).toEqual(['徐诗雨', '熊梓铭']);
  });

  it('切换主发言后身份随之改变（状态先于身份）', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A, B]));
    g.dispatch({ type: 'SPEAK', target: B.uuid, now: T0 });
    const id = resolveIdentityFromState(g.getState(), 'secretary');
    expect(id.speakerName).toBe('熊梓铭');
    expect(id.speakerUuid).toBe('TXS-2');
  });

  it('散会后回落玉瑶态，speakerUuid 清空（不残留旧 UUID）', () => {
    const g = new GroupSession({ enabled: true, now: () => T0 });
    g.dispatch(wake([A]));
    g.dispatch({ type: 'LEAVE', now: T0 });
    const id = resolveIdentityFromState(g.getState(), 'secretary');
    expect(id.speakerUuid).toBeNull();
    expect(id.mode).toBe('yuyao');
  });
});
