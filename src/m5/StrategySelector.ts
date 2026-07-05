/**
 * M5 Step 2: 策略选择 — 规则引擎，零LLM
 *
 * v2: 生成温度由 M3 感知维度（arousal/pleasure）综合计算，
 * 替换固定温度逻辑，全链路情感口径唯一。
 */
import type { CognitionObject, StrategyConfig } from './types/index.js';
import type { M3Action } from '../m3/types/perception.js';
import { M5_CONFIG } from '../config/M5Config.js';

export class StrategySelector {
  select(cognition: CognitionObject): StrategyConfig {
    const action = cognition.current.action;
    const template = this.selectTemplate(action, cognition);
    const tpl = M5_CONFIG.strategy.templates[template as keyof typeof M5_CONFIG.strategy.templates]
      ?? M5_CONFIG.strategy.templates['mem-general'];

    // P1-2: 生成温度由 M3 感知维度计算
    const temperature = this.calcTemperature(cognition);

    return {
      strategy_id: template,
      params: {
        tone: cognition.strategy_hint.tone,
        temperature,
        max_length: tpl.maxLength,
        include_entity: cognition.current.key_entities,
        include_history: cognition.history.has_relevant_history,
        include_family: cognition.family?.has_family_context ?? false,
      },
      description: tpl.description,
    };
  }

  /**
   * P1-2: 基于 M3 感知维度计算生成温度
   *
   * arousal（唤醒度）高 → 温度偏高，回应更丰富强烈
   * arousal 低 → 温度偏低，回应更平稳温和
   * pleasure（愉悦度）高 → 适当加温，反馈积极情绪
   * pleasure 低 → 适当减温，避免轻浮回应
   */
  private calcTemperature(cognition: CognitionObject): number {
    const tc = M5_CONFIG.temperature;
    let temp = tc.base;
    const p = cognition.current.perception_snapshot;

    if (p.arousal >= 0.5) temp += tc.highArousalBonus;
    else if (p.arousal < 0.2) temp += tc.lowArousalPenalty;

    if (p.pleasure >= 0.5) temp += tc.highPleasureBonus;
    else if (p.pleasure <= -0.3) temp += tc.lowPleasurePenalty;

    return Math.max(tc.minTemperature, Math.min(tc.maxTemperature, Math.round(temp * 100) / 100));
  }

  private selectTemplate(actions: M3Action[], _cognition: CognitionObject): string {
    if (actions.includes('act')) return 'act-core';
    if (actions.includes('comfort')) return 'com-warm';
    if (actions.includes('ask') && actions.includes('memorize')) return 'mem-ask';
    if (actions.includes('ask')) return 'ask-curious';
    return 'mem-general';
  }
}
