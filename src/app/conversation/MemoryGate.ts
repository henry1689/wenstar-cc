/**
 * MemoryGate — 记忆层级管控器（纯模式分类器）
 *
 * 只做一件事：判断当前对话属于哪种模式
 * 不做的事：不生成过渡话术、不构建幻觉防护（那些在 MemoryRecallEngine）
 *
 * 判定矩阵:
 *   ┌──────────────────┬──────────────────┬──────────────────┐
 *   │ 用户输入                  │ 模式                      │ 行为                                              │
 *   ├──────────────────┼──────────────────┼──────────────────┤
 *   │ 日常闲聊/普通回复     │ casual                    │ 只使用对话上下文，不查任何记忆库                     │
 *   │ "那后来呢""上次说到"   │ memory_recall             │ 查记忆库 + 幻觉防护                                  │
 *   │ "你记得那个…"           │ vague_recall              │ 线索检索 + 幻觉防护                                  │
 *   │ "知识库/看过/知道吗"    │ knowledge_query           │ 查知识库                                             │
 *   └──────────────────┴──────────────────┴──────────────────┘
 *
 * 更精细的回忆规则（topic_resonance / entity_match）在 MemoryRecallEngine 处理
 */

import type { ConversationTurn } from '../../m5/types/index.js';
import type { PerceptionState24 } from '../../m3/types/perception.js';
// 🔴 MEM-UNIFY-V1 批1：记忆表达法单一法源（三档 / 三重奏 / 憧憬自由 / 守卫禁令）
import {
  MEMORY_LAW_VERSION,
  MEMORY_LAW_TIERS,
  MEMORY_LAW_TRIO,
  MEMORY_LAW_FUTURE,
  MEMORY_LAW_GUARD,
  resolveMemoryTier,
  type MemoryTier,
} from '../../m5/prompts/memory-expression-law.js';

// ─── 对话模式 ───

export type ConversationMode = 'casual' | 'memory_recall' | 'vague_recall' | 'knowledge_query';

// ─── 模式判定结果 ───

export interface ModeDecision {
  mode: ConversationMode;
  /** 是否需要检索记忆库 */
  needsMemorySearch: boolean;
  /** 是否需要检索知识库 */
  needsKnowledgeSearch: boolean;
  /** 检测到的过去时标记 */
  pastMarkers: string[];
  /** 检测到的知识类标记 */
  knowledgeMarkers: string[];
}

// ─── 记忆管控上下文 ───

export interface MemoryGateContext {
  /** 当前用户消息 */
  message: string;
  /** 最近对话历史（最近 6 轮） */
  recentHistory: ConversationTurn[];
  /** 当前话题是否延续上下文 */
  isFollowUp: boolean;
  /** 是否有新实体出现 */
  hasNewEntity: boolean;
  /** 是否有继续标记（嗯/对/好/是） */
  hasContinuationMarkers: boolean;
  /** M3 钙化等级 */
  calciumLevel: number;
  /** 用户消息长度 */
  messageLength: number;
  /** P1-2: M3 24D 感知向量（用于增强模式判定） */
  perception?: PerceptionState24;
}

// ─── 过去时标记词 ───

const PAST_MARKERS = [
  { pattern: /上次|那次|以前|曾经|过去|那时|那天|那晚|当时|回忆/, type: 'memory_recall' },
  { pattern: /你记不记得|你还记得|你记着|你忘了|你记得|你有没有印象/, type: 'memory_recall' },
  { pattern: /那个.*店|那家.*厅|那个.*人|某家|某次|某个/, type: 'vague_recall' },
  { pattern: /后来|然后呢|接着说|还有吗|之后/, type: 'memory_recall' },
];

// ─── 知识类标记词 ───

const KNOWLEDGE_MARKERS = [
  /知识库|看过|知道.*吗|了解.*吗|有没有.*资料|查一下|搜索|百度|谷歌/,
  /是什么|什么是|什么是|怎么回事|原理|怎么用|为什么|如何/,
];

