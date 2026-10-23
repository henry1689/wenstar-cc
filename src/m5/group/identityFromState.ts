/**
 * identityFromState — 从 SessionState 解析身份（T013 Phase 2 · ADR-013 硬约束③ + 协作接口#4）
 *
 * 🔴 与第 0 步的 `resolveIdentity`（m5/identity/resolveIdentity.ts）的关系：
 *   - 第 0 步落地的是**输入投影**版本：`{isMeeting, speakerName, yuyaoRole}`，
 *     它消灭了「三段接力定身份」的架构债，但输入仍由调用方各自拼。
 *   - 本函数是**状态投影**版本（ADR-013 §2.1 硬约束③「身份解析在状态之后」）：
 *     只接受 SessionState，**不可能出现「会晤态 + 玉瑶角色」的组合**，
 *     且顺带产出 speakerUuid —— 这正是 PI 的
 *     `meetingIsolation.meetingSpeakerUuid({speakerUuid})` / `applyMeetingUuidFilter(uuid)`
 *     要吃的字段（ADR-013 协作接口#4）。
 *   - 两者的 role/isMeeting 决策逻辑完全同一处（委托 resolveIdentity），不是第二份实现。
 */
import type { RoleType } from '../../app/role/RoleClassifier.js';
import { resolveIdentity, type ResolvedIdentity } from '../identity/resolveIdentity.js';
import { sessionMode, speaker } from './sessionReducer.js';
import type { SessionState } from './types.js';

export interface StateIdentity extends ResolvedIdentity {
  /** 会晤态主发言者 UUID（供检索过滤直接使用）；玉瑶态恒 null */
  speakerUuid: string | null;
  /** 会晤参与者名单（name+uuid），供 prompt 里的「其他人只给摘要」用 */
  participantsDigest: Array<{ uuid: string; name: string }>;
  /** 当前会话模式 */
  mode: 'yuyao' | 'meeting';
}

/**
 * 从状态解析身份。**纯函数**，不读全局、不查 FG、不调 LLM。
 *
 * @param state      群聊会话状态（唯一真源）
 * @param yuyaoRole  玉瑶态的当前角色（RoleRouter 结果；会晤态会被忽略，由会话模式统一收口）
 */
export function resolveIdentityFromState(state: SessionState, yuyaoRole: RoleType): StateIdentity {
  const mode = sessionMode(state);
  const isMeeting = mode === 'meeting';
  const current = speaker(state);

  const base = resolveIdentity({
    isMeeting,
    speakerName: current?.name ?? null,
    yuyaoRole,
  });

  return {
    ...base,
    speakerUuid: isMeeting ? state.speakerUuid : null,
    participantsDigest: state.participants.map(p => ({ uuid: p.uuid, name: p.name })),
    mode,
  };
}
