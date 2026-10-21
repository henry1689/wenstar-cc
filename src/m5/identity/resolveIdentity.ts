/**
 * resolveIdentity — 身份解析纯函数（T013 Phase2 第0步，ADR-013 §2.1/§3 第二层）
 *
 * 🔴 解决的问题（T012 摸底 P037 实证）：
 *   此前「当前发言者是谁」由**三段接力**决定，任何一段变化都会造成身份泄漏：
 *     1. chat.ts:494 角色路由（早于会晤状态机 314 行，会把 role 定格为 secretary）
 *     2. M5Orchestrator:82 `if (isEntityMeeting) role = 'recaller'`（兜住 1）
 *     3. DeepSeekLLMProvider:1700 `_effectiveRole = max_length<=15 ? 'secretary' : role`（可再次覆盖 2）
 *   三者不在同处、可独立变化 → 正确性靠下游兜底而非调用方保证，属架构债。
 *
 * 🔴 ADR-013 三条硬约束中「身份解析在状态之后」的落地：
 *   本函数是 **role 与 isEntityMeeting 一致性的唯一决定点** —— 同一次调用的返回值里
 *   两者由同一个分支产生，不可能出现「会晤态 + 玉瑶角色」的组合。
 *
 * 设计约束：
 *   - 纯函数：无副作用、不读全局、不缓存（便于单测与复现）
 *   - 输入只接受**状态投影**（isMeeting/speakerName），不接受任何可被别处覆盖的「当前角色」
 *     之外的隐式上下文
 *   - 会晤态**一律返回 recaller**：recaller 模板按 isEntityMeeting 生成档案身份从句
 *     （RoleProfiles.ts:156-180），这是现有唯一正确隔离的身份通道
 */
import type { RoleType } from '../../app/role/RoleClassifier.js';

export interface IdentityInput {
  /** 是否处于实体会晤（等价于 SessionState.mode === 'meeting'） */
  isMeeting: boolean;
  /** 会晤态的当前发言者名（玉瑶态为 null） */
  speakerName: string | null;
  /** 玉瑶态的当前角色（RoleRouter 分类结果，仅非会晤态被采纳） */
  yuyaoRole: RoleType;
}

export interface ResolvedIdentity {
  /** 传给 M5/LLM 的角色 —— 会晤态恒为 recaller */
  role: RoleType;
  /** 与 role 同源产生的模式标志，二者不可能不一致 */
  isMeeting: boolean;
  /** 会晤态发言者名（玉瑶态为 null） */
  speakerName: string | null;
  /**
   * 会晤态自称铁律（非会晤态为空串）。
   * 与 role 的档案身份从句同向，供注入方在需要时补充到 prompt 尾部强化。
   */
  identityClause: string;
}

/** 会晤态发言者名的兜底长度上限（防异常长名污染 prompt） */
const MAX_SPEAKER_NAME_LEN = 32;

export function resolveIdentity(input: IdentityInput): ResolvedIdentity {
  // ── 玉瑶态：采纳 RoleRouter 的分类结果 ──
  if (!input.isMeeting) {
    return {
      role: input.yuyaoRole,
      isMeeting: false,
      speakerName: null,
      identityClause: '',
    };
  }

  // ── 会晤态：身份一律走 recaller（档案优先）通道 ──
  const raw = (input.speakerName ?? '').trim();
  const name = raw.length > MAX_SPEAKER_NAME_LEN ? raw.slice(0, MAX_SPEAKER_NAME_LEN) : raw;

  return {
    role: 'recaller',
    isMeeting: true,
    speakerName: name || null,
    identityClause: name
      ? `你就是${name}。你只能自称${name}，不得自称玉瑶、AI 或档案以外的任何身份。`
      : '',
  };
}
