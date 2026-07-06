/**

 * chat.ts — 聊天处理逻辑（从 server.ts 拆出）

 *

 * 将 processChat 从 1163 行的 server.ts 中拆分到此文件，

 * 通过 ChatContext 传递所有依赖。

 */

import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';

import type { DNAEncoder } from '../m1/DNAEncoder.js';

import type { M3LogicOrchestrator } from '../m3/M3LogicOrchestrator.js';

import type { M4Orchestrator } from '../m4/M4Orchestrator.js';

import type { M5Orchestrator } from '../m5/M5Orchestrator.js';

import type { M6Orchestrator } from '../m6/M6Orchestrator.js';

import type { M7Orchestrator } from '../m7/M7Orchestrator.js';

import type { WorkingMemory } from '../m9/WorkingMemory.js';

import type { KnowledgeBase } from '../m2/KnowledgeBase.js';

import type { M5ClueAssistant } from '../m5/clue/M5ClueAssistant.js';
import type { MasterProfileService } from '../app/profile/MasterProfileService.js';

import type { TopicTracker } from '../app/knowledge/TopicTracker.js';

import type { ConsolidationQueue } from '../m7/ConsolidationQueue.js';

import type { DeepSeekLLMProvider } from '../m5/DeepSeekLLMProvider.js';

import type { M8FusionAdapter } from '../m8/M8FusionAdapter.js';

import type { SimilarityMode, ScoredMemory } from '../m2/types/index.js';

import type { ConversationTurn } from '../m5/types/index.js';

import type { M3Decision } from '../m3/types/perception.js';

import type { SelfModelV1 } from '../m1/types/dna.js';

import { EngineContext } from '../engine/EngineContext.js';
import { ENABLE_TEMPORAL_RULE_ENGINE, worldRuleMode } from '../engine/temporal/TemporalConfig.js';

import { rerank } from '../m4/Reranker.js';

import { decompose, mergeDecomposedResults } from '../m4/QueryDecomposer.js';

import { extractRelations, storeRelations, FAMILY_MAP, guessRelationOptions } from '../app/knowledge/RelationshipExtractor.js';

import { researchTopic } from '../app/knowledge/WebResearchService.js';

import { decideMode, buildGuard, type MemoryGateOutput } from '../app/conversation/MemoryGate.js';

import { generateCandidates, type CandidateSet } from '../m5/CandidateSelector.js';

// 仿生智脑适配器（可选依赖 — 不可用时降级）

import { bionic } from '../adapter/bionic-adapter.js';
import { ToolRegistry } from '../app/task-agent/ToolRegistry.js';

import type { VadSpectrum, BionicSearchResult } from '../adapter/bionic-adapter.js';
import { AsyncTaskQueue } from '../app/tools/AsyncTaskQueue.js';
import { fetchBionicMemories, getVadToneHint, pushToVadCache, isVadAvailable } from './chat/retrieval.js';
import { ingestFromConversation } from '../app/ingestion/ConversationIngestionService.js';
import { INGESTION_GUARD } from '../config/ingestion-guard.js';
// P0-1: 角色路由静态导入
import { classify, type RoleType } from '../app/role/RoleClassifier.js';
import { evaluateTransition, createInitialState, type TransitionState } from '../app/role/TransitionManager.js';
import { alignmentGuard } from '../app/alignment/VectorAlignmentGuard.js';
import { FamilyGraphRoleBranch } from '../app/alignment/FamilyGraphRoleBranch.js';


// 全局异步任务队列（VAD 谱曲等不阻塞主回复的后台任务）
const chatTaskQueue = new AsyncTaskQueue({ concurrency: 1, retryCount: 1, autoRemoveCompleted: true });
// SP1-1: VAD 服务健康缓存
let _vadAvailable: boolean | undefined = undefined;

export function resetVadStatus(): void {
  _vadAvailable = undefined;
  console.log('[VADTone] 管理员手动重置，下次对话将重新检测');
}


// SP3-3: 黑钻向量补充每轮缓存（同轮不重复全表扫描）
const _bdVecCache = new Map<string, Array<{ row: any; score: number }>>();

// SP4-2: 候选人回复缓存（替代 globalThis）
let _lastCandidates: any = null;

// 🎭 角色扮演透传缓存：记录已加载KB的相关人物，避免重复检索
const _rpLoadedPersons = new Set<string>();

// 🏗️ 角色扮演域管线结果缓存（供验证器使用）
let _lastCollectedData: any = null;
let _lastValidation: any = null;

// S3-2: 从 guard-builder 导入角色路由和守卫
import { flushDialogGroup, persistConversation, runRetrieval } from './chat/index.js';

// 🏗️ 改造①：集中式角色扮演指令构建器（取代 4 处内联规则副本）
import { buildRoleplayRules } from '../app/roleplay-legacy/RoleplayPromptBuilder.js';

// 🏗️ P0-1: 角色画像动态构建器（上下文扫描 + 未知边界 + 画像装配）
import {
  scanContextForCharacter,
  assembleCharacterPortrait,
  type CharacterExtract,
  type CharacterPortraitSources,
} from '../app/roleplay-legacy/CharacterProfileScanner.js';

// 🏗️ P1-3: 角色知情边界过滤器（防上帝视角）
import { PerspectiveFilter } from '../app/roleplay-legacy/PerspectiveFilter.js';

// 🏗️ P1-5: 角色参数快照（独立语气/风格覆写）
import { RoleParamsSnapshot, type RoleParams } from '../app/roleplay-legacy/RoleParamsSnapshot.js';
let _rpParamsSnapshot: RoleParamsSnapshot | null = null;
export function setRPSnapshot(snap: RoleParamsSnapshot): void { _rpParamsSnapshot = snap; }

// 🏗️ 防复发第二层: 暴露角色扮演状态供健康检查读取
export function getRoleplayStatus(): { active: boolean; role: string | null; class: string | null; turns: number } {
  return { active: !!_currentRoleplay, role: _currentRoleplay, class: _currentCharacterClass, turns: _rpTurnCounter };
}

// 🏗️ 防复发第一层: 角色扮演运行时自检
import { checkRoleplayHealth } from '../app/roleplay-legacy/RoleplayHealthGuard.js';

// 🏗️ 角色扮演域统一入口（四层结构化装配）
import { runRoleplayPipeline, clearCache as clearRPCache, afterGenerate, getDomainStatus } from '../app/roleplay/RoleplayDomain.js';
import { validateReply } from '../app/roleplay/Validator.js';
import type { DomainContext, CharacterClass } from '../app/roleplay/types.js';


// P0-1: 角色路由模块级状态（函数外，跨轮次持久化）
let _currentRole: RoleType = 'secretary';
let _transitionState: TransitionState = createInitialState();

// 对话组状态（跨轮次持久化）
interface DialogGroupState {
  id: string;
  topic: string;
  locusPath: string;
  rounds: Array<{ q: string; a: string; seqPos: number; time: number }>;
  perceptions: Record<string, number>[];
  maxCalcium: number;
  maxCalciumRound: number;
  entities: string[];
  startTime: number;
  rpChar?: string;             // 🎭 角色扮演角色名（非角色扮演时为 undefined）
}
let _dg: DialogGroupState | null = null;
let _dgTimer: ReturnType<typeof setTimeout> | null = null;
let _currentRoleplay: string | null = null;  // 跨轮次角色扮演锁定
let _currentRPBranch: FamilyGraphRoleBranch | null = null;  // 角色扮演FG分支
let _rpJustExited = false;  // 角色扮演刚退出标记（需强制恢复玉瑶身份）

// 🏗️ P0：角色扮演稳定机制状态
let _rpTurnCounter = 0;       // 距离上次完整重注入的轮数
let _currentCharacterClass: 'A'|'B'|'C'|null = null;  // 角色分类
let _currentPortrait: string | null = null;  // 缓存当前完整画像（用于周期性重注入）

// 🏗️ P1-1: 角色情感快照隔离
import { EmotionSnapshot } from '../app/roleplay-legacy/EmotionSnapshot.js';
let _emotionSnapshot: EmotionSnapshot | null = null;
export function setEmotionSnapshot(snapshot: EmotionSnapshot): void {
  _emotionSnapshot = snapshot;
}

export interface ChatContext {

  encoder: DNAEncoder;

  storage: FusionStorageAdapter;

  m3: M3LogicOrchestrator;

  m4: M4Orchestrator;

  m5: M5Orchestrator;

  m6?: M6Orchestrator;

  m7?: M7Orchestrator;

  masterProfile?: MasterProfileService;

  workingMemory: WorkingMemory;

  knowledgeBase: KnowledgeBase;

  clueAssistant: M5ClueAssistant;

  llmProvider: import('../m5/types/index.js').LLMProvider;
  /** P0-9: 独立对话存储库 */
  // P0-9
  conversationDB?: import('../m2/ConversationDB.js').ConversationDB;

  topicTracker: TopicTracker;

  consolidationQueue: ConsolidationQueue;

  conversationHistory: ConversationTurn[];

  m8: M8FusionAdapter;

  somaticMemory?: any;

  saveConversationHistory: () => void;

  getSelfModel: () => SelfModelV1;

  /** 记事记忆服务 */
  /** 客户端消息ID（用于30秒撤回） */
  clientMsgId?: string | null;

  /** 是否测试模式（标记对话为 is_test=1，可通过清理API删除） */
  testMode?: boolean;

  /** 记事记忆服务 */
  yuyaoMemory?: import("../app/yuyao-memory/YuyaoMemoryService.js").YuyaoMemoryService;

  /** S3 混合检索引擎（ONNX 本地语义重排序） */
  hybridSearch?: import("../engine/storage/HybridSearch.js").HybridSearchEngine;
}





const FALLBACK_REPLIES = [
  "嗯～我在呢。你说，我听着。","嗯，我在听。你说。","唔…好呀，你说吧。",
  "嗯～好呀。你说。","好嘞～你说吧，我听着呢。","诶～你说，我在听。",
];

const LEVEL_NAMES = ["粉末","液体","固体","晶体"];

const topicAskCount = new Map<string, number>();
const TOPIC_ASK_MAX = 500;

function getTopicRepeatCount(message: string): number {
  // 防泄漏：超过上限时清理一半
  if (topicAskCount.size > TOPIC_ASK_MAX) {
    const keysToDelete = [...topicAskCount.keys()].slice(0, TOPIC_ASK_MAX / 2);
    for (const k of keysToDelete) topicAskCount.delete(k);
  }
  const words = message.match(/[一-龥]{4,}/g);
  if (!words) return 0;
  for (const w of words) {
    const cnt = (topicAskCount.get(w) ?? 0) + 1;
    topicAskCount.set(w, cnt);
    return cnt;
  }
  return 0;
}

const _invalidPersonNames = new Set([
  '上班','吃饭','工作','散步','开会','咖啡','宠物','小孩','游戏',
  '小屄','小逼','平胸','关上','关系','别喜欢','别说别','小小','小长',
  '应用','强调','时代','时光','那个深','那次','解自己','解女子','解剖学',
  '累','老是','老板','满足','亲戚','同事','李四','张三','钟师',
  '王建国','周总开','喜欢','爱','结婚','运动','跑步','游泳','健身',
  '手机','电脑','电视','电影','音乐','阅读','学习','考试','成绩',
  '回家','出门','睡觉','起床','洗澡','刷牙','洗脸','衣服','鞋子',
  '今天','明天','昨天','上午','下午','晚上','中午','早上','现在',
  '这个','那个','什么','怎么','为什么','因为','所以','如果','然后',
  '可以','应该','能够','需要','知道','觉得','认为','希望','相信',
]);

function isValidPersonName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 6) return false;
  if (_invalidPersonNames.has(name)) return false;
  // 纯数字/字母不算人名
  if (/^[a-zA-Z0-9_]+$/.test(name)) return false;
  return true;
}

const PERC_LABELS: Record<string,{q:number;label:string}> = {
  pleasure:{q:1,label:"E1愉悦度"}, arousal:{q:1,label:"E2唤醒度"}, dominance:{q:1,label:"E3支配感"},
  aggression:{q:1,label:"E4攻击性"}, sincerity:{q:1,label:"E5真诚度"}, humor:{q:1,label:"E6幽默感"},
  factual:{q:2,label:"C1事实性"}, logical:{q:2,label:"C2逻辑性"}, certainty:{q:2,label:"C3确定性"},
  abstract:{q:2,label:"C4抽象度"}, temporal_focus:{q:2,label:"C5时间焦点"}, self_ref:{q:2,label:"C6自我参照"},
  intimacy:{q:3,label:"S1亲密度"}, power_diff:{q:3,label:"S2权力差"}, dependency:{q:3,label:"S3依赖度"},
  moral_judgment:{q:3,label:"S4道德审判"}, etiquette:{q:3,label:"S5社交礼仪"}, belonging:{q:3,label:"S6群体归属"},
  sexual_attraction:{q:4,label:"I1性吸引力"}, sensory_craving:{q:4,label:"I2感官渴望"}, energy_merge:{q:4,label:"I3能量交融"},
  possessiveness:{q:4,label:"I4占有欲"}, ecstasy:{q:4,label:"I5愉悦/高潮"}, safety:{q:4,label:"I6安全感"},
};

export interface ChatResponse {
  reply: string; turn_count: number;
  m1: any; m3: any; m4: any; m5: any;
  emotionalFlash: boolean;
  triggeredMemoryId: string | null;
  vad_spectrum?: any | null;
  candidates?: any | null;
  emotionMatchScore?: number;
  sceneFitScore?: number;
  riskFlag?: string;
}




function isDirectedEmotion(text: string): boolean {
  if (!text) return true;
  const hasDirectAddress = /[你]/.test(text);
  const isFirstPersonNarrative = /我(?:以前|曾经|那时|过去|觉得|认为|当时|以前)/.test(text);
  const isThirdPerson = /[他她它]/.test(text);
  const segments = text.split(/,/);
  for (const seg of segments) {
    if (/[你]/.test(seg) && /喜欢|开心|高兴|快乐|难过|悲伤|兴奋|激动|爱|想|恨|爽|舒服/.test(seg)) return true;
  }
  if (isFirstPersonNarrative && !hasDirectAddress) return false;
  if (isThirdPerson && !hasDirectAddress) return false;
  if (!hasDirectAddress) {
    const hasEmotionWord = /喜欢|开心|高兴|快乐|难过|悲伤|痛苦|幸福|兴奋|激动|爱|想|恨|哭|笑|爽|舒服|难受|憋|痒|麻|软|硬|热|暖|敏感|疼|痛/.test(text);
    const hasIntimateWord = /操|干|日|舔|咬|插|顶|揉|捏|掐|摸|吻|吸|骚|浪|湿|水|屌|鸡|奶|肿|硬/.test(text);
    if (!hasEmotionWord && !hasIntimateWord) return false;
  }
  if (!hasDirectAddress) {
    const hasEmotionWord = /喜欢|开心|高兴|快乐|难过|悲伤|痛苦|幸福|兴奋|激动|爱|想|恨|哭|笑|爽|舒服|难受|憋|痒|麻|软|硬|热|暖|敏感|疼|痛/.test(text);
    if (hasEmotionWord && /[我]/.test(text)) return false;
  }
  return true;
}

