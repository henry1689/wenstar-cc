/**
 * perception-40d-config — 40D 感知向量双轨开关
 * ============================================================
 * 🔴 双轨制：24D（Perception24D）接口兼容层保留（旧字段名），40D 为新标准；
 * 40D（PerceptionV40）通过此开关渐进启用，验证后切默认值。
 *
 * 开关行为：
 *   PERCEPTION_40D=false → 40D 不参与检索（旧24D字段兼容）
 *   PERCEPTION_40D=true（默认）→ 40D 参与检索（混合检索 + 40D 重排）
 *   回退：开关关回即恢复 24D 检索，零数据迁移成本
 * 🔴 默认 true：40D 已全链路验证（覆盖率100%），作为目标态默认开启；降级时置 false
 */
import { ConfigService } from './ConfigService.js';

/** 40D 感知向量双轨开关（默认 true，env 读取） */
export function isPerception40DEnabled(): boolean {
  return ConfigService.getBool('PERCEPTION_40D', true);
}

/** 40D 感知向量旁路写入开关（独立控制：即使检索未启用，也持续收集 v2 数据） */
export function isPerception40DCollectEnabled(): boolean {
  return ConfigService.getBool('PERCEPTION_40D_COLLECT', true);
}

/** V3.1: 40D 主模式 — 全面停止 24D 独立运行，检索只走 40D。
 *  🔴 V12.4 阶段B 根除24D: 默认已改为 true（perception_json 列已删，24D 检索路径退役，
 *     仅剩 40D 路径可选；置 false 时 findByEmotionalSimilarity 仍固定走 40D，此开关仅保留
 *     兼容位，不影响检索行为）。
 *  true：检索只用 40D 余弦；24D 接口仅作 M3 内部语义引擎（兼容层） */
export function isPerception40DOnly(): boolean {
  return ConfigService.getBool('PERCEPTION_40D_ONLY', true);
}
