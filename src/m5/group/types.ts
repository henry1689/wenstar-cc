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
/**
 * 会话模式（**纯派生，不入库**）。
 *
 * 2026-11-01 三值化：原为 `'yuyao' | 'meeting'` 两值，但运行时实际有四个态 ——
 * 独处态（散会后无人在场）与玉瑶态在状态机里是**同一个值**，只能靠调用方的模块级
 * 标志区分，进程重启即丢。现在把「曾经建立过席位」提升为状态字段
 * `SessionState.everHadSeats`，模式随之可派生为三个值：
 *
 *   - `'yuyao'`  —— 从未建立过席位（首聊、或全新安装）
 *   - `'alone'`  —— 曾建立过席位，此刻空场（散会之后）。**跨重启保留**
 *   - `'meeting'`—— 此刻有席位；单/多由 `isMulti` 再派生
 */
export type SessionMode = 'yuyao' | 'alone' | 'meeting';

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
  /**
   * 独处态过渡提示是否已发过（2026-11-01）。
   *
   * 🔴 用途：散会后从「有人应答」切到「完全静默」是一步跳变，体验生硬。
   *   进入独处态的**第一轮**给一句固定收尾文案（不过 LLM），之后彻底静默。
   *   本字段记录「这一轮独处是否已经提示过」：
   *     · WAKE / LEAVE 清空至空场 ⇒ 重置 false（下次独处重新提示）
   *     · ALONE_ACK ⇒ 置 true
   *   🔴 放 State 而非模块级变量：模块标志进程重启即丢（同 `_hadMeeting` 的教训）。
   * 🔴 向后兼容：schemaVersion **不 bump**，旧快照缺失时由 normalizeState 补 false。
   */
  aloneNotified: boolean;
  /**
   * 临时点名应答的**原主 UUID**（2026-11-01 D2）；`null` = 没有待恢复的临时切换。
   *
   * 🔴 用途：会晤中「@阿珍」或「阿珍，……」这类**点名**过去被当成永久换主（`switch`），
   *   业主说完一句，主发言者就永远停在被点名者身上，再也回不去。
   *   现在点名只顶替**本轮**：reduce 记下原主 UUID 到这里，下一轮请求开头由
   *   `chat.ts` dispatch `SPEAK` 回原主。明确的「换XX来」仍是永久切换（不动指针）。
   * 🔴 何时清空：WAKE / LEAVE / 普通 SPEAK 一律清空 —— 会话结构一变，
   *   旧的回退目标可能已不在场，留着就是错主。
   * 🔴 向后兼容：schemaVersion **不 bump**，旧快照缺失时由 `normalizeState` 补 null。
   */
  transientSpeakerFrom: string | null;
  /**
   * 是否**曾经**建立过席位（WAKE 置 true，永不回落）。
   *
   * 🔴 用途：把「散会之后」与「从未会晤」区分开 —— 前者是独处态（业主一个人，
   *   系统不该应答），后者是玉瑶态（正常对话）。旧实现靠 chat.ts 的模块级标志
   *   `_hadMeeting` 承担同一职责，进程重启即丢；本字段让它成为可持久化真状态。
   * 🔴 向后兼容：schemaVersion **不 bump**，旧快照缺失时由 `normalizeState` 补
   *   `participants.length > 0`（等价于旧实现「重启后丢失会晤记忆」）。
   */
  everHadSeats: boolean;
  /**
   * P090 · P096 §1.2：askAll 待发言队列（UUID，按 participants 加入序）；**空 = 不在轮答中**。
   * 只存 UUID（reducer 内不做名称解析）；含当前发言人（P094 裁决①，一律全答不跳过）。
   * 与 `speakerUuid` 正交 —— 推进靠适配层出队 + `SPEAK`，状态机只负责存取队列。
   * 🔴 向后兼容：schemaVersion **不 bump**（bump 会让旧快照整份被拒 ⇒ 重启无法恢复会晤），
   *   旧快照缺失本字段时由 `normalizeState` 补 `[]`。
   */
  askAllQueue: string[];
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
  /**
   * 独处态过渡提示已发出（2026-11-01）。
   *
   * 单独成 Action 而非手改 state：ADR-013 硬约束② —— 状态只有 `reduce` 一处写。
   * 调用方（chat.ts）发完固定文案后 dispatch 本 action，使下文不再重复提示。
   */
  | { type: 'ALONE_ACK'; now?: number }
  /**
   * 本轮点名应答（2026-11-01 D2）。
   *
   * 与 `SPEAK` 的区别：`SPEAK` 是**永久**换主（业主明确说「换XX来」），会清掉回退指针；
   * 本 action 是「只说这一轮」—— 第一次设置时记下当时的 `speakerUuid` 到
   * `transientSpeakerFrom`，由调用层在**下一轮**请求开头 `SPEAK` 回去。
   * 🔴 连续点名保留**最初**的原主，不把上一个被点名者当成原主。
   */
  | { type: 'TRANSIENT_SPEAK'; target: string; now?: number }
  | { type: 'RESUME'; state: SessionState; now?: number }
  | { type: 'IDLE'; now: number }
  /**
   * P090 · P096 §1.1「向全员提问」一次性入队。
   * 单独成 Action 而非给 SPEAK 塞队列标记：ADR-013 §2.2 的 6 个 Action 语义单一，
   * SPEAK =「指定某人发言」，塞进队列会让它同时承载「指定」与「轮询」，破坏单一职责。
   * 入队内容与顺序由 reduce 依 `participants` 原序派生（含当前发言人，P094 裁决①）。
   */
  | { type: 'ASK_ALL'; now?: number };

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
  | { type: 'speakerChanged'; from: string | null; to: string | null }
  /**
   * P090 · P096 §1.4：askAll 首次入队（`prev.askAllQueue` 空 且 `next` 非空，仅派生一次）。
   * 推进阶段**不派生新 effect** —— 每次出队都会 `SPEAK`，`speakerChanged` 已覆盖日志与持久化。
   */
  | { type: 'askAllStarted'; uuids: string[] };
