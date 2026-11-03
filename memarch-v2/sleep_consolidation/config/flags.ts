/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / config/flags
 *
 * 全局总开关与功能标志
 * 遵循主文档第十六章接口契约
 */

export interface FeatureFlags {
  /** 遗忘总开关：0 = 只计算不执行（dry-run），1 = 实际执行 purge/tombstone */
  MEMORY_FORGET_ENABLED: 0 | 1;
  /** 是否启用 LLM 精确显著性打分（关闭则降级为规则版） */
  LLM_SALIENCE_ENABLED: boolean;
  /** 是否启用 episode gist 生成（LLM） */
  LLM_GIST_ENABLED: boolean;
  /** 是否启用语义萃取（semantic_facts 抽取） */
  SEMANTIC_EXTRACTION_ENABLED: boolean;
  /** 是否启用 STC（Systemic Consolidation Marker）标记 */
  STC_MARKER_ENABLED: boolean;
  /** 小睡模式：只跑轻量步骤（RAW_ONLY 快速复评 + 晋升推进） */
  NAP_MODE: boolean;
}

/** 默认标志（从环境变量覆盖） */
export function loadFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return {
    MEMORY_FORGET_ENABLED: (env.MEMORY_FORGET_ENABLED === '1' ? 1 : 0) as 0 | 1,
    LLM_SALIENCE_ENABLED: env.LLM_SALIENCE_ENABLED !== '0',
    LLM_GIST_ENABLED: env.LLM_GIST_ENABLED !== '0',
    SEMANTIC_EXTRACTION_ENABLED: env.SEMANTIC_EXTRACTION_ENABLED !== '0',
    STC_MARKER_ENABLED: env.STC_MARKER_ENABLED !== '0',
    NAP_MODE: env.SLEEP_NAP_MODE === '1',
  };
}
