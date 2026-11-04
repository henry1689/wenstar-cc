/**
 * 昼夜相位（S-009a / 勘误 E-20、E-24）
 *
 * E-24 拆分：S-009a（本文件，core）只做分钟数→(sin, cos) 纯函数；
 * S-009b（后续 adapter 切片）负责时区、时钟注入、夏令时日（23/25 小时）
 * 与跨零点行为——那些需要 Date/时区库，core 禁止引入。
 *
 * D39 / D40 存的是一天中的相位，按**本地钟表时间**计算，
 * 存为 (sin θ, cos θ) 两个分量，精度固定 π = 400。
 *
 * 用正余弦双分量而非单角度存储，是为了让 23:59 与 00:01 在向量空间里
 * 相邻——单角度在 0/2π 处会跳变，导致跨零点被判成「隔了一整天」。
 */

import { MINUTES_PER_DAY, PI_MAX } from './config.js';

/** 昼夜相位读数 */
export interface DialPhase {
  readonly sin: number;
  readonly cos: number;
  /** 精度固定为 400（σ 下限 0.05），由 E-20 裁定 */
  readonly pi: number;
}

/**
 * S-009a 由本地分钟数求昼夜相位（G-009）
 *
 *   θ = 2π · 本地分钟数 / 1440
 *   输出 (sin θ, cos θ)，π = 400
 *
 * 纯函数：core 禁止 Date.now / 时区库，取「现在几点」是调用方（IO 层）
 * 的职责，本函数只负责把分钟数换算成相位。
 *
 * 分钟数按一天取模归一（含负数），因此 1440 与 0 等价。
 * 非有限输入 → 未知（sin/cos 置 0，pi = 0），满足 S-007。
 */
export function phaseFromLocalMinutes(minutes: number): DialPhase {
  if (!Number.isFinite(minutes)) return { sin: 0, cos: 0, pi: 0 };
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const theta = (2 * Math.PI * normalized) / MINUTES_PER_DAY;
  return { sin: Math.sin(theta), cos: Math.cos(theta), pi: PI_MAX };
}
