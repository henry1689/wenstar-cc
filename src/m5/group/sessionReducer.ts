/**
 * sessionReducer — 群聊状态 reducer（T013 Phase 2 主体工程 · ADR-013 §2.2）
 *
 * 🔴 状态唯一写入口。整个文件是**纯函数**：不读全局、不查 FG、不写库、不调 LLM、
 *   不修改传入对象（每次都返回新对象）。
 *   这带来三件旧实现做不到的事：
 *     ① 每次变更都是 (prev, action, next) 三元组 —— action 序列即审计日志，零额外代码
 *     ② 第七层校验失败需要回滚一轮时，重放 action 序列即可
 *     ③ 序列化天然成立（JSON.stringify 即持久化）→ 修掉「多人会晤重启永不恢复」
 *
 * 与旧实现的关键差异：
 *   - 旧 EntityMeeting 在 enter() 里隐式做「已有单人会晤则自动升级为多人」等副作用；
 *     此处全部显式化为 action，由调用方（适配层）决定意图 → action 的映射。
 *   - 旧 `isMulti` 是**存库的布尔**，与 participants 实际数量会漂移；
 *     此处一律由 `isMulti(state)` 派生（ADR-013 §2.1 硬约束①）。
 *   - 旧退出是 `reset*` **归零**（玉瑶基线丢失，P039 缺陷②）；此处 LEAVE 是**弹栈恢复**。
 */
