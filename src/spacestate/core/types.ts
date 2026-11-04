/**
 * 单维读数类型与规范化入口（S-003 / S-006 / S-007）
 *
 * 🔴 类型契约：读数只携带精度 π（1/方差），不携带任何形式的离散度字段。
 * 调用方在读取 v 之前必须先过 isKnown 判断，否则会把「未知」误当成 0。
 */

import { BIPOLAR_MIN, PI_MAX } from './config.js';
import { isBipolar, type DimId } from './layout.js';

/** 值域截断结果（内部原语的返回形） */
interface RangeResult {
  /** 截断后的值；非有限输入原样透传 */
  readonly v: number;
  /** 是否发生了越界截断（供调用方累加计数，本函数自身不持有计数状态） */
  readonly truncated: boolean;
}

/**
 * S-002 值域截断（内部原语，仅由 normalizeReading 调用）：双极 [-1,1]，单极 [0,1]。
 *
 * 越界一律截断并标记，不抛异常；截断次数由调用方累加
 * （core 禁止模块级可变状态，故计数不在此处持有）。
 *
 * 🔴 刻意不导出：它是读数规范化的一个中间步骤。裸数值层没有 pi 可以标记
 * 「未知」，单独暴露就会把 NaN 透传给调用方——而 S-007 要求输出里 NaN 数为 0。
 * 返回 0 又会把未知伪装成中性值，正是 S-003 要防的错误。
 * 非有限输入在外层已被拦截，正常路径不会触达此处。
 */
function clampToRange(value: number, bipolar: boolean): RangeResult {
  if (!Number.isFinite(value)) return { v: value, truncated: false };
  const lo = bipolar ? BIPOLAR_MIN : 0; // 整改 5：字面量 -1 收进 config
  const hi = 1;
  if (value < lo) return { v: lo, truncated: true };
  if (value > hi) return { v: hi, truncated: true };
  return { v: value, truncated: false };
}

/**
 * 单维读数三元组（S-003）
 *
 * - v    维度值（双极 [-1,1] / 单极 [0,1]）
 * - pi   精度，1/方差，取值 [0, 400]；pi = 0 表示未知，此时 v 一律被忽略
 * - src  读数来源标识
 *
 * 接口只传 π。离散度在系统内部一律由 π 反推（σ = π^(−1/2)），
 * 不作为字段出现，避免同一信息双份存储导致漂移。
 */
export interface DimReading {
  readonly v: number;
  readonly pi: number;
  readonly src: string;
}

/** 未知读数：pi = 0，v 被忽略（frozen，调用方不可就地改写） */
export const UNKNOWN_READING: DimReading = Object.freeze({
  v: 0,
  pi: 0,
  src: 'unknown',
});

/**
 * 读取 v 前的必经判断（S-003 + E-25）。
 * 所有要使用 v 的代码路径都必须先调用本函数，pi = 0 时 v 视为不存在。
 *
 * 两个条件缺一不可：
 * - **v 必须有限**：`{v: NaN, pi: 100}` 若只看 pi 会误判为已知，把 NaN 当成有效值读出去
 * - **π > 0 且非 NaN**：π=+∞ 按 E-25 是「σ→0 无限精确」而非未知，故不判有限性；
 *   需要规范化后的 π（必在 [0,400]）时请先过 `normalizeReading`
 */
export function isKnown(r: DimReading): boolean {
  return Number.isFinite(r.v) && r.pi > 0 && !Number.isNaN(r.pi);
}

/**
 * 读数异常/截断原因，与 Python oracle `sanitize_reading` 返回的 flag **逐字对齐**。
 *
 * | flag             | 触发条件                | 计入异常计数 |
 * |------------------|-------------------------|--------------|
 * | `nan`            | π = NaN                 | ✅           |
 * | `pos_inf`        | π = +∞（饱和 400）      | ✅           |
 * | `negative`       | π = −∞ 或 π < 0         | ✅           |
 * | `bad_value`      | v = NaN 或 ±∞           | ✅           |
 * | `range_clamped`  | 值域越界被钳位          | ⚠️ 仅在无更高优先级异常时出现 |
 * | `null`           | 无异常                  | —            |
 *
 * 🔴 `null` 也覆盖「π 有限但 >400」——那是**常规截断不是异常**，不计入异常计数。
 */
