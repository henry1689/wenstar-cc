/**
 * llm-config — LLM 参数统一配置中心
 *
 * 📜 架构优化：温度/超时/重试/推理参数按场景分组
 * 一处修改，全局生效
 */

import type { RoleType } from '../../app/role/RoleClassifier.js';

/** 场景类型 */
export type LLMScenario = 'daily' | 'recall' | 'intimate' | 'roleplay' | 'short_mode';

/** 单场景参数配置 */
export interface LLMScenarioConfig {
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  frequencyPenalty: number;
  presencePenalty: number;
  reasoningEffort?: 'low' | 'medium' | 'max';
}

/** 所有场景参数（权威来源） */
const SCENARIO_CONFIGS: Record<LLMScenario, LLMScenarioConfig> = {
  /** 日常对话：中性情绪、工作、闲聊 */
  daily: {
    temperature: 0.9,
    maxTokens: 1200,
    timeoutMs: 10_000,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
  },

  /** 回忆/分享：需要更多创造力和输出长度 */
  recall: {
    temperature: 1.0,
    maxTokens: 1500,
    timeoutMs: 10_000,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
  },

  /** 亲密场景：高创造、长输出、宽松惩罚 */
  intimate: {
    temperature: 1.0,
    maxTokens: 2500,
    timeoutMs: 20_000,
    frequencyPenalty: 0.0,
    presencePenalty: 0.2,
  },

  /** 角色扮演：低温度、高推理、中等输出 */
  roleplay: {
    temperature: 0.4,
    maxTokens: 1500,
    timeoutMs: 15_000,
    frequencyPenalty: 0.1,
    presencePenalty: 0.5,
    reasoningEffort: 'max',
  },

  /** 简短模式：极短输出 */
  short_mode: {
    temperature: 0.4,
    maxTokens: 600,
    timeoutMs: 10_000,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
  },
};

/** 场景检测规则 */
type ScenarioRule = {
  match: (level: number, rawInput: string, role: RoleType) => boolean;
  scenario: LLMScenario;
};

const SCENARIO_RULES: ScenarioRule[] = [
  // 角色扮演优先检测
  { match: (_l, _r, role) => role === 'recaller', scenario: 'roleplay' },
  // 故事/长文创作
  { match: (_l, r, _role) => /讲(个|一)?故事|写(个|一)?小说/.test(r), scenario: 'recall' },
  // 回忆/分享
  { match: (_l, r, _role) => /感觉|感受|回忆|分享|记得|印象|那时|那次/.test(r), scenario: 'recall' },
  // 亲密场景
  { match: (l, _r, role) => l >= 2 || role === 'lover', scenario: 'intimate' },
];

/**
 * 根据情绪等级 + 用户消息 + 角色 选择场景配置
 */
export function selectLLMConfig(level: number, rawInput: string, role?: RoleType): LLMScenarioConfig {
  for (const rule of SCENARIO_RULES) {
    if (rule.match(level, rawInput, role as RoleType)) {
      return SCENARIO_CONFIGS[rule.scenario];
    }
  }
  return SCENARIO_CONFIGS['daily'];
}

/** 获取指定场景的配置（直接查表） */
export function getScenarioConfig(scenario: LLMScenario): LLMScenarioConfig {
  return SCENARIO_CONFIGS[scenario];
}

export { SCENARIO_CONFIGS, SCENARIO_RULES };
