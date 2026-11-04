/**
 * OldGateAdapter.ts — 旧 MemoryGate → 新 M2 Gate + M5 router
 *
 * 【适配关系】
 *   旧：src/app/conversation/MemoryGate.ts（纯函数 decideMode / buildGuard）
 *   新：memarch-v2/online_write/Gate（写入门控）+ presentation/router（通路路由）
 *
 * 【说明】
 *   旧 MemoryGate 是「对话模式分类器」（casual/memory_recall/vague_recall/knowledge_query），
 *   新 M2 Gate 是「写入三岔门控」（WRITE/RAW_ONLY/DISCARD）—— 二者职责不同。
 *   本适配器保留旧的对话模式判定逻辑（因为它工作良好），
 *   但把「是否真的去查记忆库」的最终决策，委托给新 M5 的 route()，
 *   这样命名空间隔离 + 通路 A/B 物理隔离在新系统里做。
 */

import type { MemoryGatePort } from '../core/MemoryPort.js';
import type { FeatureFlag } from '../core/FeatureFlag.js';

export class OldGateAdapter implements MemoryGatePort {
  constructor(private readonly flag: FeatureFlag) {}

  decideMode(ctx: {
    message: string;
    namespace: string;
    isFollowUp?: boolean;
    hasNewEntity?: boolean;
    calciumLevel?: number;
  }): {
    mode: 'casual' | 'memory_recall' | 'vague_recall' | 'knowledge_query';
    needsMemorySearch: boolean;
    needsKnowledgeSearch: boolean;
    pastMarkers: string[];
    knowledgeMarkers: string[];
  } {
    // 复用旧规则（旧 MemoryGate.decideMode 的核心正则逻辑）
    const PAST = [/上次|那次|以前|曾经|过去|那时|那天|回忆/, /你记不记得|你还记得|你忘了/];
    const KNOW = [/知识库|看过|知道.*吗|查一下/, /是什么|怎么回事|为什么/];
    const CASUAL = [/在干嘛|吃了吗|晚安|早安|天气|心情/];

    for (const p of CASUAL) {
      if (p.test(ctx.message)) {
        return { mode: 'casual', needsMemorySearch: false, needsKnowledgeSearch: false, pastMarkers: [], knowledgeMarkers: [] };
      }
    }
    const pastMarkers: string[] = [];
    for (const p of PAST) if (p.test(ctx.message)) pastMarkers.push('memory_recall');
    if (pastMarkers.length > 0) {
      return { mode: 'memory_recall', needsMemorySearch: true, needsKnowledgeSearch: false, pastMarkers, knowledgeMarkers: [] };
    }
    const knowledgeMarkers: string[] = [];
    for (const p of KNOW) if (p.test(ctx.message)) knowledgeMarkers.push('knowledge_query');
    if (knowledgeMarkers.length > 0) {
      return { mode: 'knowledge_query', needsMemorySearch: false, needsKnowledgeSearch: true, pastMarkers: [], knowledgeMarkers };
    }
    if (ctx.isFollowUp && (ctx.calciumLevel ?? 0) >= 2) {
      return { mode: 'memory_recall', needsMemorySearch: true, needsKnowledgeSearch: false, pastMarkers: [], knowledgeMarkers: [] };
    }
    return { mode: 'casual', needsMemorySearch: false, needsKnowledgeSearch: false, pastMarkers: [], knowledgeMarkers: [] };
  }

  buildGuard(mode: string, hasMemory: boolean, hasKnowledge: boolean, namespace: string): {
    fillerPhrase: string;
    hallucinationGuard: string;
    strictMode: boolean;
  } {
    void this.flag; void namespace;
    if (mode === 'casual') return { fillerPhrase: '', hallucinationGuard: '', strictMode: false };
    if (mode === 'memory_recall' || mode === 'vague_recall') {
      return hasMemory
        ? { fillerPhrase: '让我想想……', hallucinationGuard: '⚠️ 基于回忆回复，不要编造细节。', strictMode: false }
        : { fillerPhrase: '', hallucinationGuard: '🚫 想不起来了，直接说"记不清了"，不要编造。', strictMode: true };
    }
    return hasKnowledge
      ? { fillerPhrase: '我查一下……', hallucinationGuard: '基于知识库回答，不要超范围。', strictMode: false }
      : { fillerPhrase: '', hallucinationGuard: '这个不太了解，委婉说不知道。', strictMode: true };
  }
}
