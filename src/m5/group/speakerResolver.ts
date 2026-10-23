/**
 * speakerResolver — 发言者判断分层（T013 Phase 2 · ADR-013 第一层）
 *
 * 🔴 分层判断，默认路径**零 LLM 调用**：
 *     ① rule-first   点名命中 + 状态判定（无会晤 ⇒ WAKE；会晤中 ⇒ JOIN/SPEAK）
 *     ② 粘性保持     会晤中 speakerUuid 不变；玉瑶态恒 null
 *     ③ LLM 兜底     **仅会晤首轮且无人点名**才调用，结构化输出
 *
 * 对比旧实现 EntityMeeting.inferSpeaker（两段：提及命中 / 直接问 LLM）：
 *   - 旧路径在「多人 + 无提及」时**每轮都问 LLM**（≈1-2s + 一次调用），延迟与成本随轮数线性增长；
 *   - 新路径把不确定性交给**粘性保持**（零成本、符合用户直觉「不点名就继续当前发言人」），
 *     LLM 只在状态机认为「本轮没有确定答案且是首轮」时才介入。
 *
 * 安全约束（ADR-013 第一层）：
 *   - LLM 兜底结果 confidence < 0.6 → **不采信**，回落粘性保持
 *   - 不确定时**不得输出玉瑶**（除非玉瑶在 participants 中——而按 ADR 玉瑶恒不入列，
 *     故本函数对会晤态永远返回实体 UUID，结构上排除了「误判为玉瑶」这条路径）
 *
 * 本文件**纯函数 + 注入式依赖**：别名表与 LLM 都由调用方传入，不 import 全局。
 */
import type { MessageIntent } from '../../m4/household/EntityMeeting.js';
import type { SessionState } from './types.js';
import { isActive } from './sessionReducer.js';

/** LLM 兜底的最小依赖面（与 EntityMeeting.inferSpeaker 同形，便于复用 ctx.llmProvider） */
export interface SpeakerLlm {
  rawCall?: (msgs: Array<{ role: string; content: string }>, maxTokens: number, temp: number) => Promise<string>;
}

/** 判断结果 */
export interface SpeakerDecision {
  /** 主发言者 UUID；null = 维持现状（粘性）或玉瑶态 */
  speakerUuid: string | null;
  name: string | null;
  /** 0~1；rule=1.0 / sticky=0.9 / llm=模型给值（<0.6 不采信） */
  confidence: number;
  source: 'rule' | 'sticky' | 'llm' | 'none';
  reason: string;
  /** 置信度不足需回落粘性时为 true（供调用方记告警） */
  needsStickyHold: boolean;
}

/** 置信度门槛 —— 低于此值不采信（ADR-013 第一层明文 0.6） */
export const SPEAKER_LLM_CONFIDENCE_FLOOR = 0.6;

// ═══════════════════════════════════════════════════════════════
// 名称解析（别名归一 → 主名 → uuid）
// ═══════════════════════════════════════════════════════════════

/**
 * 别名归一：把消息里的别名替换成主名（长别名优先，防"阿芬"抢在"芬芬阿"前）。
 * 与 EntityMeeting._normalizeAliases 同构，但为纯函数且作用于**参与者集合**
 * （旧实现作用于全 FG 人名池，会在会晤中把非参与者也归一进来 → 越界召回）。
 */
export function normalizeAliases(msg: string, aliasMap?: Map<string, string>): string {
  if (!aliasMap || aliasMap.size === 0) return msg;
  let out = msg;
  const entries = [...aliasMap.entries()]
    .filter(([a, m]) => a && a.length >= 1 && m && m.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, main] of entries) {
    if (out.includes(alias)) out = out.split(alias).join(main);
  }
  return out;
}

/**
 * 在**参与者集合内**解析一个名字片段 → 主名。
 * 只在 participants 里找（ADR-013 第一层「不确定时不得输出玉瑶」的结构性保证）。
 */
export function matchParticipantName(fragment: string, state: SessionState): string | null {
  const f = (fragment || '').trim();
  if (!f) return null;
  for (const p of state.participants) {
    if (p.name === f) return p.name;
  }
  for (const p of state.participants) {
    if (p.name.includes(f) || f.includes(p.name)) return p.name;  // "诗雨" ⊂ "徐诗雨"
  }
  return null;
}

