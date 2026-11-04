/**
 * MemArch-v2.0.0 / M5-Presentation (MemSym) / types.ts
 *
 * M5 内部统一类型契约。
 * 与 M4 Evidence 的适配放在 fromM4Evidence()，避免 M5 直接依赖 M4 模块路径。
 * 与 M2/M3 的回写通过接口（ReinforceSink / WriteSink / PathwayStore）注入，
 * 遵循依赖倒置——M5 不直接 import M2/M3 实现。
 */

// ============================================================
// 1. 证据条目（M5 内部视图）
// ============================================================

/** 通路：A=可直出的强记忆，B=仅可暗示的弱记忆 */
export type Pathway = 'A' | 'B';

/**
 * M5 看到的证据条目。
 * 字段对齐任务书：uuid / raw_text / timestamp / score / tombstone / suppressed / pathway
 * 同时保留 M4 已有的 strength / recency / source_namespace 供标签判定使用。
 */
export interface NormalizedEvidence {
  /** 记忆节点 UUID（对应 M4 Evidence.memory_id） */
  uuid: string;
  /** 原文（对应 M4 Evidence.text） */
  raw_text: string;
  /** 产生时间 epoch ms */
  timestamp: number;
  /** 融合后得分 [0,1]，由 M4 给出 */
  score: number;
  /** 距今天数（0=今天） */
  recency: number;
  /** M3 巩固度 [0,1] */
  strength: number;
  /** M1 视图命名空间 */
  source_namespace: string;
  /** 墓碑：true 表示已被标记删除，M5 必须不可见 */
  tombstone: boolean;
  /** 抑制：true 表示敏感/低置信，只允许走通路 B */
  suppressed: boolean;
  /** 通路归属：A=可直出，B=仅暗示；由检索阶段或 B→A 升级器决定 */
  pathway: Pathway;
  /** 命中的召回路（诊断用） */
  recall_sources?: string[];
  /** 提取出的实体（诊断用） */
  entities?: string[];
}

/**
 * 从 M4 的 Evidence 结构做适配映射。
 * M4 Evidence 没有 tombstone/suppressed/pathway 字段——这三个由上游在返回前
 * 注入（见 M1 视图层），或在这里按合理默认补齐：
 *   - tombstone 默认 false（M4 召回阶段本应已过滤，这里兜底再判一次）
 *   - suppressed 默认 false
 *   - pathway 默认 'A'（若 suppressed=true，路由层会强制改判为 B）
 */
export interface M4EvidenceLike {
  memory_id: string;
  text: string;
  score: number;
  timestamp: number;
  recency: number;
  strength: number;
  source_namespace: string;
  recall_sources?: string[];
  entities?: string[];
  /** M4 可选扩展字段（视图层注入） */
  tombstone?: boolean;
  suppressed?: boolean;
  pathway?: Pathway;
}

export function fromM4Evidence(m4: M4EvidenceLike): NormalizedEvidence {
  const tombstone = m4.tombstone === true;
  const suppressed = m4.suppressed === true;
  let pathway: Pathway = m4.pathway ?? 'A';
  // 硬规则：suppressed 一律压到 B，绝不许漏到 A
  if (suppressed && pathway === 'A') pathway = 'B';
  return {
    uuid: m4.memory_id,
    raw_text: m4.text,
    timestamp: m4.timestamp,
    score: clamp01(m4.score),
    recency: Math.max(0, m4.recency),
    strength: clamp01(m4.strength),
    source_namespace: m4.source_namespace,
    tombstone,
    suppressed,
    pathway,
    recall_sources: m4.recall_sources,
    entities: m4.entities,
  };
}

// ============================================================
// 2. 证据标签四档
// ============================================================

/** 「记得」/「印象」/「线索」/「不说」 */
export type EvidenceLabel = 'remembered' | 'impression' | 'clue' | 'refused';

export const LABEL_CN: Record<EvidenceLabel, string> = {
  remembered: '记得',
  impression: '印象',
  clue: '线索',
  refused: '不说',
};

// ============================================================
// 3. 路由结果
// ============================================================

/**
 * 通路 A 概率 p_A ∈ [0,1]。
 * >= p_A_high → A_direct 直出
 * in [p_A_low, p_A_high) → hybrid 混合拼接
 * < p_A_low → B_only 降级暗示
 */
export type RoutedPath = 'A_direct' | 'hybrid' | 'B_only';

// ============================================================
// 4. 对外输出
// ============================================================

/** 从候选输出中抽出的可验证断言（OutputGuard 用） */
export interface Assertion {
  /** 原子分句原文 */
  text: string;
  /** 抽取到的实体重心词（用于在证据原文里做包含验证） */
  tokens: string[];
  /** 支撑它的证据 uuid（guard 通过时填充） */
  supportedBy?: string;
}

export interface PresentationResult {
  /** 最终 utterance（已过 guard） */
  utterance: string;
  /** 四档标签 */
  label: EvidenceLabel;
  /** 路由结果 */
  routed_path: RoutedPath;
  /** 通路 A 概率 */
  p_A: number;
  /** OutputGuard 是否通过（false 表示 utterance 已被降级或吞掉） */
  guard_passed: boolean;
  /** 被 guard 丢弃的断言（无证据支撑） */
  dropped_assertions: Assertion[];
  /** 实际采用的证据 uuid 列表（审计用） */
  used_uuids: string[];
}

// ============================================================
// 5. 强化归因
// ============================================================

/** 四类用户反馈信号 */
export type AttributionSignal = 'confirm' | 'engaged' | 'ignored' | 'correct';

export interface AttributionHit {
  uuid: string;
  signal: AttributionSignal;
  /** 触发的关键词/证据片段（诊断用） */
  reason: string;
}

// ============================================================
// 6. 外部依赖接口（依赖倒置，由 M1/M2/M3 注入实现）
// ============================================================

/**
 * M3 reinforce 接口——M5 不直接 import M3，只依赖此接口。
 * signal 语义：
 *   - 'positive'  confirm/engaged → 强化激活度
 *   - 'negative'  ignored → 轻微衰减
 *   - 'decay'     correct 时旧版本进入衰减队列（不删除）
 */
export type ReinforceSignal = 'positive' | 'negative' | 'decay';

export interface ReinforceSink {
  reinforce(uuid: string, signal: ReinforceSignal): void;
}

/**
 * M2 online_write 写入接口——再巩固时写新版本走这里。
 * 签名对齐 M2 MemoryWriter.write(WriteMessageInput) → WriteResult，
 * M5 只依赖最小子集。
 */
export interface WriteInput {
  message_id: string;
  role: string;
  content: string;
  ts_utc?: number;
  namespace?: string;
}
export interface WriteResult {
  trace_id?: string;
  gate?: string;
}
export interface WriteSink {
  write(input: WriteInput): WriteResult;
}

/**
 * M1 视图层通路回写接口——B→A 升级时更新某条记忆的通路归属。
 * M5 不直接查底层表，通过此接口走 M1 视图。
 */
export interface PathwayStore {
  /** 读：某 uuid 当前通路 */
  getPathway(uuid: string): Pathway;
  /** 写：升级通路（B→A），带强化计数 */
  promoteToA(uuid: string, boost: number): void;
  /** 读：累计强化次数（用于 B→A 升级阈值判定） */
  getReinforcementCount(uuid: string): number;
  /** 累加一次强化 */
  bumpReinforcement(uuid: string): number;
}

// ============================================================
// 7. 工具
// ============================================================

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
