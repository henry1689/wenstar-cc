/**
 * MemArch-v2.0.0 / M5-Presentation / index.ts
 *
 * 对外门面：组装 router → labeler → utterance builder → outputGuard。
 * 同时提供 attribute() 入口，把用户反馈接到 reinforce / reconsolidate / upgrade。
 */

import {
  fromM4Evidence,
  type AttributionHit,
  type M4EvidenceLike,
  type NormalizedEvidence,
  type PathwayStore,
  type PresentationResult,
  type ReinforceSink,
  type WriteSink,
} from './types.js';
import { DEFAULT_CONFIG, mergeConfig, type PresentationConfig } from './config.js';
import { route } from './router.js';
import { labelAggregate } from './labeler.js';
import { runGuard } from './outputGuard.js';
import { attribute as attributeImpl, toReinforceSignal } from './attributor.js';
import { reconsolidate } from './reconsolidate.js';
import { applyUpgrades } from './downgrade.js';

export interface EngineDeps {
  reinforceSink: ReinforceSink;
  writeSink: WriteSink;
  pathwayStore: PathwayStore;
}

export class PresentationEngine {
  readonly config: PresentationConfig;
  private deps: EngineDeps;

  constructor(deps: EngineDeps, configOverride?: Partial<PresentationConfig>) {
    this.deps = deps;
    this.config = mergeConfig(DEFAULT_CONFIG, configOverride);
  }

  // ============================================================
  // 主入口：检索证据 → 生成 utterance
  // ============================================================

  present(input: {
    /** M4 返回的 Evidence[]（已按视图层过滤 tombstone，但 M5 仍兜底再判一次） */
    evidences: M4EvidenceLike[];
    /** 当前用户 query（用于模糊借氛围检测） */
    user_query: string;
  }): PresentationResult {
    const normalized = input.evidences.map(fromM4Evidence);

    // 1. 路由
    const decision = route({ evidences: normalized, config: this.config.router });

    // 2. 打标签（用所有未被丢弃的证据）
    const visible = [...decision.a_side, ...decision.b_side];
    const labelResult = labelAggregate({
      evidences: visible,
      user_query: input.user_query,
      config: this.config.labels,
    });

    // 3. 生成候选 utterance（规则模板，不调 LLM）
    const candidate = this.buildCandidateUtterance(decision.routed_path, decision.a_side, decision.b_side);

    // 4. OutputGuard
    const guardResult = runGuard({
      candidate_utterance: candidate,
      evidences: visible,
      routed_path: decision.routed_path,
      config: this.config.guard,
    });

    return {
      utterance: guardResult.utterance,
      label: labelResult.label,
      routed_path: decision.routed_path,
      p_A: decision.p_A,
      guard_passed: guardResult.guard_passed,
      dropped_assertions: guardResult.dropped_assertions,
      used_uuids: visible.map((e) => e.uuid),
    };
  }

  // ============================================================
  // 主入口：用户反馈 → 强化 / 再巩固 / 升级
  // ============================================================

  attribute(input: {
    user_reply: string;
    /** 上一轮 present() 实际用到的证据 */
    used_evidences: NormalizedEvidence[];
  }): {
    hits: AttributionHit[];
    reconsolidated: { old_uuid: string; new_trace_id?: string }[];
    promoted: string[];
  } {
    const hits = attributeImpl({
      user_reply: input.user_reply,
      used_evidences: input.used_evidences,
      config: this.config.attribution,
    });

    const reconsolidated: { old_uuid: string; new_trace_id?: string }[] = [];
    const positiveHits: AttributionHit[] = [];

    for (const hit of hits) {
      if (hit.signal === 'correct') {
        // 再巩固：写新版本 + 旧版本进衰减队列
        const ev = input.used_evidences.find((e) => e.uuid === hit.uuid);
        if (ev) {
          const r = reconsolidate({
            old_evidence: ev,
            user_correction: input.user_reply,
            writeSink: this.deps.writeSink,
            reinforceSink: this.deps.reinforceSink,
            config: this.config.reconsolidate,
          });
          reconsolidated.push({ old_uuid: r.old_uuid, new_trace_id: r.new_trace_id });
        }
      } else {
        // confirm / engaged / ignored → 调 ReinforceSink
        this.deps.reinforceSink.reinforce(hit.uuid, toReinforceSignal(hit.signal));
        positiveHits.push(hit);
      }
    }

    // B→A 升级
    const upgradeResult = applyUpgrades({
      hits: positiveHits,
      used_evidences: input.used_evidences,
      store: this.deps.pathwayStore,
      config: this.config.upgrade,
    });

    return { hits, reconsolidated, promoted: upgradeResult.promoted };
  }

  // ============================================================
  // 内部：候选 utterance 生成（规则模板）
  // ============================================================

  private buildCandidateUtterance(
    routed_path: 'A_direct' | 'hybrid' | 'B_only',
    a_side: NormalizedEvidence[],
    b_side: NormalizedEvidence[],
  ): string {
    if (a_side.length === 0 && b_side.length === 0) {
      return this.config.guard.fallback_no_evidence;
    }

    const topA = a_side[0];
    const topB = b_side[0];

    switch (routed_path) {
      case 'A_direct':
        // 直出原文——不加修饰，避免 guard 自己把自己拦了
        return topA ? topA.raw_text : this.config.guard.fallback_no_evidence;
      case 'hybrid': {
        // A 直引 + B 一句模糊暗示
        const aText = topA ? topA.raw_text : '';
        const bHint = topB ? '另外隐约有一点印象，但我不太确定。' : '';
        return [aText, bHint].filter(Boolean).join('。');
      }
      case 'B_only':
      default:
        // 通路 B：只说"有感觉"，不引原文
        return '感觉好像之前聊过类似的，具体内容我把握不大。';
    }
  }
}

// ============================================================
// 导出类型与工具
// ============================================================

export { fromM4Evidence };
export type {
  Assertion,
  AttributionHit,
  AttributionSignal,
  EvidenceLabel,
  M4EvidenceLike,
  NormalizedEvidence,
  Pathway,
  PresentationResult,
  ReinforceSignal,
  ReinforceSink,
  RoutedPath,
  WriteInput,
  WriteResult,
  WriteSink,
  PathwayStore,
} from './types.js';

export {
  DEFAULT_CONFIG,
  mergeConfig,
  type PresentationConfig,
  type RouterConfig,
  type LabelConfig,
  type GuardConfig,
  type AttributionConfig,
  type ReconsolidateConfig,
  type UpgradeConfig,
} from './config.js';

export { route, computePA, decidePath } from './router.js';
export { labelSingle, labelAggregate, isVagueMoodQuery, hasConflict } from './labeler.js';
export { runGuard, extractAssertions, tokenize, hasNarrativeMarker } from './outputGuard.js';
export { attribute } from './attributor.js';
export { reconsolidate } from './reconsolidate.js';
export { applyUpgrades } from './downgrade.js';
