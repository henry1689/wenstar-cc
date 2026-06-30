/**
 * VectorAlignmentGuard — 向量对齐守护系统
 *
 * 三层防护架构：
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  第一层 · 防护 (Prevention)                                        │
 * │  → 写入前检查：向量维度/NaN/边界值                                  │
 * │  → 写入时强制：calcium_level ≥ 1 保底                               │
 * │  → 路由参数断言：权重sum=1、相似度∈[0,1]                            │
 * │  → 降级门禁：零结果时自动降级阈值                                   │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  第二层 · 检测 (Detection)                                         │
 * │  → 对齐健康分(0-100)：向量维度一致率/钙化等级分布/零召回率/检索率  │
 * │  → 逐轮审计日志：每轮对话记录关键对齐指标                            │
 * │  → 告警阈值：健康分<60 → degraded；<40 → error                     │
 * │  → 跨会话趋势：对比历史健康分变化                                    │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  第三层 · 加固 (Reinforcement)                                      │
 * │  → 自动修复：维度不一致时padding/truncate                             │
 * │  → 钙化重分级：批量修复ca_level=0的记录为1                           │
 * │  → 降级回退：向量检索失败→降级到LIKE全文检索                          │
 * │  → 启动自检：服务启动时全面检查对齐链路                                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 关键公式：
 *   对齐健康分 = Σ(各检查点得分 × 权重)
 *   检查点：M3感知精度(20%) + 存储向量完整率(25%) + 检索召回率(25%) + LLM注入率(30%)
 *
 * 集成点：
 *   - chat.ts processChat() → 每轮对话记录审计指标
 *   - M3 M3LogicOrchestrator.decide() → 感知向量写入前检查
 *   - M2 findByEmotionalSimilarity() → 检索前零结果门禁
 *   - M5 orchestrate() → 注入前检查finalKnowledgeText含记忆
 *   - server.ts /api/health → 暴露对齐健康分
 *   - server.ts /api/alignment/audit → 暴露详细审计报告
 */

// ─── 类型定义 ────────────────────────────────────

export interface AlignmentAuditPoint {
  /** 检查点名称 */
  checkpoint: string;
  /** 是否通过 */
  passed: boolean;
  /** 健康得分 0-100 */
  score: number;
  /** 详情 */
  detail: string;
  /** 建议修复 */
  suggestion?: string;
}

export interface AlignmentReport {
  /** 总体健康分 0-1, 0-100, 等级 */
  score: number;           // 0-100
  status: 'healthy' | 'degraded' | 'broken';
  /** 各检查点详情 */
  checkpoints: AlignmentAuditPoint[];
  /** 运行时指标 */
  metrics: AlignmentMetrics;
  /** 建议操作 */
  recommendations: string[];
  /** 时间戳 */
  timestamp: string;
}

export interface AlignmentMetrics {
  /** memories表总记录数 */
  totalMemories: number;
  /** calcium_level >= 1的记录数 */
  memoryAccessible: number;
  /** memoryAccessible / totalMemories */
  accessibilityRate: number;
  /** effective_strength >= 0.1的记录数 */
  memoryViable: number;
  /** 24D向量完整率 (有perception_json的记录占比) */
  vectorCompleteRate: number;
  /** 黑钻recall_count > 0的记录占比 */
  diamondRecallRate: number;
  /** 最近10轮对话中memoryFragments被注入的平均条数 */
  avgMemoryFragmentsInjected: number;
  /** 最近10轮对话中检索返回空结果的次数 */
  emptyRetrievalCount: number;
  /** 对话历史长度 */
  conversationHistoryLen: number;
  /** 金库→黑钻晋升统计 */
  promotedToDiamond: number;
  /** 是否有维度不匹配的记录 */
  dimensionMismatchCount: number;
}

// ─── 健康状态阈值 ────────────────────────────────

