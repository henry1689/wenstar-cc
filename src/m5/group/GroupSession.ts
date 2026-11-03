/**
 * GroupSession — 群聊会话门面（T013 Phase 2 · ADR-013 §2.2）
 *
 * 职责边界（刻意很薄）：
 *   - 持有一个 SessionState，所有变更经 `dispatch` → `reduce`（唯一写入口）
 *   - 把 `diffEffects` 产出的副作用转交给注册的监听者（适配层做压栈/弹栈/门阀/日志）
 *   - 提供 serialize / restore（**纯字符串**，不含 IO）——持久化到 engine_store 属批 B 的 SessionStore
 *
 * 🔴 2026-10-31 第三层固化：回滚开关 `WS_GROUP_V2` 已**彻底删除**。
 *   本类是群聊/会晤状态的**唯一真源**，不存在「关闭后走旧 EntityMeeting 状态机」这条路。
 *   旧状态机那套方法（进入 / 退出 / 切主 / 加人 / 恢复 一类）已随开关一并删除，
 *   生产代码零残留 —— 要回退只能 `git revert` 代码，配置层不再有任何开关可退回错误实现。
 *   🔴 刻意不复述方法名：复述等于持续向读者演示已删 API，正是 2026-11-02 根除要消除的入口。
 *
 * 线程模型：单进程内存对象（与旧 EntityMeeting 同）；**不做隐式全局** ——
 *   实例由适配层显式创建并挂在 ctx 上，避免第 7 份副本式的模块级单例漂移。
 */
import {
  createSessionState,
  deserializeState,
  diffEffects,
  findParticipant,
  isActive,
  isMulti,
  reduce,
  serializeState,
  sessionMode,
  speaker,
} from './sessionReducer.js';
import type { Action, ContextSlot, Participant, SessionEffect, SessionMode, SessionState } from './types.js';

/** 现场槽监听者（L5/L6 的压栈/弹栈落点；适配层负责与 ContextMemory/SceneAnchor 同步） */
export type SlotListener = (slot: ContextSlot, kind: 'save' | 'restore') => void;
/** 通用副作用监听者 */
export type EffectListener = (effect: SessionEffect, prev: SessionState, next: SessionState) => void;
/** 状态变更监听者 */
export type EnterListener = (prev: SessionState, next: SessionState) => void;

export interface GroupSessionOptions {
  /** 初始时间注入（测试用；缺省 Date.now()） */
  now?: () => number;
}

export class GroupSession {
  private _state: SessionState;
  private readonly _now: () => number;
  private readonly _onEnter: EnterListener[] = [];
  private readonly _onEffect: EffectListener[] = [];
  private readonly _onSlot: SlotListener[] = [];
  /** 动作审计轨迹（action 序列即日志，ADR-013 §2.2；仅供诊断/重放） */
  private readonly _trail: Action[] = [];
  private static readonly TRAIL_CAP = 200;

  constructor(opts: GroupSessionOptions = {}) {
    this._now = opts.now ?? (() => Date.now());
    this._state = createSessionState(this._now());
  }

  /** 只读取状态（外部无法修改；对象本身仍是内部实例，勿直接改字段） */
  getState(): SessionState { return this._state; }

  // ── 便捷派生（避免调用方到处 import 纯函数）──
  get mode(): SessionMode { return sessionMode(this._state); }
  get active(): boolean { return isActive(this._state); }
  get multi(): boolean { return isMulti(this._state); }
  get participantCount(): number { return this._state.participants.length; }
  get speakerUuid(): string | null { return this._state.speakerUuid; }
  getParticipants(): Participant[] { return [...this._state.participants]; }
  getParticipantByUuid(uuid: string): Participant | null { return findParticipant(this._state, uuid); }
  getSpeaker(): Participant | null { return speaker(this._state); }
  /** 会晤开始时的历史索引（沿用 EntityMeeting V5.0 语义） */
  getMeetingStartHistoryIndex(): number { return this._state.meetingStartHistoryIndex; }
  /** 动作审计轨迹（快照） */
  getTrail(): Action[] { return [...this._trail]; }

