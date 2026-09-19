/**
 * EntityTriageService — 实体质量离线终审编排器
 * =============================================
 * 分层定位（对应批13 的结构设计）：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ EntityTriageService（本文件 · 编排层）          │
 *   │   · 持有 LLM 调用能力（依赖注入）                │
 *   │   · 串联：收集 → 判定 → 应用                     │
 *   └───────────────┬──────────────┬────────────────┘
 *                   │              │
 *      collectCandidateItems  buildJudgePrompt
 *      applyJudgments              / parseJudgeResponse
 *                   │              / applyConservativePolicy
 *                   ▼              ▼
 *        FamilyGraph（数据层，无 LLM）  EntityQualityJudge（纯函数，无 IO）
 *
 * 为什么不放进 M7 梦境编排器：
 *   M7 的梦境模块（person_review 等）均**不依赖 LLM**（规则/统计驱动）。
 *   把 LLM 依赖塞进 M7 会破坏其分层，且判定失败会污染梦境熔断计数。
 *   故独立成服务，由上层在「空闲时机」显式触发。
 *
 * 保守边界（用户 2026-09-20 决策）：
 *   - 只做提升（noise → 仅标注，永不自动回收）
 *   - 解析失败 / 低置信 → 一律视为 unknown（继续观察）
 *
 * @module app/entity
 */
import {
  buildJudgePrompt,
  parseJudgeResponse,
  applyConservativePolicy,
  JUDGE_PROMOTE_MIN_CONFIDENCE,
  type JudgeItem,
} from './EntityQualityJudge.js';

/** 依赖：数据层 + LLM 调用（低层 rawCall，与既有 provider 签名一致） */
export interface TriageDeps {
  familyGraph: {
    collectCandidateItems(limit?: number): JudgeItem[];
    applyJudgments(
      outcome: { promote: string[]; annotate: Array<{ name: string; confidence: number; reason?: string }> },
      source?: string,
    ): { promoted: number; annotated: number };
  };
  rawCall: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    maxTokens: number,
    temperature: number,
  ) => Promise<string>;
}

export interface TriageReport {
  /** 本轮扫描到的 candidate 数 */
  scanned: number;
  /** 提升为 active 的数量 */
  promoted: number;
  /** 标注为 noise（未回收）的数量 */
  annotated: number;
  /** 保持观察的数量（unknown / 低置信） */
  kept: number;
  /** 是否因无候选而跳过 LLM 调用 */
  skipped: boolean;
  /** 失败原因（若有） */
  error?: string;
}

/** 单批上限：控制 prompt 体积与单次调用成本 */
export const DEFAULT_TRIAGE_BATCH = 30;
// 评审 F10: 30 条 × 4 键 ≈ 900~1200 tokens，叠加解释文本易截断；
// 截断会让 parseJudgeResponse 退化为全 unknown（静默零提升）。取 2500 留足余量。
const JUDGE_MAX_TOKENS = 2500;

export class EntityTriageService {
  private deps: TriageDeps;
  /** 防重入：终审可能被多个触发源同时唤起 */
  private running = false;

  constructor(deps: TriageDeps) {
    this.deps = deps;
  }

  /**
   * 执行一轮离线终审。
   *
   * 设计要点：
   *  - **无候选则完全跳过**（不调 LLM，零成本）
   *  - 全程 try/catch：任一环节失败都只记录 error，绝不影响主链路
   *  - 失败时不做任何状态变更（宁可不动，不可误动）
   */
  async runOnce(limit: number = DEFAULT_TRIAGE_BATCH): Promise<TriageReport> {
    if (this.running) {
      return { scanned: 0, promoted: 0, annotated: 0, kept: 0, skipped: true, error: '已有终审在进行中' };
    }
    this.running = true;
    try {
      const items = this.deps.familyGraph.collectCandidateItems(limit);
      if (items.length === 0) {
        return { scanned: 0, promoted: 0, annotated: 0, kept: 0, skipped: true };
      }

      const names = items.map((i) => i.name);
      const prompt = buildJudgePrompt(items);

      let raw = '';
      try {
        raw = await this.deps.rawCall(
          [
            { role: 'system', content: '你是严谨的中文实体审核员，只输出要求的 JSON。' },
            { role: 'user', content: prompt },
          ],
          JUDGE_MAX_TOKENS,
          0,
        );
      } catch (e: any) {
        // LLM 不可用 → 本轮不动任何数据
        return { scanned: items.length, promoted: 0, annotated: 0, kept: items.length, skipped: false, error: 'LLM 调用失败: ' + (e?.message || e) };
      }

      const judgments = parseJudgeResponse(raw, names);
      // 评审 F10: 区分「LLM 判 unknown」与「解析失败」—— 后者表现为功能静默失效
      if (judgments.every((j) => j.verdict === 'unknown' && j.confidence === 0) && raw.trim().length > 0) {
        console.warn('[EntityTriage] 判定响应无法解析（可能被截断）→ 本轮全量保持观察。raw 前120字:', raw.slice(0, 120));
      }
      const outcome = applyConservativePolicy(judgments);
      const applied = this.deps.familyGraph.applyJudgments(outcome, 'dream-judge');

      return {
        scanned: items.length,
        promoted: applied.promoted,
        annotated: applied.annotated,
        kept: outcome.keepObserving.length,
        skipped: false,
      };
    } catch (e: any) {
      return { scanned: 0, promoted: 0, annotated: 0, kept: 0, skipped: false, error: e?.message || String(e) };
    } finally {
      this.running = false;
    }
  }

  /** 供上层/测试查询当前阈值（保守策略的公开口径） */
  get promoteThreshold(): number {
    return JUDGE_PROMOTE_MIN_CONFIDENCE;
  }
}

export default { EntityTriageService, DEFAULT_TRIAGE_BATCH };
