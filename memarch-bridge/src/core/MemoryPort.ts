/**
 * MemoryPort.ts — 依赖倒置端口（Port）
 *
 * 【设计意图】
 *   主系统（src/**）只依赖本文件定义的抽象接口（Port），
 *   不直接 import 旧记忆实现（src/m2, src/m4, src/m5...）
 *   也不直接 import 新 MemArch v2（memarch-v2/**）。
 *
 *   具体走旧实现还是新实现，由 BridgeRegistry + FeatureFlag 决定，
 *   主系统零感知 —— 这是「结构级解决而非打补丁」的核心。
 *
 * 【六类端口 ↔ 新 M1-M6 映射】
 *   MemoryWritePort      → M2 MemoryWriter（写在线路径）
 *   MemoryRetrievePort   → M4 Retriever（检索路径）
 *   MemoryPresentPort    → M5 PresentationEngine（呈现层）
 *   MemoryAssessPort     → M3 SleepOrchestrator / PromotionEvaluator（评估/巩固）
 *   MemoryStoragePort    → M1 WriteQueue / Storage（底层存储）
 *   MemoryGatePort       → M2 Gate + M5 router（门控/路由）
 *   MemoryConfigPort     → 全局配置（M2/M4/M5 配置合并视图）
 *
 * 【硬性约束】
 *   - 所有方法必须显式带 namespace 入参（角色隔离由 NamespaceContext 兜底）
 *   - 不允许出现无 namespace 的裸读写
 *   - 返回值结构稳定，新旧实现不得改变 Port 签名
 */

// ============================================================
// 公共类型
// ============================================================

/** 命名空间标识（角色物理隔离键） */
export type Namespace = string;

/** 记忆条目（Port 层统一视图，屏蔽新旧 schema 差异） */
export interface MemoryEntry {
  /** 业务唯一 ID（幂等键） */
  messageId: string;
  /** 所属命名空间（角色） */
  namespace: Namespace;
  /** 角色：user / assistant / system */
  role: 'user' | 'assistant' | 'system' | string;
  /** 原文内容 */
  content: string;
  /** UTC epoch ms */
  tsUtc: number;
  /** 事件 episode id（可选） */
  episodeId?: string;
  /** 显著度 [0,1] */
  salience?: number;
  /** 门控结果 */
  gate?: 'WRITE' | 'RAW_ONLY' | 'DISCARD';
  /** L3 痕迹 UUID（WRITE 门控后有值） */
  traceId?: string;
  /** 敏感度 0/1/2 */
  sensitivity?: 0 | 1 | 2;
  /** 角色扮演角色名（玉瑶/诗雨/王全芬...） */
  roleplayChar?: string;
  /** 任意扩展字段 */
  metadata?: Record<string, unknown>;
}

/** 检索结果条目 */
export interface RetrievedEvidence {
  /** 痕迹 UUID */
  uuid: string;
  /** 所属命名空间 */
  namespace: Namespace;
  /** 原文 */
  rawText: string;
  /** 摘要 */
  summary?: string;
  /** 相关度分数 */
  score: number;
  /** 来源通路（A=直引 / B=模糊） */
  pathway?: 'A' | 'B';
  /** 钙化等级 / 巩固度 */
  consolidation?: number;
  /** 生命周期状态 */
  lifecycle?: 'fresh' | 'consolidated' | 'calcium' | 'tombstone';
  /** 命中的召回腿 */
  recallLeg?: string;
  /** 时间戳 */
  tsUtc?: number;
}

/** 检索结果 */
export interface RetrieveResult {
  evidence: RetrievedEvidence[];
  metrics: {
    totalMs: number;
    recallLegMs: Record<string, number | null>;
    degradedLegs: string[];
    rerankSkipped: boolean;
    finalCount: number;
  };
}

/** 呈现层输出 */
export interface PresentResult {
  /** 最终给用户看的 utterance */
  utterance: string;
  /** 证据标签 */
  label: string;
  /** 路由通路 */
  routedPath: 'A_direct' | 'hybrid' | 'B_only';
  /** A 通路置信概率 */
  pA: number;
  /** Guard 是否通过 */
  guardPassed: boolean;
  /** 被丢弃的断言 */
  droppedAssertions: string[];
  /** 实际用到的证据 UUID 列表 */
  usedUuids: string[];
}

// ============================================================
// 七类端口（对应旧系统 7 个调用面）
// ============================================================

/**
 * P1: MemoryWritePort — 在线写入
 * 适配旧：src/m2/（MemoryWriteGateway / DualHelixWriter / ConversationDB）
 * 对接新：memarch-v2/online_write/MemoryWriter
 */
export interface MemoryWritePort {
  /** 写入一条消息（幂等：同 messageId 返回同结果） */
  write(entry: MemoryEntry): Promise<WritePortResult>;
  /** 批量写入（迁移/回放用） */
  writeBatch(entries: MemoryEntry[]): Promise<WritePortResult[]>;
  /** 恢复未处理缓冲（进程启动时） */
  recover(): Promise<{ recovered: number; failed: number }>;
  /** 门控统计（Harness 监控） */
  getGateStats(): { write: number; rawOnly: number; discard: number; total: number };
}

export interface WritePortResult {
  conversationId: number;
  gate: 'WRITE' | 'RAW_ONLY' | 'DISCARD';
  salience: number;
  episodeId?: string;
  traceId?: string;
  latencyMs: number;
}

/**
 * P2: MemoryRetrievePort — 检索
 * 适配旧：src/m4/MemoryRetriever.ts
 * 对接新：memarch-v2/retrieval/Retriever
 */
