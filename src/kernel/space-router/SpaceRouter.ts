/**
 * 空间路由器 · 内核
 * ============================================================
 * **可独立插拔的信息流路由器**。纯函数、零依赖、零 IO、零 LLM。
 *
 * 【两条关系 + 一条外部真源】（2026-10-30 第二层）
 *   audience —— 谁听得见      → 视图过滤（本内核负责）
 *   address  —— 冲着谁说的    → 提示词身份（本内核负责）
 *   focus    —— 下一句谁答    → 🔴 **不归本内核**，唯一真源是 GroupSession.speakerUuid
 *             （内核原有一整套 focus/令牌模型，全仓消费者为 0，已删除）
 *
 * 【唯一公理】
 *   canPerceive(seat, event) : 任期命中 且 audience 包含该席位
 *   所有可见性行为都是它的推论 —— 不允许任何绕过它的特例。
 *
 * 【系统里没有例外】
 *   无默认发言人；玉瑶与其他席位同权；空间空 = 业主独处，无人应答。
 *
 * 【纯函数承诺】
 *   route() 不修改入参 state（返回全新对象）；不读时钟；不调外部。
 *   相同 (state, flow) 必然得到相同结果 ⇒ 回放可精确复现。
 */
import {
  type Address,
  type Audience,
  type ContextView,
  type Flow,
  type RouteOutput,
  type Seat,
  type SpaceEvent,
  type SpaceEventKind,
  type SpaceState,
  isOnStage,
} from './types.js';

// ══════════════════════════════════════════════════════════════════
// 一、公理层（唯一的权限判定）
// ══════════════════════════════════════════════════════════════════

/**
 * 事件是否落在该席位的**任期内**（不看 audience）。
 *
 * 🔴 **刻意不读取 `allowHistoryBackread`**（2026-10-29 实测反例留档）：
 *    若写成「allowHistoryBackread 为真时 afterEnter 恒真」，则
 *    periods=[{10,20},{30,40}]、allowHistoryBackread=true、event.ts=25 时——
 *    第 1 段 beforeLeave 为 false，第 2 段 afterEnter 被强行置真且 25<40 成立
 *    ⇒ 返回 true，把「两段任期之间的空白」放进来了。
 */
export function isInTenure(seat: Seat, event: SpaceEvent): boolean {
  return isTsInTenure(seat, event.ts);
}

/**
 * 同一任期判定的**时间戳版本** —— 供「事件尚未生成、但需要预判能否听见」的场景使用
 * （典型：耳语发出前判断目标此刻是否在场）。
 *
 * 🔴 与 `isInTenure` 共用一份区间判定，不允许各写一遍 —— 区间口径漂移即越权。
 */
function isTsInTenure(seat: Seat, ts: number): boolean {
  return seat.periods.some(
    (p) => ts >= p.enteredAt && (p.leftAt === undefined || ts < p.leftAt),
  );
}

/** audience 是否覆盖该席位（room = 全场；seat = 仅目标） */
export function audienceIncludes(audience: Audience, uuid: string): boolean {
  return audience.kind === 'room' || audience.uuid === uuid;
}

/** 🔴 **唯一公理**：能否读取事件的正文。 */
export function canPerceive(seat: Seat, event: SpaceEvent): boolean {
  return isInTenure(seat, event) && audienceIncludes(event.audience, seat.uuid);
}

/** 事件是否**冲着**该席位说 */
export function isAddressedTo(event: SpaceEvent, uuid: string): boolean {
  const a = event.address;
  return !!a && a.kind === 'seat' && a.uuid === uuid;
}

// ══════════════════════════════════════════════════════════════════
// 二、基础工具（全部纯函数，无副作用）
// ══════════════════════════════════════════════════════════════════

/** 确定性事件 id（不用随机数，保证纯函数可回放） */
function eventId(state: SpaceState, kind: SpaceEventKind, ts: number): string {
  return `${kind}:${ts}:${state.events.length}`;
}

function makeEvent(
  state: SpaceState,
  kind: SpaceEventKind,
  ts: number,
  actorUuid: string | null,
  audience: Audience,
  privateContent: string | null,
  publicMeta: Record<string, unknown> | null = null,
  address: Address = { kind: 'room' },
): SpaceEvent {
  return {
    id: eventId(state, kind, ts),
    spaceId: state.spaceId,
    ts,
    kind,
    actorUuid,
    audience,
    address,
    publicMeta,
    privateContent,
  };
}

/** 按显示名或 uuid 找席位（公共 API） */
export function findSeat(state: SpaceState, key: string): Seat | undefined {
  return state.seats.find((s) => s.displayName === key || s.uuid === key);
}

/** 内部：在给定席位数组里查找 */
function findIn(seats: Seat[], key: string): Seat | undefined {
  return seats.find((s) => s.displayName === key || s.uuid === key);
}