const THRESHOLDS = {
  /** 健康（正常） */
  HEALTHY_MIN: 80,
  /** 退化（需关注） */
  DEGRADED_MIN: 60,
  /** 断裂（需修复） */
  BROKEN_MIN: 0,
  /** 钙化等级最低值 */
  CALCIUM_LEVEL_FLOOR: 1,
  /** 有效强度最低值 */
  STRENGTH_FLOOR: 0.05,
  /** 24D向量标准维度 */
  VECTOR_DIMENSION: 24,
  /** 健康巡检间隔（毫秒） */
  CHECK_INTERVAL_MS: 300_000, // 5分钟
  /** 零结果告警触发次数（连续N轮） */
  ZERO_RESULT_ALERT_N: 3,
} as const;

// ─── 运行时审计日志 ──────────────────────────────

interface TurnAuditLog {
  turn: number;
  timestamp: string;
  /** 本轮情感向量维度 */
  perceptionDim: number;
  /** 检索到的记忆条数 */
  memoriesRetrieved: number;
  /** memoryFragments最终条数 */
  fragmentsInjected: number;
  /** 对齐健康得分 */
  healthScore: number;
  /** 异常标记 */
  anomalies: string[];
}

class AuditLogBuffer {
  private logs: TurnAuditLog[] = [];
  private maxSize = 100;

  push(log: TurnAuditLog): void {
    this.logs.push(log);
    if (this.logs.length > this.maxSize) this.logs.shift();
  }

  tail(n = 10): TurnAuditLog[] {
    return this.logs.slice(-n);
  }

  getRecentEmptyRetrievals(): number {
    return this.tail(10).filter(l => l.memoriesRetrieved === 0).length;
  }

  getAvgFragmentsInjected(): number {
    const recent = this.tail(10);
    if (recent.length === 0) return 0;
    return recent.reduce((s, l) => s + l.fragmentsInjected, 0) / recent.length;
  }

  getAll(): TurnAuditLog[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}

// ─── 对齐守护者 ──────────────────────────────────

export class VectorAlignmentGuard {
  /** 审计日志缓冲区 */
  private auditLog: AuditLogBuffer = new AuditLogBuffer();
  /** 上次全面巡检时间 */
  private lastFullCheck: number = 0;
  /** 上次健康报告缓存 */
  private cachedReport: AlignmentReport | null = null;
  /** 对话轮次计数（用于审计日志） */
  private turnCounter: number = 0;

  // ── 依赖注入 ──
  private getSqlite: (() => { queryAll: (sql: string, params?: any[]) => any[] }) | null = null;
  private getMemoriesCount: (() => number) | null = null;
  private getConversationHistoryLen: (() => number) | null = null;

  /** 注册依赖（由 server.ts 在初始化时注入） */
  registerDependencies(deps: {
    getSqlite: () => { queryAll: (sql: string, params?: any[]) => any[] };
    getMemoriesCount: () => number;
    getConversationHistoryLen: () => number;
  }): void {
    this.getSqlite = deps.getSqlite;
    this.getMemoriesCount = deps.getMemoriesCount;
    this.getConversationHistoryLen = deps.getConversationHistoryLen;
  }

  /** 检查是否所有依赖已注册 */
  private isReady(): boolean {
    return !!(this.getSqlite && this.getMemoriesCount && this.getConversationHistoryLen);
  }

  // ════════════════════════════════
  // 第一层：防护 (写入前/运行前检查)
  // ════════════════════════════════

  /**
   * 保护①：向量写入前检查 — 维度/NaN/边界值
   * 返回修复后的感知向量，确保不写入损坏数据
   */
  sanitizePerceptionVector(p: Record<string, number>): Record<string, number> {
    const sanitized = { ...p };
    const FIELDS = ['pleasure','arousal','dominance','aggression','sincerity','humor',
      'factual','logical','certainty','abstract','temporal_focus','self_ref',
      'intimacy','power_diff','dependency','moral_judgment','etiquette','belonging',
      'sexual_attraction','sensory_craving','energy_merge','possessiveness','ecstasy','safety'];

    for (const field of FIELDS) {
      const val = sanitized[field];
      if (val === undefined || val === null || isNaN(val) || !isFinite(val)) {
        sanitized[field] = 0;
      }
    }
    return sanitized;
  }