function byName(state: SessionState, name: string): { uuid: string; name: string } | null {
  const p = state.participants.find(x => x.name === name);
  return p ? { uuid: p.uuid, name: p.name } : null;
}

// ═══════════════════════════════════════════════════════════════
// ① rule-first —— 同步、零成本、零 LLM
// ═══════════════════════════════════════════════════════════════

/**
 * 从消息里找**明确点名**：@某人 / "某人，…" 称呼 / "换某人"。
 * 刻意只认这三种强句式 —— 弱提及（正文里出现名字）交给 ③ LLM 兜底，
 * 避免旧实现「提一个名字就换人」的误切（P039 缺陷⑦）。
 */
export function ruleFindNamed(message: string, state: SessionState): { uuid: string; name: string } | null {
  const msg = (message || '').trim();
  if (!msg) return null;

  // @某人
  const at = msg.match(/^@\s*([一-龥\w]{1,8})/);
  if (at) {
    const hit = byName(state, matchParticipantName(at[1], state) ?? '');
    if (hit) return hit;
  }
  // "某人，…" / "某人：…"
  const voc = msg.match(/^\s*([一-龥]{2,8})\s*[：:，,、]/);
  if (voc) {
    const hit = byName(state, matchParticipantName(voc[1], state) ?? '');
    if (hit) return hit;
  }
  // "换某人"（仅整句，等价旧 detectSwitchIntent 的最强句式）
  const sw = msg.match(/^换\s*([一-龥]{2,8})\s*(?:来|吧|过来)?\s*$/);
  if (sw) {
    const hit = byName(state, matchParticipantName(sw[1], state) ?? '');
    if (hit) return hit;
  }
  return null;
}

/**
 * 同步判定主发言者。**默认路径，永远不调 LLM**。
 *
 * @param message   本轮用户消息
 * @param state     当前会话状态
 * @param aliasMap  FG 别名 → 主名（由适配层注入）
 */
