/**
 * project — EntityMeeting 状态 → reducer action 的**投影**（T013 Phase 2 批B B1）
 *
 * 🔴 为什么要有这一层：批B 阶段 EntityMeeting **仍是唯一真源**（ADR-013 §2.3「薄适配层 +
 *   逐段替换」的第一段）。GroupSession 先以**影子状态**运行 —— 只读真源、投影成 action、
 *   不做任何决策。这样可以在不改变任何用户可感知行为的前提下，先验证新状态机与旧实现
 *   逐轮无漂移，再谈切主。
 *
 * 🔴 为什么单独一个文件而不内联进 chat.ts：内联就无法单测。影子并线若不可测，
 *   等于上了一个「看起来在跑、实际上没人验证它对不对」的东西 —— 那正是 T012 十项缺陷
 *   的产生方式。
 *
 * 投影策略：**集合整体同步**，不用增量 JOIN/LEAVE 猜中间态。
 *   - 参与者集合不同 → WAKE（整体重置为真源集合）
 *   - 集合相同、仅主发言不同 → SPEAK
 *   - 无变化 → null（调用方不 dispatch，零副作用）
 * 理由：EntityMeeting 的中间态（自动升级多人、switchTo 内部先 exit 再 enter）对外不透明，
 *   用增量动作去猜会猜错；影子模式只需要**终态正确**。
 */
import { isActive } from './sessionReducer.js';
import type { Action, ContextSlot, ParticipantSeed, SessionState } from './types.js';

/** 从 EntityMeeting 读出的状态快照（适配层负责组装，本文件不做任何 IO/类型耦合） */
export interface MeetingSnapshot {
  /** 会晤是否激活（等价 EntityMeeting.isActive()） */
  active: boolean;
  /** 当前主发言者 UUID（等价 getEntityUUID()）；未激活时应为 null */
  speakerUuid: string | null;
  /** 当前主发言者名（等价 getEntityName()） */
  speakerName: string | null;
  /** 参与者（多人时 getParticipants()，单人时只含主发言者） */
  participants: Array<{ uuid: string; name: string; category?: string }>;
}

/** 参与者集合的比较键（只看 uuid，顺序无关） */
function keyOf(p: { uuid: string }): string {
  return String(p.uuid || '').trim();
}

function toSeeds(list: MeetingSnapshot['participants']): ParticipantSeed[] {
  return list
    .filter(p => keyOf(p) && p.name)
    .map(p => ({ uuid: keyOf(p), name: String(p.name), category: p.category }));
}

/**
 * 把真源快照投影成 action。**纯函数**：不读全局、不查 FG、不写库。
 *
 * @param prev  影子状态的当前值（GroupSession.getState()）
 * @param snap  真源快照
 * @returns action **序列**；无需变更时返回空数组
 *
 * 🔴 返回序列而非单个 action 的原因（实测 bug，detectDrift 抓到后修正）：
 *   `WAKE` 的 reducer 把 `speakerUuid` 固定为 `participants[0]`。当真源集合变化
 *   且当前主发言**不是**列表首位时（例如真源刚从单人升为多人、主发言是后来加入的人），
 *   单发一个 WAKE 会把主发言错回首位 —— 影子状态随即与真源漂移。
 *   故集合变化时先 WAKE 重建集合，再按需补一个 SPEAK 把主发言对齐真源。
 */
export function projectMeetingState(
  prev: SessionState,
  snap: MeetingSnapshot,
  now: number = Date.now(),
  /** 批C：进入会晤时要压栈的玉瑶现场。**只在产出 WAKE 时被使用**，不传则不带（批A/B 行为不变） */
  slot?: ContextSlot,
): Action[] {
  const prevActive = isActive(prev);
  const seeds = toSeeds(snap.participants || []);
  // 真源说激活但解析不出任何参与者 → 视为无效快照，不动影子状态（宁可不投影，不可投影错）
  if (snap.active && seeds.length === 0) return [];

  // ── 玉瑶态 → 会晤：进入 ──
  if (!prevActive && snap.active) {
    const enter: Action[] = [{ type: 'WAKE', targets: seeds, now, ...(slot ? { slot } : {}) }];
    // WAKE 后主发言恒为首位；若真源主发言不是首位，补一个 SPEAK 对齐
    const want = snap.speakerUuid ? keyOf({ uuid: snap.speakerUuid }) : null;
    if (want && seeds.length > 0 && want !== seeds[0].uuid && seeds.some(s => s.uuid === want)) {
      enter.push({ type: 'SPEAK', target: want, now });
    }
    return enter;
  }

  // ── 会晤中 → 玉瑶态：散会（无 target = LEAVE 全体）──
  if (prevActive && !snap.active) {
    return [{ type: 'LEAVE', now }];
  }

  // 两边都未激活 → 无需变更
  if (!prevActive && !snap.active) return [];

  // ── 两边都激活：比较参与者集合 ──
  const prevSet = new Set(prev.participants.map(keyOf).filter(Boolean));
  const nextSet = new Set(seeds.map(p => p.uuid));
  const sameSet = prevSet.size === nextSet.size && [...nextSet].every(u => prevSet.has(u));
  const speakerUuid = snap.speakerUuid ? keyOf({ uuid: snap.speakerUuid }) : null;

  if (!sameSet) {
    // 集合有增减 —— 整体重置（WAKE 幂等重建 participants），不做增量猜测；
    // 重置后主发言变回首位，故必须再按真源主发言补 SPEAK（见上方 🔴 注释）
    const out: Action[] = [{ type: 'WAKE', targets: seeds, now }];
    if (speakerUuid && seeds[0]?.uuid !== speakerUuid && nextSet.has(speakerUuid)) {
      out.push({ type: 'SPEAK', target: speakerUuid, now });
    }
    return out;
  }

  // ── 集合相同：只可能变了主发言 ──
  if (speakerUuid && speakerUuid !== prev.speakerUuid && nextSet.has(speakerUuid)) {
    return [{ type: 'SPEAK', target: speakerUuid, now }];
  }

  return [];   // 无变化
}

/**
 * 影子状态自检：把 action 应用到 prev 上，验证结果与真源快照**一致**。
 * 供适配层在开关开启时打日志/告警（漂移 = 投影逻辑有 bug，必须暴露出来而不是悄悄错下去）。
 *
 * @returns null = 一致；非 null = 不一致的描述
 */
export function detectDrift(next: SessionState, snap: MeetingSnapshot): string | null {
  if (snap.active !== isActive(next)) return `active 漂移: 真源=${snap.active} 影子=${isActive(next)}`;

  if (!snap.active) return null;   // 玉瑶态不比集合

  const snapUuids = new Set(toSeeds(snap.participants).map(p => p.uuid));
  const nextUuids = new Set(next.participants.map(keyOf));
  if (snapUuids.size !== nextUuids.size || [...snapUuids].some(u => !nextUuids.has(u))) {
    return `participants 漂移: 真源=[${[...snapUuids].join(',')}] 影子=[${[...nextUuids].join(',')}]`;
  }

  const want = snap.speakerUuid ? keyOf({ uuid: snap.speakerUuid }) : null;
  if (want && want !== next.speakerUuid) {
    return `speaker 漂移: 真源=${want} 影子=${next.speakerUuid}`;
  }
  return null;
}
