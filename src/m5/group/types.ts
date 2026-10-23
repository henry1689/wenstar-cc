/**
 * 群聊会话状态 — 类型定义（T013 Phase 2 主体工程 · ADR-013 §2.1）
 *
 * 🔴 存在的理由：当前会话状态分散在 6+ 份副本里
 *   EntityMeeting: `_meeting` / `_multiParticipants` / `_multiTurns` / `_multiMeetingName` / `_isFirstTurn`
 *   chat.ts:       `_currentRole`（12 个读写点）/ `_meetingEntityName` / `_savedHumanRole` / `_meetingKBCache`
 *   任意一份被单独修改都会造成身份/状态错位（P037/P039 的根因形态）。
 *
 * 三条硬约束（ADR-013 §2.1）：
 *   ① 禁止冗余派生字段 —— mode 由 `sessionMode()` 从 participants 派生，**不落库**
 *      （落库 = 第二个真源，必然与 participants 漂移）
 *   ② 状态只有一处写 —— 所有变更走 `reduce(state, action)`，外部只读
 *   ③ 身份解析在状态之后 —— 见 identityFromState.ts
 *
 * 命名提示：`SessionState` 与 `engine/temporal/global-types.ts` 的同名类型语义不同
 *   （那边是 active|sealed|emotional_anchor）。本目录不做 barrel 导出，调用方需显式
 *   从 `m5/group/types.js` 导入，避免被通配导出带进同一作用域。
 *
 * 依赖：本文件对 SceneAnchor / ContextSnapshot / RoleType **全部 type-only 导入**，
 *   运行时零依赖、零副作用。
 */
import type { RoleType } from '../../app/role/RoleClassifier.js';
import type { SceneAnchor } from '../SceneAnchor.js';
import type { ContextSnapshot } from '../ContextMemory.js';

/** 序列化格式版本 —— RESUME 时版本不符一律拒绝，避免旧/新结构互读 */
export const GROUP_SESSION_SCHEMA_VERSION = 2 as const;
export type GroupSessionSchemaVersion = typeof GROUP_SESSION_SCHEMA_VERSION;

/** 群聊参与者（玉瑶默认不入列；空数组 = 玉瑶态） */
export interface Participant {
  /** FG 实体 UUID —— **唯一键**，所有隔离（记忆/FG/知识库）按它取 */
  uuid: string;
  /** 显示名（FG 主名） */
  name: string;
  /** 别名（PI 白名单/意图匹配用） */
  aliases: string[];
  /** FG category（'S' 为系统本体，不允许作为参与者） */
  category: string;
  joinedAt: number;
  turnCount: number;
}

/** WAKE/JOIN 时由适配层（rule-first）解析出的参与者种子；reducer 保持纯函数，不做 FG 查询 */
export interface ParticipantSeed {
  uuid: string;
  name: string;
  aliases?: string[];
  category?: string;
}

/** 情感现场（与 M3 感知 / emotion_snapshots 表字段同名） */
export interface EmotionSlot {
  pleasure: number;
  arousal: number;
  intimacy: number;
}

/**
 * 上下文现场槽（ADR-013 第五/六层）。
 * 进入会晤时把玉瑶现场压入栈（uuid=null）；退出到空参与者时弹栈恢复**而不是归零**。
 * 换人（SPEAK）不新增层级，按 uuid 原位覆盖（每人独立现场）。
 */
export interface ContextSlot {
  /** null = 玉瑶 */
  uuid: string | null;
  emotion: EmotionSlot;
  sceneAnchor: SceneAnchor | null;
  contextMemory: ContextSnapshot | null;
  /** 玉瑶态保存的角色现场（会晤态的 role 恒为 recaller，无需保存） */
  savedRole?: RoleType;
  savedAt: number;
}

/** 会话模式 —— 派生值，不入库 */
export type SessionMode = 'yuyao' | 'meeting';

/** 群聊会话的**唯一**状态对象（可 JSON 序列化） */
export interface SessionState {
  schemaVersion: GroupSessionSchemaVersion;
  /** 参与者（不含玉瑶）；length === 0 ⇒ 玉瑶态 */
  participants: Participant[];
  /** 当前主发言者 UUID；玉瑶态恒为 null */
  speakerUuid: string | null;
  /** 本轮会话累计轮数 */
  turnIndex: number;
  /** 现场栈：已保存的非当前现场；栈顶为最近保存 */
  contextStack: ContextSlot[];
  /** 最后一次会话活动时间（epoch ms） */
  lastActivityAt: number;
  /** 会晤开始时的 conversationHistory 索引（沿用 EntityMeeting V5.0 语义） */
  meetingStartHistoryIndex: number;
}

/**
 * 状态变更动作（ADR-013 §2.2 的 6 个）。
 * 所有 target 都已经由适配层解析为 UUID；reducer 内不做名称解析。
 */
export type Action =
  | {
      type: 'WAKE';
      /** 目标参与者（1 人 = 单人会晤，≥2 = 多人会晤，同一入口） */
      targets: ParticipantSeed[];
      /** 进入会晤时要压栈的玉瑶现场（缺省 = 不保存现场） */
      slot?: ContextSlot;
      /** 会晤开始时的对话历史索引 */
      historyIndex?: number;
      now?: number;
    }
  | { type: 'JOIN'; target: ParticipantSeed; now?: number }
  | {
      type: 'SPEAK';
      /** 目标 UUID（优先）或主名 */
      target: string;
      /** 切换前当前发言者的现场（按 uuid 原位保存，不新增层级） */
      slot?: ContextSlot;
      now?: number;
    }
  | { type: 'LEAVE'; target?: string; now?: number }
  | { type: 'RESUME'; state: SessionState; now?: number }
  | { type: 'IDLE'; now: number };

/**
 * 状态变化的副作用描述（由 `diffEffects(prev, next)` 派生，不在 reducer 内执行）。
 * 适配层据此做压栈/弹栈、门阀与日志——保持 reducer 纯函数、可重放。
 */
export type SessionEffect =
  | { type: 'saveSlot'; slot: ContextSlot }
  | { type: 'restoreSlot'; slot: ContextSlot }
  | { type: 'meetingStarted'; uuids: string[] }
  | { type: 'meetingEnded' }
  | { type: 'participantJoined'; uuid: string }
  | { type: 'participantLeft'; uuid: string }
  | { type: 'speakerChanged'; from: string | null; to: string | null };