export type ReadingFlag =
  | 'nan'
  | 'pos_inf'
  | 'negative'
  | 'bad_value'
  | 'range_clamped'
  | null;

/** 原始值清洗结果（不含 src，供 dimEvidence 等按极性直接调用） */
export interface SanitizeResult {
  readonly v: number;
  readonly pi: number;
  readonly flag: ReadingFlag;
  readonly truncated: boolean;
}

/**
 * 按极性清洗一对 (v, π) —— **单一真相源**。
 *
 * `normalizeReading`（按 dim 查极性）与 `dimEvidence`（直接收 bipolar 参数）
 * 都走这里，避免两处清洗口径漂移。逻辑与 oracle `sanitize_reading` 逐条对齐。
 *
 * @param bipolar 双极维用 [-1,1]，单极维用 [0,1]
 */
export function sanitizeValue(v: number, pi: number, bipolar: boolean): SanitizeResult {
  // E-25：v 非有限 → 未知。🔴 不得把 +∞ 截成边界值凭空造强证据
  if (!Number.isFinite(v)) return { v: 0, pi: 0, flag: 'bad_value', truncated: false };

  // E-25：π = NaN → 未知
  if (Number.isNaN(pi)) return { v: 0, pi: 0, flag: 'nan', truncated: false };

  // E-25：π = +∞ → 饱和 400（σ→0 无限精确），属异常计数
  if (pi === Infinity) {
    const range = clampToRange(v, bipolar);
    return { v: range.v, pi: PI_MAX, flag: 'pos_inf', truncated: true };
  }

  // E-25：π = −∞ 或 <0 → 未知并计数
  if (pi === -Infinity || pi < 0) return { v: 0, pi: 0, flag: 'negative', truncated: true };

  // π 钳到 [0,400]；为 0（含 -0）即未知，不走值域钳位（与 oracle p<=0 分支一致）
  const p = Math.min(pi, PI_MAX);
  if (p === 0) return { v: 0, pi: 0, flag: null, truncated: false };

  const range = clampToRange(v, bipolar);
  return {
    v: range.v,
    pi: p,
    flag: range.truncated ? 'range_clamped' : null,
    // π 有限但 >400 属常规截断：truncated=true 供计数，flag=null 不计异常
    truncated: range.truncated || p !== pi,
  };
}

/** 规范化结果 */
export interface NormalizeResult {
  readonly reading: DimReading;
  /** 异常/截断原因，与 oracle flag 逐字对齐；null 表示无异常 */
  readonly flag: ReadingFlag;
  /** 是否发生了值域或精度截断（S-002 计数用）；π>400 属此列但 flag 为 null */
  readonly truncated: boolean;
}

/**
 * 读数规范化，四条规则一次执行：
 *
 * ① **值**（v/q/x）为 NaN 或 ±∞ → 整个读数按未知处理（E-25 / S-007）
 *    🔴 不得把 +∞ 截成边界值，否则凭空造出强证据
 * ② **精度** π 按 E-25 分情况：NaN→未知；+∞→饱和 400；−∞ 或 <0→未知**并计数**
 * ③ 值域截断并标记（S-002，双极 [-1,1] / 单极 [0,1]）
 * ④ 精度截断到 [0, 400]（S-006，σ 下限 0.05 ⟺ π ≤ 400）
 *
 * 纯函数：不持有计数、不抛异常、不产生 NaN。
 * `truncated` 标志即计数依据——core 禁止模块级可变状态，累计由调用方在 trace 完成
 * （E-25 补充：π=+∞ 本身说明上游 bug，须由调用方记异常计数）。
 *
 * @param dim 维度编号（如 'D01' / 'Y2'），用于查值域表；类型收紧为 DimId 以在编译期挡住拼写错误
 */
export function normalizeReading(r: DimReading, dim: DimId): NormalizeResult {
  // 极性由 dim 查表得出，清洗本身全部交给 sanitizeValue（单一真相源）
  const s = sanitizeValue(r.v, r.pi, isBipolar(dim));
  return {
    reading: s.pi > 0 ? { v: s.v, pi: s.pi, src: r.src } : UNKNOWN_READING,
    flag: s.flag,
    truncated: s.truncated,
  };
}
