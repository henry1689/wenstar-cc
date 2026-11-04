/**
 * 数值编码层（S-004 / S-005 / S-006）
 *
 * - int8 对称舍入量化（G-004）
 * - 精度 π 的 uint8 对数编码（G-005，勘误 E-01）
 * - σ 下限与 ICC 精度上限（G-006）
 *
 * 全部为纯函数：无 fs / 无数据库 / 无时钟 / 无随机 / 无环境变量。
 */

import {
  INT8_MAX,
  PI_BYTE_OFFSET,
  PI_CODE_MAX,
  PI_CODE_MIN,
  PI_LOG2_SCALE,
  PI_MAX,
} from './config.js';

/**
 * S-004 int8 对称舍入量化（G-004）
 *
 *   q(x) = sign(x) · floor(|x| · 127 + 0.5)，截断到 [-127, 127]
 *
 * ⚠️ 刻意不使用 Math.round：JS 的 Math.round 是 half 向 +∞
 * （Math.round(2.5) = 3、Math.round(-63.5) = -63），与 Python 的
 * 银行家舍入（round(-63.5) = -64）结果不同，跨语言差分对拍会因此分歧。
 * 用 floor(|x|·127+0.5) 先在绝对值上取正向舍入，再乘符号，
 * 保证正负两侧对称。
 *
 * 非有限输入返回 0：量化层不携带精度字段，未知值由上层以 pi=0 标记，
 * 本函数的职责是绝不吐出 NaN。
 */
export function quantizeInt8(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const magnitude = Math.min(Math.floor(Math.abs(x) * INT8_MAX + 0.5), INT8_MAX);
  if (magnitude === 0) return 0; // 归一 -0 → 0，避免 Object.is 判等失败
  return Math.sign(x) * magnitude;
}

/**
 * S-004 int8 反量化（G-004）
 *
 *   dequantize(q) = q / 127
 *
 * 反量化误差上界为半个量化步长，即 1/254（S-004 校验标准）。
 *
 * 整改 7：输入先钳到合法 int8 值域 [-127,127]——`dequantizeInt8(-200)` 若不钳
 * 会得到 -1.57，一个不可能由量化产生的值域外结果。钳位后恒落在 [-1,1]。
 * （注：oracle v3 的 `dequant_int8` 不钳位，此处按整改任务书第 77 行取钳位，
 *  属已知分歧，已记入差异报告。）
 */
export function dequantizeInt8(q: number): number {
  if (!Number.isFinite(q)) return 0;
  const clamped = Math.min(Math.max(q, -INT8_MAX), INT8_MAX);
  return clamped / INT8_MAX;
}

/**
 * S-006 精度截断 + E-25 非有限输入口径
 *
 * | 输入            | 处理           | 理由                          |
 * |-----------------|----------------|-------------------------------|
 * | π = NaN         | 0（未知）      | 未知                          |
 * | π = +∞          | 饱和 400       | σ→0 无限精确，饱和即可        |
 * | π = −∞ 或 π < 0 | 0（未知）      | 负精度无物理意义，由调用方计数 |
 * | 0 < π ≤ 400     | 原值           | S-006 定义域                  |
 * | π > 400         | 400            | σ 下限 0.05 ⟺ π ≤ 400         |
 *
 * ⚠️ π=+∞ 归 400 而非 0，是 E-25 与旧 S-007 字面的分歧点：
 * π=1/σ²，π→+∞ 是 σ→0（无限精确），不是「未知」，NaN 才是未知。
 * 若把 +∞ 当未知，会与 S-011「πx=+∞ 按 400 处理」方向相反。
 */
export function clampPi(pi: number): number {
  if (Number.isNaN(pi)) return 0;
  if (pi === Infinity) return PI_MAX;
  if (pi <= 0) return 0; // −∞ 或负值
  return Math.min(pi, PI_MAX);
}

/**
 * S-005 精度 π → uint8 对数码（G-005，勘误 E-01）
 *
 *   k = clamp(round(128 + 14.75 · log2 π), 1, 255)
 *   π = 0 时 k = 0（表示未知）
 *
 * 编码先过 clampPi，因此 π > 400 会被压到 400 再编码。
 */
export function encodePi(pi: number): number {
  const clamped = clampPi(pi);
  if (clamped === 0) return 0;
  const raw = Math.round(PI_BYTE_OFFSET + PI_LOG2_SCALE * Math.log2(clamped));
  return Math.min(Math.max(raw, PI_CODE_MIN), PI_CODE_MAX);
}

/**
 * S-005 精度 uint8 对数码 → π（G-005）
 *
 *   π = 2^((k − 128) / 14.75)
 *
 * k = 0（或非有限、非正）→ 0，表示未知。
 */
export function decodePi(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 0;
  const code = Math.min(Math.max(Math.round(k), PI_CODE_MIN), PI_CODE_MAX);
  return Math.pow(2, (code - PI_BYTE_OFFSET) / PI_LOG2_SCALE);
}

/**
 * S-006 ICC 精度上限（G-006）
 *
 *   π_cap = ICC / ((1 − ICC) · τ²)
 *
 * - ICC ≤ 0 或非有限输入 → 0（无一致性即无精度可言，同时满足 S-007）
 * - 结果发散（ICC → 1、τ → 0）→ 按 σ 下限封顶到 400，不吐 Infinity
 * - ICC > 1 时 (1−ICC) 为负会算出**负 π**，而 π = 1/σ² 的定义域是 [0,400]，
 *   故下限同样截到 0（π=0 即未知），与 ICC≤0 同口径
 *
 * 整改 4（定义域统一）：ICC>1 **归 0** 而非抛异常——oracle v3 没有此函数
 * （只有基线 S-006 的公式），无可对齐对象；归 0 与 ICC≤0 同口径，
 * 语义是「无有效一致性即无精度」，且全输入域输出恒落在 [0,400]。
 */
export function iccPrecisionCap(icc: number, tau: number): number {
  if (!Number.isFinite(icc) || !Number.isFinite(tau) || icc <= 0) return 0;
  const cap = icc / ((1 - icc) * tau * tau);
  if (!Number.isFinite(cap)) return PI_MAX;
  return Math.min(Math.max(cap, 0), PI_MAX);
}