/**
 * 🔴 **识别「这句话冲着谁说」**（2026-10-29 新增）。
 *
 * 只匹配**本空间已登记席位**的 displayName —— 不做 FG 查询，保持零依赖。
 * 判定条件（避免把叙述误当成指名）：名字之后必须紧跟称呼标点，或直接跟「你」。
 *
 *   ✅ 「阿珍，别忘了带那个」   → 阿珍 + '，'
 *   ✅ 「诗雨你呢」             → 诗雨 + '你'
 *   ❌ 「诗雨走后悄悄说的话」   → 诗雨 + '走'  ⇒ 不判定为指名
 *
 * 取最长匹配（「阿珍姐」优先于「阿珍」）。
 */
function detectAddressee(seats: Seat[], text: string): Seat | null {
  const t = String(text || '').trim().replace(/^@/, '');
  if (!t) return null;
  const named = seats
    .filter((s) => !!s.displayName)
    .sort((a, b) => (b.displayName!.length - a.displayName!.length));
  for (const s of named) {
    const n = s.displayName!;
    if (!t.startsWith(n)) continue;
    const rest = t.slice(n.length);
    if (/^\s*[，,、:：]/.test(rest) || rest.startsWith('你')) return s;
  }
  return null;
}

/** 关闭该席位当前开放的任期，返回新 Seat（无开放任期时原样返回） */
function closeOpenPeriod(seat: Seat, ts: number): Seat {
  return {
    ...seat,
    periods: seat.periods.map((p) => (p.leftAt === undefined ? { ...p, leftAt: ts } : p)),
  };
}

/** 确保某席位在场：不在场则开一段任期（R1 指名即入场）。返回新数组。 */
function ensureOnStage(seats: Seat[], uuid: string, ts: number): Seat[] {
  return seats.map((s) => {
    if (s.uuid !== uuid || isOnStage(s)) return s;
    return { ...s, periods: [...s.periods, { enteredAt: ts }] };
  });
}

// ══════════════════════════════════════════════════════════════════
// 四、视图派生层（纯只读，不产生任何状态变更）
// ══════════════════════════════════════════════════════════════════

/**
 * 构建每个席位各自的感知视图。
 *
 * · readable  —— 任期内 且 audience 覆盖 ⇒ 完整事件（含正文）
 * · metaOnly  —— 任期内 但 audience 不含 ⇒ privateContent 强制置 null
 * · addressed —— readable 中**指向本席位**的事件（「这话是给我的」）
 *
 * 🔴 覆盖面 = **有过任期**的席位（不是「当前在场」）：离场者仍需一份
 *    「他当时知道什么」的视图，否则「离场后不可感知」会退化成同义反复。
 * ⚠️ 是否为其发起一次生成，由上层按 isOnStage 判定。
 */
export function buildViews(
  state: SpaceState,
  events: readonly SpaceEvent[],
): Map<string, ContextView> {
  const views = new Map<string, ContextView>();
  for (const seat of state.seats) {
    // 从未入场 ⇒ 没有视图（与 buildViewFor 的 null 语义一致）
    if (seat.periods.length === 0) continue;
    views.set(seat.uuid, partitionForSeat(seat, events));
  }
  return views;
}

/**
 * 单个席位的视图 —— 与 `buildViews().get(uuid)` **逐字段等价**，但只扫一遍事件。
 *
 * 🔴 为什么需要它（2026-10-31 性能重构）：
 *   `turnsFor()` 只需要**一个**席位的视图，旧实现却调用 `buildViews()` 把全部席位
 *   都算一遍 —— 5 席位时会白算 4/5。实测这是会话内每请求的主要开销（占 87%）。
 *
 * @returns 席位不存在、或从未入场（periods 为空）⇒ `null`（fail-closed，不猜）
 */
export function buildViewFor(state: SpaceState, uuid: string): ContextView | null {
  const seat = state.seats.find((s) => s.uuid === uuid);
  if (!seat || seat.periods.length === 0) return null;
  return partitionForSeat(seat, state.events);
}

/**
 * 视图分区的唯一实现（buildViews 与 buildViewFor 共用）。
 *
 * 🔴 单点实现是刻意的：两条路径若各写一遍，判定口径迟早漂移 ——
 *   而「谁能读到什么」正是本模块的核心不变量，漂移即越权。
 */