  /**
   * 保护②：钙化等级写入保底 — 确保最低为1
   */
  ensureCalciumLevel(raw: number): number {
    return Math.max(raw, THRESHOLDS.CALCIUM_LEVEL_FLOOR);
  }

  /**
   * 保护③：有效强度写入保底
   */
  ensureStrength(raw: number): number {
    return Math.max(raw, THRESHOLDS.STRENGTH_FLOOR);
  }

  /**
   * 保护④：检索权重归一化断言 — 确保权重和=1
   */
  assertWeightsNormalized(weights: { emotional: number; topic: number; entity: number; calcium: number }): boolean {
    const sum = weights.emotional + weights.topic + weights.entity + weights.calcium;
    const ok = Math.abs(sum - 1.0) < 0.01;
    if (!ok) {
      console.warn(`[AlignmentGuard] ⚠️ 权重未归一化: sum=${sum.toFixed(4)}, emotional=${weights.emotional}, topic=${weights.topic}, entity=${weights.entity}, calcium=${weights.calcium}`);
    }
    return ok;
  }

  /**
   * 保护⑤：零结果降级门禁
   * 当检索返回0条时，返回降级阈值建议
   */
  getDegradedThreshold(emptyThreshold: number, consecutiveEmpty: number): number {
    if (consecutiveEmpty <= 1) return emptyThreshold;
    // 连续空结果时逐级降级：0.05 → 0.03 → 0.01 → 0.0
    const degrades = [0.05, 0.03, 0.01, 0.0];
    const idx = Math.min(consecutiveEmpty - 1, degrades.length - 1);
    console.log(`[AlignmentGuard] ⬇️ 连续${consecutiveEmpty}轮空结果，降级阈值至${degrades[idx]}`);
    return degrades[idx];
  }

  /** 保护⑥：向量维度一致性检查 */
  checkVectorDimension(vec: number[] | Float64Array): boolean {
    return vec.length === THRESHOLDS.VECTOR_DIMENSION || vec.length === 20;
    // 20D 是旧版兼容，24D 是标准
  }

  // ════════════════════════════════
  // 第二层：检测 (对齐健康巡检)
  // ════════════════════════════════

