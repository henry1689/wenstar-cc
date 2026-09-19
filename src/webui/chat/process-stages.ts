/**
 * V10.0 P2-1: processChat 拆分 — 4 个独立 Stage
 * ==============================================
 * 从 2336 行的 processChat 中提取 22 个关注点到 4 个 Pipeline Stage。
 * 每个 Stage 有明确的职责边界，保持行为完全不变。
 *
 * 原 processChat 调用顺序:
 *   runPerceptionStage → runMeetingStage → runKnowledgeStage → runInjectionStage
 *
 * Post-reply 副作用（Stage 5）保留在 processChat 中。
 */
import type { ChatContext } from '../chat.js';
import type { DNA } from '../../m1/types/dna.js';
import type { ConversationTurn } from '../../m5/types/index.js';
import type { RoleType } from '../../app/role/RoleClassifier.js';

import { classify } from '../../app/role/RoleClassifier.js';
import { evaluateTransition, createInitialState, type TransitionState } from '../../app/role/TransitionManager.js';
import { EntityMeeting } from '../../m4/household/EntityMeeting.js';
import { ConfigService } from '../../config/ConfigService.js';
import { ENABLE_TEMPORAL_RULE_ENGINE, worldRuleMode } from '../../engine/temporal/TemporalConfig.js';

// ═══════════════════════════════════════════════════════════════
// Stage 1: 感知 + M3 决策 + 角色路由
// ═══════════════════════════════════════════════════════════════

export interface Stage1Input {
  message: string;
  ctx: ChatContext;
  _currentRole: RoleType;
}

export interface Stage1Output {
  dna: DNA;
  p: any;
  decision: any;
  seqPos: number;
  _currentRole: RoleType;
  _ruleEngineBlocked: boolean;
  _ruleEngineReply: string | null;
  _weatherContext: string;
}

/** 仅包含角色路由逻辑的轻量封装，具体 DNA 编码在 processChat 的 runChatEntry 中完成 */
export function routeRole(
  p: any, message: string, dna: DNA,
  _currentRole: RoleType, _transitionState: TransitionState,
  _inMeeting: boolean
): RoleType {
  if (_inMeeting) return 'recaller';

  const roleDecision = classify({
    message, perception: p,
    entities: dna.entity_genes,
    previousRole: _currentRole,
    consecutiveIntimateCount: _transitionState.consecutiveIntimate,
  });
  const transition = evaluateTransition(_transitionState, roleDecision, message);
  // 副作用: 更新 _transitionState（调用方负责）
  return transition.newRole;
}

// ═══════════════════════════════════════════════════════════════
// Stage 2: 会晤管理
// ═══════════════════════════════════════════════════════════════

export interface Stage2Input {
  message: string;
  ctx: ChatContext;
  dna: DNA;
  memoryFragments: string[];
  knowledgeBaseText: string;
}

export interface Stage2Output {
  _meetingEntityName: string | null;
  _entityContextText: string;
  /** 会晤启动时的历史索引（用于过滤会晤前的玉瑶对话） */
  _meetingStartHistoryIndex: number;
}

/**
 * 执行会晤检测、进入、切换、退出全流程。
 * 原代码来自 processChat lines 608-820。
 */
