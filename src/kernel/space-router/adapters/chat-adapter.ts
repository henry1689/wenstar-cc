/**
 * ChatSpaceAdapter — 空间路由器 ↔ chat 管线适配器
 * ============================================================
 * **本文件是适配层，不属于内核**：内核（../types、../SpaceRouter、../__tests__）
 * 保持零依赖、零 IO、零 LLM；这里负责把 chat 管线的事实翻译成 `Flow`，
 * 把 `ContextView` 翻译回管线需要的形状。
 *
 * 【判据变更】
 *   旧：按 `belongEntityUuid`（这条对话归属于谁）过滤 —— 多角色会晤中
 *       B 看不到 A 在场时说的话，而「对话延续」块又把别人的话标成 B 说的。
 *   新：按**当时谁在场**（任期 ∧ audience）过滤，说话人标签永远真实。
 *
 * 【🔴 时序铁律（2026-10-29 实测修正版）】
 *   真正的约束**不是**调用顺序，而是：**首次同步的 enter 必须锚定在会晤起点**。
 *
 *   踩过的坑：原来 `syncParticipants()` 用 `Date.now()` 给 enter 打点，
 *   而 `syncFromHistory()` 摄入的历史用的是其**原生 timestamp**（会晤开始时刻 T，
 *   必然早于 now）。于是 enter.ts(now) > history.ts(T) ⇒ 会晤内历史全部落在
 *   任期**之前** ⇒ 参与者对新会晤完全失忆。
 *   ——单测 `chat-adapter.test.ts` 的三条失败精确地暴露了这一点。
 *
 *   现在的做法：
 *     · `syncFromHistory()` 记录 `_meetingStartTs` = 首条被摄入历史的时间戳；
 *     · **首次** `syncParticipants()` 的 enter 使用 `_meetingStartTs`；
 *     · 会中陆续加入的人仍用当前时刻；
 *     · 首次 enter 早于最后一条历史时，route 必产 `ts_out_of_order` —— 这是
 *       **预期内**的，故对这一次调用单独过滤，其余告警照常保留。
 *
 * 【已知限制】
 *   会晤之前的历史没有「那一刻谁在场」的记录，无法精确重放 —— 因此按
 *   startIndex（= meetingStartHistoryIndex）一刀切不摄入（等价于「入场前不可见」）。
 *   更早的对话由长期记忆链路承载，不走 enrichedHistory。
 */
import type { Flow, SpaceEvent, SpaceState, Seat } from '../types.js';
import { createEmptySpace } from '../types.js';
import { buildViewFor, route } from '../SpaceRouter.js';

/**
 * 🔴 2026-10-30 第一层固化：开关 `WS_SPACE_ROUTER_VIEW` 与 `isSpaceViewEnabled()` 已删除。
 *
 * 删除理由：开关给了「随时退回旧的 belongEntityUuid 归属过滤」的出口，而旧过滤正是
 * 「标签串台」的成因 —— 留着一个能退回错误实现的开关，等于把已修好的缺陷留在触手可及处。
 * 现在空间视图是**唯一**可见性实现，没有第二条路径可以漂回去。
 */

/**
 * 🔴 埋点阈值：单次 route 超过该毫秒数才落一条 `[Hook]` 日志。
 *   稳态 route 通常 < 0.5ms，逐条打点只会制造噪音；异常慢调用才是需要被看见的。
 */
const SLOW_ROUTE_MS = 5;

/** 参与者最小契约（结构类型：不 import GroupSession/EntityMeeting，保持适配层解耦） */
export interface ParticipantLike {
  uuid: string;
  name: string;
}

/** 历史轮次最小契约（与 m5 的 ConversationTurn 兼容） */
export interface HistoryTurnLike {
  role: string;
  content?: string;
  timestamp?: string;
  belongEntityUuid?: string;
  /**
   * 🔴 2026-10-31 耳语：该轮业主发言的**唯一听众**（席位 UUID）。
   *   有值 ⇒ 重新摄⼊时还原成 `audience: { kind:'seat' }`，其余席位只见占位。
   *   ⚠️ 该字段存放在**内存对话轮**上；落库无对应列，重启后重新摄取会退化为全场可闻。
   */
  whisperToUuid?: string;
}

