/**
 * DualCorePipeline.ts — BIOS/Mind 双核管线集成 (蓝皮书 §1.1)
 * ============================================================
 * 将 chat.ts processChat 的 M1→M3→M4→M5 流程拆为 BIOS 核 + Mind 核。
 *
 * BIOS 核 (实时,禁LLM):
 *   M1 DNA 编码 → M3 感知分析 → 五级闸门过滤 → M4 记忆检索
 *
 * Mind 核 (推理,禁Storage):
 *   M5 上下文组装 → LLM 生成 → 回复
 *
 * 使用: 在 chat.ts processChat 中调用本模块的两个钩子:
 *   const biosOutput = await runBIOSPhase(input, ctx);
 *   const reply = await runMindPhase(biosOutput.assembledContext, ctx);
 */

import type { DNA } from './types/dna.js';
import type { DNAEncoder } from './DNAEncoder.js';
import type { M3LogicOrchestrator } from '../m3/M3LogicOrchestrator.js';
import type { M4Orchestrator } from '../m4/M4Orchestrator.js';
import type { M5Orchestrator } from '../m5/M5Orchestrator.js';
import type { FiveStageGate, GateContext, ScoredMemory, GateResult } from '../m3/FiveStageGate.js';
import type { PerceptionState24, M3Decision } from '../m3/types/perception.js';
import type { BIOSContext, BIOSOutput, MindContext, MindOutput } from './DualCoreKernel.js';

// ── BIOS 核阶段 ──────────────────────────────────────────────

export interface BIOSPhaseInput {
  message: string;
  dna: DNA;
  decision: M3Decision;
  perception: PerceptionState24;
  emotionalMemories: any[];
  locationFingerprint?: string;
  currentRoleplay: string | null;
}

export interface BIOSPhaseOutput {
  /** 闸门过滤后的记忆 */
  gatedMemories: DNA[];
  /** 闸门统计 */
  gateStats: GateResult['stageStats'];
  /** 组装好的上下文 (传给 Mind 核) */
  biosVerified: boolean;
  gateReport: string;
}

/**
 * BIOS 核执行:
 *   1. DNA 编码已完成 (M1, 在调用本函数前)
 *   2. 感知分析已完成 (M3, 同上)
 *   3. 运行五级闸门过滤 (G1→G2→G3→G4→G5)
 *   4. 返回过滤后记忆 + 统计
 *
 * 🔴 此函数内禁止调用 LLM
 */
export async function runBIOSPhase(
  input: BIOSPhaseInput,
  gateModule?: FiveStageGate,
): Promise<BIOSPhaseOutput> {
  // 如果没有闸门实例, 全部通过 (降级模式)
  if (!gateModule) {
    console.warn('[BIOS] 五级闸门未加载, 全部通过 (降级模式)');
    return {
      gatedMemories: input.emotionalMemories,
      gateStats: { g1In: input.emotionalMemories.length, g1Out: input.emotionalMemories.length, g2In: 0, g2Out: 0, g2Suppressed: { P1: 0, P2: 0, P3: 0 }, g3In: 0, g3Out: 0, g4In: 0, g4Out: 0, g5In: 0, g5Out: 0 },
      biosVerified: false,
      gateReport: 'Gate offline, all pass (degraded)',
    };
  }

  try {
    const memoriesAsScored = input.emotionalMemories.map(m => ({
      id: m.branch_id,
      dna_root_id: (m as any).dna_root_id,
      raw_input: m.raw_input,
      calcium_score: (m as any).calcium_score ?? 0,
      calcium_level: (m as any).calcium_level ?? 0,
      effective_strength: (m as any).effective_strength ?? 1,
      location_fingerprint: input.locationFingerprint || (m as any).location_fingerprint || '',
      locus_path: m.locus_path,
      leaf_zone: m.leaf_zone,
      absolute_timestamp: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
      is_landmark: (m as any).is_landmark ?? 0,
    })) as any as ScoredMemory[];
    const gated = gateModule.filter(memoriesAsScored,
      {
        query: input.message,
        locationFingerprint: input.locationFingerprint || '0'.repeat(32),
      } as GateContext,
    );

    // 重建原始 DNA 对象列表
    const passedIds = new Set(gated.passed.map(m => m.id));
    const gatedMemories = input.emotionalMemories.filter(m => passedIds.has(m.branch_id)) as DNA[];

    console.log(`[BIOS] 闸门: ${input.emotionalMemories.length}→${gated.passed.length} (G1→G5)`);

    return {
      gatedMemories,
      gateStats: gated.stageStats,
      biosVerified: !gated.degraded,
      gateReport: gated.degradationReasons.join('; ') || 'PASS',
    };

  } catch (e) {
    console.warn('[BIOS] 闸门异常, 全通过:', (e as Error).message);
    return {
      gatedMemories: input.emotionalMemories,
      gateStats: { g1In: input.emotionalMemories.length, g1Out: input.emotionalMemories.length, g2In: 0, g2Out: 0, g2Suppressed: { P1: 0, P2: 0, P3: 0 }, g3In: 0, g3Out: 0, g4In: 0, g4Out: 0, g5In: 0, g5Out: 0 },
      biosVerified: false,
      gateReport: `Gate error: ${(e as Error).message}`,
    };
  }
}

// ── Mind 核阶段 ──────────────────────────────────────────────

export interface MindPhaseInput {
  message: string;
  knowledgeBaseText: string;
  /** BIOS 核过滤后的记忆 (已过闸门) */
  gatedMemories: DNA[];
  m4Orchestrator: M4Orchestrator;
  m5Orchestrator: M5Orchestrator;
  decision: M3Decision;
  currentRoleplay: string | null;
}

/**
 * Mind 核执行:
 *   M4 编排 → M5 LLM 生成 → 回复
 *
 * 🔴 此函数内禁止直接操作 Storage (所有数据由 BIOS 核提供)
 */
export async function runMindPhase(
  input: MindPhaseInput,
): Promise<{ reply: string; m4Result: any }> {
  // M4: 基于闸门过滤后的记忆编排
  const m4Result = await input.m4Orchestrator.orchestrate(input.decision, input.gatedMemories as any);

  // M5: LLM 生成 (不使用存储, 只使用 M4 组装好的上下文)
  const reply = await input.m5Orchestrator.orchestrate(
    m4Result,
    [],                         // enrichedHistory — BIOS已处理
    input.knowledgeBaseText,    // 知识上下文 — BIOS已检索
    input.message,
    input.currentRoleplay as any,
  );

  return { reply, m4Result };
}

// ═══════════════════════════════════════════════════════════════
// §3 — 双核日志 (调试/验证用, 非生产)
// ═══════════════════════════════════════════════════════════════

export interface DualCoreLog {
  timestamp: string;
  biosPhase: {
    durationMs: number;
    gateStats: BIOSPhaseOutput['gateStats'];
    biosVerified: boolean;
  };
  mindPhase: {
    durationMs: number;
    replyLength: number;
  };
}

let _lastLog: DualCoreLog | null = null;

export function setDualCoreLog(log: DualCoreLog): void { _lastLog = log; }
export function getDualCoreLog(): DualCoreLog | null { return _lastLog; }