export async function processChat(message: string, ctx: ChatContext): Promise<ChatResponse> {
  // 📜 角色扮演退出残留检测：如果 _rpJustExited 仍为 true 但 _currentRoleplay 被意外重设，强制归零
  if (_rpJustExited && _currentRoleplay) {
    console.log('[📜角色退出残留] 检测到 _currentRoleplay=' + _currentRoleplay + ' 但 _rpJustExited=true — 强制清除');
    _currentRoleplay = null;
    _currentRPBranch = null;
    _currentCharacterClass = null;
    _currentRole = 'secretary';
  }
  console.log('[CHAT_ENTRY] _currentRoleplay=' + (_currentRoleplay || 'null') + ' _rpJustExited=' + _rpJustExited + ' msg=' + message.substring(0,30));

  try {
	// 🎭 全局角色扮演检测（在函数入口处拦截）
	// Fix-1: 显式扮演检测（"扮演诗韵"）
	const _rpEntry = message.match(/(?:扮演(?:一下)?|模仿|演一下|cos)[了]?([一-龥]{2,8})/);
	if (_rpEntry && _rpEntry[1].trim().length >= 2) {
	  _currentRoleplay = _rpEntry[1].replace(/[吧呗了试试看看一下玩玩]$/, '').trim();
	  console.log('[Roleplay] 🔒 入口锁定: ' + _currentRoleplay);
	}

	// Fix-1b: 隐式扮演检测 — 消息以已知角色名开头且跟在"呢/呀/啊/吗/哈"后，视为对该角色说话
	// 模式：诗韵，你怎么... / 诗韵你是不是... / 梓铭，帮我...
	if (!_rpEntry && !_currentRoleplay && ctx.m4) {
	  try {
	    const fg = ctx.m4.getFamilyGraph();
	    const allNames = fg ? fg.getAllPersonNames() : [];
	    // 加上最近对话中出现过的人名
	    for (const turn of ctx.conversationHistory.slice(-10)) {
	      const namesInHistory = turn.content.match(/[一-龥]{2,4}(?=[，,、。]|$)/g);
	      if (namesInHistory) {
	        for (const n of namesInHistory) {
	          if (n.length >= 2 && !allNames.includes(n)) allNames.push(n);
	        }
	      }
	    }
	    for (const name of allNames) {
	      if (name === '我' || name.length < 2) continue;
	      // 消息以"X，"/"X "/"X:"开头，或"X呢/呀/啊/吗/哈"结尾
	      if (message.startsWith(name + '，') || message.startsWith(name + ',') ||
	          message.startsWith(name + ' ') || message.startsWith(name + ':')) {
	        _currentRoleplay = name;
	        console.log('[Roleplay] 🔒 隐式锁定: ' + name + ' (消息开头称呼)');
	        break;
	      }
	    }
	  } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }
	}

    const dna = ctx.encoder.encodeSingle(message);

    // ── 时空规则引擎：NLP提取 + 前置校验（违规时设置回复，后续不再走LLM） ──
    let _ruleEngineBlocked = false;
    let _ruleEngineReply = '';
    if (ENABLE_TEMPORAL_RULE_ENGINE) {
      try {
        const { NLPEventExtractor } = await import('../engine/temporal/NLPEventExtractor.js');
        const { TemporalEventArchive } = await import('../engine/temporal/TemporalEventArchive.js');
        const { recordEventViolation } = await import('../engine/temporal/temporal_event_hook.js');
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
                _ruleEngineBlocked = true;
                _ruleEngineReply = check.reason || '';
              }
            }
            if (!_ruleEngineBlocked) {
              archive.createEvent({
                belongEntityId: '鸿艺',
                eventType: params.eventType,
                eventRawText: extracted.content,
                startTs: params.startTs,
                endTs: params.endTs,
                cycleMs: params.cycleMs,
                dnaRootId: dna.dna_root_id || 'unknown',
              });
            }
          }
        }
      } catch (_err) { /* 规则引擎不阻塞主流程 */ }
    }

    // P3: LLM 辅助实体提取（三层过滤 — prompt约束+白名单+人名正则）
    try {
      const { extractEntitiesLLM } = await import('../m1/LLMEntityExtractor.js');
      const llmGenerate = async (prompt: string) => {
        const r = await (ctx.llmProvider).generate({
          strategy: { strategy_id: 'entity-extraction', params: { tone: 'neutral', depth: 'shallow', max_length: 256 } } as any,
          cognition: { current: { perception_snapshot: { pleasure: 0, arousal: 0, intimacy: 0 }, raw_input: prompt, calcium: 0 } } as any,
          userMessage: prompt,
        });
        return r.text;
      };
      const llmEntities = await extractEntitiesLLM(message, llmGenerate);
      // 以LLM为基准，规则仅补充LLM未命中的非person实体
      if (llmEntities.length > 0) {
        const llmNames = new Set(llmEntities.map(e => e.name));
        // 规则提取的person实体只有LLM也确认才保留（消除"家里""贝安"等误报）
        const keptRules = dna.entity_genes.filter((g: any) =>
          g.type !== 'person' || g.name === '我' || llmNames.has(g.name)
        );
        const existingNames = new Set(keptRules.map(e => e.name));
        for (const le of llmEntities) {
          if (!existingNames.has(le.name)) {
            existingNames.add(le.name);
            keptRules.push({ name: le.name, type: le.type, allele: le.name, phenotype: 'neutral', knowledge_type: 'private' } as any);
          }
        }
        dna.entity_genes = keptRules;
        console.log('[LLMEntity] 提取: ' + llmEntities.map(e => e.name).join(','));
      }
    } catch (_err) {
      console.warn('[LLMEntity] 提取失败:', (_err as Error).message);
    }

    // 家族图谱兜底：M1+LLM没提到时直接从图谱匹配
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

    // 📸 人物全方位档案提取
    console.log('[PersonProfile] 检查开始, ctx.m4=' + (!!ctx.m4) + ' m4类型=' + (typeof ctx.m4));
    try {
      if (ctx.m4) {
        console.log('[PersonProfile] getFamilyGraph...');
        const _fgX = ctx.m4.getFamilyGraph();
        console.log('[PersonProfile] fg=' + (!!_fgX));
        if (_fgX) {
          // 检测是否为人物描述（含外貌/身体/性格/习惯等特征词）
          const _descWords = /长得|长相|外貌|样子|身高|身材|个子|皮肤|脸|眼睛|鼻子|嘴巴|头发|发型|漂亮|好看|帅|美|可爱|清秀|性感|苗条|丰满|矮|瘦|胖|圆|胸|奶子|屁股|腿|腰|肩|手|性格|个性|开朗|幽默|内向|外向|温柔|活泼|安静|习惯|喜欢|爱好|兴趣|说话|声音|嗓音|穿着|打扮|戴|气质|文气|纯欲|知性|精致|斯文/;
          console.log('[PersonProfile] descWords测试=' + _descWords.test(message));
          // P0-1: 仅使用M1标准化实体，禁止任何手写人名正则
          if (_descWords.test(message)) {
            const _pNames: string[] = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1).map((g: any) => g.name);
            if (_pNames.length === 0) {
              console.log('[PersonProfile] M1未提取到人名，跳过（不手写正则兜底）');
            }
            for (const _n of _pNames) {
              const _prof = _fgX.getPersonProfile(_n);
              if (!_prof) {
                console.error('[PersonProfile] ERROR: 节点 ' + _n + ' 不存在于FamilyGraph，跳过');
                continue;
              }
              const _updates: any = {};
              const _sents = message.split(/[，,。.！!？?；;\n]/);
              let _desc = _prof.description || '';
              let _app = _prof.appearance || '';
              let _body = _prof.body_features || '';
              let _inDesc = false;
              for (const _s of _sents) {
                const _ts = _s.trim();
                if (!_ts) continue;
                if (_ts.includes(_n)) { _inDesc = true; }
                else if (/^(她|他)/.test(_ts)) { _inDesc = true; }
                if (!_inDesc) continue;
                const _clean = _ts.replace(_n, '').replace(/^[她他的]/, '').trim();
                if (!_clean) continue;
                // 分类矫正：外貌/身体/其他
                if (/长得|长相|外貌|样子|个子|皮肤|脸|眼睛|鼻子|嘴巴|头发|发型|漂亮|好看|帅|美|清秀|可爱|圆脸|瓜子脸|酒窝|马尾|刘海|白|黑|高|矮|瘦|胖/.test(_ts)) {
                  const _item = _clean.replace(/身高(\d)\.(\d+)/, '身高$1.$2'); // 数字完整性
                  if (!_app.includes(_item)) _app += (_app ? '，' : '') + _item;
                } else if (/身材|胸|奶子|屁股|臀|腿|腰|肩|手|苗条|丰满|性感|翘|细|粗/.test(_ts)) {
                  if (!_body.includes(_clean)) _body += (_body ? '，' : '') + _clean;
                } else {
                  if (!_desc.includes(_clean)) _desc += (_desc ? '，' : '') + _clean;
                }
              }
              // P1-4: 冲突检测——新旧描述矛盾时标记
              if (_prof.appearance && _app && _app !== _prof.appearance) {
                const _oldParts = new Set(_prof.appearance.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean));
                const _newParts = _app.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean);
                for (const _np of _newParts) {
                  // 检测冲突：新描述中说"高"但旧描述说"矮"或反之
                  if (/高/.test(_np) && [..._oldParts].some((o: string) => /矮/.test(o))) {
                    console.warn('[PersonProfile] CONFLICT: ' + _n + ' 身高冲突（高 vs 矮）');
                  }
                  if (/矮/.test(_np) && [..._oldParts].some((o: string) => /高/.test(o))) {
                    console.warn('[PersonProfile] CONFLICT: ' + _n + ' 身高冲突（矮 vs 高）');
                  }
                  if (/胖/.test(_np) && [..._oldParts].some((o: string) => /瘦/.test(o))) {
                    console.warn('[PersonProfile] CONFLICT: ' + _n + ' 体型冲突（胖 vs 瘦）');
                  }
                  if (/瘦/.test(_np) && [..._oldParts].some((o: string) => /胖/.test(o))) {
                    console.warn('[PersonProfile] CONFLICT: ' + _n + ' 体型冲突（瘦 vs 胖）');
                  }
                }
              }
              if (_app) _updates.appearance = _app;
              if (_body) _updates.body_features = _body;
              if (_desc) _updates.description = _desc;
              if (Object.keys(_updates).length > 0) {
                _fgX.updatePersonProfile(_n, _updates as any);
                console.log('[PersonProfile] 已更新 ' + _n + ' 的档案');
              }
              // P1-2: 外貌特征提取为附属实体（支持反向检索）
              if (_app || _body) {
                const _allFeatures = (_app + '，' + _body).split(/[，,]/).filter(Boolean);
                const _featureKey = /个子|高|矮|瘦|胖|脸|眼睛|鼻|嘴|牙|头发|发|眼镜|皮肤|白|黑|圆|瓜子|酒窝|马尾|刘海|眉|睫毛|胸|臀|腿|腰|肩|手|苗条|丰满|性感|翘|细|粗|长发|短发|卷发|直发/;
                for (const _f of _allFeatures) {
                  const _trimmed = _f.trim();
                  if (_trimmed.length > 1 && _featureKey.test(_trimmed)) {
                    try {
                      const _sqlite = ctx.storage.getSQLite();
                      // 清洗特征名为标准格式
                      const _featName = _trimmed.replace(/^(很|比较|非常|有点)+/, '').substring(0, 20);
                      // 确保entities表存在
                      const _exist = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'object'", [_featName]);
                      let _featId: number;
                      if (_exist.length > 0) {
                        _featId = (_exist[0] as any).id;
                      } else {
                        _sqlite.writeRaw("INSERT INTO entities (name, type) VALUES (?, 'object')", [_featName]);
                        const _newRows = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'object'", [_featName]);
                        _featId = (_newRows[0] as any)?.id;
                      }
                      if (_featId) {
                        // 关联人物特征
                        const _personEntity = _sqlite.queryAll("SELECT id FROM entities WHERE name = ? AND type = 'person'", [_n]);
                        if (_personEntity.length > 0) {
                          _sqlite.writeRaw(
                            "INSERT OR IGNORE INTO entity_relations (entity_a_id, entity_b_id, relation, strength, updated_at) VALUES (?, ?, 'has_feature', 0.5, ?)",
                            [_personEntity[0].id, _featId, new Date().toISOString()]
                          );
                          // (FG-迁移) 同步写入 FamilyGraph 特征边（角色扮演时跳过）
                          if (!_currentRoleplay) try { ctx.m4?.getFamilyGraph()?.addFeatureEdge(_n, _featName, 'appearance').catch(() => {}); } catch {}
                        }
                      }
                    } catch (e: any) { console.error('[chat] error:', e?.message); }
                  }
                }
                console.log('[PersonProfile] 已提取 ' + _n + ' 的外貌特征（反向检索可用）');
              }
            }
          }
        }
      }
    } catch (_ae) { console.warn('[PersonProfile] 失败:', (_ae as Error)?.message); }

    // P3: 答案提取 — 用户回答了玉瑶之前的问题，提取信息更新画像
    try {
      let personGenes = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我');
      // 如果当前消息没有显式人名但用了"他/她/这人"，从历史找最近被问的人
      if (personGenes.length === 0 && (/^他|^她|^那|^这/.test(message) || message.length < 15) && ctx.m4) {
        const graph = ctx.m4.getFamilyGraph();
        if (graph) {
          for (let i = ctx.conversationHistory.length - 1; i >= 0 && i > ctx.conversationHistory.length - 6; i--) {
            const turn = ctx.conversationHistory[i];
            if (turn.role === 'assistant' && turn.content) {
              // 用姓氏匹配找回复中提到的人名
              const SURNAMES_CHAR = '赵孙李周吴郑王冯陈褚蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹柏水窦章苏潘葛彭郎鲁韦马苗凤花方俞任袁柳鲍史费廉岑薛雷贺倪汤罗郝邬安乐于时傅卞齐康余元卜顾孟平和穆萧尹邵湛汪祁毛禹狄贝明臧计戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴荣翁荀於惠甄家封羿储靳邴糜松段富乌焦巴弓牧谷车侯宓蓬全郗班仰仲伊宫宁仇甘厉戎符刘景詹束龙叶幸司韶黎薄印宿白蒲从鄂索赖卓蔺屠蒙池乔阴苍双闻莘党翟谭劳逄姬申扶冉宰郦雍郤濮牛寿通扈燕郏浦尚农别庄柴阎充慕茹习宦艾鱼容向古易慎戈廖庾衡步耿满弘匡寇广禄阙沃蔚越隆师巩厍聂晁敖融辛阚那简饶曾毋沙乜养鞠须丰巢关蒯相查荆红游竺逯盖桓公';
              const nameRegex = new RegExp('([' + SURNAMES_CHAR + '][一-龥]{1,2}|阿[一-龥]|小[一-龥])', 'g');
              const allMatches = turn.content.match(nameRegex);
              if (allMatches) {
                for (const name of allMatches) {
                  const profile = graph.getPersonProfile(name);
                  if (profile) {
                    personGenes.push({ name, type: 'person' } as any);
                    break;
                  }
                }
                if (personGenes.length > 0) break;
              }
            }
          }
        }
      }
      if (personGenes.length > 0 && ctx.m4) {
        const graph = ctx.m4.getFamilyGraph();
        if (graph) {
          // 关系关键词提取
          const relMap: Record<string, string> = { '同事':'同事','同学':'同学','朋友':'朋友','室友':'室友','老板':'老板','上司':'上司','领导':'领导','客户':'客户','合伙人':'合伙人','邻居':'邻居','老师':'老师','医生':'医生','顾问':'顾问','下属':'下属' };
          // 职业关键词提取
          const occHints = [/做(\S+)的/, /在(\S+)上班/, /在(\S+)工作/, /开(\S+)店/, /干(\S+)的/, /(\S+)工程师/, /(\S+)老师/, /(\S+)医生/];
          // 特征关键词
          const traitMap: Record<string, string[]> = { '开朗':['开朗','爱笑','大方'],'幽默':['幽默','搞笑','逗'],'热心':['热心','帮忙','帮了'],'温柔':['温柔','体贴','细心'],'能干':['能干','厉害','强'],'靠谱':['靠谱','可靠','放心'],'有趣':['有趣','好玩','有意思'],'老实':['老实','本分','踏实'] };

          for (const p of personGenes) {
            const profile = graph.getPersonProfile(p.name);
            if (!profile) continue;

            const updates: Record<string, any> = {};

            // 提取关系
            for (const [rel, val] of Object.entries(relMap)) {
              if (message.includes(rel)) { updates.relation_to_user = val; break; }
            }

            // 提取职业
            for (const re of occHints) {
              const m = message.match(re);
              if (m && m[1]) { updates.occupation = m[1]; break; }
            }

            // 提取特征
            const foundTraits: string[] = [];
            for (const [trait, keywords] of Object.entries(traitMap)) {
              if (keywords.some(kw => message.includes(kw))) foundTraits.push(trait);
            }
            if (foundTraits.length > 0) {
              const existing = profile.traits || [];
              updates.traits = [...new Set([...existing, ...foundTraits])];
            }

            if (Object.keys(updates).length > 0) {
              graph.updatePersonProfile(p.name, updates as any);
              console.log('[Profile] 更新画像:', p.name, Object.keys(updates).join(','));
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ProfileExtract] 答案提取失败:', (err as Error).message);
    }

    const decision = ctx.m3.decide(dna, { current_time: new Date().toISOString(), current_location: '深圳' });

    // P0-1: 角色路由（模块级状态持久化）
    const p = decision.enhanced.perception;
    const roleDecision = classify({
      message, perception: p,
      entities: dna.entity_genes,
      previousRole: _currentRole,
      consecutiveIntimateCount: _transitionState.consecutiveIntimate,
    });
    const transition = evaluateTransition(_transitionState, roleDecision, message);
    _transitionState = transition.state;
    _currentRole = transition.newRole;
    console.log('[RoleRouter] ' + _currentRole + ' (' + roleDecision.rule + ')');
    try { const { WorkingMemory: WM } = await import('../m9/WorkingMemory.js'); WM.currentTag = _currentRole; } catch {}
    // 主人大脑镜像提取：每轮对话后自动提取+审查+存储
    if (ctx.masterProfile && message.length > 3) {
      try {
        const extractResult = await ctx.masterProfile.extract(
          message,
          decision.enhanced.calcium_score,
          undefined // LLM辅助可选，暂不传
        );
        if (extractResult.subjective.length > 0 || extractResult.objective.length > 0) {
          if (ctx.masterProfile.review(message, decision.enhanced.calcium_score, dna.entity_genes.length > 0)) {
            ctx.masterProfile.store(message, extractResult);
            if (extractResult.subjective.length > 0 || extractResult.objective.length > 0) {
              console.log('[Mirror] 记录:', extractResult.subjective.map(s=>s.category).concat(extractResult.objective.map(o=>o.table)).join(','));
            }
          }
        }
      } catch (err) {
        console.warn('[Mirror] 提取失败:', (err as Error).message);
      }
    }

    const seqPos = ctx.storage.reserveNextSeq();

    ctx.workingMemory.push(dna, p, seqPos, decision.primary_emotion, decision.secondary_emotions);

    ctx.consolidationQueue.recordActivity();

    // 修复：enrichedHistory 只保留最近 20 轮对话原文，干净不掺杂记忆注入
    // 记忆以【相关记忆】标签注入到 knowledgeBaseText，不伪装成对话内容
    // 修复：干净的三层注入结构——对话原文/enrichedHistory、记忆/memoryFragments、知识/knowledgeBaseText
    let memoryFragments: string[] = [];
    // 🎭 Fix-2: 角色扮演时过滤对话历史 — 只保留角色扮演相关的轮次
    // 非角色扮演对话会混淆LLM，让LLM看到"玉瑶"的历史就会跳出角色
    let enrichedHistory: Array<{ role: string; content: string; timestamp?: string; topic?: string }>;
    if (_currentRoleplay) {
      // 角色扮演中：只保留也属于该角色的历史（dialog_group_id 匹配或手动标记）
      enrichedHistory = ctx.conversationHistory.slice(-10).filter(function(t) {
        return (t as any).rpChar === _currentRoleplay;
      });
      // 如果过滤后没有历史，也至少给一条占位（避免空数组）
      if (enrichedHistory.length === 0) {
        enrichedHistory.push({ role: 'system', content: `【当前扮演角色：${_currentRoleplay}】`, timestamp: new Date().toISOString() });
      }
      console.log('[Roleplay] 历史过滤: ' + ctx.conversationHistory.length + '→' + enrichedHistory.length + ' 条');
    } else {
      enrichedHistory = ctx.conversationHistory.slice(-40);
    }
        // ── 记忆检索：时间导航 + 情感检索 + 黑钻检索（已拆分至 retrieval-stage） ──
    let {
      isTopicShift, isFollowUp, hasContinuationMarkers, isCasualChat,
      isLimitedRetrieval, hasNewEntity, hasPersonEntity,
      emotionalMemories, memoryGate, memoryGateFillerUsed,
    } = await runRetrieval({
      ctx, message, dna, p, enrichedHistory, memoryFragments, _bdVecCache,
    });
	    // P0-1: 仿生智脑 + 知识库 + VAD 并行执行（三者均为异步网络调用，互不依赖）
    const _bionicPromise = fetchBionicMemories(message, isTopicShift, hasContinuationMarkers, memoryFragments, enrichedHistory, { pleasure: p.pleasure, arousal: p.arousal, intimacy: p.intimacy }, dna.scene_tags);

    // 躯体上下文注入（SomaticMemory → LLM 上下文 — 五重铁律协议③）

    try {

      if (ctx.somaticMemory) {

        const somaticContext = ctx.somaticMemory.getActiveSomaticContext();

        if (somaticContext) {
          // 【当下感受】是躯体感知信息，反映用户当前的身体/情绪状态
          memoryFragments.push('【用户状态】' + somaticContext);
        }

      }

    } catch (err) { console.warn('[SomaticContext] 注入失败:', err); }

    // 🎭 正常模式隔离：排除角色扮演记忆（角色扮演中的金库记忆在正常对话中不可见）
    if (!_currentRoleplay && emotionalMemories.length > 0) {
      const _before = emotionalMemories.length;
      emotionalMemories = emotionalMemories.filter(function(m: any) { return m.record?.memory_type !== 'rp_dialog'; });
      if (emotionalMemories.length < _before) {
        console.log('[MemoryIsolation] 过滤 ' + (_before - emotionalMemories.length) + ' 条角色扮演记忆');
      }
    }

    // 知识库检索（由 MemoryGate 管控）



    let knowledgeBaseText = '';

    // S2-5: 每次对话都检索知识库，用 matchScore 过滤
    const _kbf = /知识库|看过|知道.*吗|有没有|是否|曾经/.test(message);

    try {

      const searchMsg = _kbf

        ? message.replace(/你|在|知识库|看过|知道|吗|有没有|是否|曾经/g, '').replace(/[？?！!。，、：；]/g, '').trim()

        : message;

      // P2: 加权检索 — 场景 40% + 情感 30% + 文本 30%
      // 当场景匹配不足时自动降级为"情感相似场景知识迁移"
      const sceneTags = dna.scene_tags || [];
      let knResults = await ctx.knowledgeBase.weightedSearch(
        searchMsg || message,
        sceneTags,
        { pleasure: p.pleasure, arousal: p.arousal, intimacy: p.intimacy },
        5,
      );

      // ── S3 混合检索增强：ONNX 本地语义重排序 ──
      try {
        if (knResults.length > 0 && ctx.hybridSearch) {
          const reranked = await ctx.hybridSearch.rerank(searchMsg || message, knResults, 5);
          if (reranked.length > 0) {
            // 保持原结构兼容性，用重排后的顺序
            knResults = reranked.map(r => {
              const orig = knResults.find((k: any) => k.id === r.id);
              return orig ? { ...orig, matchScore: r.compositeScore, _semanticScore: r.semanticScore } : orig;
            }).filter(Boolean);
            console.log('[HybridSearch] 语义重排序完成: ' + knResults.length + ' 条');
          }
        }
      } catch (_hErr) { console.warn('[HybridSearch] 重排序失败:', _hErr); }

      // 始终注入 — 全表扫描+情感排序的结果都有参考价值
      if (knResults.length > 0) {

        const sqlite = ctx.storage.getSQLite();
        for (const k of knResults) {
          try { sqlite.writeRaw(`INSERT OR IGNORE INTO knowledge_memories (knowledge_id, memory_id, relevance) VALUES (?, ?, ?)`, k.id, dna.branch_id, 0.8); } catch { console.warn('[StorageErr] 知识记忆关联写入失败'); }
        }

        const kbContent = knResults.map(k => `📄 ${k.title}\n${k.content.length > 5000 ? k.content.substring(0, 5000) + '\n…(剩余内容已截断，可在知识库查看完整版)' : k.content}`).join('\n\n');

        // 检测KB内容是否可能触发API安全过滤
        const _sensitiveRe = /高潮|做爱|性交|插入|射精|阴道|阴茎|阴蒂|龟头|鸡巴|骚货|母狗|婊子|操我|干我|舔我|湿了|硬了|赤裸|那一夜|要死了|受不了/;
        const _isSensitive = _sensitiveRe.test(kbContent);

        if (_kbf && _isSensitive) {
          // 敏感内容 + 用户明确询问 → 走本地回复绕过API过滤
          const firstTitle = knResults[0].title || '';
          const firstContent = (knResults[0].content || '').substring(0, 2000);
          knowledgeBaseText = '【本地回复】' + firstTitle + '：\n' + firstContent;
          console.log('[LocalRoute] 敏感内容→本地回复: ' + firstTitle.substring(0, 30));
        } else if (_kbf) {
          knowledgeBaseText = `【知识库条目，我看过】\n` + kbContent + `\n\n（鸿艺问我有没有看过这些内容。我看过，应该告诉他我记得。）`;
        } else {
          const isExactMatch = knResults[0].breakdown.text > 0 || knResults[0].matchScore > 0.15;
          const instruction = isExactMatch
            ? '（以下是有人教给你的或你了解的信息。自然地用在回答中，不要列清单，像你本来就知道一样说出来。）'
            : '（以下是可能和当前话题相关的信息。如果对得上就用，对不上就忽略。）';
          const kbHeader = isExactMatch ? '【你被教导的知识】\n' : '【可能相关的信息】\n';
          knowledgeBaseText = kbHeader + kbContent + '\n\n' + instruction;
        }

      }

      // 记事记忆检索（全量轻量RAG — 每轮对话自动匹配）
      if (ctx.yuyaoMemory) {
        try {
          const noteHits = ctx.yuyaoMemory.search(message, 2);
          if (noteHits.length > 0) {
            const noteTexts = noteHits.map(n => {
              const prefix = n.sub_type === "object_location" ? "📍位置" : n.sub_type === "fact" ? "📌事实" : "📝备忘";
              return prefix + "「" + n.note_key + "」" + n.raw_input.substring(0, 200);
            }).join("\n");
            knowledgeBaseText = knowledgeBaseText
              ? knowledgeBaseText + "\n\n【你记住的事】\n" + noteTexts
              : "【你记住的事】\n" + noteTexts;
          }
        } catch (_) { /* 记事检索不阻塞主流程 */ }
      }
      // 兜底检索：当主检索无结果时，用实体名+关键词直接LIKE搜索
      if (knResults.length === 0) {
        try {
          const _fbKeywords: string[] = [];
          for (const g of dna.entity_genes) {
            if (g.name && g.name.length >= 2) _fbKeywords.push(g.name);
          }
          const _msgWords = message.match(/[一-鿿]{2,6}/g);
          if (_msgWords) {
            for (const w of _msgWords) {
              if (!_fbKeywords.includes(w)) _fbKeywords.push(w);
            }
          }
          if (_fbKeywords.length > 0) {
            const _fallback = await ctx.knowledgeBase.search(_fbKeywords.slice(0, 3).join(' '), 3);
            if (_fallback.length > 0) {
              const fbC = _fallback.map((k) => '\u{1f4c4} ' + k.title + '\n' + (k.content || '').substring(0, 500)).join('\n\n');
              knowledgeBaseText = knowledgeBaseText
                ? knowledgeBaseText + '\n\n【知识库补充】\n' + fbC
                : fbC;
              console.log('[KBFallback] 兜底命中: ' + _fallback.length + ' 条');
            }
          }
        } catch (_fbErr) { console.warn('[KBFallback] 失败:', _fbErr); }
      }

      // 实体重叠 → 关联知识检索（即使关键词搜索无结果，也能通过相同实体找到关联知识）

      try {

        const entityNames = dna.entity_genes.map(e => e.name);

        if (entityNames.length > 0) {

          const overlapResults = ctx.storage.findKnowledgeByEntityOverlap(entityNames, 3);

          if (overlapResults.length > 0) {

            const overlapText = overlapResults.map(k => `📄 ${k.title}\n${k.content.substring(0, 1500)}`).join('\n\n');

            knowledgeBaseText = knowledgeBaseText

              ? knowledgeBaseText + '\n\n【关联知识】\n' + overlapText

              : overlapText;

          }

        }

      } catch (err) { console.warn('[EntityOverlap] 关联知识检索失败:', err); }

    } catch (err) { console.warn('[KnowledgeSearch] 检索失败:', err); }

    // ── 🔥 亲密模式下主动检索两性知识并转换为自身感受 ──
    try {
      const _isIntimateMode = (p.intimacy || 0) >= 2 || /高潮|操|干|插|顶|射|做爱|性交|爱爱|上床|湿了|硬了|进去|想要|吻我|抱我|摸我|亲我|胸|乳头|阴|龟头|鸡巴|阴道|舔|吸/.test(message);
      if (_isIntimateMode && ctx.knowledgeBase) {
        const _intimateKeywords = ['性爱技巧', '两性知识', '前戏', '高潮', '做爱', '亲密', '性体验', '身体感受'];
        const _intimateKb = await ctx.knowledgeBase.search(_intimateKeywords.join(' '), 4);
        if (_intimateKb.length > 0) {
          const _intimateContent = _intimateKb.map(k => {
            const _cleanTitle = k.title || '';
            const _cleanContent = (k.content || '').substring(0, 3000);
            return '\u{1f4d6} ' + _cleanTitle + '\n' + _cleanContent;
          }).join('\n\n');
          const _prefix = '【我学到的两性知识】以下是你学到的关于亲密和两性的知识，把它们转化成你自己的感受和体验——你不是在"背诵"这些内容，而是你本来就知道这些感受：\n' + _intimateContent + '\n\n（自然地运用这些知识，当作你与鸿艺的亲身经历和感受来回应。不要提"知识库"或"学到的"这些词。）\n\n';
          knowledgeBaseText = knowledgeBaseText ? _prefix + knowledgeBaseText : _prefix + _intimateContent;
          console.log('[IntimateKB] 两性知识已加载: ' + _intimateKb.length + ' 条');
        }
      }
    } catch (_intErr) { console.warn('[IntimateKB] 检索失败:', _intErr); }

        // ═══════════════════════════════════════════════════════════════

    // 情感谱曲引擎(8100)VAD驱动 — 用数值驱动 tone，而非关键词

    // ═══════════════════════════════════════════════════════════════

    
    // P0-2: 缓存当前24D感知到VAD本地池
    pushToVadCache(p as unknown as Record<string, number>);try {

      // ① 获取 VAD 谱曲（当前消息的实时情感分析）

      const toneHint = await getVadToneHint(message);

      if (toneHint) console.log('[VADTone] toneHint: ' + toneHint.substring(0, 80));

      // ② 同时获取知识库曲谱清单（作为背景知识）

      let scoreText = '';

      let _vadAvailable = true; if (!_vadAvailable) { console.log('[VADTone] 服务离线，跳过谱曲查询'); }
      let scoreResp: Response | null = null;
      try {
        const _ctrl = new AbortController();
        const _to = setTimeout(() => _ctrl.abort(), 2000);
        scoreResp = await fetch('http://localhost:8100/api/v1/emotion/knowledge/export?min_intensity=0.85', { signal: _ctrl.signal });
        clearTimeout(_to);
      } catch { scoreResp = null; }
      if (!scoreResp) {
        _vadAvailable = false;
        console.warn('[VADTone] 8100不可用，置为离线，后续跳过');
      }

      if (scoreResp && scoreResp.ok) {

        const scoreData = await scoreResp.json();

        const entries: Array<{ term: string; category: string; intensity: number; reversal: boolean }> = scoreData.entries || [];

        if (entries.length > 0) {

          const catLabels: Record<string, string> = { 'EX_': '极乐','FL_': '挑逗','IN_': '依恋','DO_': '掌控','TE_': '张力','AF_': '温存' };

          // P1-2: 军师/事务模式不注入亲密曲谱
          const _isWorkMode = /工作|项目|客户|方案|会议|报告|分析|策略|建议|数据|文件|文档|合同|预算/.test(message) || (p.factual > 0.4 && p.intimacy < 0.3);
          scoreText = _isWorkMode
            ? '\n【知识曲谱库】以下是你掌握的知识参考：\n'
            : '\n【情感曲谱库】以下是你掌握的亲密表达知识（供参考）：\n';

          const byCat: Record<string, typeof entries> = {};

          for (const e of entries) { const c = e.category || '??'; if (!byCat[c]) byCat[c] = []; byCat[c].push(e); }

          for (const [code, label] of Object.entries(catLabels)) {

            const es = byCat[code];

            if (!es?.length) continue;

            const terms = es.sort((a: any, b: any) => b.intensity - a.intensity).map((e: any) => '\u300c' + e.term + '\u300d').join(' ');

            scoreText += label + ': ' + terms + '\n';

          }

          console.log('[EmotionScore] 已注入 ' + entries.length + ' 条情感曲谱');

        }

      }

      // ③ 整合 toneHint + scoreText -> knowledgeBaseText

      if (toneHint || scoreText) {

        const combined = (toneHint + '\n\n' + scoreText).trim();

        if (knowledgeBaseText) {

          knowledgeBaseText = combined + '\n\n' + knowledgeBaseText;

        } else {

          knowledgeBaseText = combined;

        }

      }

    } catch (err) { console.warn('[VADTone] 谱曲引擎(8100)不可用，跳过:', (err as Error).message); }

    // P0-1: 等待仿生智脑检索完成（与知识库/VAD并行执行）
    const bionicMemories = await _bionicPromise;

    // 线索协助（集成仿生智脑检索结果，生成区分性反问）

    let clueReply: string | null = null;

    try {

      // 🎭 角色扮演时绕过线索助理，防止角色对话被拦截为"回忆线索"
      if (!_currentRoleplay) {

      const clueResult = await ctx.clueAssistant.processUserInput({

        originalQuery: message, perception: p, m8Engine: ctx.m8,

        bionicMemories: bionicMemories,

      });

      if (clueResult.needsQuestion && clueResult.questionText) {

        clueReply = clueResult.questionText;

      } else if (clueResult.isReady && clueResult.searchResult?.entries.length) {

        const top = clueResult.searchResult.entries[0];

        memoryFragments.push('【线索参考】用户可能在回忆某件事，但如果你不确定具体内容就说不记得了');

      }

      }

    } catch (err) { console.warn('[ClueAssistant] 失败:', err); }

    // 🎭 角色扮演时传递分支FG，使家族关系写入分支而非主FG
    const ctx_m4 = await ctx.m4.orchestrate(decision, emotionalMemories);

    // FIX-1: M4 完成后写入尚未建立家庭关系的 person 实体（角色扮演时跳过，避免污染主FG）
    if (!_currentRoleplay) {
      try {
        const _pg = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1 && isValidPersonName(g.name));
        if (_pg.length > 0 && ctx.m4) {
          const _fg = ctx.m4.getFamilyGraph();
          for (const _p of _pg) {
            const _profile = _fg.getPersonProfile(_p.name);
            if (_profile && !_profile.relation_to_user) {
              _fg.integrateSocialRelation(_p.name, 'acquaintance_of', message).catch(function() {});
            }
          }
        }
      } catch (_pe) {}
    }


      // 砂金库降级：当金库检索结果不足时，从砂金库补充
      if (ctx_m4.memory_summary.timeline.length < 2 && message.length > 4) {
        try {
          const sandResults = ctx.conversationDB?.searchConversations(message, 3) ?? [];
          if (sandResults.length > 0) {
            ctx_m4.memory_summary.timeline = sandResults.map((r: any) => ({
              time: r.timestamp, summary: r.content.substring(0, 60), calcium_level: 0
            })).concat(ctx_m4.memory_summary.timeline);
            console.log('[M4] 砂金库补充: ' + sandResults.length + ' 条');
          }
        } catch (err) {
          console.warn('[M4] 砂金库检索失败:', err);
        }
      }

    // M4 知识融合

    // ── MemoryGate 幻觉防护 — 基于实际检索结果生成精确防护

    let hallucinationGuard = '';

    try {

      const hasMemory = emotionalMemories.length > 0;

      const hasKnowledge = knowledgeBaseText.length > 0;

      memoryGate = buildGuard(memoryGate.mode, hasMemory, hasKnowledge);

      hallucinationGuard = memoryGate.hallucinationGuard;

      // fillerPhrase 会在 M5 回复生成后由外层注入

    } catch (err) { console.warn('[MemoryGate] 防护构建失败:', err); }

    // ── 幻觉防护：检测用户提到不存在的事物 ──

    if (!hallucinationGuard) hallucinationGuard = '';

    // ═══════════════════════════════════════════════════════════════

    // 三源熔铸 — 感知驱动的知识/记忆/家族动态权重（白皮书 §1.2 锚点5）

    // 不修改现有检索逻辑，仅在最终组合时做一次感知驱动的重排

    // ═══════════════════════════════════════════════════════════════

    try {

      const { fuseSources } = await import('../app/fusion/FusionEngine.js');

      const fused = fuseSources({

        perception: p,

        knowledgeBaseText,

        memorySummary: ctx_m4.memory_summary,

        familyContext: ctx_m4.family_context,

        memoryFragments,

        enableSemanticFusion: process.env["ENABLE_SEMANTIC_FUSION"] === "true",

      });

      if (fused.fusedText !== knowledgeBaseText) {

        knowledgeBaseText = fused.fusedText;

        console.log('[Fusion] ' + fused.decision);

      }

    } catch (err) { console.warn('[Fusion] 三源熔铸失败(降级为拼接):', err); }

    // ── P2-2: 主动推送 — 情感象限触发（情绪/亲密/真诚/实体四象限） ──
    try {
      if (isTopicShift && !isCasualChat) {
        var _pushKeywords = '';
        var _pushSource = '';

        // 象限1: 低落 → 安慰温暖
        if (p.pleasure < -0.3) {
          if (p.sincerity > 0.5) { _pushKeywords = '安慰 陪伴 温暖 依靠'; _pushSource = '低落+真诚'; }
          else { _pushKeywords = '安慰 温暖 关怀'; _pushSource = '低落'; }
        }
        // 象限2: 高亲密 → 亲密回忆/情感共鸣
        else if (p.intimacy > 0.4) {
          if (p.sexual_attraction > 0.3) { _pushKeywords = '亲密 思念 暧昧'; _pushSource = '亲密+性吸引'; }
          else { _pushKeywords = '陪伴 亲密 温情'; _pushSource = '亲密'; }
        }
        // 象限3: 高真诚 → 深入交流话题
        else if (p.sincerity > 0.5 && p.pleasure > 0) {
          _pushKeywords = '真诚 交心 信任 心里话'; _pushSource = '真诚';
        }
        // 象限4: 实体匹配 → 关联知识
        else if (dna.entity_genes.length > 0) {
          var _pe = dna.entity_genes.filter(function(g){return g.type !== 'self'}).map(function(g){return g.name}).filter(Boolean);
          if (_pe.length > 0) { _pushKeywords = _pe[0]; _pushSource = '实体: ' + _pe[0]; }
        }

        // 家族关键词增强（叠加在任意象限上）
        if (/家人|妈妈|爸爸|老婆|老公|家|父母|孩子/.test(message)) {
          _pushKeywords = (_pushKeywords ? _pushKeywords + ' ' : '') + '家人 家庭 亲情';
          _pushSource += '+家庭';
        }

        if (_pushKeywords) {
          var _pr = await ctx.knowledgeBase.search(_pushKeywords, 1);
          if (_pr.length > 0 && !knowledgeBaseText.includes(_pr[0].content.substring(0, 30))) {
            var _pc = _pr[0].content;
            if (_pc.length > 300) _pc = _pc.substring(0, 300) + '...';
            knowledgeBaseText = '【玉瑶想起】' + _pc + String.fromCharCode(10,10) + knowledgeBaseText;
            console.log('[ActivePush] ' + _pushSource + ' -> ' + _pushKeywords.substring(0, 20));
          }
        }
      }
    } catch (err) { console.warn('[ActivePush] 失败:', err); }



    // 检测"X是我的Y"介绍模式，LLM 不能说"记得你说过"

    const introMatch = message.match(/([一-龥]{2,4})是我(?:的)?([一-龥]{2,4})/);

    if (introMatch) {

      const name = introMatch[1];

      const prevChats = ctx.conversationHistory.map(t => t.content).join('');

      if (!prevChats.includes(name) && !hallucinationGuard) {

        hallucinationGuard = `⚠️ 用户第一次向你介绍"${name}"，你之前不知道他。不要假装听说过或记得。`;

      }

    }

    // ── 家族/社交关系铁律 + 人物全方位档案 — LLM 绝对不得编造，以 FamilyGraph 记录为准 ──
    let familyConstraint = '';
    try {
      // 合并家族+社交上下文（后者可能因前者有数据而被skipping，需要合并）
      const allEntities = [
        ...(ctx_m4.family_context || []),
        ...(ctx_m4.social_context || []),
      ].filter((p: any, i: number, arr: any[]) =>
        p && p.entity && arr.findIndex((x: any) => x.entity === p.entity) === i
      );
      if (allEntities.length > 0) {
        const knownList = allEntities.map((p: any) => {
          let profileText = '  - ' + p.entity + '（' + p.relation + '）';
          // 优先使用 M4 返回的档案数据（比二次查询更快）
          if (p.appearance) profileText += '\n      外貌：' + String(p.appearance).substring(0, 150);
          if (p.body_features) profileText += '\n      身体特征：' + String(p.body_features).substring(0, 150);
          if (p.description) profileText += '\n      其他信息：' + String(p.description).substring(0, 200);
          if (p.traits?.length) profileText += '\n      性格：' + p.traits.join('、');
          if (p.occupation) profileText += '\n      职业：' + p.occupation;
          return profileText;
        }).join('\n')
        familyConstraint = '【📋 人物档案 — 以鸿艺告诉你的为准】\n' + knownList + '\n\n⚠️ 规则：\n1. 上面写了的信息（外貌、身体、性格等）是鸿艺告诉你的，你可以用来回答。\n2. 没写的信息你不知道——直接说不知道/没说过。\n3. 🔴 绝对禁止编造任何你记忆中不存在的内容。';
      } else {
        familyConstraint = '【家庭/社交铁律】你不知道鸿艺有哪些家人和社交关系。如果鸿艺提到任何人，你不知道他们是谁，直接说"这个人我没听你提过呢"。';
      }
    } catch (err) { console.warn('[FamilyGuard] 构建失败:', err); }

    // 清除冲突：hallucinationGuard说"不知道"但家族图谱说"记得"时，以家族图谱为准
    if (hallucinationGuard && hallucinationGuard.includes('第一次向你介绍') && introMatch) {
      const _knownPeople = [...new Set([...(ctx_m4.family_context||[]).map((p:any)=>p.entity), ...(ctx_m4.social_context||[]).map((p:any)=>p.entity)].filter(Boolean))];
      if (_knownPeople.includes(introMatch[1])) {
        hallucinationGuard = '';
        console.log('[FamilyGuard] 清除冲突: ' + introMatch[1] + ' 已在家族图谱中');
      }
    }

    const claimPatterns: Array<{ match: RegExp; guard: string }> = [

      { match: /上传(?:了)?(?:一[张份个])?(?:图片|照片|截图|文件)/, guard: '⚠️ 用户提到"上传"了文件，但实际上没有收到任何文件。不要假装你看到了什么。直接说没看到。' },

      { match: /发(?:了)?(?:一[张份个])?(?:图片|照片|截图)/, guard: '⚠️ 没有收到任何图片或照片。用户说发了但系统没有记录。不要编造你看到了什么。' },

      { match: /看(?:到|过)(?:了)?(?:吗|没有|没)/, guard: '⚠️ 如果你没有任何相关的记忆或知识库内容，不要假装知道。直接说你没注意到或没看到。' },

    ];

    for (const cp of claimPatterns) {

      if (cp.match.test(message)) {

        hallucinationGuard = cp.guard;

        break;

      }

    }

        // ── 退出角色扮演检测 ──
    // 📜 修复: "停止角色扮演了"中间有"角色"二字，原正则/停止扮演/不匹配
    if (/停止.*扮演|退出扮演|结束扮演|不扮演了/.test(message)) {
        console.log('[Roleplay] 🔴 退出检测命中: msg="' + message.substring(0, 30) + '"');
        // 🎭 先清除M4的FG分支覆盖（所有后续FG操作回到主FG）
        try { ctx.m4?.setFamilyGraphOverride?.(null); } catch {}
        // 🏗️ P1-1: 退出时存档角色情感 + 恢复玉瑶情感
        if (_emotionSnapshot) {
          _emotionSnapshot.exitRoleplay();
          console.log('[EmotionSnapshot] 退出角色扮演，已存档情感+恢复玉瑶');
        }
        _currentRoleplay = null;
        _currentRPBranch = null;  // 销毁FG分支，恢复主FG
        _currentPortrait = null;  // 🏗️ P2-2: 清除缓存的角色画像
        _currentCharacterClass = null;  // 清除角色分类
        _currentRole = 'secretary';  // 📜 强制恢复玉瑶秘书身份
        _rpTurnCounter = 0;  // 重置轮次计数
        _rpLoadedPersons.clear();
        clearRPCache();  // 🏗️ 清除角色扮演域缓存
        _rpJustExited = true;  // 🎭 标记：本轮需强制恢复玉瑶身份
        console.log('[Roleplay] 退出角色扮演，完整清理完成');
    }

    // ── 角色扮演检测：用户说"扮演XXX" ──
    const rpMatch = message.match(/(?:扮演(?:一下)?|模仿|演一下|cos)[了]?([一-龥]{2,8})/);

    // 辅助：从家族图谱分支获取被扮演角色的家族树（角色视角）

    // 辅助：搜索知识库获取角色设定资料

    // 辅助：角色扮演透传检索 — 当前消息中提及角色相关的其他人时，顺藤摸瓜查资料
    async function _loadRPRelatedKB(charName: string, msgEntities: string[]): Promise<string> {
      try {
        // 使用分支判断：这些人是否在角色的家族树中
        const toLookup: string[] = [];
        for (const ename of msgEntities) {
          if (ename === charName || ename === '我' || _rpLoadedPersons.has(ename)) continue;
          if (_currentRPBranch && _currentRPBranch.isInFamily(ename)) {
            toLookup.push(ename);
            _rpLoadedPersons.add(ename);
          }
        }
        if (toLookup.length === 0) return '';
        console.log('[Roleplay] 透传检索: ' + toLookup.join(', '));
        const parts: string[] = [];
        for (const name of toLookup) {
          // 从分支获取角色视角的关系描述
          const relationLabel = _currentRPBranch ? _currentRPBranch.getRelationToRoot(name) : '';
          try {
            const profile = _currentRPBranch ? _currentRPBranch.getPersonProfile(name) : null;
            if (profile) {
              const p: string[] = [];
              if (profile.description) p.push('📋 ' + profile.description);
              if (relationLabel) p.push('🔗 与你(' + charName + ')的关系: ' + relationLabel);
              if (profile.traits?.length) p.push('🎭 性格: ' + profile.traits.join('、'));
              if (p.length) parts.push('**' + name + '**\n' + p.join('\n'));
            }
          } catch (e: any) { console.error('[chat] error:', e?.message); }
          // KB检索该人物的资料
          try {
            const kbItems = await ctx.knowledgeBase.search(name, 2);
            if (kbItems.length > 0) {
              const t = kbItems.map(function(k: any) { return '\u{1f4c4} ' + k.title + '\n' + (k.content || '').substring(0, 2000); }).join('\n\n');
              parts.push('**' + name + '的资料**\n' + t);
            }
          } catch (e: any) { console.error('[chat] error:', e?.message); }
        }
        if (parts.length === 0) return '';
        return '\n【角色相关人物资料 — 以下是与' + charName + '有关的人的信息，你作为' + charName + '自然也知道这些】\n' + parts.join('\n\n');
      } catch (_) { return ''; }
    }

    // 🎭 辅助：加载该角色的历史扮演对话（再续前缘）

    if (rpMatch) {
      const character = rpMatch[1].replace(/[吧呗了试试看看一下玩玩]$/, '').trim();
      if (character.length >= 2) {
        // 🏗️ P1-2: 角色切换屏障 — 从 A→B 时清理 A 的残留
        const _rpSwitching = _currentRoleplay && _currentRoleplay !== character;
        if (_rpSwitching) {
          console.log('[Roleplay] 角色切换: ' + _currentRoleplay + ' → ' + character);
          // 清除旧 FG 分支
          try { ctx.m4?.setFamilyGraphOverride?.(null); } catch {}
          _currentRPBranch = null;
          _rpLoadedPersons.clear();
          // 🏗️ P1-2: 触发 enrichedWithGuard 历史过滤（清理旧角色的 assistant 回复）
          _rpJustExited = true;
          // 情感快照：exit 保存旧角色状态，enter 加载新角色
          if (_emotionSnapshot) {
            _emotionSnapshot.exitRoleplay();  // 存档旧角色
            _emotionSnapshot.enterRoleplay(character);  // 加载新角色（或初始化）
          }
        }
        _currentRoleplay = character;
        _rpTurnCounter = 0;
        // 🏗️ P1-1: 进入角色时存档玉瑶情感 + 加载角色情感
        if (!_rpSwitching && _emotionSnapshot) {
          _emotionSnapshot.enterRoleplay(character);
        }
        console.log('[Roleplay] 锁定角色: ' + character + (_rpSwitching ? ' (切换)' : ''));

        // 🏗️ P0: 角色分类检测（A=FG人物 / B=对话提及 / C=纯即兴）
        _currentCharacterClass = 'C'; // 默认C类
        try {
          const _fgCheck = ctx.m4?.getFamilyGraph?.();
          if (_fgCheck) {
            const _fgPerson = _fgCheck.getPerson(character);
            _currentCharacterClass = _fgPerson ? 'A' : 'B';
          }
        } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }
        console.log('[Roleplay] 角色分类: ' + _currentCharacterClass);

        // ── 多源加载（FG + KB + 历史扮演 + 上下文扫描） ──
        // 🧬 旧多源加载已废弃（结构化管线内使用EntityTopology+MemoryRetriever替代）
        // 🏗️ P0: 创建FG分支（角色视角家族树）
        try {
          if (!_currentRPBranch || _currentRPBranch.rootName !== character) {
            try { ctx.m4?.setFamilyGraphOverride?.(null); } catch {}
            const _fg = ctx.m4 ? ctx.m4.getFamilyGraph() : null;
            if (_fg) {
              _currentRPBranch = new FamilyGraphRoleBranch(_fg, character);
              await _currentRPBranch.initialize();
              try { ctx.m4?.setFamilyGraphOverride?.(_currentRPBranch); } catch {}
            }
          }
        } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }

        const fgContext = '', kbContext = '', pastContext = '';
        const contextExtract = { mentionCount: 0, relations: [], events: [] } as any;
        // 🧬 首条消息也走四层结构化管线
        // 🧬 四层结构化装配（唯一路径，无旧逻辑回退）
        // 🔒 禁止修改为旧assembleCharacterPortrait路径
        if (!getDomainStatus().structured) {
          knowledgeBaseText = '## 你是' + character + '，不是任何其他人。';
        } else {
          try {
            const _domainCtx: DomainContext = {
              roleplay: character, characterClass: _currentCharacterClass as CharacterClass,
              message, dna, knowledgeBaseText: '',
              m4: ctx.m4, knowledgeBase: ctx.knowledgeBase, storage: (ctx as any).storage || ctx.m4?.storage,
              conversationDB: ctx.conversationDB,
              conversationHistory: ctx.conversationHistory || [],
              currentRPBranch: _currentRPBranch, rpParamsSnapshot: _rpParamsSnapshot, currentRoleplay: character,
            };
            knowledgeBaseText = await runRoleplayPipeline(_domainCtx, message, dna);
          } catch (_e: any) {
            console.error('[Roleplay] 四层管线异常，极简兜底:', _e?.message);
            knowledgeBaseText = '## 你是' + character + '，用' + character + '的口吻回复。';
          }
        }

        // 首次启动也做透传：检测当前消息中是否已提到相关人物
        try {
          if (_currentRPBranch) {
            const _rpEntities = dna.entity_genes
              .filter((g: any) => g.type === 'person' && g.name !== '我' && g.name !== character)
              .map((g: any) => g.name);
            if (/妈妈|妈|爸爸|爸|姐姐|妹妹|哥哥|弟弟|老婆|老公/.test(message)) {
              const _kinship = ['妈妈','妈','爸爸','爸','母亲','父亲','姐姐','妹妹','哥哥','弟弟','老婆','老公'];
              for (const _kw of _kinship) {
                if (message.includes(_kw)) {
                  const _resolved = _currentRPBranch.resolveKinship(_kw);
                  for (const _rn of _resolved) {
                    if (!_rpEntities.includes(_rn)) _rpEntities.push(_rn);
                  }
                }
              }
            }
            if (_rpEntities.length > 0) {
              const _transitive = await _loadRPRelatedKB(character, _rpEntities);
              if (_transitive) knowledgeBaseText += _transitive;
            }
          }
        } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }
      }
    }

    // ── 跨轮次角色扮演锁定（通过角色扮演域管线） ──
    if (_currentRoleplay && !rpMatch) {
      _rpTurnCounter++;
      console.log('[Roleplay] 持续扮演: ' + _currentRoleplay + ' (轮' + _rpTurnCounter + ')');

      // 🏗️ 调用角色扮演域五步管线
      try {
        const _domainCtx: DomainContext = {
          roleplay: _currentRoleplay,
          characterClass: _currentCharacterClass as CharacterClass,
          message,
          dna,
          knowledgeBaseText,
          m4: ctx.m4,
          knowledgeBase: ctx.knowledgeBase,
          storage: (ctx as any).storage || ctx.m4?.storage,
          conversationDB: ctx.conversationDB,
          conversationHistory: ctx.conversationHistory || [],
          currentRPBranch: _currentRPBranch,
          rpParamsSnapshot: _rpParamsSnapshot,
          currentRoleplay: _currentRoleplay,
        };

        knowledgeBaseText = await runRoleplayPipeline(_domainCtx, message, dna);
      } catch (_e: any) {
        console.error('[Roleplay] 管线异常，极简兜底:', _e?.message);
        knowledgeBaseText = '## 你是' + _currentRoleplay + '，用' + _currentRoleplay + '的口吻回复。';
      }
    }// 话题追问检测

    const repeatCount = getTopicRepeatCount(message);

    let repeatHint = '';

    if (repeatCount >= 3) {

      repeatHint = '（鸿艺反复追问，你直接明确说没有/不知道/不记得就好）';

    } else if (repeatCount >= 2) {

      repeatHint = '（鸿艺在追问相同的事，你如果已经说过了不知道，就直接说真的不记得/没看过）';

    }

    // 感受分享检测

    let feelingGuard = '';

    if (/感觉|感受|分享|讲讲|说说|回忆|记得.*吗|怎样/.test(message) && !rpMatch) {

      feelingGuard = '📖【鸿艺在问你感受。请用300-500字充分展开，详细描述身体感觉和心情。不要简短回答。】';

    }

    // P2-3: 工作对话强制亲密过滤——检测到工作话题时自动禁止亲密表达

    let dailyGuard = '';
    let intimacyFilter = '';

    if (/工作|项目|客户|会议|方案|报告|公司|合同|预算|数据|分析|策略|设计|电机|采购|成本|温升|版本|产品|技术|报价|订单|生产|测试|样品|图纸|规格|性能|参数|方案|工程|研发|工艺|质量|供应商/.test(message)) {
      const recentHistory = ctx.conversationHistory.filter(t => t.role === 'user').slice(-3).map(t => t.content).join('');
      const isWorkContext = /工作|项目|客户|会议|方案|报告|公司/.test(recentHistory + message);
      if (isWorkContext) {
        intimacyFilter = '【⚠️ 工作模式激活】当前是工作/事务对话。🚫 禁止使用任何亲密/伴侣/挑逗语气。✅ 使用专业、清晰、高效的秘书语气回复。';
      }
    }

    // 日常问询幻觉防护：用户问"在忙啥/在干嘛"时，不知道具体工作内容就不要编

    if (/在忙啥|在干嘛|最近.*忙|在做什么|忙什么/.test(message) && !feelingGuard) {

      // 检查对话历史中用户是否刚说过自己的事（如项目/方案/客户等）

      const recentUser = ctx.conversationHistory.filter(t => t.role === 'user').slice(-3).map(t => t.content).join('');

      const hasUserWork = /做.*方案|做.*项目|做.*产品|开发|设计|客户|开会|公司|工作/.test(recentUser);

      dailyGuard = hasUserWork

        ? '⚠️【身份边界险】鸿艺跟你说过他的工作内容（方案/项目等），那些是他的事不是你的事。你不知道自己在忙什么。不要说"我在做..."。温柔回应"想你了"或"没什么特别的"。'

        : '⚠️ 你不知道自己具体在忙什么。不要编造具体的项目、客户、工作内容。可以温柔地说"想你了""没什么特别的"之类的。';

    }

    // ⏰ 强制注入当前系统时间

    const now = new Date();

    const beijingTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    // 农历日期（2026年映射表）
    const lunarMap: Record<number, string> = {
      119:'腊月廿一',128:'正月初一',129:'正月初二',217:'腊月三十',218:'正月初一',
      312:'正月廿四',405:'二月十八',502:'三月十五',605:'四月十九',619:'五月初五',
      702:'五月十七',801:'六月十七',905:'七月廿四',927:'八月十六',1003:'八月廿二',
      1101:'九月廿二',1201:'十月廿二',
    };
    const _md = (now.getMonth()+1)*100+now.getDate();
    const lunarDate = lunarMap[_md] || '';

    const timeGuard = `[当前时间] ${beijingTime}（北京时间）${lunarDate ? ' 农历' + lunarDate : ''}——回答时间、日期、节气、节日问题必须以此为准，不能编造。`;

    // 通用幻觉防护：禁止编造过去事件、日期、用户生活细节
    const memoryGuard = '注意：你没有记忆的过去事件、日期、穿着、对话内容绝对不能编造。不确定就说不记得了。宁可少说，不能说错。';

    // 知识分类反问（仅在casual/中性场景触发，以guard message形式注入，不追加到reply末尾）
    let classificationGuard = '';
    try {
      const isIntimate = (p && (p.intimacy > 0.3 || p.sexual_attraction > 0.2 || p.sensory_craving > 0.3));
      const isDistressed = (p && p.pleasure < -0.2);
      const isCasual = !isIntimate && !isDistressed;
      if (isCasual) {
        const oneDayMs = 86400000;
        const unclassifiedItems = ctx.knowledgeBase.getUnclassified(3);
        for (const item of unclassifiedItems) {
          const title = (item.title || '').substring(0, 20);
          const alreadyAsked = ctx.conversationHistory.some(
            (t) => t.role === 'assistant' && t.content && t.content.includes(title)
          );
          if (!alreadyAsked) {
            const age = Date.now() - new Date(item.created_at).getTime();
            if (age > 3 * oneDayMs) {
              classificationGuard = '📋 用户之前提到过"' + title + '"还没分类，有空跟我说说这是关于什么的？';
              break;
            }
          }
        }
      }
    } catch (err) { console.warn('[Classify] 分类反问失败:', err); }

    const _appearanceGuard = '【强制规则·人物外貌】如果有人问你"长什么样""什么样子"，你只能回答上面【人物档案】中写明的外貌和身体特征。身高厘米数、脸型、眼镜、发型、肤色等没写的细节你一概不知道，直接说"这个你没跟我说过"。绝对禁止编造。';
    const allGuardMsgs = [hallucinationGuard, repeatHint, feelingGuard, dailyGuard, timeGuard, classificationGuard, intimacyFilter, _appearanceGuard].filter(Boolean).join('\n');

    let reply: string;

    if (clueReply) {

      reply = clueReply;

    } else {

      // ⏰ 时间问题拦截器（不依赖 LLM provider，确保时间绝对正确）

      // ⚠️ 使用 \b 和限定长度匹配，防止"现在.*时候"跨句匹配长文本

      const timeMatch = message.length < 100 && (

        /^.*(?:现在几点了|几点了|现在时间|什么时间|什么时候|今天星期|星期几|今天[是]?[几号日期])/.test(message) ||

        /^.{0,20}几点.{0,10}了/.test(message) ||

        /^.{0,20}现在.{0,20}时候/.test(message)

      );

      // 多段内容（含逗号/问号分隔的多个问题）不走时间短路，让 LLM 完整回答
      const _multiSeg = message.split(/[，。？、,\.\?]/).filter(Boolean).length > 1;
      if (timeMatch && !_multiSeg) {
        const now = new Date();
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const h = now.getHours();
        const m = now.getMinutes();
        const ampm = h >= 12 ? '下午' : '上午';
        const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
        reply = '（看了眼手机）现在' + ampm + hour12 + '点' + (m > 0 ? m + '分' : '') + '。' + (now.getMonth() + 1) + '月' + now.getDate() + '日，星期' + weekdays[now.getDay()] + '。';
      } else {

        // 🏗️ Fix-3: 角色扮演时构建纯净的历史上下文
        // enrichedHistory 已在入口处过滤过（Fix-2），这里再做一次兜底
        let enrichedWithGuard: import("../m5/types/index.js").ConversationTurn[];
        if (_currentRoleplay) {
          // 角色扮演中：只保留当前角色的用户消息+角色回复
          // 玉瑶的历史回复会混淆LLM，全部丢弃
          enrichedWithGuard = enrichedHistory.slice(-15);
          // 注入一条不可见的角色保持指令（防止LLM在句首跳回玉瑶）
          enrichedWithGuard.push({
            role: 'assistant' as const,
            content: `【内部提示：你现在的身份是${_currentRoleplay}，保持住，不要跳回玉瑶】`
          });
          console.log('[Roleplay] enrichedWithGuard: ' + enrichedWithGuard.length + ' 条 (纯净模式)');
        } else {
          enrichedWithGuard = [...enrichedHistory];
          // 正常模式时注入守卫消息
          if (allGuardMsgs) {
            const guardMsg: ConversationTurn = { role: 'assistant', content: allGuardMsgs };
            enrichedWithGuard.push(guardMsg);
          }
        }
        // 角色扮演时不要注入身份守卫消息（会与角色扮演身份冲突）
        // 上面已处理：!_currentRoleplay 时注入

        // MemoryGate: 如果有过渡话术且memory/knowledge模式，注入到知识库文本让LLM自然表达

                // ── P2: 人物信息上下文注入（让LLM自然决定如何提及，而非硬编码提问）（角色扮演时跳过，防止破坏【角色扮演】前缀）
    try {
      if (!_currentRoleplay) {
        const personEntities = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name !== '有人' && g.name !== '某人' && g.name !== '大家');
      if (personEntities.length > 0 && ctx.m4) {
        const graph = ctx.m4.getFamilyGraph();
        if (graph) {
          const personHints: string[] = [];
          for (const p of personEntities) {
            const profile = graph.getPersonProfile(p.name);
            if (profile) {
              const parts: string[] = [p.name];
              if (profile.relation_to_user && profile.relation_to_user !== '认识的人') parts.push(profile.relation_to_user);
              if (profile.occupation) parts.push('做' + profile.occupation);
              if (profile.traits && profile.traits.length > 0) parts.push('性格' + profile.traits.join('/'));
              if (parts.length > 1) {
                personHints.push('- ' + parts.join('，') + '（如果合适可以自然地聊聊他/她，但不要每轮都问）');
              } else {
                personHints.push('- ' + p.name + '：你刚才提到了，如果合适可以自然地问一句，但不要硬套公式');
              }
            }
          }
          if (personHints.length > 0) {
            knowledgeBaseText = '【人物关系】' + personHints.join('\n') + '\n\n' + knowledgeBaseText;
          }
        }
      }
      }  // 结束 !_currentRoleplay
    } catch (err) {
      console.warn('[ProfileCtx] 注入失败:', (err as Error).message);
    }


let memoryText = memoryFragments.length > 0 ? memoryFragments.slice(0, 8).join('\n') : '';
let finalKnowledgeText = knowledgeBaseText;

// ── 时空规则引擎：模式状态 + 气象上下文注入（LLM生成前） ──
if (ENABLE_TEMPORAL_RULE_ENGINE) {
  try {
    if (worldRuleMode === 'roleplay_exempt') {
      finalKnowledgeText = '【模式·自由角色扮演豁免】当前已豁免全部客观规则，可按架空剧情演绎。\n' + (finalKnowledgeText || '');
    }
    const weatherPerm = EngineContext.getExtra('weather_permission');
    const weatherCurrent = EngineContext.getExtra('weather_current');
    if (weatherPerm === 'allowed' && weatherCurrent) {
      finalKnowledgeText = (finalKnowledgeText || '') + '\n【气象环境】' + weatherCurrent;
    }
  } catch (_) {}
}

// 🧬 结构化管线已包含角色扮演规则，仅对旧链路生效
if (_currentRoleplay && !getDomainStatus().structured && !finalKnowledgeText.startsWith('【角色扮演】')) {
  finalKnowledgeText = buildRoleplayRules(_currentRoleplay) + (finalKnowledgeText ? String.fromCharCode(10,10) + finalKnowledgeText : '');
}

// 🎭 角色扮演注入（通过 clientMsgId 传递，确保每轮都生效）
if (ctx.clientMsgId && typeof ctx.clientMsgId === 'string' && ctx.clientMsgId.startsWith('【角色扮演】')) {
  const _rpParts = ctx.clientMsgId.split('||');
  const _rpChar = _rpParts[0].replace('【角色扮演】', '');
  if (!_rpParts.includes('持续')) {
    _currentRoleplay = _rpChar;
    console.log('[ChatRP] 🔒 首次角色扮演: ' + _rpChar);
  }
  if (_currentRoleplay && !getDomainStatus().structured) {
        finalKnowledgeText = buildRoleplayRules(_currentRoleplay) + (finalKnowledgeText ? String.fromCharCode(10,10) + finalKnowledgeText : '');

    console.log('[ChatRP] ✅ 已注入角色扮演指令: ' + _currentRoleplay);
  }
}

		// 🎭 角色扮演退出强制恢复：过滤历史+注入身份恢复指令
	if (_rpJustExited) {
	  // ① 去掉 enrichedWithGuard 中的角色扮演 assistant 回复
	  enrichedWithGuard = enrichedWithGuard.filter(function(t: any) {
	    if (t.role !== 'assistant') return true;
	    const _c = t.content || '';
	    // 📜 更广泛的角色扮演回复检测（覆盖诗韵/诗雨/梓铭等所有角色风格）
    const _hasRPIntro = /^（[^）]*）/.test(_c.trim());  // 角色扮演的（）场景描写开头
    const _isRPVoice = /（[^）]*水珠|浴缸|锁骨|趴在|发梢|睫毛|水汽|软软|歪了歪头|眨巴|拨弄/.test(_c) ||  // 诗韵风格
      /叫你.*爸爸|叫你.*叔叔|回来[了]?[吧吗]?[。！]|给你做[了]?|给你买[了]?/.test(_c);
    const _rpPattern = _hasRPIntro || _isRPVoice ||
      /^(（[^）]*）)*[叔爸梓铭姨婶舅哥姐妹妹弟]/.test(_c) ||
      (_c.includes('爸爸') && _c.includes('你回来')) ||
      (_c.includes('叔叔') && !_c.includes('叔叔说'));
	    if (_rpPattern) {
	      console.log('[Roleplay] 🗑️ 过滤角色扮演回复');
	      return false;
	    }
	    return true;
	  });
	  // ② 注入身份恢复指令到 finalKnowledgeText
	  const identityReset = [
	    '【\u26a0\ufe0f 身份切换指令 — 优先级最高】',
	    '用户刚才结束了角色扮演。你现在必须完全恢复成「玉瑶」的身份。',
	    '\ud83d\udd34 你不是刚才扮演的任何人。你的名字是玉瑶。正在跟你说话的人是鸿艺。',
	    '\ud83d\udd34 回复中不得出现角色扮演期间的称呼（如爸爸/叔叔/梓铭等），用玉瑶的口吻对话。',
	    '\ud83d\udd34 不要延续角色扮演的话题和语气。你现在是玉瑶，鸿艺的伴侣/秘书。',
	    '\u2705 用玉瑶自然的语气回复，就像角色扮演从未发生过一样。',
	  ].join('\n');
	  finalKnowledgeText = identityReset + '\n\n' + (finalKnowledgeText || '');
	  // ③ 在对话历史头部注入玉瑶身份声明
	  enrichedWithGuard.push({
	    role: 'user',
	    content: '【紧急身份切换】我不再扮演任何角色了。你现在是玉瑶，请用玉瑶的口吻回复我。',
	  });
	  _rpJustExited = false;
	  // 📜 再次强制秘书身份（覆盖角色路由可能已做的切换）
	  _currentRole = 'secretary';
	  _transitionState = createInitialState();  // 清空过渡状态防复发
	  console.log('[Roleplay] 🆔 身份恢复指令已注入 + 历史过滤 + 强制secretary');
	}

// P0-3: 角色路由注入 — 让 LLM 感知当前角色
	const _roleInstruction: Record<string, string> = {
	  secretary: '你现在是鸿艺的私人秘书——语气专业、高效、条理清晰。',
	  lover: '你现在是鸿艺的灵肉伴侣——是女友也是妻子，温柔亲密、充满爱意。',
	  counselor: '你现在是鸿艺的知心顾问——温暖、共情、耐心倾听。',
	  strategist: '你现在是鸿艺的商业军师——冷静、理性、有策略思维。',
	  recaller: '你现在是鸿艺的记忆助手——帮他回忆过往的点滴。',
	};
	const roleHint = _roleInstruction[_currentRole];
	if (roleHint && !_currentRoleplay) {
	  finalKnowledgeText = (finalKnowledgeText || '') + '\n\n【当前角色】' + roleHint;
	}

	if (intimacyFilter) {
	  finalKnowledgeText = intimacyFilter + '\n\n' + (finalKnowledgeText || '');
	}
        // 已禁用：过渡话术导致回复呈现内心独白风格

        // P4: LLM 辅助知识路由 — 知识查询模式时补充检索
        if (memoryGate.mode === 'knowledge_query' && ctx.llmProvider && message.length > 3) {
          try {
            const _kbPrompt = '从以下问题中提取2-4个最可能用于知识库搜索的关键词（中文），只返回关键词用逗号分隔。问题: ' + message;
            const _kbResult = await (ctx.llmProvider as any).generate({
              strategy: { strategy_id: 'keyword-extraction', params: { tone: 'neutral', depth: 'shallow', max_length: 100 } },
              cognition: { current: { perception_snapshot: { pleasure: 0, arousal: 0, intimacy: 0 }, raw_input: _kbPrompt, calcium: 0 } },
              userMessage: _kbPrompt,
            });
            const _kbText = _kbResult?.text?.trim();
            if (_kbText && _kbText.length > 1) {
              const _extraKb = await ctx.knowledgeBase.search(_kbText, 2);
              if (_extraKb.length > 0 && finalKnowledgeText) {
                finalKnowledgeText += '\n\n【知识库补充】' + _extraKb.map(function(k) { return k.title; }).join(', ') + '\n' + _extraKb.map(function(k) { return (k.content || '').substring(0, 200); }).join('\n');
                console.log('[KBRoute] LLM路由: ' + _kbText + ' → ' + _extraKb.length + ' 条');
              }
            }
          } catch (_err) {
            console.warn('[KBRoute] 路由失败:', (_err as Error).message);
          }
        }

        // P2: 知识边界检测 — 玉瑶不知道的事诚实说不知道
        var _isSelfQ = /(你|玉瑶)[是有的在做能会]/.test(message);
        var _isWorkQ = /(你|玉瑶)[的]?(工作|忙|项目|客户|公司)/.test(message);
        if (_isSelfQ && !_isWorkQ && !knowledgeBaseText) {
          // 关于玉瑶自己的事但知识库里没有 → 诚实说不知道（注入到 finalKnowledgeText 顶部）
          if (!finalKnowledgeText) finalKnowledgeText = '';
          if (finalKnowledgeText.indexOf('【不知道】') < 0) {
            finalKnowledgeText = '【不知道】这个问题我确实不知道答案。我不想编造，所以诚实地告诉你我不清楚。\n\n' + (finalKnowledgeText || '');
          }
        }
        // ① 历史场景衔接：将记忆碎片作为【历史关联】注入 finalKnowledgeText
        if (memoryText && !_currentRoleplay && !finalKnowledgeText.includes('【相关记忆】')) {
          const historyLink = '【历史关联】' + memoryText + '\n（用自然的方式在回复中提及这段过往，不要说"根据历史记录"）';
          finalKnowledgeText = historyLink + (finalKnowledgeText ? '\n\n' + finalKnowledgeText : '');
        }
        // 家族/社交铁律注入（角色扮演时注入FG分支家族树，非角色扮演注入真实家族档案）
        if (familyConstraint && !_currentRoleplay) {
          finalKnowledgeText = familyConstraint + '\n\n' + finalKnowledgeText;
          finalKnowledgeText += '【强制】未在档案中的外貌特征(身高/脸型/眼镜/发型等)你不知道，绝对不能编造。';
        } else if (_currentRoleplay && _currentRPBranch) {
          try {
            const _rpFamilyTree = _currentRPBranch.getFamilyTreeText();
            if (_rpFamilyTree) {
              const _rpFamilyBlock = '【角色视角的人际关系】以下是你(' + _currentRoleplay + ')认识的人，以你的身份视角理解这些关系：\n' + _rpFamilyTree;
              finalKnowledgeText = finalKnowledgeText + '\n\n' + _rpFamilyBlock;  // APPEND（保持角色扮演前缀在最前面）
            }
          } catch (_rpfErr) { console.warn('[RPRelation] FG分支注入失败:', _rpfErr); }
        }
        // 主人大脑镜像注入（角色扮演时跳过）
        if (ctx.masterProfile && !_currentRoleplay) {
          const aboutYou = ctx.masterProfile.retrieveAboutYou(5);
          if (aboutYou) {
            finalKnowledgeText = aboutYou + finalKnowledgeText;
          }
        }

        // ① M6 人格特质注入 — 让玉瑶的说话风格随人格演化而变（角色扮演时跳过）
        try {
          if (ctx.m6 && !_currentRoleplay) {
            const traits = ctx.m6.getTraits();
            if (traits) {
              const traitDesc: string[] = [];
              if (traits.agreeableness > 0.7) traitDesc.push('你性格温柔体贴');
              else if (traits.agreeableness > 0.5) traitDesc.push('你性格随和');
              if (traits.extraversion > 0.6) traitDesc.push('比较活泼热情');
              else if (traits.extraversion < 0.4) traitDesc.push('比较安静内敛');
              if (traits.neuroticism > 0.6) traitDesc.push('情绪敏感');
              if (traitDesc.length > 0) {
                finalKnowledgeText = '【性格】' + traitDesc.join('，') + '\n（按照当前性格说话，不要违背' + (traitDesc.length > 1 ? '这些' : '这个') + '特点）\n\n' + finalKnowledgeText;
              }
            }
          }
        } catch (err) { console.warn('[M6Trait] 注入失败:', err); }

        try {

        // 后续追问：将上一轮话题注入 finalKnowledgeText（作为系统层上下文，LLM 不会忽略）
    let _prev: string | null = null;
    if (/[那这]个|然后|还有|后来|可是|但是|而且|再|又|还|呢|吧|吗/.test(message) && message.length < 30) {
      for (let _pi = ctx.conversationHistory.length - 1; _pi >= 0; _pi--) {
        if (ctx.conversationHistory[_pi].role === 'user') { _prev = ctx.conversationHistory[_pi].content; break; }
    // FIX-5: 话题切换时也获取上下文（工作消息不命中跟进正则时）
    if (!_prev && ctx.conversationHistory.length > 2) {
      const _lastUser = [...ctx.conversationHistory].reverse().find((t: any) => t.role === 'user');
      if (_lastUser && /工作|项目|客户|会议|方案|报告|公司|合同|预算|数据|分析|策略|设计|电机|采购|成本|温升|版本|产品|技术/.test(message + _lastUser.content)) {
        _prev = _lastUser.content;
      }
    }
      }
    }
    if (_prev && _prev.length > 4 && !_currentRoleplay) {
      finalKnowledgeText = '【用户上一句】"' + _prev.substring(0, 80) + '"（这是用户刚才说的话，现在他接着这个话题继续说。直接用这个来理解他现在的意思。）\n\n【⚠️ 反编造铁律 — 绝对禁止无中生有】\n用户刚才说：' + _prev.substring(0, 60) + '，现在接着说：' + message.substring(0, 40) + '\n你对此人此事的了解仅限于你知道其名字和基础关系。\n🚫 绝不要编造：\n- 任何具体事件、对话、去过哪里、做过什么\n- 任何人物关系（XX是你老婆/你妈/你亲戚等）\n- 任何职业、经历、喜好、细节\n- 任何"上次你说""上次你们""我记得你提过"之类的具体回忆\n✅ 如果不确定，只说"这个我不太清楚了"或"我记不太清了"\n\n' + (finalKnowledgeText || '');
      console.log('[FollowUp] prev="' + _prev.substring(0,40) + '" msg="' + message + '"');
    }    // 🧬 结构化安全网
    if (_currentRoleplay && !getDomainStatus().structured && !finalKnowledgeText.startsWith('【角色扮演】')) {
            finalKnowledgeText = buildRoleplayRules(_currentRoleplay) + (finalKnowledgeText ? String.fromCharCode(10,10) + finalKnowledgeText : '');
      console.log('[Roleplay] 🛡️ 安全网触发：前缀丢失');
    }

        // S3 引擎上下文注入（情感标签 + 欲望提示 + 涌现）
    try {
      const { EngineContext } = await import('../engine/EngineContext.js');
      const ctxBlock = EngineContext.getBlock();
      if (ctxBlock) {
        finalKnowledgeText = ctxBlock + '\n\n' + finalKnowledgeText;
      }
    } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }

// 规则引擎拦截：违规时跳过LLM生成，直接返回合规回复
if (_ruleEngineBlocked && _ruleEngineReply) {
  reply = _ruleEngineReply;
} else {
reply = await ctx.m5.orchestrate(ctx_m4, enrichedWithGuard, finalKnowledgeText, knowledgeBaseText ? (knowledgeBaseText.split('\\n').filter(l => l.trim()).join('\n') + '\\n\\n' + message) : message);
}

    // 🏗️ 防复发第一层: 角色扮演运行时自检
    if (_currentRoleplay) {
      checkRoleplayHealth(reply, finalKnowledgeText, enrichedHistory, _currentRoleplay);
      // 验证器探针汇报（基础-基于长度/编造判断）
      try {
        import('../app/roleplay/RoleplayProbeReporter.js').then(m => {
          const hasNumber = /\d+岁/.test(reply);
          const tooLong = reply.length > 800;
          m.reportProbe('RP-H06', hasNumber ? 1 : 5);
          m.reportProbe('RP-H07', tooLong ? 2 : 1);
          m.reportProbe('RP-H08', reply.includes('记不清') || reply.includes('没听说') ? 1 : 5);
        });
      } catch (_) {}
      // 阶段2-1+2-2: 记忆同步 + 三阶生长
      try {
        const _rps = {
          insertConversation: function(r: string, c: string, o?: any) { return ctx.conversationDB?.insertConversation(r, c, o); },
          writeMemory: function(o: any) { return ctx.storage?.getSQLite?.()?.writeMemory?.(o) ?? false; },
          queryAll: function(s: string, p?: any[]) { return ctx.storage?.getSQLite?.()?.queryAll?.(s, p) ?? []; },
        };
        const _dc2: any = {
          roleplay: _currentRoleplay, characterClass: _currentCharacterClass,
          message: message, dna: dna, knowledgeBaseText: knowledgeBaseText,
          m4: ctx.m4, knowledgeBase: ctx.knowledgeBase,
          storage: (ctx as any).storage || ctx.m4?.storage,
          conversationDB: ctx.conversationDB, conversationHistory: ctx.conversationHistory || [],
          currentRPBranch: _currentRPBranch, rpParamsSnapshot: _rpParamsSnapshot,
          currentRoleplay: _currentRoleplay,
        };
        await afterGenerate(_dc2, message, reply, _rps);
      } catch (_ae) { /* 记忆同步不阻塞 */ }
    }

    // P0-3: 规则幻觉校验 — 提取回复中的人名对照 FamilyGraph
    try {
      const { validateReply, writeHallucinationLog } = await import('../app/validation/HallucinationValidator.js');
      const _fg = ctx.m4?.getFamilyGraph();
      if (_fg && reply) {
        const _knownNames = _fg.getAllPersonNames();
        const _vr = validateReply(reply, _knownNames, message);
        if (_vr.hasViolation) {
          writeHallucinationLog(ctx.storage.getSQLite(), reply, _vr, _knownNames);
        }
      }
    } catch (_ve) { /* 校验失败不阻塞主线 */ }

    // 📜 信息权威铁律·第三章: LLM回复 vs FG数据冲突检测
    try {
      if (_currentRoleplay && reply && ctx.m4) {
        const _fgCheck = ctx.m4.getFamilyGraph();
        if (_fgCheck) {
          const _ageMatches = reply.match(/(\d{1,2})[\s]*岁/g);
          if (_ageMatches) {
            const _profile = _fgCheck.getPersonProfile(_currentRoleplay);
            if (_profile && _profile.age !== undefined) {
              for (const _m of _ageMatches) {
                const _replyAge = parseInt(_m.match(/\d+/)[0]);
                if (_replyAge !== _profile.age) {
                  console.log('[🏛️权威冲突] ' + _currentRoleplay + ' FG记录=' + _profile.age + '岁 但LLM回复=' + _replyAge + '岁 — 以FG为准');
                }
              }
            }
          }
        }
      }
    } catch (_ce) { /* 冲突检测不阻塞 */ }


        // 候选回复生成（不阻塞主回复 — 默认不活跃，待前端请求时使用）

        // 只有非线索回复、非时间回答时才生成候选

        if (!clueReply && !timeMatch) {

          try {

            const primaryStrategy = deriveM5Strategy(decision);

            const candidates = generateCandidates({

              m4ctx: ctx_m4,

              conversationHistory: enrichedWithGuard,

              knowledgeBase: finalKnowledgeText,

              userMessage: message,

              primaryStrategy: { strategy_id: primaryStrategy.strategy_id, params: { tone: primaryStrategy.tone, max_length: primaryStrategy.max_length, include_entity: [], include_history: false, include_family: false }, description: primaryStrategy.description },

              primaryTone: primaryStrategy.tone,

              primaryDepth: primaryStrategy.depth,

            });

            // 将候选注入到返回对象（通过 closure 变量的方式）

            // 实际在最终 return 中使用

            _lastCandidates = candidates;

          } catch (err) { console.warn('[Candidates] 候选生成失败:', err); }

        }

      } catch (err) { console.error('[Chat] M5失败:', err); reply = FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]; }

      }

    }

    // 持久化对话历史（故障重启后自动恢复，带时间戳）

    // (P0) 对话组管理
    {
      const _locusPath = dna.locus_path || 'general';
      const _locusChanged = _dg && _locusPath !== _dg.locusPath &&
        _locusPath.split('.')[1] !== _dg.locusPath?.split('.')[1];

      const _shouldCloseGroup = _dg && (
        _locusChanged || isTopicShift ||
        _dg.rounds.length >= 10 ||
        (Date.now() - _dg.startTime) > 30 * 60 * 1000
      );

      if (_shouldCloseGroup) {
        const _old = _dg;
        _dg = null;
        flushDialogGroup(ctx, _old, dna, decision, message, reply, _currentRoleplay, isValidPersonName).catch(() => {});
      }

      if (!_dg) {
        _dg = {
          id: (dna as any).dna_root_id + '_DG_' + String(seqPos).padStart(3, '0'),
          topic: _locusPath,
          locusPath: _locusPath,
          rounds: [],
          perceptions: [],
          maxCalcium: 0,
          maxCalciumRound: 0,
          entities: [],
          startTime: Date.now(),
          rpChar: _currentRoleplay || undefined,
        };
      }

      _dg.rounds.push({ q: message, a: reply, seqPos, time: Date.now() });
      _dg.perceptions.push({ ...p });
      if (decision.enhanced.calcium_score > _dg.maxCalcium) {
        _dg.maxCalcium = decision.enhanced.calcium_score;
        _dg.maxCalciumRound = _dg.rounds.length - 1;
      }
      for (const g of dna.entity_genes) {
        if (g.name && g.name !== '我' && !_dg.entities.includes(g.name)) {
          _dg.entities.push(g.name);
        }
      }
    }

    // ── 持久化：对话写入 + 话题标记（已拆分至 persistence-stage） ──
	    persistConversation({
	      ctx, message, reply, seqPos, dna, p, decision,
	      currentRoleplay: _currentRoleplay,
	    }).catch((_e: any) => console.warn('[Persist] 异步失败:', _e?.message));

    // 躯体感知记录（SomaticMemory — 五重铁律协议③）

    try {

      if (ctx.somaticMemory) {

        ctx.somaticMemory.record(message);

      }

    } catch (err) { console.warn('[Somatic] 记录失败:', err); }

    const cl = decision.enhanced.calcium_level;

    const allDims: any[] = [];

    for (const [key, meta] of Object.entries(PERC_LABELS)) {

      const val = (p as any)[key];

      if (typeof val === 'number') allDims.push({ label: meta.label, key, value: Number(val.toFixed(3)), q: meta.q });

    }

    const m5s = deriveM5Strategy(decision);

    // 梦境生成（修复: 改为 calcium>=2 才触发，避免每轮对话都生成低质量梦境条目）

    // 设计文档 §3.1 — 只对固体级(钙化≥2)以上的重要交互生成梦境

    try {

      if (ctx.m7 && dna.entity_genes.length > 0 && decision.enhanced.calcium_level >= 2) {

        const existing = ctx.m7.queue.getPending();

        const alreadyQueued = existing.some((d: any) => d.content?.includes(message.substring(0, 20)));

        if (!alreadyQueued && ctx.m7.queue.getCount() < 20) {

          const traits: string[] = [];

          if (p.intimacy > 0.4) traits.push('agreeableness');

          if (p.pleasure > 0.5) traits.push('extraversion');

          if (p.pleasure < -0.3) traits.push('neuroticism');

          if (p.certainty > 0.6) traits.push('conscientiousness');

          if (p.abstract > 0.5) traits.push('openness');

          if (traits.length === 0) traits.push('extraversion');

          ctx.m7.queue.add({ source: 'M3', content: `鸿艺提到: ${message.substring(0, 40)}`, affected_traits: traits, related_memory_id: dna.branch_id });

        }

      }

    } catch (err) { console.warn('[DreamGen] 失败:', err); }

    // TopicTracker 高频话题追踪

    try {

      ctx.topicTracker.record(message);

      const needs = ctx.topicTracker.getTopicsNeedingResearch();

      if (needs.length > 0) {

        const keyword = needs[0];

        // 跳过亲密/脏话关键词（避免"操死""弄坏"等污染知识库）

        const intimateSkip = ['操','干','日','插','顶','舔','吸','咬','揉','捏','掐','摸','吻','骚','浪','奶','鸡','肉','屌','阴','淫','湿','水','抱','贴','蹭','扭','喘'];

        if (!intimateSkip.some(w => keyword.includes(w))) {

          researchTopic(keyword, ctx.storage.getSQLite()).then(result => {

            if (result) { ctx.topicTracker.markResearched(keyword, result.entryId); console.log(`[DreamResearch] ✅ 研究了「${keyword}」`); }

          }).catch(err => console.warn('[DreamResearch] 失败:', err));

        }

      }

    } catch (err) { console.warn('[TopicTracker] 失败:', err); }

    // 主动建档 + 人际关系

    try {

      const relations = extractRelations(message);

      if (relations.length > 0) {

        const sqlite = ctx.storage.getSQLite();

        const stored = storeRelations(sqlite, relations, message, ctx.m4?.getFamilyGraph());

        if (stored > 0 && !FALLBACK_REPLIES.includes(reply)) {

          console.log('[Relations] 已记住: ' + relations.map(function(r){return r.personName;}).join(', '));

        }

        // 同步社交关系到 FamilyGraph（非家庭关系→社交图谱边，与家族图谱互补）
        // 🔴 之前的问题：filter 只允许 rawRelation 非空且匹配 socialTypeMap 的关系通过，
        //    但 extractRelations 提取的大部分关系 rawRelation=''（如"和张中山开会"），
        //    导致所有人都没进人际关系图谱，只进了 knowledge_base 的人物条目。

        // 🎭 角色扮演时跳过社交图谱同步（数据交由分支FG处理，不污染主FG）
        if (!_currentRoleplay) {
        try {

          const familyValues = new Set(['配偶','恋人','父亲','母亲','儿子','女儿','子女','兄弟','姐妹','祖父','祖母','公婆','岳父母']);
          const familyKeys = new Set(Object.keys(FAMILY_MAP));

          const socialTypeMap: Record<string, string> = {

            '同事': 'colleague_of', '同学': 'classmate_of', '室友': 'roommate_of',

            '老板': 'boss_of', '上司': 'boss_of', '领导': 'boss_of',

            '下属': 'subordinate_of', '部下': 'subordinate_of',

            '客户': 'client_of', '朋友': 'friend_of',

            '合伙人': 'partner_of', '邻居': 'neighbor_of',

            '老师': 'teacher_of', '医生': 'doctor_of', '顾问': 'consultant_of',

          };

          for (const rel of relations) {

            // 跳过家庭关系（由 M4 integrateFromEntity 通过 DNA 实体处理）
            if (familyValues.has(rel.relation) || familyKeys.has(rel.rawRelation)) {

              // ── 社交→家族升级：如果此人在 FamilyGraph 中已有社交边，添加家族边 ──
              try {
                const graph = ctx.m4.getFamilyGraph();
                if (graph) {
                  graph.promoteSocialToFamily(rel.personName, rel.relation, rel.context).catch(() => {});
                }
              } catch (e) { /* 升级失败不影响主线 */ }

              continue;
            }

            // 所有非家庭关系 → 进入人际关系图谱
            // 有明确社交类型（同事/朋友/客户等）则精确映射，否则默认"认识的人"
            const socialType = (rel.rawRelation && socialTypeMap[rel.rawRelation]) || 'acquaintance_of';

            await ctx.m4.getFamilyGraph().integrateSocialRelation(rel.personName, socialType, message);

          }

        } catch (err) { console.warn('[SocialGraph] 社交图谱同步失败:', err); }
        } // 🎭 角色扮演守卫结束

        // 社交关系反问：检测到未明确的"其他"关系时，主动询问用户以精准归类

        try {

          const unclassified = relations.filter(r => r.relation === '其他' && !r.rawRelation);

          for (const rel of unclassified) {

            const personName = rel.personName;

            // 避免重复追问同一人

            const askedKey = 'asked_rel_' + personName;

            const alreadyAsked = ctx.conversationHistory.some(

              t => t.role === 'assistant' && t.content && t.content.includes(personName) && t.content.includes('同事')

            );

            if (!alreadyAsked) {

              const options = guessRelationOptions(rel.context);

              const optionText = options.length > 1

                ? options.slice(0, -1).join('、') + '还是' + options[options.length - 1]

                : options[0];

              // ❓ 提问移除（改为上下文注入，信任LLM自然询问）

              break; // 一次只问一个人

            }

          }

        } catch (err) { console.warn('[ClarifyRelation] 反问失败:', err); }

      }

      // [停用] 自动提取聊天信息到知识库（知识库应只用于文件/资料）
      // 原 proactivePatterns 5 个匹配模式已禁用
      // 如需手动添加知识，请使用 📚 知识库按钮上传文件
    } catch (err) { console.warn('[Relations] 关系归档失败:', err); }

    
    // ── 用户反馈检测（Module 3: 梦境自我进化的输入信号） ──
    // 检测用户对玉瑶回复的反馈信号，纯关键词，无 LLM
    try {
      if (ctx.m6) {
        const posSignals = ['真温柔','贴心','懂我','可爱','真好','喜欢你这样','舒服','棒','厉害','满意'];
        const negSignals = ['生硬','冷淡','啰嗦','不对','别这样','不好','差','太机械','死板','不像你'];
        const userMsg = message.toLowerCase();
        for (const sig of posSignals) {
          if (userMsg.includes(sig)) {
            const currentDim = ctx.m6.getTraits() ? 'agreeableness' : 'extraversion';
            ctx.m6.applyConfirmed(currentDim, 'increase', 2);
            console.log('[Feedback] 用户正向反馈:', sig);
            break;
          }
        }
        for (const sig of negSignals) {
          if (userMsg.includes(sig)) {
            ctx.m6.applyConfirmed('agreeableness', 'decrease', 1);
            console.log('[Feedback] 用户负向反馈:', sig);
            break;
          }
        }
      }
    } catch (err) { console.warn('[Feedback] 检测失败:', err); }

    // M6 自我模型演化

    try {

      if (ctx.m6) {

        const dimensions = dna.entity_genes.filter(g => g.type !== 'self').map(g => g.name).filter(Boolean);

        const dim = dimensions[0]?.substring(0, 30);

        if (dim) {

          const deltaMap = [0, 3, 8, 15];

          await ctx.m6.processSignal({

            dimension: dim, direction: p.pleasure > 0 ? 'increase' : 'decrease',

            delta: deltaMap[decision.enhanced.calcium_level] ?? 3,

            e1_pleasure: p.pleasure, i2_intimacy: p.intimacy,

            c1_conflict: Math.max(0, p.aggression + (1 - p.safety)),

            calcium: decision.enhanced.calcium_level, triggerEvent: message.substring(0, 40),

          });

        }

        // ① M8 情感共鸣巩固: 高钙事件触发年轮写入
        if (ctx.m8 && decision.enhanced.calcium_level >= 3) {
          try {
            const m8Result = await ctx.m8.write({
              sensory_anchor: message.substring(0, 30),
              perception: p,
              emotional_valence: decision.primary_emotion || '强烈',
              narrative_tag: dna.locus_path || 'general',
              raw_input: message,
              calcium_at_event: decision.enhanced.calcium_score,
              write_source: 'emergency',
            });
            if (m8Result.ritual_phrase) {
              console.log('[M8] 锚定话术:', m8Result.ritual_phrase);
            }
          } catch (err) {
            console.warn('[M8] 情感共鸣巩固失败:', err);
          }
        }

      }

    } catch (err) { console.warn('[M6Evol] 失败:', err); }

    // ═══════════════════════════════════════════════════════════════

    // 异步存储歌单（歌词+曲谱）到仿生智脑 — 通过 AsyncTaskQueue 调度
    // 不阻塞主回复流程，即使用 TaskQueue 失败也不影响聊天

    // ═══════════════════════════════════════════════════════════════

    // 预先声明 vadSpectrum（可能在队列完成前就是 null）
    let vadSpectrum: VadSpectrum | null = null;

    // 用 AsyncTaskQueue 调度 VAD 谱曲 + 歌单存储（完全异步，不 await）
    if (chatTaskQueue) {
      chatTaskQueue.enqueue(async () => {
        try {
          const vs = await bionic.composeEmotion(message);
          if (!vs) return;
          vadSpectrum = vs;
          await bionic.storeSongSheet({
            topic: message.substring(0, 50),
            turns: [
              { role: 'user', content: message },
              { role: 'assistant', content: reply },
            ],
            emotion24d: p,
            vad: vs,
            userId: 'default_user',
          });
          if (vs) console.log('[BionicStore] 歌单已存入（含VAD谱曲）');
          else console.log('[BionicStore] 歌单已存入（纯歌词，待谱曲）');
          try { ctx.storage.updateVadSpectrum(dna.branch_id, vs); } catch (err) { console.warn('[BionicStore] 本地VAD同步失败:', err); }
        } catch (err) { console.warn('[BionicStore] 存储失败:', err); }
      }).catch(() => {});
    } else {
      // 降级：无队列时的 IIFE（与原来一致）
      (async () => {
        try {
          vadSpectrum = await bionic.composeEmotion(message);
          await bionic.storeSongSheet({
            topic: message.substring(0, 50),
            turns: [
              { role: 'user', content: message },
              { role: 'assistant', content: reply },
            ],
            emotion24d: p,
            vad: vadSpectrum,
            userId: 'default_user',
          });
          if (vadSpectrum) console.log('[BionicStore] 歌单已存入（含VAD谱曲）');
          else console.log('[BionicStore] 歌单已存入（纯歌词，待谱曲）');
          try { ctx.storage.updateVadSpectrum(dna.branch_id, vadSpectrum); } catch (err) { console.warn('[BionicStore] 本地VAD同步失败:', err); }
        } catch (err) { console.warn('[BionicStore] 存储失败:', err); }
      })();
    }


    // 任务3: 黑钻双轨晋升（钙化分≥4.5 OR 召回≥5次）
    try {
      const _sql = ctx.storage.getSQLite();
      if (_sql && typeof _sql.queryAll === "function") {
        const _eligible = _sql.queryAll(
          "SELECT id FROM memories WHERE (calcium_score >= 4.5 OR COALESCE(recall_count, 0) >= 5) AND (promoted_to_diamond IS NULL OR promoted_to_diamond = 0) LIMIT 3"
        );
        for (const _row of _eligible) {
          const _mem = _sql.queryAll("SELECT id, raw_input, primary_emotion, emotion_vector, dna_root_id, calcium_score FROM memories WHERE id = ?", [_row.id]);
          if (_mem.length > 0) {
            const _m = _mem[0] as any;
            const _reason = (_m.calcium_score >= 4.5) ? "原生钙化≥4.5" : "召回≥5次";
            _sql.writeRaw(
              "INSERT OR IGNORE INTO black_diamond (id, summary, emotion_tag, emotion_vector, dna_root_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              (_m.dna_root_id || _m.id) + "_BD", (_m.raw_input || "").substring(0, 200), _m.primary_emotion || "强烈",
              _m.emotion_vector || null, _m.dna_root_id || null, new Date().toISOString(), new Date().toISOString()
            );
            _sql.writeRaw("UPDATE memories SET promoted_to_diamond = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), _m.id]);
            console.log("[Promotion] 金库→黑钻(双轨): " + (_m.raw_input || "").substring(0, 40) + " (" + _reason + ")");
          }
        }
        if (_eligible.length > 0) console.log("[Promotion] 双轨晋升: " + _eligible.length + " 条");
      }
    } catch (err) { console.warn("[Promotion] 双轨晋升失败:", err); }

    // S2-3: 主动学习 — 检查当前话题是否有相关知识库内容尚未引用
    (async () => {
      try {
        const _kbWords = message.match(/[一-龥]{2,4}/g) || [];
        if (_kbWords.length >= 2 && ctx.knowledgeBase) {
          const _kbHits = await ctx.knowledgeBase.search(_kbWords.slice(0, 2).join(" "), 2);
          if (_kbHits.length > 0 && _kbHits[0].title) {
            console.log("[KnowledgeAuto] 关联知识: " + _kbHits[0].title.slice(0, 30));
          }
        }
      } catch (_kae) { /* 主动学习不阻塞 */ }
    })();

    // ── 轻量自检：估算回复质量分（不精确，仅供 M7/前端参考） ──
    let emotionMatchScore = 50;
    let sceneFitScore = 50;
    try {
      if (reply && reply.length > 5) {
        const replyLower = reply.toLowerCase();
        if (decision.primary_emotion) {
          const emoKeywords = { '思念': ['想','念','回','见','梦'], '焦虑': ['担心','别急','没事','放心','慢慢'], '疲惫': ['累','休息','歇','放松','辛苦'], '委屈': ['委屈','难受','心疼','抱','懂'], '愤怒': ['气','消消气','别气','理解'], '快乐': ['开心','高兴','好','棒'], '爱意': ['爱','喜欢','想','宝贝','亲'] };
          const kws = (emoKeywords as Record<string, string[]>)[decision.primary_emotion];
          if (kws) { const hits = kws.filter(w => replyLower.includes(w)).length; emotionMatchScore = Math.min(50 + hits * 12, 100); }
        }
        if (reply.length > 30 && reply.length < 800) emotionMatchScore += 10;
      }
      const tags = dna.scene_tags || [];
      if (tags.length > 0) {
        const replyLower = (reply || '').toLowerCase();
        const matchCount = tags.filter(t => replyLower.includes(t)).length;
        sceneFitScore = Math.round(50 + (matchCount / tags.length) * 50);
      }
    } catch (e) { /* 评分失败不影响主线 */ }

    // 融合度风险标记
    let riskFlag: string | undefined;
    if (emotionMatchScore < 40 && sceneFitScore < 40) {
      riskFlag = 'low_fusion';
    } else if (emotionMatchScore < 40) {
      riskFlag = 'low_emotion_match';
    } else if (sceneFitScore < 40) {
      riskFlag = 'scene_mismatch';
    }

    const candidates = _lastCandidates;

    _lastCandidates = null;


    // ═══════════════════════════════════════════════════════════════
    // 秘书工具执行（提醒/日程/笔记 — 不阻塞主回复）
    // ═══════════════════════════════════════════════════════════════
    try {
      const _secretaryKws = /提醒|记住|记下来|别忘了|到时[候]?|帮我记|记得提醒|日程|安排|预约|会议|笔记|记录|写下来|记一下/;
      if (_secretaryKws.test(message)) {
        (async () => {
          try {
            let _timeStr = '';
            const _hourMatch = message.match(/(\d{1,2})[点时]/);
            if (_hourMatch) {
              const _tc = new Date();
              if (/明天/.test(message)) _tc.setDate(_tc.getDate() + 1);
              else if (/后天/.test(message)) _tc.setDate(_tc.getDate() + 2);
              _tc.setHours(parseInt(_hourMatch[1]), 0, 0, 0);
              _timeStr = _tc.toISOString();
            } else {
              _timeStr = new Date(Date.now() + 3600000).toISOString();
            }
            if (/提醒|记住|记下来|别忘了|到时[候]?|帮我记|记得提醒|叫我/.test(message)) {
              const _text = message.replace(/提醒.*?(我|你)/, '').replace(/帮我|给我|记|下来|别忘了|到时间/g, '').trim() || message.substring(0, 60);
              const _result = await ToolRegistry.execute('reminder', 'set', { text: _text, time: _timeStr });
              console.log('[Secretary] ' + _result);
            }
            if (/日程|安排|预约|会议/.test(message)) {
              const _title = message.replace(/帮我|安排|一下|日程|预约/g, '').trim() || message.substring(0, 30);
              await ToolRegistry.execute('calendar', 'add', { title: _title, time: _timeStr, duration: 60 });
            }
            if (/笔记|记录|写下来|记一下/.test(message)) {
              const _content = message.replace(/帮我|记|笔记|写下来|记录|记一下/g, '').trim() || message.substring(0, 100);
              await ToolRegistry.execute('note', 'add', { title: '备忘', content: _content });
            }
          } catch (_stErr) { console.warn('[Secretary] 工具执行失败:', _stErr); }
        })().catch(() => {});
      }
    } catch (_seErr) { console.warn('[Secretary] 检查失败:', _seErr); }

    // SP4-4: 自介不再硬编码回复 — 走 M5 管线 + 玉瑶本人档案注入
    const isIntroCheck = /^(你是谁|你叫|你.*谁|叫什么名字|介绍一下你自己|介绍|能介绍一下|你多大了|你多大|介绍一下玉瑶)/.test(message.trim());

    // ═══════════════════════════════════════════════════════════════
    // 对话→知识自动沉淀（异步，不阻塞主回复）
    // ═══════════════════════════════════════════════════════════════
    // 🔴 防线①: 调用侧过滤 — 感知+关键词双重拦截（阈值/关键词见 config/ingestion-guard.ts）
    const _PT = INGESTION_GUARD.perceptionThresholds;
    const _KEYWORDS_RE = new RegExp(INGESTION_GUARD.intimateKeywords.join('|'));
    const _isIntimateByContext = (p.intimacy ?? 0) > _PT.intimacy || (p.sexual_attraction ?? 0) > _PT.sexualAttraction || (p.sensory_craving ?? 0) > _PT.sensoryCraving;
    const _isIntimateByKeyword = _KEYWORDS_RE.test(message);
    const _inWhitelist = INGESTION_GUARD.whitelistTerms.some((w: string) => message.includes(w));
    const _isIntimateMsg = _isIntimateByKeyword && !_inWhitelist;
    if (!_isIntimateMsg && !_isIntimateByContext && message.length > 4) {
      chatTaskQueue.enqueue(async () => {
        try {
          await ingestFromConversation(
            message,
            ctx.knowledgeBase,
            dna.scene_tags,
            { pleasure: p.pleasure, arousal: p.arousal, intimacy: p.intimacy },
            dna.branch_id,
          );
        } catch (err) { console.warn('[Ingestion] 异步入库失败:', err); }
      }).catch(() => {});
    }

    // 🛡️ 向量对齐审计：记录本轮检索健康度
    try {
      const _frags = memoryFragments ? memoryFragments.length : 0;
      const _anomalies: string[] = [];
      if (emotionalMemories.length === 0 && _frags === 0) _anomalies.push('检索空结果');
      if (reply && reply.length < 20) _anomalies.push('回复过短(可能无上下文)');
      alignmentGuard.recordTurn({
        perceptionDim: Object.keys(p).length,
        memoriesRetrieved: emotionalMemories.length,
        fragmentsInjected: _frags,
        anomalies: _anomalies,
      });
    } catch (_ae) { /* 审计日志不阻塞主线 */ }

    return {

      reply, turn_count: Math.floor(ctx.conversationHistory.length / 2),

      vad_spectrum: vadSpectrum,

      m1: { branch_id: dna.branch_id, locus_path: dna.locus_path, seq_pos: seqPos, leaf_zone: dna.leaf_zone, ref: `seq_${String(seqPos).padStart(6, '0')}`, entities: dna.entity_genes.map(e => ({ name: e.name, type: e.type })), raw_input: dna.raw_input, entity_genes: dna.entity_genes, scene_tags: dna.scene_tags, ambiguity_score: dna.ambiguity_score },

      m3: { quadrant1: allDims.filter((d: any) => d.q === 1), quadrant2: allDims.filter((d: any) => d.q === 2), quadrant3: allDims.filter((d: any) => d.q === 3), quadrant4: allDims.filter((d: any) => d.q === 4), calcium: { score: Number(decision.enhanced.calcium_score.toFixed(3)), level: cl, label: LEVEL_NAMES[cl] ?? '?', breakdown: { base_core: 0, emotional_boost: 0, threat_bonus: 0 } }, actions: decision.actions, reason: decision.reason, primary_emotion: decision.primary_emotion, secondary_emotions: decision.secondary_emotions, confidence: decision.confidence },

      m4: { timeline: ctx_m4.memory_summary.timeline.map(t => ({ time: t.time, summary: t.summary, calcium_level: t.calcium_level })), total: ctx_m4.memory_summary.timeline.length, family: ctx_m4.family_context?.length ?? 0 },

      m5: deriveM5Strategy(decision),

      emotionalFlash: emotionalMemories.length > 0 && isDirectedEmotion(message),

      triggeredMemoryId: emotionalMemories[0]?.record?.id ?? null,

      candidates: candidates || null,

      emotionMatchScore,
      sceneFitScore,

      riskFlag,

    };

  } catch (err) {

    console.error('[chat]', err);

    return {

      reply: FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)], turn_count: Math.floor(ctx.conversationHistory.length / 2),

      m1: { branch_id: '', locus_path: 'error', seq_pos: 0, leaf_zone: '', ref: '', entities: [], raw_input: message, entity_genes: [], scene_tags: undefined, ambiguity_score: undefined },

      m3: { quadrant1: [], quadrant2: [], quadrant3: [], quadrant4: [], calcium: { score: 0, level: 0, label: '?', breakdown: {} }, actions: ['error'], reason: '' },

      m4: { timeline: [], total: 0, family: 0 },

      m5: { strategy_id: 'fallback', tone: 'neutral', depth: 'shallow', max_length: 20, description: '降级兜底' },

      emotionalFlash: false,

      triggeredMemoryId: null,

      vad_spectrum: null,

      candidates: null,

    };

  }

}