export async function runMeetingStage(input: Stage2Input): Promise<Stage2Output> {
  const { message, ctx, dna, memoryFragments, knowledgeBaseText } = input;
  // 🔍 V10.0 诊断: 确认 Stage 2 被调用
  const _hasMeeting = !!ctx._entityMeeting;
  console.log(`[MeetingStage DEBUG] 进入: msg="${message.substring(0,30)}" entityMeeting=${_hasMeeting} isActive=${ctx._entityMeeting?.isActive?.() ?? 'N/A'}`);

  let _meetingEntityName: string | null = null;
  let _entityContextText = '';
  let _meetingStartHistoryIndex = 0;
  // _meetingKBCache 已移到 processChat 中通过闭包维护

  // ── V4.0 门阀白名单 ──
  if (ctx._gatekeeper) {
    try {
      const personUUIDs: string[] = [];
      for (const gene of (dna.entity_genes || [])) {
        if (gene.type === 'person' && gene.name && gene.name !== '我') {
          const uuid = ctx.m4.getFamilyGraph()?.getUUIDByName?.(gene.name);
          if (uuid) personUUIDs.push(uuid);
        }
      }
      if (personUUIDs.length > 0) ctx._gatekeeper.setSessionEntities(personUUIDs);
      ctx.m4.setGatekeeper?.(ctx._gatekeeper);
    } catch (_gErr) { /* 门阀设置失败不影响对话 */ }
  }

  // ── 多人会议记录 ──
  if (ctx._entityMeeting?.isMultiParty()) {
    ctx._entityMeeting.recordTurn('user', message, '鸿艺');
  }

  // ── 会中换人检测 ──
  if (ctx._entityMeeting?.isActive()) {
    const fg = ctx.m4?.getFamilyGraph?.();
    const allNames: string[] = fg?.getAllPersonNames?.() || [];

    if (ctx._entityMeeting.isMultiParty()) {
      const _activeNames = ctx._entityMeeting.getParticipants().map((p: any) => p.name);
      const _collIntent = EntityMeeting.detectCollectiveIntent(message, _activeNames);
      if (_collIntent) console.log('[EntityMeeting] 集体呼唤: ' + _activeNames.join('、'));
    }

    // 🛡️ V10.0: 会中换人必须是非常明确的切换语句，不能仅因提到其他名字就切换
    //   "换XX来"、"让XX来替一下"、"退下吧换XX"→ 切换
    //   "XX多大了"、"XX在干嘛"、"你妹妹叫什么"→ 不切换（只是闲聊提及）
    const switchTarget = EntityMeeting.detectSwitchIntent(message, allNames);
    if (switchTarget) {
      await ctx._entityMeeting.switchTo(switchTarget);
      console.log('[EntityMeeting] 会中切换: → ' + switchTarget);
    }
  }

  // ── 会晤退出 ──
  const _exitMatch = /^(?:散会|结束.*会议|会议.*结束|不开了|今天就到这儿|今天就到这里|先这样|下了|拜拜|再见|瑶瑶|玉瑶|瑶儿)\s*$/.test(message.trim());
  const _isShortMsg = message.trim().length < 10;
  const _prevTurnIsQuestion = ctx.conversationHistory.slice(-1)[0]?.content?.match(/[？?]$/);
  if (ctx._entityMeeting?.isActive() && _exitMatch && _isShortMsg && !_prevTurnIsQuestion) {
    const exitResult = await ctx._entityMeeting.exit();
    if (exitResult?.minutes) console.log('[EntityMeeting] 多人会议结束，纪要已自动归档');
  }

  // ── 实体会晤意图检测 + 激活 ──
  const fg = ctx.m4?.getFamilyGraph?.();
  const _rawNames: string[] = fg?.getAllPersonNames?.() || [];
  const _safeNames = _rawNames.length > 0 ? _rawNames : [
    '徐诗雨','徐诗韵','徐诗涵','熊梓铭','熊梓玥','阿珍','阿苏','徐东伟',
    '熊勇','王全芬','林土锋','宁清华','陈雪花','曾美容','陈斌','赖陈喜',
    '张小龙','罗权斌','刘运新','邱运财','陈锋华'
  ];
  // 🛡️ V10.0: 会晤激活已上移至 chat.ts V10.0 强制入口统一管理
  // process-stages 不再独立触发会晤进入，只处理切换和退出

  // ── V10.0 P0-1: 门阀补充 + entity_genes 追加 ──
  if (ctx._entityMeeting?.isActive()) {
    _meetingEntityName = ctx._entityMeeting.getEntityName();
    if (_meetingEntityName) {
      // 追加 entity_genes
      const _alreadyInGenes = (dna.entity_genes || []).some((g: any) => g.name === _meetingEntityName);
      if (!_alreadyInGenes) {
        dna.entity_genes.push({ name: _meetingEntityName, type: 'person', allele: _meetingEntityName, phenotype: 'neutral', knowledge_type: 'private' });
      }
      // 同步门阀
      if (ctx._gatekeeper) {
        try {
          const _mu = ctx.m4?.getFamilyGraph?.()?.getUUIDByName?.(_meetingEntityName);
          if (_mu) ctx._gatekeeper.addSessionEntity?.(_mu);
        } catch (_gErr) { /* 非关键 */ }
      }

      // 构建实体上下文
      try {
        const _isMulti = ctx._entityMeeting.isMultiParty?.() ?? false;
        const { buildEntityContext, buildMultiEntityContext } = await import('../../m4/household/EntityContextBuilder.js');
        const isFirstTurn = ctx._entityMeeting.isFirstTurn?.() ?? false;

        let recentConversations: Array<{ role: string; content: string; timestamp: string }> = [];
        try {
          if (ctx.conversationDB && typeof ctx.conversationDB.searchConversations === 'function') {
            const cRows = ctx.conversationDB.searchConversations(_meetingEntityName, 10, true);
            if (cRows && cRows.length > 0) {
              recentConversations = cRows.map((r: any) => ({
                role: r.role || 'user', content: (r.content || '').substring(0, 200), timestamp: r.timestamp || '',
              }));
            }
          }
          if (recentConversations.length === 0 && ctx.conversationHistory) {
            const _hist = ctx.conversationHistory.filter((t: any) => (t.content || '').includes(_meetingEntityName!)).slice(-10);
            if (_hist.length > 0) {
              recentConversations = _hist.map((t: any) => ({
                role: t.role || 'user', content: (t.content || '').substring(0, 200), timestamp: t.timestamp || '',
              }));
            }
          }
        } catch (_convErr) { /* 对话历史查询失败不阻塞 */ }

        let ecResult;
        if (_isMulti) {
          const _participants = ctx._entityMeeting.getParticipants?.() || [];
          const _allNames = _participants.map((p: any) => p.name);
          ecResult = buildMultiEntityContext(ctx.m4.getFamilyGraph?.(), {
            entityNames: _allNames.length > 0 ? _allNames : [_meetingEntityName], isFirstTurn,
          });
        } else {
          ecResult = buildEntityContext(ctx.m4.getFamilyGraph?.(), {
            entityName: _meetingEntityName, isFirstTurn,
            userName: (ctx as any)._userName || '鸿艺',
            recentConversations: recentConversations.length > 0 ? recentConversations : undefined,
          });
        }
        _entityContextText = ecResult.systemText;

        // KB 缓存（通过闭包引用 processChat 中的 Map）
        const _meetingKBCache: Map<string, string> = (ctx as any)._meetingKBCache;
        if (_meetingKBCache) {
          const cachedKB = _meetingKBCache.get(_meetingEntityName);
          if (isFirstTurn) {
            const _kbForCache = knowledgeBaseText?.substring(0, 3000) || '';
            if (_kbForCache.length > 20) {
              _meetingKBCache.set(_meetingEntityName, _kbForCache);
              _entityContextText += '\n\n【关于你的知识库档案】\n' + _kbForCache;
            }
          } else if (cachedKB) {
            _entityContextText += '\n\n【关于你的知识库档案】\n' + cachedKB;
          }
        }

        if (!isFirstTurn) {
          const prevTurn = ctx.conversationHistory.slice(-2);
          const continuityParts: string[] = [];
          for (const t of prevTurn) {
            continuityParts.push(`${t.role === 'user' ? '鸿艺' : _meetingEntityName}：${(t.content || '').substring(0, 300)}`);
          }
          if (continuityParts.length > 0) {
            _entityContextText += '\n\n【对话延续·刚才的对话】\n' + continuityParts.join('\n');
          }
        }
      } catch (e) { /* 实体上下文构建失败不阻塞 */ }

      if (ctx._entityMeeting?.isFirstTurn?.()) ctx._entityMeeting.incrementTurn();
    }
  }

  return { _meetingEntityName, _entityContextText, _meetingStartHistoryIndex };
}
