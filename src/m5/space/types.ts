/**
 * 空间路由器 · 类型契约
 * ============================================================
 * 定位：**可独立插拔的信息流路由器内核**。零依赖、零 IO、零 LLM。
 *
 * 【三条关系 —— 互相独立，不可混用】（2026-10-29 重构核心）
 *   audience —— 这条事件**谁听得见**      → 决定视图过滤（谁知道什么）
 *   address  —— 这条事件**冲着谁说的**    → 决定提示词身份（这话是给谁的）
 *   focus    —— **下一句谁答**            → 决定谁生成回复
 *
 *   只做 audience 时，系统能回答「她知道什么」，但回答不了
 *   「这话是不是对她说的」——这正是「阿珍在场却说不记得」的根因。
 *
 * 【唯一公理】
 *   canPerceive(seat, event) :=
 *     ∃ period ∈ seat.periods :
 *         event.ts >= period.enteredAt
 *      && (period.leftAt === undefined || event.ts < period.leftAt)
 *      && audienceIncludes(event.audience, seat.uuid)
 *
 *   推论：
 *     · 走了看不到后来的  → 任期上界
 *     · 新人看不到历史    → 任期下界
 *     · 耳语只有目标可见  → audience
 *     · 空空间无人应答    → seats 全不在场 ⇒ focus 为 null
 *     · 多次进出 = 多段独立任期（中间空白永远不可见）
 *
 * 【系统里没有例外】（业主 2026-10-29 明确）
 *   无默认发言人；玉瑶与其他席位完全同权，可被叫来、可被叫走；
 *   空间空 = 业主独处，可以自言自语，没有人应答。
 *
 * 【纯函数不变性 —— 必读】
 *   🔴 外部**禁止**直接修改 `SpaceState`。所有状态变更**只能**通过
 *      `route(state, flow) => nextState` 的返回值推进。
 *   🔴 存储适配器**只负责** serialize / deserialize，**不做任何业务修改**。
 *   🔴 回放 / 审计 = 按时序依次喂 flow，逐步复现 nextState —— 天然可复现。
 *
 * 【零依赖边界】
 *   本目录（types / SpaceRouter / __tests__）是**内核**，不 import 任何项目内模块、
 *   不碰数据库、不调 LLM。存储、LLM、前端、A/B 记忆链路的适配器全部放在本目录之外。
 */

// ══════════════════════════════════════════════════════════════════
// 一、入端口：四种信息流
// ══════════════════════════════════════════════════════════════════

/**
 * 流入路由器的信号。
 *
 * 🔴 **ts 必须单调递增**（由调用方/适配器保证）：
 *    Router 不做时钟校正、不重排事件。若检测到倒退，会产出
 *    `ts_out_of_order` 告警事件（**不纠错 ≠ 不可见**），但仍按给定 ts 计算。
 */
export type Flow =
  /**
   * 业主/用户说话。
   *
   * 🔴 2026-10-31 新增 `whisperTo`：耳语的**唯一生产者入口**。
   *   此前内核有 `audience: { kind:'seat' }` 分支与耳语测试，但**上层从不产生这类事件**，
   *   实机 `audience` 恒为 room ⇒ 耳语形同不存在。
   *   给了 `whisperTo` 后：该条 say 的 audience 收窄到目标席位，
   *   其余在场席位只能看到一条 `publicMeta`（知道"有人耳语了几句"，读不到正文）。
   *   缺省 = 全场可闻，与既有行为逐字一致。
   */
  | { kind: 'user_say'; text: string; ts: number; whisperTo?: string }
  /** 某个角色说话（LLM 产出后回流，用于记账 + 视图更新） */
  | { kind: 'agent_say'; uuid: string; text: string; ts: number }
  /**
   * 🔴 **机器指令通道**（2026-10-29）：适配器自动同步席位时使用。
   *
   *    与 `command` **刻意分道**：`command.raw` 的语义是人类自然语言文本，
   *    把 UUID 拼进 raw（如 `"${uuid}过来"`）会依赖「UUID 恰好不含
   *    `过来/走了/留下` 等命令关键词」这一脆弱假设——将来命令正则一旦放宽
   *    （例如加一条兜底捕获），机器指令就会被误解析。
   *
   *    本分支**不经 parseCommand**，由 route() 顶层直接分流到席位演化，
   *    两条通道互不污染。`targetUuid` 必须已由调用方解析为 UUID（内核不查 FG）。
   */
  | { kind: 'internal_seat_op'; op: 'enter' | 'leave'; targetUuid: string; ts: number }
  /** 系统事件（含解析失败、时序告警等） */
  | { kind: 'system'; event: string; detail?: string; ts: number };

// ══════════════════════════════════════════════════════════════════
// 二、听觉范围 与 指向
// ══════════════════════════════════════════════════════════════════

/**
 * 一条事件的**听觉范围**（谁听得见）。
 * 🔴 `room` **不代表"永远所有人可见"** —— 仍受各席位任期约束。
 */
export type Audience =
  /** 全场（所有任期内席位可听） */
  | { kind: 'room' }
  /** 耳语：仅目标席位可听正文；其余任期内席位只能看到 publicMeta */
  | { kind: 'seat'; uuid: string };

/**
 * 一条事件的**指向**（这句话冲着谁说的）。
 *
 * 🔴 与 `audience` 是**两个不同的问题**，不可合并：
 *    对阿珍说「今晚带电话」，audience=room（大家都听见了），
 *    address=阿珍（这话是给阿珍的）。
 *    只记 audience 时，阿珍无法区分「这话是给我的」与「我只是在旁边听见」。
 */
export type Address =
  /** 没对着特定的人说 */
  | { kind: 'room' }
  /** 指名对着某人说 */
  | { kind: 'seat'; uuid: string };