function partitionForSeat(seat: Seat, events: readonly SpaceEvent[]): ContextView {
  const readable: SpaceEvent[] = [];
  const metaOnly: SpaceEvent[] = [];
  const addressed: SpaceEvent[] = [];
  for (const e of events) {
    if (!isInTenure(seat, e)) continue;
    if (canPerceive(seat, e)) {
      readable.push(e);
      if (isAddressedTo(e, seat.uuid)) addressed.push(e);
    } else if (e.publicMeta) {
      // 🔴 P138 第三缺口修复（2026-11-01）：事件正文在 `text` 字段（types: user_say/agent_say.text），
      //   原占位只置空 privateContent、spread 保留 text ⇒ 非目标席位仍读到耳语正文（测试②实证）。
      //   占位语义不变（看得见、听不到）：只抹正文，其余元数据（ts/audience/publicMeta）原样保留。
      metaOnly.push({ ...e, privateContent: null, ...('text' in e ? { text: '' } : {}) } as (typeof metaOnly)[number]);
    }
  }
  return { seatUuid: seat.uuid, readable, metaOnly, addressed };
}

// ══════════════════════════════════════════════════════════════════
// 五、席位演化层（四条指令 = 四个纯变换）
// ══════════════════════════════════════════════════════════════════

interface SeatEvolution {
  seats: Seat[];
  events: SpaceEvent[];
  warnings: string[];
}

function notFound(state: SpaceState, seats: Seat[], name: string, ts: number): SeatEvolution {
  const w = `command_target_not_found: ${name}`;
  return {
    seats,
    events: [
      makeEvent(state, 'system', ts, null, { kind: 'room' }, null, {
        type: 'command_failed',
        detail: w,
      }),
    ],
    warnings: [w],
  };
}

function evolveEnter(
  state: SpaceState,
  seats: Seat[],
  name: string,
  asAuditor: boolean,
  ts: number,
): SeatEvolution {
  const target = findIn(seats, name);
  if (!target) return notFound(state, seats, name, ts);

  const nextSeats = seats.map((s) => {
    if (s.uuid !== target.uuid) return s;
    const periods = [...s.periods];
    const updated: Seat = { ...s, kind: asAuditor ? 'auditor' : s.kind, periods };
    if (!isOnStage(updated)) periods.push({ enteredAt: ts });
    return updated;
  });

  const now = nextSeats.find((s) => s.uuid === target.uuid)!;
  return {
    seats: nextSeats,
    events: [
      makeEvent(state, 'enter', ts, target.uuid, { kind: 'room' }, null, {
        type: 'enter',
        uuid: target.uuid,
        asAuditor,
      }),
    ],
    warnings: [],
  };
}

function evolveLeave(
  state: SpaceState,
  seats: Seat[],
  name: string,
  ts: number,
): SeatEvolution {
  const target = findIn(seats, name);
  if (!target) return notFound(state, seats, name, ts);

  const nextSeats = seats.map((s) => (s.uuid !== target.uuid ? s : closeOpenPeriod(s, ts)));
  return {
    seats: nextSeats,
    events: [
      makeEvent(state, 'leave', ts, target.uuid, { kind: 'room' }, null, {
        type: 'leave',
        uuid: target.uuid,
      }),
    ],
    warnings: [],
  };
}


// ══════════════════════════════════════════════════════════════════
// 六、主入口
// ══════════════════════════════════════════════════════════════════

export interface RouteResult {
  nextState: SpaceState;
  out: RouteOutput;
}

/**
 * 路由一条信息流。
 *
 * 🔴 纯函数：不修改入参，不读时钟，不调外部。
 * 🔴 乱序（flow.ts < state.lastTs）**不纠错**，但要**可观测**。
 * 🔴 `out.tokens` 与 `pendingTokens` 的增量**严格同源**，都是本轮新发放。
 */