import {
  GROUP_SESSION_SCHEMA_VERSION,
  type Action,
  type ContextSlot,
  type Participant,
  type ParticipantSeed,
  type SessionEffect,
  type SessionMode,
  type SessionState,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// 构造与派生
// ═══════════════════════════════════════════════════════════════

/** 玉瑶态初始状态（participants 空 ⇒ 无会晤） */
export function createSessionState(now: number = Date.now()): SessionState {
  return {
    schemaVersion: GROUP_SESSION_SCHEMA_VERSION,
    participants: [],
    speakerUuid: null,
    turnIndex: 0,
    contextStack: [],
    lastActivityAt: now,
    meetingStartHistoryIndex: 0,
  };
}

/** 会话模式 —— 派生，不入库（ADR-013 §2.1 硬约束①） */
export function sessionMode(state: SessionState): SessionMode {
  return state.participants.length > 0 ? 'meeting' : 'yuyao';
}

/** 是否多人 —— 派生（修掉旧 `isMulti` 存库布尔漂移） */
export function isMulti(state: SessionState): boolean {
  return state.participants.length >= 2;
}

/** 会晤是否激活 —— 派生（等价旧 EntityMeeting.isActive()） */
export function isActive(state: SessionState): boolean {
  return state.participants.length > 0;
}

/** 当前主发言者（找不到 uuid 对应参与者时返回 null，不抛） */
export function speaker(state: SessionState): Participant | null {
  if (!state.speakerUuid) return null;
  return state.participants.find(p => p.uuid === state.speakerUuid) ?? null;
}

/** 取参与者（按 uuid，找不到返回 null） */
export function findParticipant(state: SessionState, uuid: string): Participant | null {
  return state.participants.find(p => p.uuid === uuid) ?? null;
}

function toParticipant(seed: ParticipantSeed, joinedAt: number): Participant {
  return {
    uuid: seed.uuid,
    name: seed.name,
    aliases: seed.aliases ? [...seed.aliases] : [],
    category: seed.category || 'G',
    joinedAt,
    turnCount: 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// 现场槽（L5/L6）—— 压栈 / 弹栈 / 原位覆盖
// ═══════════════════════════════════════════════════════════════

/**
 * 压栈：保存一个现场。**按 uuid 原位覆盖**，不重复入栈。
 * 同一人被保存两次（换人来回切）只留最新一份，栈不会随切换次数膨胀。
 */
export function pushSlot(stack: ContextSlot[], slot: ContextSlot): ContextSlot[] {
  const rest = stack.filter(s => s.uuid !== slot.uuid);
  return [...rest, slot];
}

/**
 * 弹栈：取出并移除某人的现场；不存在返回 null。
 * 🔴 这是与旧 `reset*()` 归零的根本差异 —— 找不到就不动，绝不用默认值覆盖现场。
 */
export function popSlot(stack: ContextSlot[], uuid: string | null): { slot: ContextSlot | null; rest: ContextSlot[] } {
  const idx = stack.findIndex(s => s.uuid === uuid);
  if (idx < 0) return { slot: null, rest: [...stack] };
  const slot = stack[idx];
  return { slot, rest: [...stack.slice(0, idx), ...stack.slice(idx + 1)] };
}

// ═══════════════════════════════════════════════════════════════
// reduce —— 唯一状态写入口
// ═══════════════════════════════════════════════════════════════

/**
 * 状态转移。**纯、同步、不修改入参**。
 *
 * 「不操作」的返回契约：与入参**同一引用**（`prev === next`），便于调用方用
 * 引用比较判定「门卫拒绝 / 模糊不操作 / 非参与者」，无需比较内容。
 */
export function reduce(prev: SessionState, action: Action): SessionState {
  const now = action.now ?? Date.now();

  switch (action.type) {
    // ── 进会晤（1 人或多人同一入口；玉瑶现场压栈保存）──
    case 'WAKE': {
      const seen = new Set<string>();
      const fresh = action.targets.filter(t => {
        if (!t.uuid || seen.has(t.uuid)) return false;
        seen.add(t.uuid);
        return true;
      });
      if (fresh.length === 0) return prev;                       // 解析失败 → 不操作

      const participants = fresh.map(t => toParticipant(t, now));
      // 现场栈：给了新槽就压栈（按 uuid 原位覆盖），否则沿用上一态（状态不可变，直接复用引用）
      const stack = action.slot ? pushSlot(prev.contextStack, action.slot) : prev.contextStack;
      return {
        ...prev,
        participants,
        speakerUuid: participants[0].uuid,
        turnIndex: prev.turnIndex + 1,
        contextStack: stack,
        lastActivityAt: now,
        meetingStartHistoryIndex:
          typeof action.historyIndex === 'number' ? action.historyIndex : prev.meetingStartHistoryIndex,
      };
    }

    // ── 加人（已在列 → 不操作；单人会话加人 ⇒ 自动变多人，由 isMulti 派生表达）──
    case 'JOIN': {
      if (!action.target.uuid) return prev;
      if (findParticipant(prev, action.target.uuid)) return prev;
      const participants = [...prev.participants, toParticipant(action.target, now)];
      return {
        ...prev,
        participants,
        // 从玉瑶态直接 JOIN（不经 WAKE）：首个参与者成为主发言
        speakerUuid: prev.speakerUuid ?? action.target.uuid,
        turnIndex: prev.turnIndex + 1,
        lastActivityAt: now,
      };
    }

    // ── 换主发言（不压新栈；旧发言者现场按 uuid 原位保存）──
    case 'SPEAK': {
      const target = findParticipant(prev, action.target)
        ?? prev.participants.find(p => p.name === action.target)
        ?? null;
      if (!target) return prev;                                  // 非参与者 → 不操作
      if (target.uuid === prev.speakerUuid && !action.slot) return prev;  // 同人切换 = 无变化

      return {
        ...prev,
        participants: prev.participants.map(p => (p.uuid === target.uuid ? { ...p, turnCount: p.turnCount + 1 } : p)),
        speakerUuid: target.uuid,
        contextStack: action.slot ? pushSlot(prev.contextStack, action.slot) : [...prev.contextStack],
        lastActivityAt: now,
      };
    }

    // ── 减人 / 散会（弹栈恢复，不归零）──
    case 'LEAVE': {
      if (prev.participants.length === 0) return prev;
      if (!action.target) {
        // 散会：清空参与者；玉瑶现场（uuid=null）仍留在栈上，
        // 由 diffEffects 产出 restoreSlot 交适配层恢复 —— reducer 不做 IO。
        return {
          ...prev,
          participants: [],
          speakerUuid: null,
          turnIndex: prev.turnIndex + 1,
          lastActivityAt: now,
        };
      }
      const left = findParticipant(prev, action.target)
        ?? prev.participants.find(p => p.name === action.target);
      if (!left) return prev;
      const participants = prev.participants.filter(p => p.uuid !== left.uuid);
      return {
        ...prev,
        participants,
        speakerUuid: prev.speakerUuid === left.uuid ? (participants[0]?.uuid ?? null) : prev.speakerUuid,
        turnIndex: prev.turnIndex + 1,
        lastActivityAt: now,
      };
    }

    // ── 重启恢复（校验失败直接拒绝，绝不半恢复）──
    case 'RESUME':
      return normalizeState(action.state, action.now ?? Date.now()) ?? prev;

    // ── 时间活动（只刷新时间戳，不改结构）──
    case 'IDLE':
      return { ...prev, lastActivityAt: now };
  }
}

// ═══════════════════════════════════════════════════════════════
// 副作用派生（reducer 不执行副作用，由适配层消费）
// ═══════════════════════════════════════════════════════════════

/**
 * 由 (prev, next) 推导适配层要做的副作用。**不修改任何一方**。
 * 调用顺序固定：`const next = reduce(prev, a); applyEffects(diffEffects(prev, next));`
 * 由此 reducer 保持无 IO —— 压栈/弹栈、门阀、日志全在适配层。
 */
export function diffEffects(prev: SessionState, next: SessionState): SessionEffect[] {
  if (prev === next) return [];
  const out: SessionEffect[] = [];

  const prevUuids = new Set(prev.participants.map(p => p.uuid));
  const nextUuids = new Set(next.participants.map(p => p.uuid));

  // 进入会晤（玉瑶态 → 首个参与者）
  if (prev.participants.length === 0 && next.participants.length > 0) {
    out.push({ type: 'meetingStarted', uuids: next.participants.map(p => p.uuid) });
  }
  // 退出会晤（清空参与者）→ 顺带产出玉瑶现场恢复
  if (prev.participants.length > 0 && next.participants.length === 0) {
    out.push({ type: 'meetingEnded' });
    const yuyaoSlot = [...next.contextStack].reverse().find(s => s.uuid === null);
    if (yuyaoSlot) out.push({ type: 'restoreSlot', slot: yuyaoSlot });
  }

  for (const p of next.participants) if (!prevUuids.has(p.uuid)) out.push({ type: 'participantJoined', uuid: p.uuid });
  for (const p of prev.participants) if (!nextUuids.has(p.uuid)) out.push({ type: 'participantLeft', uuid: p.uuid });

  // 现场被保存/更新（pushSlot 返回新数组，故引用不同即视为变更）
  for (const slot of next.contextStack) {
    if (!prev.contextStack.includes(slot)) out.push({ type: 'saveSlot', slot });
  }

  if (prev.speakerUuid !== next.speakerUuid) {
    out.push({ type: 'speakerChanged', from: prev.speakerUuid, to: next.speakerUuid });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 序列化与恢复
// ═══════════════════════════════════════════════════════════════

export function serializeState(state: SessionState): string {
  return JSON.stringify(state);
}

/**
 * 解析并规范化外部传入的状态（RESUME / 反序列化共用）。
 * 🔴 保守策略：任何结构异常 → **整份拒绝返回 null**，绝不"尽力恢复"出一个半错状态
 *   （半错状态意味着 speakerUuid 指向不存在的参与者 → 检索白名单错 → 串档，I007 形态）。
 */
export function normalizeState(raw: unknown, now: number = Date.now()): SessionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<SessionState>;
  if (s.schemaVersion !== GROUP_SESSION_SCHEMA_VERSION) return null;
  if (!Array.isArray(s.participants)) return null;

  const participants: Participant[] = [];
  const seen = new Set<string>();
  for (const p of s.participants) {
    if (!p || typeof p !== 'object') return null;
    const uuid = typeof p.uuid === 'string' ? p.uuid.trim() : '';
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!uuid || !name || seen.has(uuid)) return null;   // 无 uuid / 无名 / 重复 uuid ⇒ 拒绝
    seen.add(uuid);
    participants.push({
      uuid,
      name,
      aliases: Array.isArray(p.aliases) ? p.aliases.filter((a): a is string => typeof a === 'string') : [],
      category: typeof p.category === 'string' ? p.category : 'G',
      joinedAt: typeof p.joinedAt === 'number' ? p.joinedAt : now,
      turnCount: typeof p.turnCount === 'number' && p.turnCount >= 0 ? p.turnCount : 0,
    });
  }

  const speakerUuid = typeof s.speakerUuid === 'string' && s.speakerUuid ? s.speakerUuid : null;
  // 🔴 发言者必须是参与者之一，否则拒绝（半错状态的典型形态）
  if (speakerUuid && !seen.has(speakerUuid)) return null;

  const stack: ContextSlot[] = [];
  if (s.contextStack !== undefined) {
    if (!Array.isArray(s.contextStack)) return null;
    for (const c of s.contextStack) {
      if (!c || typeof c !== 'object') return null;
      if (c.uuid !== null && typeof c.uuid !== 'string') return null;
      if (typeof c.uuid === 'string' && !seen.has(c.uuid)) return null;  // 栈里必须是当前参与者
      stack.push({
        uuid: c.uuid,
        emotion: c.emotion ?? { pleasure: 0, arousal: 0, intimacy: 0 },
        sceneAnchor: c.sceneAnchor ?? null,
        contextMemory: c.contextMemory ?? null,
        ...(typeof c.savedRole === 'string' ? { savedRole: c.savedRole } : {}),
        savedAt: typeof c.savedAt === 'number' ? c.savedAt : now,
      });
    }
  }

  return {
    schemaVersion: GROUP_SESSION_SCHEMA_VERSION,
    participants,
    speakerUuid,
    turnIndex: typeof s.turnIndex === 'number' && s.turnIndex >= 0 ? s.turnIndex : 0,
    contextStack: stack,
    lastActivityAt: typeof s.lastActivityAt === 'number' ? s.lastActivityAt : now,
    meetingStartHistoryIndex:
      typeof s.meetingStartHistoryIndex === 'number' && s.meetingStartHistoryIndex >= 0
        ? s.meetingStartHistoryIndex
        : 0,
  };
}

/** 从 JSON 字符串恢复；失败返回 null（不抛） */
export function deserializeState(json: string, now: number = Date.now()): SessionState | null {
  try {
    return normalizeState(JSON.parse(json), now);
  } catch {
    return null;
  }
}
