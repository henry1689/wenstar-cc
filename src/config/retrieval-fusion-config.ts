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

/**
 * MEM-UNIFY-V1 批4：深度收集配置（`meeting-recall.sweepAllStores` 的候选限额与注入预算）。
 * 注意：候选限额**不是**注入上限 —— 注入由 `max_chars` 字符预算决定。
 */
export interface DeepSweepConfig {
  /** 总开关：false = 普通/会晤分支都不做深度收集（回批3 行为） */
  enabled: boolean;
  /** 每关键词每仓候选条数 */
  per_kw: {
    memories: number;
    diamond: number;
    knowledge: number;
    shared_knowledge: number;
    conversation: number;
  };
  /** 单条片段字符上限（原 110 字硬顶的可配替代） */
  per_fragment_chars: number;
  /** 整编注入总字符预算（原 12 条硬顶的可配替代） */
  max_chars: number;
  /** 安全条数上限（防异常数据撑爆提示词） */
  safety_max_frags: number;
  /** 知识库无归属 = 共享（D5） */
  include_shared_knowledge: boolean;
  /** 收集对话原文 */
  include_conversations: boolean;
  /** 证据层（FG 档案 / 作品 / 记事） */
  evidence: {
    enabled: boolean;
    /** 每个关键词每路返回上限 */
    per_keyword: number;
    /** 最多取前 N 个关键词做证据检索 */
    max_keywords: number;
  };
}

/** MEM-UNIFY-V1 批4：主动回忆触发器配置（`m4/recall/proactive-trigger.ts`）。 */
export interface ProactiveConfig {
  /** 总开关：false = 不检测、不注入主动回忆指令 */
  enabled: boolean;
  festival: boolean;
  anniversary: boolean;
  emotion: boolean;
  routine: boolean;
  topic: boolean;
  /** 信号权重阈值（低于此值丢弃） */
  min_weight: number;
  /** 纪念日判定的钙化等级下限（与 is_landmark=1 取或） */
  anniversary_min_calcium: number;
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
  /**
   * 🔴 MEM-UNIFY-V1 批2A: 记忆召回总线配置（src/m4/recall/recall-bus.ts）。
   * 模式 → 层保底名额 → 单一五级闸门 → 反馈；名额由 YAML 驱动，禁止 ts 硬编码。
   */
  recall_bus: RecallBusConfig;
  /**
   * 🔴 MEM-UNIFY-V1 批4: 深度收集配置（meeting-recall.sweepAllStores / organizeForQuestion）。
   */
  deep_sweep: DeepSweepConfig;
  /**
   * 🔴 MEM-UNIFY-V1 批4: 主动回忆触发配置（m4/recall/proactive-trigger.ts）。
   */
  proactive: ProactiveConfig;
}

/** 一个召回模式的层保底名额（证据层 knowledge/long_text/work 只参与补足，不占三层名额） */
export interface RecallBusModeBudget {
  /** 本模式最多注入片段数 */
  total: number;
  /** 砂金层最小名额 */
  sand: number;
  /** 金库层最小名额 */
  gold: number;
  /** 黑钻层最小名额 */
  diamond: number;
  /** 对话组层最小名额 */
  group: number;
}

export interface RecallBusConfig {
  /** 总开关：false = 只去重+截断（一键回滚） */
  enabled: boolean;
  modes: Record<'casual' | 'standard' | 'deep' | 'proactive', RecallBusModeBudget>;
  /** 是否挂载五级闸门（默认 true；false 仅用于故障排查，不得常态关闭） */
  gate: { enabled: boolean };
  /** 是否回写 recall_count/last_recalled_at */
  feedback: { enabled: boolean };
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
  // MEM-UNIFY-V1 批2A: 召回总线默认名额（casual 轻档小预算完整总线；deep 给三层更多保底）
  recall_bus: {
    enabled: true,
    modes: {
      casual: { total: 5, sand: 1, gold: 1, diamond: 1, group: 1 },
      standard: { total: 8, sand: 2, gold: 1, diamond: 1, group: 1 },
      deep: { total: 15, sand: 3, gold: 2, diamond: 2, group: 2 },
      proactive: { total: 6, sand: 1, gold: 1, diamond: 1, group: 1 },
    },
    gate: { enabled: true },
    feedback: { enabled: true },
  },
  // MEM-UNIFY-V1 批4: 深度收集默认（取消 12 条/110 字硬顶 → 字符预算）
  deep_sweep: {
    enabled: true,
    per_kw: { memories: 2, diamond: 2, knowledge: 1, shared_knowledge: 1, conversation: 1 },
    per_fragment_chars: 400,
    max_chars: 6000,
    safety_max_frags: 48,
    include_shared_knowledge: true,
    include_conversations: true,
    evidence: { enabled: true, per_keyword: 3, max_keywords: 2 },
  },
  // MEM-UNIFY-V1 批4: 主动回忆默认（五类信号全开；阈值 0.4 让日常时段也能轻触发）
  proactive: {
    enabled: true,
    festival: true,
    anniversary: true,
    emotion: true,
    routine: true,
    topic: true,
    min_weight: 0.4,
    anniversary_min_calcium: 3,
  },
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
      // 🔴 MEM-UNIFY-V1 批2A: 召回总线段逐层合并（yaml 只写一个模式时其余模式保持默认）
      recall_bus: {
        ...DEFAULTS.recall_bus,
        ...(parsed.recall_bus || {}),
        modes: {
          casual: { ...DEFAULTS.recall_bus.modes.casual, ...(parsed.recall_bus?.modes?.casual || {}) },
          standard: { ...DEFAULTS.recall_bus.modes.standard, ...(parsed.recall_bus?.modes?.standard || {}) },
          deep: { ...DEFAULTS.recall_bus.modes.deep, ...(parsed.recall_bus?.modes?.deep || {}) },
          proactive: { ...DEFAULTS.recall_bus.modes.proactive, ...(parsed.recall_bus?.modes?.proactive || {}) },
        },
        gate: { ...DEFAULTS.recall_bus.gate, ...(parsed.recall_bus?.gate || {}) },
        feedback: { ...DEFAULTS.recall_bus.feedback, ...(parsed.recall_bus?.feedback || {}) },
      },
      // 🔴 MEM-UNIFY-V1 批4: 深度收集与主动回忆逐层合并（yaml 只写一段不丢另一段）
      deep_sweep: {
        ...DEFAULTS.deep_sweep,
        ...(parsed.deep_sweep || {}),
        per_kw: { ...DEFAULTS.deep_sweep.per_kw, ...(parsed.deep_sweep?.per_kw || {}) },
        evidence: { ...DEFAULTS.deep_sweep.evidence, ...(parsed.deep_sweep?.evidence || {}) },
      },
      proactive: { ...DEFAULTS.proactive, ...(parsed.proactive || {}) },
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