// ─── 日常闲聊标记（不用查任何东西） ───

const CASUAL_MARKERS = [
  /在干嘛|忙什么|吃了吗|睡了|晚安|早安|早上好|晚上好|刚起来|下班|到家/,
  /今天天气|好开心|好难过|好累|心情|感觉|今天.*不错|今天.*好/,
];

/**
 * 判定当前对话模式
 *
 * 只做基础分类，不涉及过渡话术/幻觉防护（那些在 MemoryRecallEngine）
 */
export function decideMode(ctx: MemoryGateContext): ModeDecision {
  const { message, isFollowUp, hasContinuationMarkers, calciumLevel } = ctx;
  const pastMarkers: string[] = [];
  const knowledgeMarkers: string[] = [];

  // 日常闲聊 → casual（也不查任何东西）
  for (const marker of CASUAL_MARKERS) {
    if (marker.test(message)) {
  // P1-2: 感知层增强 — 即使正则判定为 casual，感知信号强时也激活轻量检索
  if (ctx.perception) {
    const p = ctx.perception;
    if ((p.pleasure < -0.2 && p.arousal > 0.3) || p.intimacy > 0.4) {
      return {
        mode: 'memory_recall',
        needsMemorySearch: true,
        needsKnowledgeSearch: false,
        pastMarkers: [],
        knowledgeMarkers: [],
      };
    }
  }

      return {
        mode: 'casual',
        needsMemorySearch: false,
        needsKnowledgeSearch: false,
        pastMarkers: [],
        knowledgeMarkers: [],
      };
    }
  }

  // 知识类查询
  for (const marker of KNOWLEDGE_MARKERS) {
    if (marker.test(message)) {
      knowledgeMarkers.push(marker.source);
    }
  }
  if (knowledgeMarkers.length > 0) {
    return {
      mode: 'knowledge_query',
      needsMemorySearch: false,
      needsKnowledgeSearch: true,
      pastMarkers,
      knowledgeMarkers,
    };
  }

  // 过去时/回忆类
  for (const marker of PAST_MARKERS) {
    if (marker.pattern.test(message)) {
      pastMarkers.push(marker.type);
    }
  }
  if (pastMarkers.length > 0) {
    const isVague = pastMarkers.some(m => m === 'vague_recall');
    return {
      mode: isVague ? 'vague_recall' : 'memory_recall',
      needsMemorySearch: true,
      needsKnowledgeSearch: false,
      pastMarkers,
      knowledgeMarkers,
    };
  }

  // 话题延续 + 钙化≥2 → 轻量记忆联想（不主导回复，只做背景参考）
  // 此模式由 MemoryRecallEngine 的 topic_resonance 逻辑接管
  if (isFollowUp && calciumLevel >= 2) {
    return {
      mode: 'memory_recall',
      needsMemorySearch: true,
      needsKnowledgeSearch: false,
      pastMarkers: [],
      knowledgeMarkers: [],
    };
  }

  // 默认 → casual，不检索
  return {
    mode: 'casual',
    needsMemorySearch: false,
    needsKnowledgeSearch: false,
    pastMarkers: [],
    knowledgeMarkers: [],
  };
}

// ─── 管控输出（供 chat.ts 使用） ───

export interface MemoryGateOutput {
  /** 判定模式 */
  mode: ConversationMode;
  /** 是否需要检索（调用方根据此决定是否调 M4/M8） */
  needsMemorySearch: boolean;
  /** 是否需要检索知识库 */
  needsKnowledgeSearch: boolean;
  /** 过渡话术（检索前使用，防冷场，空字符串表示不需要过渡） */
  fillerPhrase: string;
  /** 记忆表达指令（注入到 LLM 的 system prompt） */
  hallucinationGuard: string;
  /** 是否严格限制 LLM 编造（true = 必须基于检索回复） */
  strictMode: boolean;
  /** MEMORY-LAW-V1 三档；casual 或未判定时为空 */
  tier?: MemoryTier;
}

// ─── 过渡话术池（按场景分类，随机选择） ───

