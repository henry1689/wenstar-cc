/**
 * MemArch-v2.0.0 / M2-OnlineWrite / Gate
 *
 * 三岔门控：WRITE / RAW_ONLY / DISCARD
 *
 * 判定优先级（从高到低）：
 *   1. namespace='test' → DISCARD（测试数据隔离）
 *   2. 纯寒暄/元话语 → DISCARD
 *   3. salience ≥ 0.45 且有意义实体 → WRITE
 *   4. 其余 → RAW_ONLY（挂在 episode 上，等睡眠期复评）
 *
 * 设计依据：主设计文档 §4.2 / §16.3 encoding.write_threshold
 */

import { M2_CONFIG } from './config.js';
import type { WorkingEntry, Gate } from './types.js';
import { SalienceCalculator } from './SalienceCalculator.js';

export class GateDecider {
  private readonly writeThreshold = M2_CONFIG.encoding.write_threshold;
  private salienceCalc: SalienceCalculator;

  constructor() {
    this.salienceCalc = new SalienceCalculator();
  }

  /**
   * 门控判定
   * @param entry 工作记忆条目（已包含 salience 计算结果）
   */
  decide(entry: WorkingEntry): Gate {
    // 规则 1：测试命名空间直接 DISCARD（CI 隔离红线）
    if (entry.namespace === 'test') {
      return 'DISCARD';
    }

    // 规则 2：纯寒暄/元话语 → DISCARD
    if (this.salienceCalc.isSmallTalk(entry.content)) {
      return 'DISCARD';
    }

    // 规则 3：高显著性 + 有意义实体 → WRITE
    const salience = entry.salience ?? 0;
    const hasEntity = entry.has_meaningful_entity ?? false;

    if (salience >= this.writeThreshold && hasEntity) {
      return 'WRITE';
    }

    // 规则 4：其余 → RAW_ONLY（等睡眠期复评）
    return 'RAW_ONLY';
  }

  /**
   * 获取门控分布健康状态（Harness 监管用）
   */
  static healthCheck(distribution: { write: number; rawOnly: number; discard: number }) {
    const total = distribution.write + distribution.rawOnly + distribution.discard;
    if (total === 0) return { healthy: false, reason: 'no_data' };

    const writeRatio = distribution.write / total;
    const discardRatio = distribution.discard / total;

    const cfg = M2_CONFIG.gate_distribution;
    const writeOk = writeRatio >= cfg.write_min && writeRatio <= cfg.write_max;
    const discardOk = discardRatio >= cfg.discard_min && discardRatio <= cfg.discard_max;

    return {
      healthy: writeOk && discardOk,
      writeRatio: +writeRatio.toFixed(3),
      discardRatio: +discardRatio.toFixed(3),
      writeOk,
      discardOk,
    };
  }
}