export function resolveSpeakerSync(message: string, state: SessionState, aliasMap?: Map<string, string>): SpeakerDecision {
  const named = ruleFindNamed(normalizeAliases(message, aliasMap), state);
  if (named) {
    return {
      speakerUuid: named.uuid, name: named.name, confidence: 1.0,
      source: 'rule', reason: '点名命中(' + named.name + ')', needsStickyHold: false,
    };
  }

  // 粘性保持：会晤中 → 维持当前 speakerUuid
  if (state.speakerUuid) {
    const cur = state.participants.find(p => p.uuid === state.speakerUuid);
    return {
      speakerUuid: state.speakerUuid, name: cur?.name ?? null, confidence: 0.9,
      source: 'sticky', reason: '无点名，粘性保持当前发言人', needsStickyHold: false,
    };
  }
  // 玉瑶态（无参与者）—— 由上游按 mode 处理，本层不越权给发言人
  return {
    speakerUuid: null, name: null, confidence: 0,
    source: 'none', reason: isActive(state) ? '会晤中无当前发言人' : '玉瑶态', needsStickyHold: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// ③ LLM 兜底 —— 结构化输出，一次调用，低置信不采信
// ═══════════════════════════════════════════════════════════════

/** LLM 兜底允许触发的条件（由适配层判定；默认只在多人会晤首轮） */
export function llmFallbackAllowed(state: SessionState, isFirstTurn: boolean): boolean {
  return isActive(state) && state.participants.length >= 2 && isFirstTurn;
}

/**
 * LLM 兜底判断。**仅在 `llmFallbackAllowed` 为真时调用**，结构化输出
 * `{speaker_name, confidence, reason}`，解析失败一律回落粘性。
 *
 * 🔴 安全约束：返回名不在 participants 内 ⇒ 视为解析失败，绝不把外部名字当发言人。
 */
export async function resolveSpeakerLlm(
  message: string,
  state: SessionState,
  recentTurns: Array<{ speaker: string; content: string }>,
  llm?: SpeakerLlm,
): Promise<SpeakerDecision> {
  const sticky = resolveSpeakerSync(message, state);
  if (!llm?.rawCall) return { ...sticky, needsStickyHold: true, reason: sticky.reason + '（LLM 兜底不可用）' };

  const names = state.participants.map(p => p.name);
  const list = names.join('、');
  const recent = recentTurns.slice(-8).map(t => `${t.speaker}: ${String(t.content || '').substring(0, 80)}`).join('\n');
  const prompt = `多人聊天，参会者：${list}。当前发言人：${sticky.name || '无'}。\n`
    + `最近对话：\n${recent}\n用户刚说：「${String(message || '').substring(0, 200)}」\n`
    + `判断这句话最该谁接（聊到谁负责的事/在说谁/问谁）。\n`
    + `严格只输出 JSON：{"speaker_name":"${list}之一","confidence":0到1,"reason":"一句话"}\n`
    + `无法判断就输出 {"speaker_name":"${sticky.name || ''}","confidence":0,"reason":"不确定"}`;

  try {
    const out = ((await llm.rawCall([{ role: 'user', content: prompt }], 60, 0.1)) || '').trim();
    const obj = parseSpeakerJson(out);
    const conf = typeof obj.confidence === 'number' ? obj.confidence : 0;
    const hit = obj.speaker_name ? byName(state, matchParticipantName(String(obj.speaker_name), state) ?? '') : null;

    if (!hit || conf < SPEAKER_LLM_CONFIDENCE_FLOOR) {
      // 不确定 / 不在参与者内 / 低于门槛 → 回落粘性，记告警
      return { ...sticky, needsStickyHold: true, reason: 'LLM兜底不采信(' + (conf < SPEAKER_LLM_CONFIDENCE_FLOOR ? 'conf=' + conf : '非参与者') + ')→粘性保持' };
    }
    return {
      speakerUuid: hit.uuid, name: hit.name, confidence: conf,
      source: 'llm', reason: 'LLM兜底: ' + String(obj.reason || '').substring(0, 60), needsStickyHold: false,
    };
  } catch {
    return { ...sticky, needsStickyHold: true, reason: sticky.reason + '（LLM 兜底异常）' };
  }
}

/**
 * 从 LLM 输出里解析 JSON。🔴 用**字段边界**而非正则枚举枚举引号风格 ——
 * V45 的教训是剥离器/解析器用枚举式正则把纯 JSON 削成 "[{"（1010→3 字符）。
 * 此处同理：先找最外层 {…}，再逐字段取值，不预设引号是否含转义。
 */
export function parseSpeakerJson(raw: string): { speaker_name?: string; confidence?: number; reason?: string } {
  const s = (raw || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as any) : {};
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// 意图 → action（ADR-013 §4.2 状态机消歧）
// ═══════════════════════════════════════════════════════════════

/**
 * 把 EntityMeeting.detectIntent 的产物映射为 reducer action。
 * 🔴 消歧规则（ADR-013 §4.2）由 state 决定，而非由 intent 单独决定：
 *   无会话 + ADD/wake/switch ⇒ WAKE（单人/多人同一入口）
 *   群聊/单人 + addParticipant ⇒ JOIN
 *   会晤中 + switch ⇒ SPEAK
 *   任意 + exit ⇒ LEAVE（散会）
 *   normal ⇒ 交给 resolveSpeakerSync（不是 action）
 *
 * 返回 null = 本轮无需状态变更（normal / 门卫拒绝的模糊情况）。
 */
export function intentToAction(
  intent: MessageIntent,
  state: SessionState,
  targets: Array<{ uuid: string; name: string; aliases?: string[]; category?: string }>,
  now?: number,
): { type: 'WAKE'; targets: typeof targets; now?: number }
  | { type: 'JOIN'; target: (typeof targets)[0]; now?: number }
  | { type: 'SPEAK'; target: string; now?: number }
  | { type: 'LEAVE'; target?: string; now?: number }
  | null {
  const inMeeting = isActive(state);

  switch (intent.kind) {
    case 'exit':
      return { type: 'LEAVE', now };

    case 'wake':
    case 'addParticipant':
    case 'switch': {
      if (!inMeeting) {
        // 无会话：一律唤醒（单/多同一入口）
        return targets.length > 0 ? { type: 'WAKE', targets, now } : null;
      }
      if (targets.length >= 2) return { type: 'WAKE', targets, now };   // 多人目标 → 重新开会
      if (targets.length === 0) return null;
      const t = targets[0];
      if (intent.kind === 'switch') return { type: 'SPEAK', target: t.uuid, now };
      // addParticipant / wake：已在列则 WAKE 不触发（JOIN 内部幂等拒绝）
      return { type: 'JOIN', target: t, now };
    }

    default:
      return null;   // normal → 不动状态
  }
}