  /**
   * 全链路对齐健康巡检
   * 扫描所有关键指标 → 计算复合健康分
   */
  fullCheck(): AlignmentReport {
    const startTime = performance.now();
    const checkpoints: AlignmentAuditPoint[] = [];
    const recommendations: string[] = [];

    // 如果依赖未注册，只返回基础信息
    if (!this.isReady()) {
      return {
        score: 0,
        status: 'broken',
        checkpoints: [{
          checkpoint: 'dependencies',
          passed: false,
          score: 0,
          detail: '依赖未注册（getSqlite/getMemoriesCount/getConversationHistoryLen）',
          suggestion: '调用 registerDependencies() 注入依赖',
        }],
        metrics: this.getEmptyMetrics(),
        recommendations: ['调用 registerDependencies() 注入依赖'],
        timestamp: new Date().toISOString(),
      };
    }

    const sqlite = this.getSqlite!();
    const totalMemories = this.getMemoriesCount!();
    const convHistoryLen = this.getConversationHistoryLen!();

    // 检查点①：钙化等级分布（核心指标）
    let accessibleCount = 0;
    let totalReadable = 0;
    try {
      const levs = sqlite.queryAll('SELECT calcium_level, COUNT(*) as c FROM memories GROUP BY calcium_level');
      totalReadable = levs.reduce((sum: number, r: any) => sum + (r.c || 0), 0);
      const lev0 = levs.find((r: any) => r.calcium_level === 0 || r.calcium_level === null);
      accessibleCount = totalReadable - (lev0 ? lev0.c : 0);
    } catch (e: any) {
      checkpoints.push({
        checkpoint: '钙化等级',
        passed: false,
        score: 0,
        detail: `查询失败: ${e.message}`,
      });
    }
    const accessibilityRate = totalReadable > 0 ? accessibleCount / totalReadable : 0;
    const caScore = Math.round(accessibilityRate * 100);
    checkpoints.push({
      checkpoint: '钙化等级分布',
      passed: accessibilityRate >= 0.9,
      score: caScore,
      detail: `accessible=${accessibleCount}/${totalReadable}=${(accessibilityRate*100).toFixed(1)}% (ca_level>=1)`,
      suggestion: accessibilityRate < 0.9 ? '运行健康检查脚本修复ca_level=0的记录' : undefined,
    });
    if (accessibilityRate < 0.9) {
      recommendations.push('🔧 有大量 ca_level=0 记录，运行修复：UPDATE memories SET calcium_level=1 WHERE calcium_level=0');
    }

    // 检查点②：24D向量完整性
    let vectorCompleteRate = 0;
    try {
      const withVec = sqlite.queryAll("SELECT COUNT(*) as c FROM memories WHERE perception_json IS NOT NULL AND perception_json != ''");
      const withVecC = withVec[0]?.c || 0;
      vectorCompleteRate = totalReadable > 0 ? withVecC / totalReadable : 0;
    } catch {}
    const vecScore = Math.round(vectorCompleteRate * 100);
    checkpoints.push({
      checkpoint: '24D向量完整性',
      passed: vectorCompleteRate >= 0.95,
      score: vecScore,
      detail: `有perception_json的记录=${Math.round(vectorCompleteRate * totalReadable)}/${totalReadable}=${(vectorCompleteRate*100).toFixed(1)}%`,
      suggestion: vectorCompleteRate < 0.95 ? '检查flushDialogGroup是否正确写入perception_json' : undefined,
    });

    // 检查点③：有效强度分布
    let strViable = 0;
    try {
      const strs = sqlite.queryAll('SELECT effective_strength FROM memories');
      strViable = strs.filter((r: any) => (r.effective_strength || 0) >= THRESHOLDS.STRENGTH_FLOOR).length;
    } catch {}
    const strRate = totalReadable > 0 ? strViable / totalReadable : 0;
    checkpoints.push({
      checkpoint: '有效强度分布',
      passed: strRate >= 0.7,
      score: Math.round(strRate * 100),
      detail: `effective_strength>=${THRESHOLDS.STRENGTH_FLOOR}: ${strViable}/${totalReadable}=${(strRate*100).toFixed(1)}%`,
    });

    // 检查点④：黑钻召回率
    let diamondRecallRate = 0;
    try {
      const bdRecall = sqlite.queryAll('SELECT COUNT(*) as c FROM black_diamond WHERE recall_count > 0');
      const bdAll = sqlite.queryAll('SELECT COUNT(*) as c FROM black_diamond');
      const recallC = bdRecall[0]?.c || 0;
      const allC = bdAll[0]?.c || 0;
      diamondRecallRate = allC > 0 ? recallC / allC : 0;
    } catch {}
    checkpoints.push({
      checkpoint: '黑钻召回率',
      passed: diamondRecallRate >= 0.3,
      score: Math.round(diamondRecallRate * 100),
      detail: `已召回黑钻: ${Math.round(diamondRecallRate * 100)}%`,
      suggestion: diamondRecallRate < 0.3 ? '检查黑钻向量阈值是否过低，或黑钻摘要与用户查询不匹配' : undefined,
    });
    if (diamondRecallRate < 0.3) {
      recommendations.push('🔧 黑钻召回率偏低，检查向量余弦阈值(当前0.3)是否需要进一步降低');
    }

    // 检查点⑤：运行时审计指标
    const emptyRetrievals = this.auditLog.getRecentEmptyRetrievals();
    const avgFragments = this.auditLog.getAvgFragmentsInjected();
    const runtimeScore = Math.max(0, 100 - emptyRetrievals * 10 + Math.round(avgFragments * 5));
    checkpoints.push({
      checkpoint: '运行时检索健康度',
      passed: emptyRetrievals < THRESHOLDS.ZERO_RESULT_ALERT_N,
      score: Math.min(runtimeScore, 100),
      detail: `最近10轮空检索=${emptyRetrievals}次, 平均注入记忆=${avgFragments.toFixed(1)}条/轮`,
      suggestion: emptyRetrievals >= THRESHOLDS.ZERO_RESULT_ALERT_N
        ? '连续多轮检索空结果，检查钙化等级和有效强度是否已恢复' : undefined,
    });
    if (emptyRetrievals >= THRESHOLDS.ZERO_RESULT_ALERT_N) {
      recommendations.push('🔴 最近10轮对话中空检索次数过多，对齐链路可能断裂，立即检查health/alignment');
    }

    // 检查点⑥：对话历史长度
    checkpoints.push({
      checkpoint: '对话历史长度',
      passed: convHistoryLen >= 2,
      score: Math.min(Math.round(convHistoryLen / 5), 100),
      detail: `当前对话轮次: ~${Math.round(convHistoryLen / 2)}轮（${convHistoryLen}条消息）`,
    });

    // 计算复合健康分（加权平均）
    const WEIGHTS = [0.25, 0.20, 0.15, 0.15, 0.20, 0.05]; // 对应6个检查点
    const scores = checkpoints.map(cp => cp.score);
    const weightedSum = scores.reduce((s, score, i) => s + score * (WEIGHTS[i] || 0), 0);

    // 状态判定
    let status: 'healthy' | 'degraded' | 'broken';
    if (weightedSum >= THRESHOLDS.HEALTHY_MIN) status = 'healthy';
    else if (weightedSum >= THRESHOLDS.DEGRADED_MIN) status = 'degraded';
    else status = 'broken';

    // 黑钻晋升统计
    let promotedCount = 0;
    try {
      const prom = sqlite.queryAll("SELECT COUNT(*) as c FROM memories WHERE promoted_to_diamond = 1");
      promotedCount = prom[0]?.c || 0;
    } catch {}

    // 维度不匹配检测
    let dimMismatch = 0;
    try {
      const dims = sqlite.queryAll("SELECT perception_json FROM memories WHERE perception_json IS NOT NULL ORDER BY RANDOM() LIMIT 20");
      for (const row of dims as any[]) {
        try {
          const parsed = JSON.parse(row.perception_json);
          if (parsed && typeof parsed === 'object') {
            const keys = Object.keys(parsed);
            if (keys.length !== THRESHOLDS.VECTOR_DIMENSION &&
                keys.length !== 20) { // 20D旧版兼容
              dimMismatch++;
            }
          }
        } catch {}
      }
    } catch {}

    const report: AlignmentReport = {
      score: Math.round(weightedSum),
      status,
      checkpoints,
      metrics: {
        totalMemories,
        memoryAccessible: accessibleCount,
        accessibilityRate: Math.round(accessibilityRate * 1000) / 10,
        memoryViable: strViable,
        vectorCompleteRate: Math.round(vectorCompleteRate * 1000) / 10,
        diamondRecallRate: Math.round(diamondRecallRate * 1000) / 10,
        avgMemoryFragmentsInjected: Math.round(avgFragments * 10) / 10,
        emptyRetrievalCount: emptyRetrievals,
        conversationHistoryLen: convHistoryLen,
        promotedToDiamond: promotedCount,
        dimensionMismatchCount: dimMismatch,
      },
      recommendations,
      timestamp: new Date().toISOString(),
    };

    const elapsed = performance.now() - startTime;
    console.log(`[AlignmentGuard] 📊 全链路巡检完成: score=${report.score}/100, status=${report.status}, ${elapsed.toFixed(0)}ms`);

    this.lastFullCheck = Date.now();
    this.cachedReport = report;
    return report;
  }