/** 对话轮（ConversationTurn 的超集，多带新范式字段） */
export interface SpeakerTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** 🔴 新范式主字段：真实发言者 UUID；user 轮为 undefined（业主不属于任何实体） */
  speakerUuid?: string;
  /** ⚠️ **旧管线兼容字段**：语义为「这条对话归属于谁」。新逻辑一律读 speakerUuid */
  legacyBelongEntityUuid?: string;
  /** 🔴 真实说话人显示名。旧实现把所有 assistant 硬标成当前会晤实体名，是串台成因 */
  speakerName?: string;
  /** 耳语标记（audience.kind === 'seat'），供上层渲染差异化样式 */
  isWhisper?: boolean;
}

/** 诊断快照（导出用，不参与业务逻辑） */
export interface SpaceSnapshot {
  spaceId: string;
  ingestedIndex: number;
  lastTs: number;
  seats: Seat[];
  eventCount: number;
  diagnostics: string[];
  /** 🔴 M 层埋点（HOOK_M_LAYER）：route 调用次数 / 累计耗时 / 峰值 / 超阈值次数 */
  routeStats: { count: number; totalMs: number; maxMs: number; slowCount: number };
}

export class ChatSpaceAdapter {
  private _state: SpaceState;
  private _lastTs = 0;
  /** 已从 conversationHistory 摄入到的下标（幂等增量） */
  private _ingestedIndex = 0;
  /** 会晤起点时间戳（首条被摄入历史的 timestamp）；null = 未知 */
  private _meetingStartTs: number | null = null;
  /** 是否已完成首次席位同步（决定 enter 用会晤起点还是当前时刻） */
  private _initialSynced = false;
  /** 户籍池：只允许已知实体的 UUID 进入席位表（防僵尸席位） */
  private readonly _knownUuids = new Set<string>();
  private readonly _nameOf = new Map<string, string>();
  /** 诊断缓冲：route 的 warnings 不丢弃，按需 flush */
  private readonly _diagnostics: string[] = [];
  /**
   * 🔴 M 层埋点统计（HOOK_M_LAYER）—— 字段口径与 M2 一致：
   *   operation_type=route / duration_ms / status。
   *
   * 为什么不逐条打日志：`_apply` 每请求要被调用数次，全量打点会淹没日志且拖慢主流程。
   * 故**只在超过阈值时**打一条 `[Hook]`，其余只累计。
   * 埋点本身失败绝不影响路由主流程（try/catch 吞掉）。
   */
  private readonly _routeStats = { count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
  private readonly _ownerName: string;

  constructor(spaceId: string, ownerName = '鸿艺') {
    this._state = createEmptySpace(spaceId);
    this._ownerName = ownerName;
  }

  /** 只读快照（诊断/日志用；外部不得直接改） */
  get state(): SpaceState {
    return this._state;
  }

  /** 取出并清空诊断缓冲 */
  flushDiagnostics(): string[] {
    const out = this._diagnostics.slice();
    this._diagnostics.length = 0;
    return out;
  }

  /**
   * 单调时间戳（**仅用于实时事件**；历史事件用其自带 timestamp）。
   * 🔴 内核要求 ts 严格递增（乱序只告警不纠错），同毫秒内连续调用时自增 1。
   */
  private _ts(): number {
    const now = Date.now();
    this._lastTs = now > this._lastTs ? now : this._lastTs + 1;
    return this._lastTs;
  }

  /**
   * 🔴 M 层埋点（HOOK_M_LAYER）：route 是本模块唯一的写入口，埋点必须落在这里。
   *   SpaceRouter 是零 IO 纯函数内核，埋点放进去会污染内核 —— 故由调用点计时。
   * @param durationMs 本次 route 耗时（毫秒，保留两位小数）
   * @param status     success / fail / error
   * @param extra      附加字段（如 warn_count）
   */
  private _hookRoute(durationMs: number, status: 'success' | 'fail' | 'error', extra: Record<string, unknown> = {}): void {
    try {
      const s = this._routeStats;
      s.count++;
      s.totalMs += durationMs;
      if (durationMs > s.maxMs) s.maxMs = durationMs;
      if (durationMs < SLOW_ROUTE_MS) return;
      s.slowCount++;
      console.log('[Hook] ' + JSON.stringify({
        module: 'M5.SpaceAdapter',
        event: 'module_exit',
        operation_type: 'route',
        duration_ms: Math.round(durationMs * 100) / 100,
        status,
        ...extra,
      }));
    } catch { /* 埋点失败绝不影响路由主流程 */ }
  }

  /** 推进一条 flow，并**保留** warnings 到诊断缓冲（不丢告警） */
  private _apply(flow: Flow): void {
    const _t0 = performance.now();
    const r = route(this._state, flow);
    this._hookRoute(performance.now() - _t0, 'success', { warn_count: r.out.warnings.length });
    this._state = r.nextState;
    if (r.out.warnings.length > 0) this._diagnostics.push(...r.out.warnings);
    this._lastTs = Math.max(this._lastTs, r.nextState.lastTs);
  }

  /**
   * 首次席位同步专用：enter 锚定在会晤起点，因此事件时间戳必然小于 `lastTs`，
   * route 必产 `ts_out_of_order`。这是**预期行为**（会晤起点早于最后一条历史），
   * 故过滤该条告警，其余照常保留。
   */
  private _applyInitialEnter(flow: Flow): void {
    const _t0 = performance.now();
    const r = route(this._state, flow);
    this._hookRoute(performance.now() - _t0, 'success', { warn_count: r.out.warnings.length, initial: true });
    this._state = r.nextState;
    for (const w of r.out.warnings) {
      if (!w.startsWith('ts_out_of_order')) this._diagnostics.push(w);
    }
    this._lastTs = Math.max(this._lastTs, r.nextState.lastTs);
  }

  /**
   * 户籍登记：只有显式登记过的 UUID 才能进入席位表。
   *
   * 🔴 2026-10-31 修复（耳语/指名全线失效的根因）：
   *   `syncFromHistory()` 先于 `syncParticipants()` 执行，而历史轮只带 `belongEntityUuid`
   *   **不带人名**，于是登记时只能拿 UUID 兜底 ⇒ 席位 `displayName` 被钉成 UUID。
   *   旧实现对**已存在**的席位直接 `return`，导致随后 `syncParticipants()` 拿到的真名
   *   永远刷不进去 ⇒ 内核 `detectAddressee()` 与上层耳语判据（`message.includes(displayName)`）
   *   全部匹配失败。真机表现：说「诗雨，我悄悄跟你说句话」不触发任何耳语。
   *
   * 修复两条：
   *   ① `_nameOf` 只接受**像名字**的值（`name !== uuid`），UUID 不得覆盖已记录的真名；
   *   ② 席位**已存在**时，若能解析出真名则刷新 `displayName`（占位 UUID → 真名）。
   */
  private _register(uuid: string, name: string): void {
    if (!uuid) return;
    this._knownUuids.add(uuid);
    // ① 只接受真名：UUID 不是名字，不能用它覆盖已知真名
    if (name && name !== uuid) this._nameOf.set(uuid, name);
    const resolved = this._nameOf.get(uuid) ?? uuid;

    const existing = this._state.seats.find((s) => s.uuid === uuid);
    if (existing) {
      // ② 已有席位：把占位的 UUID 名字刷新成真名（只升不降，UUID 不得覆盖真名）
      if (resolved !== uuid && existing.displayName !== resolved) {
        this._state = {
          ...this._state,
          seats: this._state.seats.map((s) =>
            s.uuid === uuid ? { ...s, displayName: resolved } : s,
          ),
        };
      }
      return;
    }

    this._state = {
      ...this._state,
      seats: [
        ...this._state.seats,
        {
          uuid,
          displayName: resolved,
          kind: 'participant',
          periods: [],
          allowHistoryBackread: false,
        },
      ],
    };
  }

  /**
   * 从 `conversationHistory` **增量**摄入新轮次（幂等）。
   *
   * 🔴 应在 `syncParticipants()` 之前调用 —— 因为首次 enter 需要用到这里的
   *    `_meetingStartTs`（会晤起点）。
   *
   * @param history    对话历史（只读）
   * @param startIndex 会晤起始下标（meetingStartHistoryIndex）—— 之前的一律不摄入
   */
  syncFromHistory(history: readonly HistoryTurnLike[], startIndex = 0): void {
    if (history.length < this._ingestedIndex) {
      console.warn(
        `[SpaceAdapter] conversationHistory 被截断（${this._ingestedIndex} → ${history.length}），重建 SpaceState；任期信息随之丢失`,
      );
      this._state = createEmptySpace(this._state.spaceId);
      this._ingestedIndex = 0;
      this._meetingStartTs = null;
      this._initialSynced = false;
      this._diagnostics.push('history_truncated_rebuild');
    }

    const from = Math.max(this._ingestedIndex, Math.min(startIndex, history.length));

    // 🔴 记录会晤起点 —— 从**被摄入区间内任一**合法时间戳推导（2026-10-30 根治）。
    //   缺陷：原实现只看**第一行**。首行恰好缺时间戳 / 值损坏时，`_meetingStartTs` 永久为 null
    //     ⇒ 首次 syncParticipants 的 anchorTs 为 null
    //     ⇒ 入场被锚到 `_ts()` = 当前最大 ts + 1，即**在全部历史之后**
    //     ⇒ 会晤里所有人「入场」晚于全部历史 ⇒ 按任期过滤后 turnsFor 一条不剩
    //     ⇒ 真机现象：[SpaceView] 历史=0条 而 事件=173、席位=5(在场1)（极具迷惑性）。
    //   判据方向：**宁可多看，不可全盲** —— 区间内全都没有合法时间戳时退化为 0（可见全量），
    //   绝不能退化成「全部不可见」。窗口边界本就由 startIndex 收紧，放宽锚点不会造成越权可见。
    if (this._meetingStartTs === null) {
      for (let i = from; i < history.length; i++) {
        const t = history[i]?.timestamp ? Date.parse(history[i].timestamp as string) : NaN;
        if (Number.isFinite(t)) {
          this._meetingStartTs = t;
          break;
        }
      }
      if (this._meetingStartTs === null && from < history.length) this._meetingStartTs = 0;
    }

    for (let i = from; i < history.length; i++) {
      const t = history[i];
      const text = (t?.content ?? '').trim();
      if (!text) continue;

      // 🔴 用历史自带时间戳还原真实先后；缺失时退化为单调递增并留诊断
      const parsed = t.timestamp ? Date.parse(t.timestamp) : NaN;
      const ts = Number.isFinite(parsed) ? parsed : this._lastTs + 1;
      if (!Number.isFinite(parsed)) this._diagnostics.push(`history_ts_missing:index=${i}`);

      if (t.role === 'user') {
        // 🔴 2026-10-31：带 whisperToUuid 的历史轮还原成耳语（只目标可闻）
        const r = route(this._state, { kind: 'user_say', text, ts, whisperTo: t.whisperToUuid });
        this._state = r.nextState;
        if (r.out.warnings.length > 0) this._diagnostics.push(...r.out.warnings);
        this._lastTs = Math.max(this._lastTs, r.nextState.lastTs);
      } else if (t.role === 'assistant' && t.belongEntityUuid) {
        // 🔴 归属即说话人：assistant 轮的 belongEntityUuid 由 persistence-stage 写入 asstUUID
        this._register(t.belongEntityUuid, this._nameOf.get(t.belongEntityUuid) ?? t.belongEntityUuid);
        const r = route(this._state, {
          kind: 'agent_say',
          uuid: t.belongEntityUuid,
          text,
          ts,
        });
        this._state = r.nextState;
        if (r.out.warnings.length > 0) this._diagnostics.push(...r.out.warnings);
        this._lastTs = Math.max(this._lastTs, r.nextState.lastTs);
      } else if (t.role === 'assistant') {
        // 归属未知 ⇒ **不猜**（户籍管理法第五条 fail-closed）
        this._diagnostics.push(`history_assistant_unowned:index=${i}`);
      }
    }
    this._ingestedIndex = history.length;
  }

  /**
   * 与会晤参与者对齐：新出现的 → enter，消失的 → leave。
   *
   * 🔴 走 `internal_seat_op` 机器通道，**不经 parseCommand** ——
   *    UUID 不是自然语言，拼进 `command.raw` 会依赖「UUID 恰好不含命令关键词」的脆弱假设。
   * 🔴 只发命令、不直接改 seats —— 任期只能由内核维护（唯一写入口）。
   * 🔴 **首次同步**用 `_meetingStartTs` 作为 enter 时间戳（见文件头时序铁律），
   *    否则会晤内历史会全部落在任期之前、人物彻底失忆。
   */
  syncParticipants(participants: readonly ParticipantLike[]): void {
    const want = new Map<string, string>();
    for (const p of participants) {
      if (!p || !p.uuid) continue;
      want.set(p.uuid, p.name || p.uuid);
      this._register(p.uuid, p.name || p.uuid);
    }

    const onStage = new Set<string>();
    for (const s of this._state.seats) {
      if (s.periods.some((p) => p.leftAt === undefined)) onStage.add(s.uuid);
    }

    const anchorTs = !this._initialSynced ? this._meetingStartTs : null;

    for (const uuid of want.keys()) {
      if (onStage.has(uuid)) continue;
      if (anchorTs !== null) {
        this._applyInitialEnter({ kind: 'internal_seat_op', op: 'enter', targetUuid: uuid, ts: anchorTs });
      } else {
        this._apply({ kind: 'internal_seat_op', op: 'enter', targetUuid: uuid, ts: this._ts() });
      }
    }
    for (const uuid of onStage) {
      if (!want.has(uuid)) {
        this._apply({ kind: 'internal_seat_op', op: 'leave', targetUuid: uuid, ts: this._ts() });
      }
    }

    this._initialSynced = true;
  }

  /** 记录一条业主发言（实时事件）；whisperTo 有值时该条仅目标可闻 */
  recordUserSay(text: string, whisperTo?: string): void {
    if (!text) return;
    this._apply({ kind: 'user_say', text, ts: this._ts(), whisperTo });
  }

  /** 记录一条角色发言（实时事件） */
  recordAgentSay(uuid: string, text: string): void {
    if (!uuid || !text) return;
    if (!this._knownUuids.has(uuid)) {
      this._diagnostics.push(`agent_say_unknown_uuid:${uuid}`);
      return;
    }
    this._apply({ kind: 'agent_say', uuid, text, ts: this._ts() });
  }

  /**
   * 该席位此刻能读到的对话（按 canPerceive 过滤），并附带**真实说话人名**。
   *
   * @param uuid        发言人席位（会晤实体 UUID）
   * @param pendingText 本轮尚未落库的业主消息 —— 以**临时叠加**方式参与计算，
   *                    不写入内部状态、不推进 `_lastTs`，避免下一轮历史摄入时重复。
   *                    仅当调用方需要「本轮消息也出现在上下文窗口里」时传入。
   */
  turnsFor(
    uuid: string,
    pendingText?: string,
    opts?: { limit?: number },
  ): SpeakerTurn[] {
    let st = this._state;
    if (pendingText) {
      const probe = route(st, { kind: 'user_say', text: pendingText, ts: this._lastTs + 1 });
      st = probe.nextState;
      if (probe.out.warnings.length > 0) this._diagnostics.push(...probe.out.warnings);
    }

    // 🔴 2026-10-31 性能重构：只求**该席位**的视图。
    //   旧实现 `buildViews(st, st.events).get(uuid)` 会把全部席位都算一遍，
    //   5 席位时白算 4/5 —— 实测占单请求开销 87%。
    const view = buildViewFor(st, uuid);
    if (!view) return [];

    // 🔴 limit：只要尾部 N 条时，从数组**尾部反向**扫描、够数即停。
    //   `process-stages.ts` 的 `.slice(-2)` 走这条路径（原来要先构造全量再截断）。
    //   非法值（≤0 / NaN / 非有限）⇒ 退回全量，语义与旧实现一致。
    const raw = opts?.limit;
    const limit = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

    // 🔴 统一收集成 `{turn, ts}` 行：排序键用**事件自带的数值 ts**。
    //   旧实现用 `Date.parse(a.timestamp)` 做比较器 —— 2000 条要解析两万次时间字符串，
    //   实测占 turnsFor 总开销 65%，而 `timestamp` 本身此刻还没被任何人读到。
    const rows: Array<{ t: SpeakerTurn; ts: number }> = [];

    if (limit > 0) {
      // 合并后的尾部 N 条，必然落在两个数组各自的尾部 N 条之内 ⇒ 各自反向取 N 条即可
      for (let i = view.readable.length - 1; i >= 0 && rows.length < limit; i--) {
        const e = view.readable[i];
        if (e.kind !== 'say' && e.kind !== 'whisper') continue;
        if (e.privateContent == null) continue;
        rows.push({ t: this._toTurn(e), ts: e.ts });
      }
      for (let i = view.metaOnly.length - 1; i >= 0 && rows.length < limit; i--) {
        const e = view.metaOnly[i];
        const t = this._toWhisperPlaceholder(e);
        if (t) rows.push({ t, ts: e.ts });
      }
      rows.sort((a, b) => a.ts - b.ts);
      return rows.slice(-limit).map((r) => r.t);
    }

    for (const e of view.readable) {
      if (e.kind !== 'say' && e.kind !== 'whisper') continue;
      if (e.privateContent == null) continue;
      rows.push({ t: this._toTurn(e), ts: e.ts });
    }
    // 🔴 2026-10-31 耳语「看得见、听不到」：读不到正文、但确实发生过的耳语，
    //   给该席位一条**占位轮**——知道"有人在耳语"，不知道说了什么。
    //   业主裁决：「耳语选择看得见，但听不到」。
    for (const e of view.metaOnly) {
      const t = this._toWhisperPlaceholder(e);
      if (t) rows.push({ t, ts: e.ts });
    }

    // 🔴 事件按 ts 递增追加 ⇒ **绝大多数情况本就有序**。先做 O(n) 检测，有序即跳过排序。
    //   ⚠️ 不能无条件假设有序：乱序 flow 会被追加到尾部（已实测 `enter@1000 → say@2000 →
    //   system@1500 → say@1500`），那时必须真正排序。检测到逆序才 sort，因此两种输入都正确。
    let ordered = true;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].ts > rows[i].ts) { ordered = false; break; }
    }
    if (!ordered) rows.sort((a, b) => a.ts - b.ts);
    return rows.map((r) => r.t);
  }

  /** 耳语占位轮（「听得见、听不清」）—— 全量路径与尾部路径共用，避免口径漂移 */
  private _toWhisperPlaceholder(e: SpaceEvent): SpeakerTurn | null {
    const meta = e.publicMeta as Record<string, unknown> | null;
    if (!meta || meta.type !== 'whisper') return null;
    return {
      role: 'user',
      content: '（鸿艺压低声音，跟人耳语了几句——你没听清）',
      timestamp: new Date(e.ts).toISOString(),
      speakerName: this._ownerName,
      isWhisper: true,
    };
  }

  private _toTurn(e: SpaceEvent): SpeakerTurn {
    const isUser = e.actorUuid === null;
    const speakerUuid = isUser ? undefined : (e.actorUuid ?? undefined);
    // 🔴 2026-10-31：timestamp 改惰性。构造 2000 条时每条都 `new Date().toISOString()`
    //   实测占 turnsFor 总开销 38%，而排序/过滤根本不需要它 —— 只有真正渲染时才读。
    //   首次读取后缓存，同一对象不会重复格式化。
    let _tsStr: string | undefined;
    return {
      role: isUser ? 'user' : 'assistant',
      content: e.privateContent ?? '',
      get timestamp(): string {
        return (_tsStr ??= new Date(e.ts).toISOString());
      },
      speakerUuid,
      // ⚠️ 旧管线兼容：user 轮**不**绑定实体（旧实现绑当前会晤实体，属二义）
      legacyBelongEntityUuid: speakerUuid,
      speakerName: isUser ? this._ownerName : (speakerUuid ? this._nameOf.get(speakerUuid) ?? speakerUuid : undefined),
      isWhisper: e.audience.kind === 'seat',
    };
  }

  /**
   * 导出诊断快照，并在导出时校验内核不变量。
   *
   * 🔴 刻意**不**在每次 `_apply` 后校验：`buildViews` 是 O(席位×事件) 全量扫描，
   *    一轮会调用多次，长会晤下会把整体拖成 O(n²)。校验只在需要留证的时刻跑。
   *
   * @throws 任期不变量被破坏时抛出（宁可炸在导出，也不静默污染）
   */
  exportSnapshot(): SpaceSnapshot {
    this._assertTenureInvariants();
    return {
      spaceId: this._state.spaceId,
      ingestedIndex: this._ingestedIndex,
      lastTs: this._lastTs,
      seats: this._state.seats.map((s) => ({ ...s, periods: s.periods.map((p) => ({ ...p })) })),
      eventCount: this._state.events.length,
      diagnostics: this._diagnostics.slice(),
      routeStats: {
        count: this._routeStats.count,
        totalMs: Math.round(this._routeStats.totalMs * 100) / 100,
        maxMs: Math.round(this._routeStats.maxMs * 100) / 100,
        slowCount: this._routeStats.slowCount,
      },
    };
  }

  /** 任期不变量：每段 leftAt > enteredAt；各段按时间升序且互不重叠 */
  private _assertTenureInvariants(): void {
    for (const s of this._state.seats) {
      let prevEnd = -Infinity;
      for (const p of s.periods) {
        if (p.leftAt !== undefined && p.leftAt <= p.enteredAt) {
          throw new Error(`[SpaceAdapter] 任期非法: uuid=${s.uuid} enteredAt=${p.enteredAt} leftAt=${p.leftAt}`);
        }
        if (p.enteredAt < prevEnd) {
          throw new Error(`[SpaceAdapter] 任期乱序/重叠: uuid=${s.uuid} enteredAt=${p.enteredAt} < prevEnd=${prevEnd}`);
        }
        prevEnd = p.leftAt ?? Infinity;
      }
    }
  }
}