/**
 * contextBridge — 模块单例 ↔ ContextSlot 的桥接（T013 Phase 2 批C）
 *
 * 🔴 为什么要单独一层（而不是直接在 chat.ts 里读写）：
 *   `SceneAnchor` 与 `ContextMemory` 都是**模块级单例**（`let _anchor` / `let _state`）。
 *   「单例 ↔ 槽」的读写是**有副作用**的操作，而批A 建立的核心不变量是
 *   `sessionReducer` / `project` **零 IO、纯函数**。把副作用混进纯函数层，
 *   等于亲手拆掉那个不变量。故隔离在本文件，chat.ts 只在开关分支里调用。
 *
 * 🔴 时序前提（chat.ts 每轮顺序，批C 的正确性完全建立在它上面）：
 *     :831 enter()  →  :947 影子投影  →  :2502 orchestrate()
 *   `M5Orchestrator:63` 每轮调 `extractAnchor()`，**用会晤内容覆盖单例**。
 *   ⇒ 采样（captureSlot）必须发生在 :947 —— 此刻单例仍是**玉瑶现场**（本轮 M5 还没跑）；
 *   ⇒ 恢复（applySlot）也落在 :947 —— 退出轮恢复后，:2502 才用恢复后的玉瑶现场生成回复。
 *   这正是旧实现做不到的：旧代码在 :855 `reset*()` 归零，且位置在 exit 之前。
 *
 * 数据约束：本文件**零 DB 读写**。P051 要求的「退出时保存实体情感快照」由旧路径
 *   `chat.ts:876-884`（`saveEmotionSnapshot`）继续负责，此处不重复写。
 */
import { getAnchor, setAnchor, type SceneAnchor } from '../SceneAnchor.js';
import { getSceneSnapshot, setSceneSnapshot, type ContextSnapshot } from '../ContextMemory.js';
import type { ContextSlot, EmotionSlot } from './types.js';

/** 情感维度的缺省值（未采到时用；与 emotion_snapshots 表字段同名同义） */
const ZERO_EMOTION: EmotionSlot = { pleasure: 0, arousal: 0, intimacy: 0 };

/** 采样时可传入的外部情感值（会晤态下当前轮的 M3 感知） */
export interface CaptureOptions {
  /** 当前轮情感（M3 Perception24D 的 pleasure/arousal/intimacy）；缺省时用零值 */
  emotion?: Partial<EmotionSlot>;
  /** 玉瑶态的当前角色（RoleRouter 结果）；仅 uuid=null（玉瑶）时有意义 */
  savedRole?: string;
  /** 现场时间戳 */
  now?: number;
}

/**
 * 情感值归一。
 * 🔴 `typeof NaN === 'number'`，故必须**单独排除 NaN/Infinity** ——
 *   一个 NaN 进槽会污染后续所有算术（夹逼、加权、40D 计算），且极难定位。
 */
function finite(src: unknown, fallback: number): number {
  return typeof src === 'number' && Number.isFinite(src) ? src : fallback;
}

function normEmotion(src?: Partial<EmotionSlot> | null): EmotionSlot {
  const s = src || {};
  return {
    pleasure: finite(s.pleasure, ZERO_EMOTION.pleasure),
    arousal: finite(s.arousal, ZERO_EMOTION.arousal),
    intimacy: finite(s.intimacy, ZERO_EMOTION.intimacy),
  };
}

/**
 * 采样当前现场 → ContextSlot。
 *
 * @param uuid null = 玉瑶现场（会晤实体传其 UUID）
 *
 * 情感为什么必须显式传入：`ContextSnapshot.atmosphere` 存的是**氛围**
 * （mood / tension / distance），与 `EmotionSnapshot` 的三维（pleasure/arousal/intimacy）
 * **不是同一套坐标**，不能互换 —— 从 atmosphere 派生 emotion 会得到语义错误的值。
 */
export function captureSlot(uuid: string | null, opts: CaptureOptions = {}): ContextSlot {
  const slot: ContextSlot = {
    uuid,
    emotion: normEmotion(opts.emotion),
    sceneAnchor: safeAnchor(),
    contextMemory: safeSnapshot(),
    savedAt: opts.now ?? Date.now(),
  };
  if (opts.savedRole) (slot as { savedRole?: string }).savedRole = opts.savedRole;
  return slot;
}

/**
 * 把 ContextSlot 写回两个模块单例。
 *
 * 🔴 写回前**必须**校验 slot 合法：空对象/全空槽一律拒绝（返回 false）。
 *   理由：写回一个空锚点等于把玉瑶现场抹成白板 —— 那比「不恢复」更糟，
 *   会直接复现 P039 缺陷② 的症状（玉瑶基线丢失）。
 *
 * @returns true = 已写回；false = 槽非法或无可写内容（调用方记告警即可，不是错误）
 */
export function applySlot(slot: ContextSlot | null | undefined): boolean {
  if (!slot || typeof slot !== 'object') return false;

  const anchor = slot.sceneAnchor;
  const memory = slot.contextMemory;

  // 至少要有一样可写内容，否则视为无效槽
  const hasAnchor = !!anchor && (anchor.isActive || !!anchor.location || (anchor.nudity ?? 0) > 0);
  const hasMemory = !!memory && !!(memory.physical || memory.atmosphere || memory.facts);
  if (!hasAnchor && !hasMemory) return false;

  if (hasAnchor) {
    try { setAnchor(anchor as SceneAnchor); } catch { /* 锚点写回失败不阻断内存恢复 */ }
  }
  if (hasMemory) {
    try { setSceneSnapshot(memory as Partial<ContextSnapshot>); } catch { /* 同上 */ }
  }
  return true;
}

/** 读现场快照；异常返回 null（**绝不抛** —— 采样失败只影响影子状态，不能伤及主链路） */
function safeSnapshot(): ContextSnapshot | null {
  try { return getSceneSnapshot(); } catch { return null; }
}

/** 读场景锚点；异常返回 null */
function safeAnchor(): SceneAnchor | null {
  try { return getAnchor(); } catch { return null; }
}