export interface MemoryRetrievePort {
  /** 主检索入口 */
  retrieve(query: string, ctx: RetrieveContext): Promise<RetrieveResult>;
  /** 关闭/释放资源 */
  close?(): void;
}

export interface RetrieveContext {
  /** 当前命名空间（物理隔离关键参数） */
  namespace: Namespace;
  /** 召回 topK */
  topK?: number;
  /** 是否强制走某通路（调试用） */
  forcePathway?: 'A' | 'B';
}

/**
 * P3: MemoryPresentPort — 呈现层
 * 适配旧：src/m5/ContextMemory.ts（场景状态 + prompt 组装）
 * 对接新：memarch-v2/presentation/PresentationEngine
 */
export interface MemoryPresentPort {
  /** 根据证据生成 utterance */
  present(input: { evidences: RetrievedEvidence[]; userQuery: string; namespace: Namespace }): PresentResult;
  /** 用户反馈归因（强化/再巩固/升级） */
  attribute(input: { userReply: string; usedEvidences: RetrievedEvidence[]; namespace: Namespace }): Promise<void>;
  /** 构建当前场景上下文 prompt（旧 ContextMemory.buildContextPrompt 的替代品） */
  buildScenePrompt(namespace: Namespace): string;
  /** 回复后更新场景状态 */
  updateAfterReply(input: { draft: string; userMessage: string; tone: string; namespace: Namespace }): void;
  /** 重置场景（角色切换时必调） */
  resetScene(namespace: Namespace): void;
}

/**
 * P4: MemoryAssessPort — 评估 / 睡眠巩固
 * 适配旧：src/app/vault/MemoryAssessor.ts
 * 对接新：memarch-v2/sleep_consolidation/SleepOrchestrator + PromotionEvaluator
 */
export interface MemoryAssessPort {
  /** 单条记忆评估（显著性/生命周期提升建议） */
  assess(entry: MemoryEntry): Promise<AssessResult>;
  /** 触发一次睡眠巩固周期 */
  runSleepConsolidation(namespace: Namespace): Promise<SleepRunResult>;
  /** 提升/降级某条记忆生命周期 */
  promote(uuid: string, namespace: Namespace, target: 'fresh' | 'consolidated' | 'calcium'): Promise<void>;
}

export interface AssessResult {
  salience: number;
  shouldPromote: boolean;
  suggestedLifecycle: 'fresh' | 'consolidated' | 'calcium';
  reason: string;
}

export interface SleepRunResult {
  stepsRun: string[];
  tracesPromoted: number;
  tracesPurged: number;
  durationMs: number;
}

/**
 * P5: MemoryStoragePort — 底层存储
 * 适配旧：src/app/memory-vault/MemoryVault.ts
 * 对接新：memarch-v2/storage/WriteQueue + DDL
 */
export interface MemoryStoragePort {
  /** 直接读（绕过 M2/M3 门控，治理层审计必须记录） */
  rawRead(table: string, namespace: Namespace, where: Record<string, unknown>): Promise<unknown[]>;
  /** 直接写（同上，谨慎使用） */
  rawWrite(table: string, namespace: Namespace, rows: Record<string, unknown>[]): Promise<void>;
  /** 行数统计（迁移校验用） */
  count(table: string, namespace: Namespace): Promise<number>;
  /** 命名空间列表 */
  listNamespaces(): Promise<Namespace[]>;
}

/**
 * P6: MemoryGatePort — 门控 / 模式判定
 * 适配旧：src/app/conversation/MemoryGate.ts
 * 对接新：memarch-v2/online_write/Gate + presentation/router
 */
export interface MemoryGatePort {
  /** 判定当前对话模式（是否需要检索） */
  decideMode(ctx: {
    message: string;
    namespace: Namespace;
    isFollowUp?: boolean;
    hasNewEntity?: boolean;
    calciumLevel?: number;
  }): {
    mode: 'casual' | 'memory_recall' | 'vague_recall' | 'knowledge_query';
    needsMemorySearch: boolean;
    needsKnowledgeSearch: boolean;
    pastMarkers: string[];
    knowledgeMarkers: string[];
  };
  /** 构建幻觉防护指令 */
  buildGuard(mode: string, hasMemory: boolean, hasKnowledge: boolean, namespace: Namespace): {
    fillerPhrase: string;
    hallucinationGuard: string;
    strictMode: boolean;
  };
}

/**
 * P7: MemoryConfigPort — 配置视图
 * 适配旧：src/config/MemoryConfig.ts
 * 对接新：M2_CONFIG / M4 DegradeBudget / M5 PresentationConfig
 */
export interface MemoryConfigPort {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): void;
  getAll(): Record<string, unknown>;
}

// ============================================================
// 桥接聚合根（主系统唯一依赖）
// ============================================================

/**
 * MemArchBridge — 主系统唯一入口
 *
 * 主系统所有旧记忆调用点，统一改为：
 *   import { bridge } from '@wenstar/memarch-bridge';
 *   await bridge.write.write({ ... });
 *
 * bridge 内部根据 FeatureFlag 决定走旧实现还是新 MemArch v2，
 * 并自动注入当前 Namespace（从 AsyncLocalStorage 取）。
 */
export interface MemArchBridge {
  write: MemoryWritePort;
  retrieve: MemoryRetrievePort;
  present: MemoryPresentPort;
  assess: MemoryAssessPort;
  storage: MemoryStoragePort;
  gate: MemoryGatePort;
  config: MemoryConfigPort;
  /** 健康检查：新系统是否就绪 */
  health(): { v2Ready: boolean; legacyReady: boolean; activePath: 'v2' | 'legacy' | 'mixed' };
}