const FILLERS: Record<string, string[]> = {
  memory_recall: [
    '你说的这个…我有点印象，让我想想……',
    '嗯…你一说这个我好像有印象。等一下，我想想……',
    '这个事我记得一些，让我在脑海里翻一翻……',
    '哦…你说的是那个啊，我想想细节……',
  ],
  vague_recall: [
    '你描述的这些我好像在哪听过…让我好好回想一下……',
    '嗯…你说的让我有点触动，我找找相关的记忆……',
    '这个说法好熟悉……给我一点时间回忆一下……',
  ],
  knowledge_query: [
    '你问的这个我之前了解过一些，我翻一翻……',
    '这个我之前看过相关的资料，让我理一理……',
    '嗯…我记得好像接触过这方面的内容，让我查证一下……',
  ],
};

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getFiller(mode: ConversationMode): string {
  if (mode === 'casual') return '';
  const pool = FILLERS[mode];
  if (!pool || pool.length === 0) return '';
  return pick(pool);
}

/**
 * 构建记忆表达指令（MEMORY-LAW-V1 三档状态机）
 *
 * 与旧行为的差别（MEM-UNIFY-V1 批1）：
 *   - 不再二元判定「有记忆 → 可以复述 / 无记忆 → 说不太记得」；
 *   - 有要素：按【记得】/【印象】表达，感受讲饱满，允许三重奏与憧憬；
 *   - 无要素：进入【线索】档，邀对方给个由头，不把「不记得」当终止符；
 *   - strictMode 只表示「事实查询缺少证据」，不用于压制记忆表达。
 *
 * @param hasMemory 本轮是否召回到记忆要素（以实际注入要素集为准）
 * @param hasKnowledge 是否召回到知识库要素
 * @param tier 召回层显式给定的档位（缺省时按 hasMemory 保守推断）
 */
export function buildGuard(
  mode: ConversationMode,
  hasMemory: boolean,
  hasKnowledge: boolean,
  tier?: MemoryTier,
): MemoryGateOutput {
  const base: MemoryGateOutput = {
    mode,
    needsMemorySearch: mode !== 'casual',
    needsKnowledgeSearch: mode === 'knowledge_query',
    fillerPhrase: getFiller(mode),
    hallucinationGuard: '',
    strictMode: false,
  };

  if (mode === 'casual') {
    base.strictMode = false;
    return base;
  }

  if (mode === 'memory_recall' || mode === 'vague_recall') {
    const _tier = tier ?? resolveMemoryTier(hasMemory);
    base.tier = _tier;
    if (_tier === 'clue' || !hasMemory) {
      base.tier = 'clue';
      base.hallucinationGuard = '🔴 鸿艺在回忆过去的事，这次没有召回到要素（【线索】档）。不要用"不记得"结束话题：温柔地邀他给个由头（"你再给个由头，我们一块把它想起来？"），他说到哪就顺着接；没有依据时不要补出具体时间、地点、人物。';
      base.strictMode = false;
      return base;
    }
    base.hallucinationGuard = `🔴 鸿艺在回忆过去的事。按 ${MEMORY_LAW_VERSION} 三档表达：\n${MEMORY_LAW_TIERS}\n${MEMORY_LAW_TRIO}\n记得的直接讲，不等确认；只有碎片就在已有要素里组织、带轻标记；感受讲饱满。${MEMORY_LAW_FUTURE}\n${MEMORY_LAW_GUARD}`;
    base.strictMode = false;
    return base;
  }

  if (hasKnowledge) {
    base.hallucinationGuard = '📖 鸿艺在问你知识相关的内容。下面【知识库】里的内容你是看过的，按记录回答；若他同时提起共同往事，照常充分回忆、展开表达。';
    base.strictMode = false;
  } else {
    base.hallucinationGuard = '📖 鸿艺在问一个知识类问题，但你目前没有相关资料。可以说"这个我还没了解过"；若问题同时涉及你们的过往，回忆部分照常按三档表达。';
    base.strictMode = true;
  }

  return base;
}