export function route(state: SpaceState, flow: Flow): RouteResult {
  const warnings: string[] = [];
  const appended: SpaceEvent[] = [];
  let seats: Seat[] = state.seats;
  let audience: Audience = { kind: 'room' };
  let address: Address = { kind: 'room' };
  // 🔴 2026-10-30 第二层：发言权（focus）与令牌模型已从内核删除 —— 全仓消费者为 0，
  //   唯一真源改为 GroupSession.speakerUuid。内核现在只负责「谁听得见 + 指向谁」。

  // ── 乱序检测（不纠错，但可见）──
  if (state.lastTs > 0 && flow.ts < state.lastTs) {
    const w = `ts_out_of_order: flow.ts=${flow.ts} < lastTs=${state.lastTs}`;
    warnings.push(w);
    appended.push(
      makeEvent(state, 'system', flow.ts, null, { kind: 'room' }, null, {
        type: 'ts_out_of_order',
        detail: w,
      }),
    );
  }

  switch (flow.kind) {
    // ══════════ 业主说话 ══════════
    case 'user_say': {
      // 🔴 2026-10-31 耳语：显式给 whisperTo 时，听觉范围收窄到该席位。
      // 🔴 P138 第三缺口根治（2026-11-01）：audience **永不因目标未登记而放宽为 room** ——
      //   历史摄入先于席位登记（syncFromHistory → syncParticipants），旧判据 seats.some() 恒 false
      //   ⇒ 耳语降级 room 全场可闻（正文泄漏主源头，测试②实证）。未登记目标 ⇒ audience=seat(未登记)
      //   = 无人可读，与「宁可无人可读，不可全场可闻」一致；目标后续登记后 enter 锚会晤起点 ⇒
      //   任期覆盖仍可读到自己的历史耳语（readable 恢复）。_whisperTo（已登记校验）仍用于 address/警告。
      const _whisperTo =
        flow.whisperTo && seats.some((s) => s.uuid === flow.whisperTo) ? flow.whisperTo : null;
      audience = flow.whisperTo ? { kind: 'seat', uuid: flow.whisperTo } : { kind: 'room' };
      if (flow.whisperTo && !_whisperTo) {
        warnings.push(`whisper_target_unregistered:${flow.whisperTo}`);
      }
      // 🔴 2026-10-31 分流可观测性：目标**已登记但不在任期**时，audience={seat} 意味着
      //   没有任何席位能命中 canPerceive ⇒ 这条正文谁都读不到，且此前**不留任何痕迹**。
      //   这里不改 audience（降级为 room 会把业主以为的悄悄话变成全场可闻，属隐私泄漏），
      //   只把「这条消息无人可读」变成可观测事实，由上层日志/诊断发现。
      if (_whisperTo) {
        const _target = seats.find((s) => s.uuid === _whisperTo);
        if (!_target || !isTsInTenure(_target, flow.ts)) {
          warnings.push(`whisper_target_offscreen:${_whisperTo}`);
        }
      }
      // 🔴 指向判定（R1/R2）：句首指名 → 指向她、若不在场则入场、由她作答
      const addressee = detectAddressee(seats, flow.text);
      if (_whisperTo) {
        address = { kind: 'seat', uuid: _whisperTo };
      } else if (addressee) {
        address = { kind: 'seat', uuid: addressee.uuid };
        // 句首称呼 = 明确召唤 ⇒ 不在场者入场（句中顺带提及不算，见 chat.ts 的 P0 判据）
        seats = ensureOnStage(seats, addressee.uuid, flow.ts);
      } else {
        address = { kind: 'room' };
      }

      appended.push(
        makeEvent(
          state,
          'say',
          flow.ts,
          null,
          audience,
          flow.text,
          // 🔴 耳语时 publicMeta 记录「谁对谁耳语」，其余席位据此渲染占位（看得见、听不到）
          _whisperTo
            ? { type: 'whisper', from: 'owner', to: _whisperTo }
            : { type: 'say', from: 'owner' },
          address,
        ),
      );
      break;
    }

    // ══════════ 角色说话 ══════════
    case 'agent_say': {
      audience = { kind: 'room' };
      address = { kind: 'room' };
      appended.push(
        makeEvent(state, 'say', flow.ts, flow.uuid, audience, flow.text, {
          type: 'say',
          from: flow.uuid,
        }),
      );
      break;
    }

    // ══════════ 控制指令（人类自然语言）══════════
    case 'internal_seat_op': {
      const res =
        flow.op === 'enter'
          ? evolveEnter(state, seats, flow.targetUuid, false, flow.ts)
          : evolveLeave(state, seats, flow.targetUuid, flow.ts);
      seats = res.seats;
      appended.push(...res.events);
      warnings.push(...res.warnings);
      break;
    }

    // ══════════ 系统事件 ══════════
    case 'system': {
      appended.push(
        makeEvent(state, 'system', flow.ts, null, { kind: 'room' }, null, {
          type: flow.event,
          detail: flow.detail ?? null,
        }),
      );
      break;
    }
  }

  // ── 组装 nextState（全新对象，绝不改入参）──
  const allEvents = [...state.events, ...appended];
  const nextState: SpaceState = {
    spaceId: state.spaceId,
    seats,
    events: allEvents,
    lastTs: Math.max(state.lastTs, flow.ts),
  };

  // 🔴 2026-10-31 性能重构：views 改为**惰性求值**。
  //   旧实现每次 route 都无条件跑一遍 buildViews（O(席位×事件)），实测占 route 耗时
  //   64~72%，而生产链路**零消费者**（只有测试读 out.views）。
  //   getter 保持接口不变（`out.views.get(...)` / `.size` 用法完全兼容），
  //   计算推迟到首次访问，且结果缓存 —— 同一次输出内反复访问不会重算。
  let _viewsCache: Map<string, ContextView> | null = null;
  const out: RouteOutput = {
    audience,
    address,
    appended,
    warnings,
    get views(): Map<string, ContextView> {
      if (_viewsCache === null) _viewsCache = buildViews(nextState, allEvents);
      return _viewsCache;
    },
  };

  return { nextState, out };
}