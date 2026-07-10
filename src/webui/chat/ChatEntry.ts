/**
 * ChatEntry.ts — 入口守卫管线
 *
 * 从 chat.ts L435-574 拆出
 * 处理: 退出残留 | 显式/隐式扮演检测 | DNA编码 | 实体提取 | 图谱匹配
 */
import type { ChatContext } from './types.js';
import { ENABLE_TEMPORAL_RULE_ENGINE, worldRuleMode } from '../../engine/temporal/TemporalConfig.js';

/** 入口管线可变状态 */
export interface EntryState {
  _currentRoleplay: string | null;
  _currentRPBranch: any;
  _currentCharacterClass: string | null;
  _currentRole: string;
  _rpJustExited: boolean;
}

export interface EntryResult {
  dna: any;
  ruleEngineBlocked: boolean;
  ruleEngineReply: string;
}

export async function runChatEntry(
  message: string,
  ctx: ChatContext,
  state: EntryState,
): Promise<EntryResult> {
  // 📜 退出残留
  if (state._rpJustExited && state._currentRoleplay) {
    console.log('[📜角色退出残留] 检测到 _currentRoleplay=' + state._currentRoleplay + ' 但 _rpJustExited=true — 强制清除');
    state._currentRoleplay = null;
    state._currentRPBranch = null;
    state._currentCharacterClass = null;
    state._currentRole = 'secretary';
  }
  console.log('[CHAT_ENTRY] _currentRoleplay=' + (state._currentRoleplay || 'null') + ' _rpJustExited=' + state._rpJustExited + ' msg=' + message.substring(0,30));

  // 显式扮演检测
  const _rpEntry = message.match(/(?:扮演(?:一下)?|模仿|演一下|cos)[了]?([一-龥]{2,8})/);
  if (_rpEntry && _rpEntry[1].trim().length >= 2) {
    state._currentRoleplay = _rpEntry[1].replace(/[吧呗了试试看看一下玩玩]$/, '').trim();
    console.log('[Roleplay] 🔒 入口锁定: ' + state._currentRoleplay);
  }

  // 隐式扮演检测
  if (!_rpEntry && !state._currentRoleplay && ctx.m4) {
    try {
      const fg = ctx.m4.getFamilyGraph();
      const allNames = fg ? fg.getAllPersonNames() : [];
      for (const turn of ctx.conversationHistory.slice(-10)) {
        const namesInHistory = turn.content.match(/[一-龥]{2,4}(?=[，,、。]|$)/g);
        if (namesInHistory) {
          for (const n of namesInHistory) {
            if (n.length >= 2 && !allNames.includes(n)) allNames.push(n);
          }
        }
      }
      const COMMON_PHRASES = new Set(['不用了', '知道了', '好了', '对了', '行了', '没事', '好的',
        '好吧', '是的', '嗯嗯', '谢谢', '不用谢', '不客气', '不会的', '可以的', '没关系']);
      const allNamesFiltered = allNames.filter(function(n) { return !COMMON_PHRASES.has(n); });
      for (const name of allNamesFiltered) {
        if (name === '我' || name.length < 2) continue;
        if (message.startsWith(name + '，') || message.startsWith(name + ',') ||
            message.startsWith(name + ' ') || message.startsWith(name + ':')) {
          state._currentRoleplay = name;
          console.log('[Roleplay] 🔒 隐式锁定: ' + name + ' (消息开头称呼)');
          break;
        }
      }
    } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }
  }

  const dna = ctx.encoder.encodeSingle(message);

  // 时空规则引擎
  let ruleEngineBlocked = false;
  let ruleEngineReply = '';
  if (ENABLE_TEMPORAL_RULE_ENGINE) {
    try {
      const { NLPEventExtractor } = await import('../../engine/temporal/NLPEventExtractor.js');
      const { TemporalEventArchive } = await import('../../engine/temporal/TemporalEventArchive.js');
      const { recordEventViolation } = await import('../../engine/temporal/temporal_event_hook.js');
      const engineCtx = ctx.storage?.getSQLite?.();
      const archive = engineCtx ? new TemporalEventArchive(engineCtx) : null;
      const extracted = NLPEventExtractor.extract(message, '鸿艺');
      if (extracted) {
        if (extracted.type === 'temporal_event' && archive && worldRuleMode === 'realistic') {
          const { params } = extracted;
          if (/怀孕|生孩子|分娩|妊娠|生宝宝/.test(message) || /感冒|发烧|受伤|恢复/.test(message)) {
            const check = archive.checkEventCompliance(message, params.durationMs);
            if (!check.valid) {
              recordEventViolation(ctx.storage?.getSQLite?.(), message, check.reason || '');
              ruleEngineBlocked = true;
              ruleEngineReply = check.reason || '';
            }
          }
          if (!ruleEngineBlocked) {
            archive.createEvent({
              belongEntityId: '鸿艺', eventType: params.eventType,
              eventRawText: extracted.content,
              startTs: params.startTs, endTs: params.endTs,
              cycleMs: params.cycleMs, dnaRootId: dna.dna_root_id || 'unknown',
            });
          }
        }
      }
    } catch (_err) { /* 规则引擎不阻塞主流程 */ }
  }

  // P3: LLM 辅助实体提取
  try {
    const { extractEntitiesLLM } = await import('../../m1/LLMEntityExtractor.js');
    const llmGenerate = async (prompt: string) => {
      const r = await (ctx.llmProvider).generate({
        strategy: { strategy_id: 'entity-extraction', params: { tone: 'neutral', depth: 'shallow', max_length: 256 } } as any,
        cognition: { current: { perception_snapshot: { pleasure: 0, arousal: 0, intimacy: 0 }, raw_input: prompt, calcium: 0 } } as any,
        userMessage: prompt,
      });
      return r.text;
    };
    const llmEntities = await extractEntitiesLLM(message, llmGenerate);
    if (llmEntities.length > 0) {
      const llmNames = new Set(llmEntities.map((e: any) => e.name));
      const keptRules = dna.entity_genes.filter((g: any) =>
        g.type !== 'person' || g.name === '我' || llmNames.has(g.name)
      );
      const existingNames = new Set(keptRules.map((e: any) => e.name));
      for (const le of llmEntities) {
        if (!existingNames.has((le as any).name)) {
          existingNames.add((le as any).name);
          keptRules.push({ name: (le as any).name, type: (le as any).type, allele: (le as any).name, phenotype: 'neutral', knowledge_type: 'private' } as any);
        }
      }
      dna.entity_genes = keptRules;
      console.log('[LLMEntity] 提取: ' + (llmEntities as any[]).map((e: any) => e.name).join(','));
    }
  } catch (_err) {
    console.warn('[LLMEntity] 提取失败:', (_err as Error).message);
  }

  // 家族图谱兜底
  try {
    const _hp = dna.entity_genes.some((g: any) => g.type === "person" && g.name !== "我" && g.name.length > 1);
    if (!_hp && ctx.m4) {
      const _fg = ctx.m4.getFamilyGraph();
      if (_fg) {
        for (const _n of _fg.getAllPersonNames()) {
          if (_n !== "我" && _n.length > 1 && message.includes(_n)) {
            dna.entity_genes.push({ name: _n, type: "person", allele: _n, phenotype: "neutral", knowledge_type: "private" });
            console.log("[FamilyGraph] 图谱匹配: " + _n);
          }
        }
      }
    }
  } catch (_fe) { console.warn("[FamilyGraph] 图谱匹配失败:", _fe); }

  return { dna, ruleEngineBlocked, ruleEngineReply };
}