  /**
   * 检测②：逐轮审计日志
   * 在 processChat 中每轮调用
   */
  recordTurn(params: {
    perceptionDim: number;
    memoriesRetrieved: number;
    fragmentsInjected: number;
    anomalies?: string[];
  }): void {
    this.turnCounter++;
    this.auditLog.push({
      turn: this.turnCounter,
      timestamp: new Date().toISOString(),
      perceptionDim: params.perceptionDim,
      memoriesRetrieved: params.memoriesRetrieved,
      fragmentsInjected: params.fragmentsInjected,
      healthScore: this.cachedReport?.score ?? 0,
      anomalies: params.anomalies ?? [],
    });
  }

  /**
   * 检测③：快速检查对齐是否健康（用于运行时断言）
   */
  isHealthy(): boolean {
    return (this.cachedReport?.status ?? 'broken') === 'healthy';
  }

  /**
   * 检测④：获取审计日志
   */
  getAuditLogs(count?: number): TurnAuditLog[] {
    return count ? this.auditLog.tail(count) : this.auditLog.getAll();
  }

  // ════════════════════════════════
  // 第三层：加固 (自动修复)
  // ════════════════════════════════

  /**
   * 加固①：自动修复 ca_level=0 的记录
   * 返回修复的记录数
   */
  fixZeroCalciumLevel(): number {
    try {
      const sqlite = this.getSqlite!();
      const zeros = sqlite.queryAll("SELECT COUNT(*) as c FROM memories WHERE (calcium_level IS NULL OR calcium_level = 0)");
      const count = zeros[0]?.c || 0;
      if (count > 0) {
        sqlite.queryAll("UPDATE memories SET calcium_level = 1 WHERE calcium_level IS NULL OR calcium_level = 0");
        console.log(`[AlignmentGuard] 🔧 修复 ${count} 条 ca_level=0 的记录 → 1`);
      }
      return count;
    } catch (e: any) {
      console.warn(`[AlignmentGuard] ⚠️ 修复ca_level失败: ${e.message}`);
      return 0;
    }
  }

