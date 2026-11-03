/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / config/budget
 *
 * LLM 调用预算控制
 * 超预算自动 defer 到下一个睡眠周期
 */

export interface LLMBudget {
  /** 主睡眠总 token 预算（input + output 合计） */
  mainSleepTokenBudget: number;
  /** 小睡总 token 预算 */
  napTokenBudget: number;
  /** 单次 gist 生成预估 token 成本 */
  gistPerCallTokens: number;
  /** 单次显著性打分预估 token 成本 */
  saliencePerCallTokens: number;
  /** 单次语义萃取预估 token 成本 */
  extractionPerCallTokens: number;
  /** 单次 RAW_ONLY 复评预估 token 成本 */
  rawReevalPerCallTokens: number;
  /** 每批最大并发 LLM 调用数 */
  maxConcurrency: number;
  /** 预算耗尽时的默认行为：defer = 留到下一周期 */
  onBudgetExhausted: 'defer' | 'abort';
}

export const DEFAULT_BUDGET: LLMBudget = {
  mainSleepTokenBudget: 80_000,   // 主睡眠 8 万 token 预算
  napTokenBudget: 15_000,         // 小睡 1.5 万 token 预算
  gistPerCallTokens: 500,
  saliencePerCallTokens: 800,
  extractionPerCallTokens: 1200,
  rawReevalPerCallTokens: 600,
  maxConcurrency: 4,
  onBudgetExhausted: 'defer',
};

/** 预算计数器（单次睡眠运行内有效） */
export class BudgetTracker {
  private usedTokens = 0;
  private callCounts: Record<string, number> = {};

  constructor(
    private readonly budget: LLMBudget,
    private readonly mode: 'main' | 'nap' = 'main',
  ) {}

  get totalBudget(): number {
    return this.mode === 'main' ? this.budget.mainSleepTokenBudget : this.budget.napTokenBudget;
  }

  get remainingTokens(): number {
    return this.totalBudget - this.usedTokens;
  }

  get utilizationRatio(): number {
    return this.usedTokens / this.totalBudget;
  }

  /** 检查某类调用是否还在预算内 */
  canAfford(callType: keyof Pick<LLMBudget, 'gistPerCallTokens' | 'saliencePerCallTokens' | 'extractionPerCallTokens' | 'rawReevalPerCallTokens'>): boolean {
    const cost = this.budget[callType];
    return this.remainingTokens >= cost;
  }

  /** 预扣预算，返回是否成功 */
  reserve(callType: keyof Pick<LLMBudget, 'gistPerCallTokens' | 'saliencePerCallTokens' | 'extractionPerCallTokens' | 'rawReevalPerCallTokens'>, actualTokens?: number): boolean {
    const cost = actualTokens ?? this.budget[callType];
    if (this.remainingTokens < cost) return false;
    this.usedTokens += cost;
    this.callCounts[callType] = (this.callCounts[callType] ?? 0) + 1;
    return true;
  }

  /** 获取当前指标快照（写入 Harness 看板） */
  snapshot(): LLMBudgetSnapshot {
    return {
      mode: this.mode,
      usedTokens: this.usedTokens,
      totalBudget: this.totalBudget,
      remainingTokens: this.remainingTokens,
      utilizationRatio: +this.utilizationRatio.toFixed(4),
      callCounts: { ...this.callCounts },
    };
  }
}

export interface LLMBudgetSnapshot {
  mode: 'main' | 'nap';
  usedTokens: number;
  totalBudget: number;
  remainingTokens: number;
  utilizationRatio: number;
  callCounts: Record<string, number>;
}
