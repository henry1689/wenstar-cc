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
// 🔴 Phase 2.3 (F / T005): 配额段的类型定义真源在纯函数模块（零运行时依赖，type-only 引用不产生循环）
import type { RecallQuotaConfig } from '../m4/retrieval/recall-quota.js';

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
  /**
   * 🔴 V35-C(2026-10-05): 砂金库兜底（时间窗采样）**条数封顶**。
   *   它是"索引零命中时的最后手段"，不是默认填充 —— 原实现每次走满额 12 条，
   *   占记忆预算均值 66.7%，把与当前话题无关的旧原文倒进提示词。
   */
  sandbox_fallback_limit: number;
  /** 🔴 V35-C: 砂金库兜底允许占用的**记忆预算比例**上限（对话是主体，记忆是补充） */
  sandbox_max_ratio_of_memory: number;
  /**
   * 🔴 V35-C: 记忆块相对**对话历史体量**的比例上限 —— 落实业主裁定的「历史 ≥ 记忆」。
   *   实测修复前记忆 8836 字符 vs 历史 4740 字符（1.9×），模型注意力被"过去的素材"带走。
   */
  memory_max_ratio_of_history: number;
  /**
   * 🔴 Phase 2.2 (B1 / T004): 会晤**高钙对话组**通道的独立配额 —— 每轮最多注入几组。
   *   与 memories 槽位（近期8 / 历史6 / 关键词4 / 最早6 / 锚点4）**互不占用**：
   *   这是组级（A 链路）的名额，不是单条记忆的名额 —— 高钙组挤占记忆槽 = 任务书明令禁止。
   */
  high_calcium_group_limit: number;
  /** 高钙阈值：`block_calcium_score >= 该值` 才进候选（与 2.1 lifecycle consolidating 同源阈值 5） */
  high_calcium_floor: number;
  /** 沉淀窗（分钟）：闭组不足该时长不参与召回（业主 2026-10-18 裁决） */
  high_calcium_settle_minutes: number;
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
  /**
   * 🔴 Phase 2.3 (F / T005): A/B 链路统一召回配额。
   * 真源代码 src/m4/retrieval/recall-quota.ts（纯函数），接线在 webui/chat/retrieval-stage.ts。
   * 开关语义：`enabled=false` = **不裁剪**（回到 2.3 之前的行为）——
   * 与 `budget.high_calcium_group_limit`（注册级：关掉即高钙整路不存在）是**两件事**，勿混淆。
   */
  recall_quota: RecallQuotaConfig;
  /**
   * 🔴 对话块召回开关（2026-11-02 由 v11 召回实现取代 n-gram 版本）。
   *
   * 开 = 注册 DialogGroupAdapter，其内部走 `recallByStructured(domain='dialog_group')`
   *      + `scoreAndRank`（与记忆召回同一套 UUID 闸门、分片围栏与四权重精排）。
   * 关 = 该路不注册，检索链路回到「单条消息」。
   *
   * 🔴 业主 2026-11-02 裁决「绝对不用旧方案兜底」：关闭本开关**不会**回退到
   *    n-gram 倒排实现——旧实现在 B2 批次已删除，不存在第二条路径。
   *
   * 之所以是**注册级**开关而非查询级：注册表在编排层构造，关掉即整条路不存在，
   * 不存在"开关关了但某处仍在查"的半失效状态。
   */
  dialog_group_v11_recall: boolean;
}

// ── 默认值（yaml 缺失时兜底，保持系统可用）──
const DEFAULTS: RetrievalFusionConfig = {
  inject_priority: { archive_tag: 0.95, black_diamond: 0.9, vault: 0.7, memory_normal: 0.6 },
  timeline_weight: { base: 0.3, scale: 0.2, cap: 0.9, min_val: 0.6 },
  foundation_rrf_domain_weight: { black_diamond: 0.25, vault: 0.12, knowledge: 0.15, sand_memory: 0.1, high_calcium_group: 0.30 },
  v13_rrf_weights: { spine: 0.35, keyword: 0.3, work: 0.25, entity: 0.2, emotion: 0.1, locus: 0.05, multi_hit_bonus: 1.2 },
  budget: { mem_ratio_normal: 0.6, kb_ratio_normal: 0.4, mem_ratio_longtext: 0.3, kb_ratio_longtext: 0.15, longtext_max_ratio: 0.8, work_max_chars: 4000, hard_max_chars: 8000, sandbox_fallback_limit: 2, sandbox_max_ratio_of_memory: 0.3, memory_max_ratio_of_history: 1.0, high_calcium_group_limit: 5, high_calcium_floor: 5, high_calcium_settle_minutes: 30 },
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
  // Phase 2.3 (F / T005): A/B 链路统一召回配额 —— yaml 缺失时按业主裁决的比例兜底
  recall_quota: {
    enabled: true, release_empty_class_quota: true, generic_query_min_hits: 1,
    meeting: { high_calcium_group: 0.4, block_summary: 0.4, recent_memory: 0.2 },
    normal: { block_summary: 0.6, high_calcium_group: 0.4 },
    generic_query_high_calcium: 0.15,
  },
  // 对话块召回。yaml 缺失时默认开（块检索是本期交付的能力）
  dialog_group_v11_recall: true,
};

let _cache: RetrievalFusionConfig | null = null;

/** 加载配置（带缓存） */
export function getRetrievalFusionConfig(): RetrievalFusionConfig {
  if (_cache) return _cache;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<RetrievalFusionConfig>;
    // Phase 2.3 (F): 配额段的原始值（YAML 里可能只写一部分字段，故按 Partial 处理）
    const _rqRaw: Partial<RecallQuotaConfig> = parsed.recall_quota || {};
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
      // Phase 2.3 (F): 配额段**逐层**合并 —— yaml 只写一段也只会覆盖该段，
      // 不会让另一个场景（meeting/normal）整体变 undefined（浅合并会踩这个坑）
      recall_quota: {
        ...DEFAULTS.recall_quota,
        ..._rqRaw,
        meeting: { ...DEFAULTS.recall_quota.meeting, ...(_rqRaw.meeting || {}) },
        normal: { ...DEFAULTS.recall_quota.normal, ...(_rqRaw.normal || {}) },
      },
      // 布尔开关不能走 `?? ` 之外的隐式转换：显式判 undefined，避免 yaml 写 false 被当成缺失
      dialog_group_v11_recall: parsed.dialog_group_v11_recall === undefined
        ? DEFAULTS.dialog_group_v11_recall
        : parsed.dialog_group_v11_recall === true,
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