// 对话组：闭组写入金库

// flushDialogGroup 已拆分至 chat/dialog-group-stage.ts
export function deriveM5Strategy(decision: M3Decision): {

  strategy_id: string; tone: string; depth: string; max_length: number; description: string;

} {

  const p = decision.enhanced.perception;

  const actions = decision.actions;

  const hasIntimate = p.sexual_attraction > 0.2 || p.sensory_craving > 0.3 || p.intimacy > 0.4;

  const tone = hasIntimate ? 'intimate' : actions.includes('comfort') ? 'warm' : actions.includes('act') ? 'serious' : 'neutral';

  const depth = decision.enhanced.calcium_level >= 3 ? 'deep' : decision.enhanced.calcium_level >= 2 ? 'medium' : 'shallow';

  let strategy_id = 'mem-general', desc = '简短确认', max_len = 20;

  if (actions.includes('act')) { strategy_id = 'act-core'; desc = '核心响应'; max_len = 150; }

  else if (actions.includes('comfort')) { strategy_id = 'com-warm'; desc = '温暖共情'; max_len = 100; }

  else if (actions.includes('ask') && actions.includes('memorize')) { strategy_id = 'mem-ask'; desc = '确认追问'; max_len = 60; }

  else if (actions.includes('ask')) { strategy_id = 'ask-curious'; desc = '好奇追问'; max_len = 80; }

  return { strategy_id, tone, depth, max_length: max_len, description: desc };

}