// ══════════════════════════════════════════════════════════════════
// 三、席位与任期
// ══════════════════════════════════════════════════════════════════

/** participant 可获发言令牌；auditor 可见对话但**永远拿不到令牌** */
export type SeatKind = 'participant' | 'auditor';

/**
 * 一段任期。
 * 🔴 同一 uuid 可以有**多段**任期（多次进出），每段相互独立 ——
 *    两段之间的空白，**永久不可见**，除非有人转述（转述本身是一条新事件）。
 */
export interface SeatPeriod {
  enteredAt: number;
  /** undefined = 仍在场 */
  leftAt?: number;
}

/** 席位 */
export interface Seat {
  uuid: string;
  /** 显示名（供控制指令与指名匹配；内核不查 FG，由适配器在入场时提供） */
  displayName?: string;
  kind: SeatKind;
  /** 多段任期，按时间升序 */
  periods: SeatPeriod[];
  /**
   * 是否允许回看**入场前**的历史（默认 false）。
   * 🔴 默认 false 是产品决定：走了再回来，不该自动知道离开期间的事。
   *    置 true 只能由「有人转述/授权」类动作显式发起。
   */
  allowHistoryBackread: boolean;
}

/** 席位当前是否在场（存在一段 leftAt === undefined 的任期） */
export function isOnStage(seat: Seat): boolean {
  return seat.periods.some((p) => p.leftAt === undefined);
}

// ══════════════════════════════════════════════════════════════════
// 四、事件
// ══════════════════════════════════════════════════════════════════

export type SpaceEventKind = 'say' | 'whisper' | 'enter' | 'leave' | 'system';

/**
 * 空间事件 —— 事件流的最小单位。
 *
 * 🔴 **四层分离**：
 *    `audience`       —— 谁听得见（路由判定依据）
 *    `address`        —— 冲着谁说的（提示词身份依据）【2026-10-29 新增】
 *    `publicMeta`     —— 全员可见摘要（如 {type:'whisper', from, to}），**仍受任期约束**
 *    `privateContent` —— 仅 audience 内可见的正文
 *
 * 为什么要分：隔离**不是让事件消失，是让内容看不见、存在感还在**。
 */
export interface SpaceEvent {
  id: string;
  spaceId: string;
  ts: number;
  kind: SpaceEventKind;
  /** 相关席位的 uuid（say/whisper 为说话人；enter/leave 为被操作者；system 为 null） */
  actorUuid: string | null;
  audience: Audience;
  /**
   * 指向：这句话冲着谁说的。
   * 🔴 缺省视为 `{ kind: 'room' }`（兼容手写事件；内核 makeEvent 一律显式写入）。
   */
  address?: Address;
  /** 全员可见摘要；null = 无公开元信息（如普通 say） */
  publicMeta: Record<string, unknown> | null;
  /** 仅 audience 内可见的正文；null = 无正文（如 enter/leave） */
  privateContent: string | null;
}

// ══════════════════════════════════════════════════════════════════
// 五、发言权 —— 🔴 2026-10-30 第二层：**已从内核删除**
// ══════════════════════════════════════════════════════════════════
//
// 原先这里有一套「发言令牌 + focusUuid」模型。删除理由（实测，不是推测）：
//   · focusUuid / pendingTokens / RouteOutput.tokens / ContextView.addressed
//     在全仓（src/ 除内核自身）**消费者数量 = 0**；
//   · 真实「谁接话」一直由 GroupSession.speakerUuid 决定。
// 两套并存 = 必然漂移。现在**唯一真源是 GroupSession.speakerUuid**，
// 内核只负责两件事：谁听得见（audience）与这话冲着谁（address）。
//
// ══════════════════════════════════════════════════════════════════
// 六、空间状态
// ══════════════════════════════════════════════════════════════════

/**
 * 空间状态 —— **不可变**。
 * 🔴 外部禁止直接改；只能推进 `route()` 返回的 nextState。
 */
export interface SpaceState {
  spaceId: string;
  seats: Seat[];
  /** 事件流（本内核只追加；落盘由适配器负责） */
  events: SpaceEvent[];
  /** 最后一条事件/流的 ts —— 用于乱序检测 */
  lastTs: number;
}

/** 新建一个空空间（= 业主独处，没有任何角色在场，也没有发言人） */
export function createEmptySpace(spaceId: string): SpaceState {
  return { spaceId, seats: [], events: [], lastTs: 0 };
}

// ══════════════════════════════════════════════════════════════════
// 七、出端口：路由结果
// ══════════════════════════════════════════════════════════════════

/** 单个席位的上下文视图（已按 canPerceive 过滤） */
export interface ContextView {
  seatUuid: string;
  /** 该席位能读到**正文**的事件 */
  readable: SpaceEvent[];
  /** 该席位读不到正文、但**知道发生过**的事件（仅 publicMeta） */
  metaOnly: SpaceEvent[];
  /**
   * 🔴 readable 中**指向本席位**的事件（address.kind === 'seat' 且 uuid 匹配）。
   *   用于让角色区分「这话是冲我说的」与「我只是在旁边听见」。
   */
  addressed: SpaceEvent[];
}

/** 路由输出 */
export interface RouteOutput {
  /** 本条 flow 的听觉范围 */
  audience: Audience;
  /** 本条 flow 的指向（谁会认为自己被点名） */
  address: Address;
  /** 每个在场席位各自的上下文视图 */
  views: Map<string, ContextView>;
  /** 本条 flow 追加到事件流的事件 */
  appended: SpaceEvent[];
  /** 告警（乱序、解析失败等）—— 供上层观测，不影响状态推进 */
  warnings: string[];
}

// ══════════════════════════════════════════════════════════════════
// 八、控制指令（解析结果）
// ══════════════════════════════════════════════════════════════════