  /**
   * 派发动作 → 更新状态 → 触发监听者。
   * 返回**新状态**；若本轮无变化（门卫拒绝/模糊不操作），返回的是原对象。
   */
  dispatch(action: Action): SessionState {
    const _t0 = Date.now();
    let _status = 'unchanged';
    let _effects = 0;
    let _participants = this._state.participants.length;
    // 🔴 M 层埋点（P055 任务1）：dispatch 是 GroupSession 状态变更的**唯一入口**
    //   （ADR-013 硬约束②「状态只有一处写」），且它本身是有状态方法（改 _state、
    //   push _trail、触发监听者）而非纯函数 —— 故埋点放此处即符合「唯一调用点」原则。
    //   reduce / diffEffects 保持零副作用，那是它们能被单测覆盖的前提
    //   （与 chat/retrieval-stage.ts:143 对 recall-quota 的处理同一原则）。
    //   放调用方（chat.ts 投影块）则 reset() 内部的 dispatch 会漏埋，未来新增调用点仍会漏。
    //   🔴 埋点失败绝不影响主链路（照 m2.SQLiteAdapter 的 _hook 范式）。
    try {
      console.log(`[Hook] module_entry module=m5.GroupSession.dispatch action=${action.type} participants=${_participants}`);
    } catch { /* 埋点失败不影响主链路 */ }
    try {
      const prev = this._state;
      const next = reduce(prev, action);
      if (next === prev) return prev;             // 无变化，不记轨迹、不触发监听者

      this._state = next;
      this._trail.push(action);
      if (this._trail.length > GroupSession.TRAIL_CAP) this._trail.splice(0, this._trail.length - GroupSession.TRAIL_CAP);

      const effects = diffEffects(prev, next);
      // 出口字段在状态定稿后取值（finally 里读的是这些外层变量）
      _status = 'applied';
      _effects = effects.length;
      _participants = next.participants.length;
      for (const fn of this._onEnter) {
        try { fn(prev, next); } catch (e) { console.warn('[GroupSession] onEnter 监听者异常:', (e as Error)?.message); }
      }
      for (const eff of effects) {
        for (const fn of this._onEffect) {
          try { fn(eff, prev, next); } catch (e) { console.warn('[GroupSession] onEffect 监听者异常:', (e as Error)?.message); }
        }
        if (eff.type === 'saveSlot') {
          for (const fn of this._onSlot) {
            try { fn(eff.slot, 'save'); } catch (e) { console.warn('[GroupSession] slot(save) 监听者异常:', (e as Error)?.message); }
          }
        } else if (eff.type === 'restoreSlot') {
          for (const fn of this._onSlot) {
            try { fn(eff.slot, 'restore'); } catch (e) { console.warn('[GroupSession] slot(restore) 监听者异常:', (e as Error)?.message); }
          }
        }
      }
      return next;
    } finally {
      // 🔴 用 finally 而非在末尾直打 —— 监听者抛异常时 module_exit 仍要打出来，
      //   否则最需要可观测的失败路径反而无日志（DeepSeekLLMProvider 只用 _status 变量，此处补上兜底）。
      try {
        console.log(`[Hook] module_exit module=m5.GroupSession.dispatch 耗时=${Date.now() - _t0}ms status=${_status} effects=${_effects} participants=${_participants}`);
      } catch { /* 埋点失败不影响主链路 */ }
    }
  }

  /** 注册状态变更监听者（PI 的加人减人回调挂这里，ADR-013 协作接口#3） */
  onEnter(fn: EnterListener): () => void { this._onEnter.push(fn); return () => { const i = this._onEnter.indexOf(fn); if (i >= 0) this._onEnter.splice(i, 1); }; }

  /** 注册副作用监听者 */
  onEffect(fn: EffectListener): () => void { this._onEffect.push(fn); return () => { const i = this._onEffect.indexOf(fn); if (i >= 0) this._onEffect.splice(i, 1); }; }

  /** 注册现场槽监听者（save=压栈 / restore=弹栈） */
  onSlot(fn: SlotListener): () => void { this._onSlot.push(fn); return () => { const i = this._onSlot.indexOf(fn); if (i >= 0) this._onSlot.splice(i, 1); }; }

  /**
   * 序列化当前状态。**无 IO** —— 返回字符串，由适配层决定存到哪里
   * （批 B：engine_store 单键 `group_session_v2`）。
   */
  serialize(): string { return serializeState(this._state); }

  /**
   * 从序列化字符串恢复。🔴 校验失败**整份拒绝**并返回 false，
   * 状态保持原样（绝不半恢复 —— 半错状态会导致 speakerUuid 指向不存在的参与者，
   * 进而使检索白名单错 → 串档）。
   */
  restore(json: string): boolean {
    const parsed = deserializeState(json, this._now());
    if (!parsed) {
      console.warn('[GroupSession] restore 拒绝：序列化内容校验未通过（保持当前状态）');
      return false;
    }
    const prev = this._state;
    this._state = parsed;
    for (const fn of this._onEnter) {
      try { fn(prev, parsed); } catch (e) { console.warn('[GroupSession] onEnter 监听者异常:', (e as Error)?.message); }
    }
    return true;
  }

  /** 清空（回到玉瑶态）。**不归零现场** —— 玉瑶现场仍留在 contextStack 由监听者恢复 */
  reset(now?: number): SessionState { return this.dispatch({ type: 'LEAVE', now: now ?? this._now() }); }
}

export default GroupSession;