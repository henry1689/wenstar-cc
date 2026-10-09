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
    /**
     * 🔴 丙1(2026-10-09): 可选推理强度 —— 透传至 m5 既有的 `reasoning_effort` 分支
     *   （`DeepSeekLLMProvider:1277` 条件展开，本批只是让该能力对上游可达）。
     *   缺省不传 = 保持既有行为，既有 7 个调用方零适配。
     */
    opts?: { reasoning_effort?: string },
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
  /**
   * 🔴 丙1(2026-10-09): 本轮是否为【解析失败】而非「LLM 判 unknown」。
   *   两者在原实现下同形（promoted=0 / kept=N），致连续 66 次故障无人察觉。
   *   上层据此把「故障」与「判定」分开记录。
   */
  parseFailed?: boolean;
  /**
   * 🔴 丙1: 原始响应长度（诊断用）。
   * ⚠️ V45(2026-10-09) 订正：原注释称「截断故障的特征是它极短」——**特征描述对，归因错**。
   *   实测该字段 =3 的成因不是截断，而是思维链剥离器把完整 JSON 削成 "[{"（削掉 1007 字）。
   *   详见文件头 JUDGE_MAX_TOKENS 处的 V45 订正说明与 `DeepSeekLLMProvider.resolveReplyFromFields`。
   */
  rawLength?: number;
  /** 失败原因（若有） */
  error?: string;
}

/**
 * 单批上限：控制 prompt 体积与单次调用成本。
 * 🔴 丙1(2026-10-09): 30 → 15。批越小单次响应越短、截断概率越低；
 *   配合每日可跑多轮，总吞吐不降反升。与 JUDGE_MAX_TOKENS 是一组，勿单独调其一。
 */
export const DEFAULT_TRIAGE_BATCH = 15;
// 评审 F10（原）: 30 条 × 4 键 ≈ 900~1200 tokens，叠加解释文本易截断；
// 截断会让 parseJudgeResponse 退化为全 unknown（静默零提升）。取 2500 留足余量。
//
// 🔴 丙1(2026-10-09) 修正 —— 该估算**只算了输出 JSON 本体，没算 reasoning 开销**：
//   实测 66 次运行，err.log 全部为
//     `[EntityTriage] 判定响应无法解析（可能被截断）… raw 前120字: [{"`
//   （raw 实际内容 = "[{" 共 3 字符）。而 rawCall 返回非空串 ⇒ resolveReplyFromFields
//   不抛错 ⇒ 外层记 status=success ⇒ 维护日志打印「扫描30 提升0 标注0 观察30」，
//   **故障与「LLM 判定全 unknown」在日志上无法区分**，因此藏了 66 次无人发现。
//
// 🔴🔴 V45(2026-10-09) 根因订正 —— 上方丙1 的归因（「reasoning 吃光 max_tokens，
//   故提到 8000」）已被三代探针**证伪**，勿再沿用：
//     · 直打 API（构造数据 / 真实候选 两种）→ 8000 下 finish_reason 一律 stop，
//       content 完整约 1100 字符，峰值仅用 2338 completion tokens（远未触及 8000）
//     · 16k / 32k 同样正常 ⇒「加大预算」对症状**零影响**
//     · 纯函数级复现：完整 1010 字符 JSON 经 resolveReplyFromFields → 输出 "[{"（3 字符）
//   **真根因**：思维链剥离器（为自然语言回复而设计）对【纯 JSON 输出】误判并削短 ——
//   详见 `DeepSeekLLMProvider.resolveReplyFromFields` 的 V45 条目（修复已提交 fb7e924）。
//   ⚠️ 故 8000 **并非必需**（保留仅因 15 条 × 4 键本就宽裕，且无副作用）；真正的修复不在此文件。
//   同理 reasoning_effort='low' 亦保留 —— 判定性任务确实不需深推理，但它不是根因所在。
const JUDGE_MAX_TOKENS = 8000;

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
          // 🔴 丙1(2026-10-09): 实体审核是【判定性任务】，不需要深度推理。
          //   压低思考强度可同时省 token、缩短响应 —— 直击「reasoning 吃光预算导致
          //   content 只剩 "[{"」的根因（见文件头 JUDGE_MAX_TOKENS 处注释）。
          { reasoning_effort: 'low' },
        );
      } catch (e: any) {
        // LLM 不可用 → 本轮不动任何数据
        return { scanned: items.length, promoted: 0, annotated: 0, kept: items.length, skipped: false, error: 'LLM 调用失败: ' + (e?.message || e) };
      }

      const judgments = parseJudgeResponse(raw, names);
      // 评审 F10: 区分「LLM 判 unknown」与「解析失败」—— 后者表现为功能静默失效
      // 🔴 丙1(2026-10-09): 升级为【结构化告警 + 信号回传】。
      //   原实现只说「可能被截断」，且返回值与「LLM 真判 unknown」**完全同形**
      //   （都是 promoted=0 / kept=N）⇒ 上层日志一律打印「扫描30 提升0 标注0 观察30」
      //   ⇒ 连续 66 次故障与 66 次正常判定无法区分，**这就是它藏了 66 次的原因**。
      //   现回传 parseFailed / rawLength，让「故障」与「判定」在日志上可分。
      const _allUnknown = judgments.every((j) => j.verdict === 'unknown' && j.confidence === 0);
      const _parseFailed = _allUnknown && raw.trim().length > 0;
      if (_parseFailed) {
        console.warn(
          '[EntityTriage] ⚠️ 判定响应解析失败（故障，非 LLM 判定）→ 本轮全量保持观察' +
          ' | raw长度=' + raw.length + ' | 待判条数=' + items.length +
          ' | raw前120字: ' + raw.slice(0, 120),
        );
      }
      const outcome = applyConservativePolicy(judgments);
      const applied = this.deps.familyGraph.applyJudgments(outcome, 'dream-judge');

      return {
        scanned: items.length,
        promoted: applied.promoted,
        annotated: applied.annotated,
        kept: outcome.keepObserving.length,
        skipped: false,
        parseFailed: _parseFailed,
        rawLength: raw.length,
        // 🔴 丙1(2026-10-09): 解析失败时**复用既有 error 通道**。
        //   上层 `maintenance.ts:175` 已有 `if (r.error) { console.warn('实体终审失败…'); return; }`
        //   ⇒ 本批**无需扩文件集到 maintenance.ts**，即可让「故障」与
        //   「LLM 判定全 unknown」分开记录（后者 error 为空，照常打印提升/标注统计）。
        //   这正是消除「66 次静默失效」的最后一环。
        ...(_parseFailed
          ? { error: '判定响应解析失败（故障，非 LLM 判定）| raw长度=' + raw.length + ' | 待判条数=' + items.length }
          : {}),
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
