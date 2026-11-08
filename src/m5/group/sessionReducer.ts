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
    askAllQueue: [],
    everHadSeats: false,
    aloneNotified: false,
    // 尚无临时点名 ⇒ 没有待恢复的原主（D2）
    transientSpeakerFrom: null,
  };
}

/** 会话模式 —— 派生，不入库（ADR-013 §2.1 硬约束①） */
export function sessionMode(state: SessionState): SessionMode {
  // 🔴 2026-11-01 三值化：空场要区分「散会之后」与「从未会晤」——
  //   前者是独处态（业主一个人，不该有人应答），后者是玉瑶态（正常对话）。
  if (state.participants.length > 0) return 'meeting';
  return state.everHadSeats === true ? 'alone' : 'yuyao';
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
        // P090：进入新会话即清空轮答队列，防上次残留（P096 §1.3）
        askAllQueue: [],
        // 🔴 2026-11-01：一旦建立过席位即永久置位 —— 散会后 mode 变为 'alone'
        //   （独处态），而不是退回 'yuyao'（把散会误当成从未会晤）。
        everHadSeats: true,
        // 有人进来 ⇒ 独处结束，下次散会要重新提示
        aloneNotified: false,
        // 🔴 D2：新会话开始 ⇒ 上一场留下的待回退目标已无意义
        transientSpeakerFrom: null,
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
        // P090：**正在轮答时**新加入者追加队尾（也被问到，与会议常识一致）。
        //   🔴 必须带「队列非空」前置条件 —— 若无条件追加，不在轮答时的普通 JOIN
        //   会把空队列变成非空 ⇒ diffEffects 误派生 `askAllStarted` ⇒ 幻觉出一次全员提问。
        askAllQueue: prev.askAllQueue.length > 0 ? [...prev.askAllQueue, action.target.uuid] : [],
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
        // P090 · P096 §1.3：**出队语义** —— target 在轮答队列中则移除。
        //   askAll 推进靠本分支自然出队（每次出队都会 SPEAK，speakerChanged 已覆盖日志与持久化）。
        //   🔴 注意 SPEAK **不清空整个队列**：点名即停（P094 裁决③）由**调用层**按意图决定
        //   是否进入轮答循环来满足（点名意图不进循环），残留队列由下次 WAKE/RESUME 清空。
        //   若在此处清空，askAll 每推进一人队列即被清空 ⇒ 轮答只能进行一人。
        askAllQueue: prev.askAllQueue.filter(u => u !== target.uuid),
        // 🔴 D2：普通换主 = 会话结构已按业主明确意图重排 ⇒ 丢掉上一轮的临时回退目标。
        //   （调用层的「回原主」本身也是 SPEAK，同样走到这里把指针清掉，形成闭环。）
        transientSpeakerFrom: null,
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
          // P090：散会即清空轮答队列（队列里都是已不存在的参与者，留着是脏数据）
          askAllQueue: [],
          // 进入独处态 ⇒ 重置提示标记（下一轮给一次性过渡文案）
          aloneNotified: false,
          // D2：散会后没有「原主」可回
          transientSpeakerFrom: null,
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
        // P090：离开者同步移出轮答队列（否则会向已离席的人继续轮询）
        askAllQueue: prev.askAllQueue.filter(u => u !== left.uuid),
        // 最后一人离场 ⇒ 与散会同义，重置独处提示标记
        aloneNotified: participants.length === 0 ? false : prev.aloneNotified,
        // D2：走掉的正是待回退的原主 ⇒ 指针作废（否则下一轮会 SPEAK 一个不在场的人）；
        //   离开的是被点名者时保留指针，下一轮仍应正常回原主。
        transientSpeakerFrom: prev.transientSpeakerFrom === left.uuid ? null : prev.transientSpeakerFrom,
      };
    }

    // ── 回玉瑶私聊（2026-11-08）：独处态的唯一离开边 ──
    case 'RETURN_YUYAO': {
      // 会晤中不允许直接回玉瑶：调用层必须先 LEAVE 再 RETURN（状态机不为调用顺序兜底）
      if (prev.participants.length > 0) return prev;
      // 玉瑶态（从未散会 / 已经回来过）→ 幂等不操作
      if (prev.everHadSeats !== true) return prev;
      return {
        ...prev,
        everHadSeats: false,     // 独处相位结束 ⇒ sessionMode 派生回 'yuyao'
        aloneNotified: false,    // 下次散会重新给一次过渡文案
        lastActivityAt: now,
        transientSpeakerFrom: null,
      };
    }

    // ── 独处态过渡提示已发出（2026-11-01）──
    case 'ALONE_ACK': {
      if (prev.aloneNotified === true) return prev;      // 幂等
      return { ...prev, aloneNotified: true, lastActivityAt: now };
    }

    // ── 本轮点名应答（2026-11-01 D2）──
    case 'TRANSIENT_SPEAK': {
      const target = findParticipant(prev, action.target)
        ?? prev.participants.find(p => p.name === action.target)
        ?? null;
      if (!target) return prev;                                  // 非参与者 → 不操作
      if (target.uuid === prev.speakerUuid) return prev;          // 点的就是当前发言者 = 无变化
      // 🔴 已在临时顶替中（连续点名）：保留**最初**的原主，不把上一个被点名者当成原主 ——
      //   否则「@阿珍 → @诗雨」之后会回到阿珍，而那从来不是业主原本在跟谁说话。
      const from = prev.transientSpeakerFrom ?? prev.speakerUuid;
      return {
        ...prev,
        participants: prev.participants.map(p => (p.uuid === target.uuid ? { ...p, turnCount: p.turnCount + 1 } : p)),
        speakerUuid: target.uuid,
        lastActivityAt: now,
        transientSpeakerFrom: from,
      };
    }

    // ── 重启恢复（校验失败直接拒绝，绝不半恢复）──
    case 'RESUME':
      return normalizeState(action.state, action.now ?? Date.now()) ?? prev;

    // ── P090 · P096 §1.3：向全员提问 —— 一次性入队 ──
    case 'ASK_ALL': {
      if (prev.participants.length === 0) return prev;   // 玉瑶态无对象可问 → 不操作
      return {
        ...prev,
        // 全量入队、按 participants 原序、**含当前发言人**（P094 裁决①：一律全答，
        // 不做「刚答过就跳过」的判断 —— 那类跳过要靠 LLM 判定，会引入漂移）。
        askAllQueue: prev.participants.map(p => p.uuid),
        lastActivityAt: now,
      };
    }

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

  // P090 · P096 §1.4：轮答**首次**入队（空 → 非空）才派生一次。
  //   推进阶段不派生新 effect —— 每次出队都会 `SPEAK`，上面的 speakerChanged 已覆盖。
  if (prev.askAllQueue.length === 0 && next.askAllQueue.length > 0) {
    out.push({ type: 'askAllStarted', uuids: [...next.askAllQueue] });
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

  // P090：轮答队列 —— **向后兼容**（旧快照无此字段 ⇒ 补 []，schemaVersion 不 bump）。
  //   队列里的每个 UUID 必须仍是当前参与者，否则按本函数的保守策略**整份拒绝**。
  //   （半错队列 = 向已离席/不存在的人继续轮询；宁可拒绝恢复，也不恢复出一个错状态。）
  const askAllQueue: string[] = [];
  if (s.askAllQueue !== undefined) {
    if (!Array.isArray(s.askAllQueue)) return null;
    for (const u of s.askAllQueue) {
      if (typeof u !== 'string' || !u || !seen.has(u)) return null;
      askAllQueue.push(u);
    }
  }

  // 🔴 D2：临时点名回退指针 —— **向后兼容**（旧快照无此字段 ⇒ null，schemaVersion 不 bump）。
  //   与 askAllQueue 不同，这里**不整份拒绝**：指针只是「下一轮回谁」的便利信息，
  //   指向已不在场的人时丢弃即可（丢掉 = 本次恢复没有待回退目标），
  //   而拒绝整份恢复会让业主重启后直接丢掉整个会晤 —— 代价远大于收益。
  const transientFromRaw =
    typeof s.transientSpeakerFrom === 'string' && s.transientSpeakerFrom ? s.transientSpeakerFrom : null;
  const transientSpeakerFrom = transientFromRaw && seen.has(transientFromRaw) ? transientFromRaw : null;

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
    askAllQueue,
    // 🔴 向后兼容：旧快照无此字段 ⇒ 由参与者推导；无参与者则为 false
    //   （等价于旧实现「重启后丢失会晤记忆」）。
    everHadSeats: s.everHadSeats === true || participants.length > 0,
    // 旧快照无此字段 ⇒ false（下一轮独处会重新提示一次，无副作用）
    aloneNotified: s.aloneNotified === true,
    transientSpeakerFrom,
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