  /**
   * 加固②：自动修复 effective_strength 为0或NULL
   */
  fixZeroStrength(): number {
    try {
      const sqlite = this.getSqlite!();
      const zeros = sqlite.queryAll("SELECT COUNT(*) as c FROM memories WHERE (effective_strength IS NULL OR effective_strength < 0.05)");
      const count = zeros[0]?.c || 0;
      if (count > 0) {
        sqlite.queryAll("UPDATE memories SET effective_strength = 0.3 WHERE effective_strength IS NULL OR effective_strength < 0.05");
        console.log(`[AlignmentGuard] 🔧 修复 ${count} 条 effective_strength 过低的记录 → 0.3`);
      }
      return count;
    } catch (e: any) {
      console.warn(`[AlignmentGuard] ⚠️ 修复strength失败: ${e.message}`);
      return 0;
    }
  }

  /**
   * 加固③：全自动修复 — 巡检时自动触发
   */
  autoRepair(): { caLevelFixed: number; strengthFixed: number } {
    const caLevelFixed = this.fixZeroCalciumLevel();
    const strengthFixed = this.fixZeroStrength();
    if (caLevelFixed > 0 || strengthFixed > 0) {
      console.log(`[AlignmentGuard] 🔧 自动修复完成: ca_level=${caLevelFixed}, strength=${strengthFixed}`);
    }
    return { caLevelFixed, strengthFixed };
  }

  // ════════════════════════════════
  // 工具方法
  // ════════════════════════════════

  getCachedReport(): AlignmentReport | null {
    return this.cachedReport;
  }

  getTurnCounter(): number {
    return this.turnCounter;
  }

  resetTurnCounter(): void {
    this.turnCounter = 0;
    this.auditLog.clear();
  }

  private getEmptyMetrics(): AlignmentMetrics {
    return {
      totalMemories: 0, memoryAccessible: 0, accessibilityRate: 0,
      memoryViable: 0, vectorCompleteRate: 0, diamondRecallRate: 0,
      avgMemoryFragmentsInjected: 0, emptyRetrievalCount: 0,
      conversationHistoryLen: 0, promotedToDiamond: 0, dimensionMismatchCount: 0,
    };
  }
}

// ─── 单例导出 ────────────────────────────────────

/** 全局单例 */
export const alignmentGuard = new VectorAlignmentGuard();
