/**
 * V10.0 P3-1: processChat Pipeline 接口文档
 * ============================================
 * 5 个 Stage 的完整输入/输出接口定义。
 *
 * 当前状态（V10.0）：
 *   ✅ Stage 2 (Meeting) 已提取到 process-stages.ts 并实际运行
 *   📋 Stage 1/3/4/5 接口已定义，实现在 chat.ts 内联代码中
 *
 * 最终状态（V11.0 目标）：
 *   ChatEntry → PerceptionStage → MeetingStage → KnowledgeStage → InjectionStage → PostReplyStage
 *   每个 Stage 可从 chat.ts 独立提取、测试、替换。
 */
import type { ChatContext } from '../chat.js';
import type { DNA } from '../../m1/types/dna.js';
import type { PerceptionState24, M3Decision } from '../../m3/types/perception.js';
import type { ConversationTurn } from '../../m5/types/index.js';
import type { RoleType } from '../../app/role/RoleClassifier.js';
import type { M4Context } from '../../m4/types/index.js';

type ScoredMemory = any;

// ═══════════════════════════════ 通用 Stage 接口 ═══════════════════════════════

/** 可执行的 Pipeline Stage（V11.0 目标形态） */
export interface Stage<TInput, TOutput> {
  name: string;
  enabled: boolean;
  run(input: TInput): Promise<TOutput>;
}

// ═══════════════════════════════ Perception Stage ══════════════════════════════
// 🔵 STAGE 1 — 实现在 chat.ts line 288-540

export interface PerceptionInput { message: string; ctx: ChatContext; _currentRole: RoleType; }

export interface PerceptionOutput {
  dna: DNA; p: PerceptionState24; decision: M3Decision; seqPos: number;
  _currentRole: RoleType; _ruleEngineBlocked: boolean; _ruleEngineReply: string | null;
  _weatherContext: string;
}

// ═══════════════════════════════ Meeting Stage ═════════════════════════════════
// 🟢 STAGE 2 — 已提取至 process-stages.ts ✅

export { runMeetingStage } from './process-stages.js';
export type { Stage2Input, Stage2Output } from './process-stages.js';

// ═══════════════════════════════ Knowledge Stage ═══════════════════════════════
// 🟡 STAGE 3 — 实现在 chat.ts line 820-940

export interface KnowledgeInput {
  message: string; dna: DNA; p: PerceptionState24; decision: M3Decision; ctx: ChatContext;
  _meetingEntityName: string | null; _entityContextText: string;
  memoryFragments: string[]; knowledgeBaseText: string; emotionalMemories: ScoredMemory[];
}

export interface KnowledgeOutput {
  ctx_m4: M4Context; knowledgeBaseText: string; memoryFragments: string[];
  biosGatedMemories: ScoredMemory[]; familyConstraint: string; hallucinationGuard: string;
  memoryGate: any;
}

// ═══════════════════════════════ Injection Stage ═══════════════════════════════
// 🔴 STAGE 4 — 实现在 chat.ts line 1280-1574

export interface InjectionInput {
  message: string; ctx: ChatContext; dna: DNA; p: PerceptionState24; decision: M3Decision;
  ctx_m4: M4Context; _meetingEntityName: string | null; _entityContextText: string;
  _currentRole: RoleType; enrichedHistory: ConversationTurn[];
  knowledgeBaseText: string; memoryFragments: string[]; familyConstraint: string;
  hallucinationGuard: string; memoryGate: any;
}

export interface InjectionOutput {
  reply: string; enrichedWithGuard: ConversationTurn[]; finalKnowledgeText: string;
}

// ═══════════════════════════════ PostReply Stage ═══════════════════════════════
// ⚪ STAGE 5 — 实现在 chat.ts line 1635-2299

export interface PostReplyInput {
  message: string; reply: string; ctx: ChatContext; dna: DNA; p: PerceptionState24;
  decision: M3Decision; seqPos: number; _meetingEntityName: string | null;
}
