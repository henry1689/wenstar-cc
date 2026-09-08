/**
 * retrieval-fusion-config — 天枢检索融合权重配置加载器
 * ============================================================
 * 从 config/retrieval-fusion.config.yaml 读取所有权重/预算/阈值，
 * 供 MemoryInjector / RRFFusion / fusion.ts 使用，消除 ts 硬编码魔法数字。
 *
 * 铁律：所有权重数字只在此 yaml 定义，代码通过本模块读取。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'retrieval-fusion.config.yaml');

/** 注入层权重 */
export interface InjectPriorityConfig {
  archive_tag: number;
  black_diamond: number;
  vault: number;
  memory_normal: number;
}
export interface TimelineWeightConfig {
  base: number;
  scale: number;
  cap: number;
  min_val: number;
}
export interface BudgetConfig {
  mem_ratio_normal: number;
  kb_ratio_normal: number;
  mem_ratio_longtext: number;
  kb_ratio_longtext: number;
  longtext_max_ratio: number;
  work_max_chars: number;
  hard_max_chars: number;
}
export interface FilterConfig {
  min_similarity: number;
  max_fusion_items: number;
}
/** 🔴 第二阶段 P0: 响应速度专项 — 精筛/分级/条数限制配置 */
export interface SpeedFilterConfig {
  /** P0-1 二次精筛阈值: 记忆 vs 用户 query 的相关性低于此值丢弃 [0,1] */
  second_filter_threshold: number;
  /** P0-3 普通碎片(sand/timeline)入池上限，超出按 priority 取前 N 条 */
  max_normal_memory_count: number;
  /** 2026-09-09: 会晤场景普通碎片入池上限（实体会晤承载"昨天一天记忆"，放宽 10→20） */
  meeting_max_normal_memory_count: number;
  /** P0-2 会话模式分级加载总开关: false 时强制 standard，一键回退 */
  prompt_depth_enabled: boolean;
}

/** 🔴 第二阶段 P1: 流式输出配置 */
export interface StreamingConfig {
  enabled: boolean;
  job_ttl_ms: number;
  poll_hint_ms: number;
}
/** 🔴 第二阶段 P1: LLM 调用削减 + 外部熔断配置（不牺牲质量，会晤旁路） */
export interface LLMReductionConfig {
  enabled: boolean;
  meeting_bypass: boolean;
  entity_conditional: boolean;
  pae_timeout_ms: number;
  pae_signal_shortcircuit: boolean;
  kb_route_rule: boolean;
  bionic_health_shortcircuit: boolean;
  bionic_timeout_ms: number;
}
export interface P1SpeedConfig {
  streaming: StreamingConfig;
  llm_reduction: LLMReductionConfig;
}

export interface RetrievalFusionConfig {
  inject_priority: InjectPriorityConfig;
  timeline_weight: TimelineWeightConfig;
  foundation_rrf_domain_weight: Record<string, number>;
  v13_rrf_weights: Record<string, number> & { multi_hit_bonus: number };
  budget: BudgetConfig;
  filter: FilterConfig;
  speed_filter: SpeedFilterConfig;
  p1_speed: P1SpeedConfig;
}

// ── 默认值（yaml 缺失时兜底，保持系统可用）──
const DEFAULTS: RetrievalFusionConfig = {
  inject_priority: { archive_tag: 0.95, black_diamond: 0.9, vault: 0.7, memory_normal: 0.6 },
  timeline_weight: { base: 0.3, scale: 0.2, cap: 0.9, min_val: 0.6 },
  foundation_rrf_domain_weight: { black_diamond: 0.25, vault: 0.12, knowledge: 0.15, sand_memory: 0.1 },
  v13_rrf_weights: { spine: 0.35, keyword: 0.3, work: 0.25, entity: 0.2, emotion: 0.1, locus: 0.05, multi_hit_bonus: 1.2 },
  budget: { mem_ratio_normal: 0.6, kb_ratio_normal: 0.4, mem_ratio_longtext: 0.3, kb_ratio_longtext: 0.15, longtext_max_ratio: 0.8, work_max_chars: 4000, hard_max_chars: 8000 },
  filter: { min_similarity: 0.6, max_fusion_items: 16 },
  speed_filter: { second_filter_threshold: 0.15, max_normal_memory_count: 10, meeting_max_normal_memory_count: 20, prompt_depth_enabled: true },
  p1_speed: {
    streaming: { enabled: true, job_ttl_ms: 180000, poll_hint_ms: 150 },
    llm_reduction: {
      enabled: true, meeting_bypass: true, entity_conditional: true,
      pae_timeout_ms: 8000, pae_signal_shortcircuit: true,
      kb_route_rule: true, bionic_health_shortcircuit: true, bionic_timeout_ms: 2500,
    },
  },
};

let _cache: RetrievalFusionConfig | null = null;

/** 加载配置（带缓存） */
export function getRetrievalFusionConfig(): RetrievalFusionConfig {
  if (_cache) return _cache;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<RetrievalFusionConfig>;
    // 深合并默认值
    _cache = {
      inject_priority: { ...DEFAULTS.inject_priority, ...(parsed.inject_priority || {}) },
      timeline_weight: { ...DEFAULTS.timeline_weight, ...(parsed.timeline_weight || {}) },
      foundation_rrf_domain_weight: { ...DEFAULTS.foundation_rrf_domain_weight, ...(parsed.foundation_rrf_domain_weight || {}) },
      v13_rrf_weights: { ...DEFAULTS.v13_rrf_weights, ...(parsed.v13_rrf_weights || {}) },
      budget: { ...DEFAULTS.budget, ...(parsed.budget || {}) },
      filter: { ...DEFAULTS.filter, ...(parsed.filter || {}) },
      speed_filter: { ...DEFAULTS.speed_filter, ...(parsed.speed_filter || {}) },
      p1_speed: {
        streaming: { ...DEFAULTS.p1_speed.streaming, ...(parsed.p1_speed?.streaming || {}) },
        llm_reduction: { ...DEFAULTS.p1_speed.llm_reduction, ...(parsed.p1_speed?.llm_reduction || {}) },
      },
    };
  } catch (e) {
    console.warn('[RetrievalFusionConfig] yaml 加载失败，使用默认值:', (e as Error)?.message);
    // 🔴 D6 修复: 返回深拷贝（避免调用方误改共享 DEFAULTS 污染全局）
    _cache = JSON.parse(JSON.stringify(DEFAULTS)) as RetrievalFusionConfig;
  }
  return _cache;
}

/**
 * 重新加载（配置变更后调用）。
 * 🔴 D5 说明: RRF 权重（RRFFusion/fusion.ts）在模块加载时 IIFE 冻结，
 * reload 对 RRF 层不生效，仅 MemoryInjector（每调用读一次）会更新。
 * RRF 权重属启动级配置，运行时热更非核心需求——如需热更 RRF，
 * 需将 DEFAULT_RRF_CONFIG/FOUNDATION_DEFAULT_WEIGHTS 改为函数内读取（影响所有引用方）。
 */
export function reloadRetrievalFusionConfig(): RetrievalFusionConfig {
  _cache = null;
  return getRetrievalFusionConfig();
}
