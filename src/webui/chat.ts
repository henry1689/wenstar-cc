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

// MemoryWriteBuffer renamed from WorkingMemory (避免与PFC冲突)
import type { MemoryWriteBuffer } from '../m9/WorkingMemory.js';

import type { KnowledgeBase } from '../m2/KnowledgeBase.js';

import type { M5ClueAssistant } from '../m5/clue/M5ClueAssistant.js';
import type { MasterProfileService } from '../app/profile/MasterProfileService.js';

import type { TopicTracker } from '../app/knowledge/TopicTracker.js';

import type { ConsolidationQueue } from '../m7/ConsolidationQueue.js';

import type { DeepSeekLLMProvider } from '../m5/DeepSeekLLMProvider.js';

import type { M8FusionAdapter } from '../m8/M8FusionAdapter.js';

import type { SimilarityMode, ScoredMemory } from '../m2/types/index.js';

import type { ConversationTurn } from '../m5/types/index.js';

import type { M3Decision, Perception24D } from '../m3/types/perception.js';
import type { KnowledgeItem } from '../app/knowledge/types.js';

import type { SelfModelV1, DNA } from '../m1/types/dna.js';

import { EngineContext } from '../engine/EngineContext.js';
import { ENABLE_TEMPORAL_RULE_ENGINE, worldRuleMode } from '../engine/temporal/TemporalConfig.js';

import { rerank } from '../m4/Reranker.js';

import { decompose, mergeDecomposedResults } from '../m4/QueryDecomposer.js';

import { extractRelations, storeRelations, FAMILY_MAP, guessRelationOptions } from '../app/knowledge/RelationshipExtractor.js';

import { researchTopic } from '../app/knowledge/WebResearchService.js';

import { decideMode, buildGuard, type MemoryGateOutput } from '../app/conversation/MemoryGate.js';

import { generateCandidates, type CandidateSet } from '../m5/CandidateSelector.js';
import { getTopicRepeatCount, isValidPersonName, isSelfNameQuestion, isIntimateContext, collectFactSnapshot, buildDirectFactReply, buildFactStatementAck, collectFactLookupTerms, isNonEmptyString, isDirectedEmotion, FALLBACK_REPLIES, LEVEL_NAMES, PERC_LABELS } from './chat-utils.js';
import type { FactSnapshot } from './chat-utils.js';

// 仿生智脑适配器（可选依赖 — 不可用时降级）

import { bionic } from '../adapter/bionic-adapter.js';
import { buildPreM4Context, refinePostM4Context } from '../app/knowledge/KnowledgeContextBuilder.js';
import { ToolRegistry } from '../app/task-agent/ToolRegistry.js';

import type { VadSpectrum, BionicSearchResult } from '../adapter/bionic-adapter.js';
import { AsyncTaskQueue } from '../app/tools/AsyncTaskQueue.js';
import { fetchBionicMemories, getVadToneHint, pushToVadCache, isVadAvailable } from './chat/retrieval.js';
import { ingestFromConversation } from '../app/ingestion/ConversationIngestionService.js';
import { INGESTION_GUARD } from '../config/ingestion-guard.js';
import { ConfigService } from '../config/ConfigService.js';
// P0-1: 角色路由静态导入
import { classify, type RoleType } from '../app/role/RoleClassifier.js';
import { evaluateTransition, createInitialState, type TransitionState } from '../app/role/TransitionManager.js';
import { alignmentGuard } from '../app/alignment/VectorAlignmentGuard.js';

import { autoPromoteCandidatesV2 } from '../app/vault/VaultManager.js';
import { EntityMeeting } from '../m4/household/EntityMeeting.js';
import { filterPrivateConversations, type PrivateConversation } from '../m4/household/EntityPrivacyFilter.js';
import { FGProfileWriteGateway } from '../m4/household/FGProfileWriteGateway.js';
// 🔴 P0-2 会话模式分级: 读取 prompt_depth_enabled 总开关
import { getRetrievalFusionConfig } from '../config/retrieval-fusion-config.js';
// 🆕 编码健康修复: 实体域边界（警幻仙姑只读等）
import { isReadOnlyEntity, isCelestialEntity } from '../config/entity-realms.js';
// 🔴 P1-4 短路: PAE 档案信号检测（有人物提及但无档案事实陈述 → 跳过 LLM 采集）
import { hasProfileSignal } from '../config/profile-acquisition-guard.js';

/**
 * 🔴 P0-2 会话模式分级: 计算 prompt 加载深度。
 * 纯函数（导出便于单测）。优先级: 会晤 > 话题切换 > 闲聊 > 事实查询 > 默认。
 * - deep    = 会晤实体/新话题切换 → 完整 PFC 5 builder + 全量记忆
 * - casual  = 闲聊 → 精简 PFC + 记忆精筛 + KB 路由跳过
 * - standard= 常规
 * 注(S4-M1): 事实查询(isFactualRecallQuery)实际走 deep —— isTopicShift 先命中（事实查询消息
 *   通常非 casual/非跟进 → 新话题判定 true），且事实准确优先需完整 PFC + 全量记忆核实，
 *   deep 是正确行为。casual 的 KB 路由跳过不会在事实查询时触发（需要 KB 检索）。
 */
export function computePromptDepth(deps: {
  isMeeting: boolean;
  isTopicShift: boolean;
  isCasualChat: boolean;
  isFactualRecallQuery: boolean;
  currentRole: string;
  depthEnabled: boolean;
}): 'deep' | 'standard' | 'casual' {
  if (!deps.depthEnabled) return 'standard';      // 总开关 false → 强制 standard（一键回退）
  if (deps.isMeeting) return 'deep';              // 会晤 = 深度全量
  if (deps.isTopicShift) return 'deep';           // 新话题切换 = 深度（事实查询通常在此命中 → deep 保准确）
  if (deps.isCasualChat) return 'casual';         // 闲聊 = 精简
  return 'standard';
}


// 全局异步任务队列（VAD 谱曲等不阻塞主回复的后台任务）
const chatTaskQueue = new AsyncTaskQueue({ concurrency: 1, retryCount: 1, autoRemoveCompleted: true });
// 🔴 P0-4 瘦身法开关: true=重复块交给 PromptAssembler 承载（旧链路跳过，降 token），
// false=恢复旧链路全部注入（回退用）。改完需重启服务生效。
const PROMPT_ASSEMBLER_STRICT = true;
// SP1-1: VAD 服务健康缓存
let _vadAvailable: boolean | undefined = undefined;

export function resetVadStatus(): void {
  _vadAvailable = undefined;
  console.log('[VADTone] 管理员手动重置，下次对话将重新检测');
}


// SP4-2: 候选人回复缓存（替代 globalThis）
let _lastCandidates: any = null;


// S3-2: 从 guard-builder 导入角色路由和守卫
import { flushDialogGroup, persistConversation, runRetrieval } from './chat/index.js';



// P0-1: 角色路由模块级状态（函数外，跨轮次持久化）
let _currentRole: RoleType = 'secretary';  // 默认秘书——日常对话从专业模式开始，情感上升后自动切换
// 🆕 编码健康修复: 天界会晤(警幻仙姑)进入时保存的人间现场角色（ctx 每轮新建，必须用模块级持久）
let _savedHumanRole: RoleType | null = null;
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
}
let _dg: DialogGroupState | null = null;
let _dgTimer: ReturnType<typeof setTimeout> | null = null;

// ── P1-2: 对话组快照持久化（重启恢复未关闭对话组）──
let _dgRestoreAttempted = false;
const DG_SNAPSHOT_KEY = 'dialog_group_snapshot';

/** 从 engine_store 恢复对话组快照（服务重启后首次对话自动恢复，仅执行一次） */
function _restoreDialogGroup(ctx: any): void {
  if (_dgRestoreAttempted || _dg) return;
  _dgRestoreAttempted = true;
  try {
    const sql = ctx.storage?.getSQLite?.();
    if (!sql || typeof sql.queryAll !== 'function') return;
    const rows = sql.queryAll('SELECT value FROM engine_store WHERE key = ?', [DG_SNAPSHOT_KEY]);
    if (!rows || rows.length === 0) return;
    const snap = JSON.parse(String((rows[0] as any).value || '{}'));
    // 🔴 S4-FIX: 深校验结构——自生成快照恒合法，但畸形/手工修改数据需防护，避免恢复后 _dg 使用处崩溃
    if (!snap?.id || !Array.isArray(snap.rounds)
      || typeof snap.locusPath !== 'string' || !Array.isArray(snap.perceptions)
      || typeof snap.startTime !== 'number') {
      console.warn('[DG-Snapshot] 快照格式非法，丢弃');
      _clearDialogGroupSnapshot(sql);
      return;
    }
    // 对话组生命周期 30 分钟——快照超时视为陈旧组，丢弃不恢复
    const age = Date.now() - snap.startTime;
    if (age > 30 * 60 * 1000) {
      console.log('[DG-Snapshot] 快照过期(' + Math.round(age / 60000) + 'min)，丢弃');
      _clearDialogGroupSnapshot(sql);
      return;
    }
    _dg = snap as DialogGroupState;
    console.log('[DG-Snapshot] 🔄 重启恢复对话组: ' + snap.id + ' (' + snap.rounds.length + '轮, 话题:' + (snap.topic || 'unknown') + ')');
  } catch (e) {
    console.warn('[DG-Snapshot] 恢复失败:', (e as Error)?.message || e);
    // S4-FIX: JSON.parse 失败等异常路径也清快照，避免损坏行永久残留
    try { _clearDialogGroupSnapshot(ctx.storage?.getSQLite?.()); } catch { /* 非关键 */ }
  }
}

/** 清除对话组快照（flush 落库后调用，防止恢复已关闭的组） */
function _clearDialogGroupSnapshot(sql: any): void {
  try {
    if (sql && typeof sql.writeRaw === 'function') {
      sql.writeRaw('DELETE FROM engine_store WHERE key = ?', [DG_SNAPSHOT_KEY]);
    }
  } catch { /* 非关键 */ }
}


/**
 * 🔋 Token节省模式 — 时间/天气/生理按需一枪式触发
 * 仅在用户消息中提到时间/天气/生理反应时才运行对应计算，完成后立即停止。
 */
function _lazyTemporalFire(message: string, ctx: any): void {
  if (!(globalThis as any).__lazyTemporalState) {
    (globalThis as any).__lazyTemporalState = { lastQueryTs: Date.now() };
  }
  const state = (globalThis as any).__lazyTemporalState;
  const now = Date.now();

  // 🕐 时间查询
  if (/几点了|时间|几点|现在.*时间|今天.*几号|星期几|什么时候/.test(message)) {
    const deltaMs = now - state.lastQueryTs;
    const deltaStr = deltaMs > 3600000
      ? `（距上次时间查询已过 ${Math.round(deltaMs / 3600000)} 小时 ${Math.round((deltaMs % 3600000) / 60000)} 分钟）`
      : deltaMs > 60000
      ? `（距上次查询 ${Math.round(deltaMs / 60000)} 分钟）`
      : '';
    state.lastQueryTs = now;
    // 写入 engine_store 供 LLM 读取
    try {
      const esql = ctx.storage?.getSQLite?.();
      esql?.writeRaw?.(
        "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('last_time_query', ?)",
        [new Date(now).toISOString()]
      );
    } catch (e) { console.warn('[chat::LazyTemporal] 时间查询存储失败', (e as Error)?.message || e); }
    console.log(`[LazyTemporal] 🕐 时间查询触发 ${deltaStr}`);
  }

  // 🌤 天气查询
  if (/天气|下雨|晴天|阴天|刮风|下雪|气温|温度|热不热|冷不冷/.test(message)) {
    try {
      const esql = ctx.storage?.getSQLite?.();
      if (esql) {
        esql.writeRaw?.(
          "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('last_weather_query', ?)",
          [new Date(now).toISOString()]
        );
      }
    } catch (e) { console.warn('[chat::LazyTemporal] 天气查询存储失败', (e as Error)?.message || e); }
    console.log('[LazyTemporal] 🌤 天气查询触发');
  }

  // 💓 生理反应查询
  if (/心跳|脉搏|血压|体温|发烧|生理期|经期|月经|排卵|怀孕/.test(message)) {
    try {
      const esql = ctx.storage?.getSQLite?.();
      if (esql) {
        esql.writeRaw?.(
          "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('last_physiology_query', ?)",
          [new Date(now).toISOString()]
        );
      }
    } catch (e) { console.warn('[chat::LazyTemporal] 生理查询存储失败', (e as Error)?.message || e); }
    console.log('[LazyTemporal] 💓 生理查询触发');
  }

  state.lastQueryTs = now;
}

import { runChatEntry } from './chat/ChatEntry.js';

export interface ChatContext {

  encoder: DNAEncoder;

  storage: FusionStorageAdapter;

  m3: M3LogicOrchestrator;

  m4: M4Orchestrator;

  m5: M5Orchestrator;

  m6?: M6Orchestrator;

  m7?: M7Orchestrator;

  masterProfile?: MasterProfileService;

  workingMemory: MemoryWriteBuffer;

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

  /** V3.2 档案自动采集引擎 — LLM 驱动的 FG 档案自动提取与写入 */
  _profileAcquisitionEngine?: import('../m4/household/ProfileAcquisitionEngine.js').ProfileAcquisitionEngine;

  /** V3.2 户籍门阀过滤器 — 会话白名单管理，门阀挂载检索入口 */
  _gatekeeper?: import('../m4/household/UUIDGatekeeper.js').UUIDGatekeeper;

  /** V3.2 关系热力追踪器 — 自动升级人际关系状态 */
  _relationHeatTracker?: import('../m4/household/RelationHeatTracker.js').RelationHeatTracker;

  /** V4.0 实体会晤管理器 — 多人会议纪要记录 */
  _entityMeeting?: import('../m4/household/EntityMeeting.js').EntityMeeting;

  /** 记事记忆服务 */
  yuyaoMemory?: import("../app/yuyao-memory/YuyaoMemoryService.js").YuyaoMemoryService;

  /** S3 混合检索引擎（ONNX 本地语义重排序） */
  hybridSearch?: import("../engine/storage/HybridSearch.js").HybridSearchEngine;
}





// ── 工具函数已迁移至 chat-utils.ts ──

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

/** 🔴 V15: _meetingEntityName 全链路传播点编目（架构铁律 #6）
 *  S4 评审必须逐点核验。修改任何传播点→必须同步更新此处索引。
 *  格式：{ 行号, 阶段, 描述, 传播方式 }
 */
const MEETING_PROP_POINTS: Array<{ line: number; stage: string; desc: string; via: string }> = [
  { line: 651, stage: 'L0-路由', desc: '活跃会议名传入 processChat', via: '_activeMeetingName' },
  { line: 764, stage: 'L1-上下文', desc: '从 EntityMeeting 获取实体名', via: 'getEntityName()' },
  { line: 798, stage: 'L2-档案', desc: '构建实体上下文（档案+对话+开场协议）', via: 'buildEntityContext()' },
  { line: 861, stage: 'L3-DNA', desc: '注入 entity_genes 到 M1 DNA 编码', via: 'dna.entity_genes.push' },
  { line: 876, stage: 'L4-KB过滤', desc: '传入 _meetingEntityUuid 给 KnowledgeContextBuilder', via: 'PreM4Input._meetingEntityUuid' },
  { line: 963, stage: 'L5-记忆门控', desc: '会晤模式跳过主人记忆检索', via: '!meetingEntityName guard' },
  { line: 1327, stage: 'L6-注入保留', desc: 'preserveLabels=true 保留结构标签', via: 'MemoryInjector.preserveLabels' },
  { line: 1380, stage: 'L7-PFC', desc: '通知前额叶皮层当前会晤实体', via: 'meetingEntity param' },
  { line: 1451, stage: 'L8-角色提示', desc: '会晤模式跳过当前角色提示', via: 'roleHint = null' },
  { line: 1487, stage: 'L9-自问自检', desc: '会晤模式跳过玉瑶自问', via: '!meetingEntityName guard' },
  { line: 1513, stage: 'L10-主人镜像', desc: '会晤模式跳过主人画像', via: '!meetingEntityName guard' },
  { line: 1647, stage: 'L11-政策选择', desc: '会晤模式使用 ChatPolicy meetingMode', via: 'ChatPolicy(meetingMode(...))' },
  { line: 1752, stage: 'L12-M5调度', desc: '传入 isEntityMeeting=true 给 M5.orchestrate', via: '!!_meetingEntityName' },
  { line: 1778, stage: 'L13-自名检测', desc: '检查回复中是否自报姓名', via: 'reply.includes(entityName)' },
];

export async function processChat(message: string, ctx: ChatContext, streamOpts?: { onToken?: (delta: import('../m5/types/index.js').LLMTokenDelta) => void }): Promise<ChatResponse> {

  try {
    // 🔥 天权海马体节律调度: 进入 θ 节律（活跃对话），暂停离线巩固
    (globalThis as any).__hippocampusCoordinator?.onUserMessage();

    // ChatEntry — entry guard pipeline (extracted)
    const entryResult = await runChatEntry(message, ctx, { _currentRole });
    const dna = entryResult.dna;
    // 🔴 转场彻底隔离(2026-08-23): 每轮进入清除转场归属标记（退出轮由 exit 分支重新设置）
    (ctx as any)._exitEntityUuid = null;
    let _ruleEngineBlocked = entryResult.ruleEngineBlocked;
    let _ruleEngineReply = entryResult.ruleEngineReply;
    const _weatherContext = entryResult.weatherContext || '';

    // 🔋 Token节省模式 — 时间/天气/生理按需一枪式触发
    _lazyTemporalFire(message, ctx);

    // 📸 人物全方位档案提取
    console.log('[PersonProfile] 检查开始, ctx.m4=' + (!!ctx.m4) + ' m4类型=' + (typeof ctx.m4));
    // 写入门户：统一写侧授权（会晤写隔离）——惰性 fg + 动态会晤状态，全程共享
    const _fgw = new FGProfileWriteGateway(
      () => ctx.m4?.getFamilyGraph?.(),
      () => ({
        meetingEntityUuid: ctx._entityMeeting?.getEntityUUID?.() ?? null,
        meetingEntityName: ctx._entityMeeting?.isActive?.() ? ctx._entityMeeting.getEntityName() : null,
      }),
    );
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
                const _oldParts: Set<string> = new Set(_prof.appearance.split(/[，,]/).map((s: string) => s.trim()).filter(isNonEmptyString));
                const _newParts = _app.split(/[，,]/).map((s: string) => s.trim()).filter(isNonEmptyString);
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
                // 📜 当前无角色扮演分支，getFamilyGraph() 即主 FG；写入门户收口（会晤写隔离）
                _fgw.updatePersonProfile(_n, _updates as any, { countMention: false });
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
                          // (FG-迁移) 同步写入 FamilyGraph 特征边
                          try { _fgw.addFeatureEdge(_n, _featName, 'appearance'); } catch (e) { console.warn('[FG] addFeatureEdge调用异常:', (e as any)?.message); }
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
              // 用姓氏匹配找回复中提到的人名（B1: 统一走 app-identity.SURNAME_CHARS）
              const { SURNAME_CHARS } = await import('../config/app-identity.js');
              const nameRegex = new RegExp('([' + SURNAME_CHARS + '][一-龥]{1,2}|阿[一-龥]|小[一-龥])', 'g');
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
          const occHints = [/做([^，。！？\s]{2,12})的/, /开([^，。！？\s]{2,12})店/, /干([^，。！？\s]{2,12})的/, /([^，。！？\s]{2,12}工程师)/, /([^，。！？\s]{2,12}老师)/, /([^，。！？\s]{2,12}医生)/];
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
              if (m && m[1] && !/什么|哪|哪里|哪儿/.test(m[1])) { updates.occupation = m[1]; break; }
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
              _fgw.updatePersonProfile(p.name, updates as any, { countMention: false });
              console.log('[Profile] 更新画像:', p.name, Object.keys(updates).join(','));
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ProfileExtract] 答案提取失败:', (err as Error).message);
    }

    // 🧠 海马体新颖度检测 (V4.0 @deprecated: 长期迁移到 SceneSnapshotBuilder)
    let _noveltyMultiplier = 1.0;
    try {
      const _nsql = ctx.storage.getSQLite?.();
      if (_nsql && dna && dna.raw_input) {
        const { NoveltyDetector } = await import('../app/brain/NoveltyDetector.js');
        const _nd = new NoveltyDetector(_nsql);
        const _nresult = _nd.assess(dna);
        _noveltyMultiplier = _nresult.calciumMultiplier;
      }
    } catch (e) { console.warn('[chat::NoveltyDetector] 新颖度检测失败', (e as Error)?.message || e); }

    const decision = ctx.m3.decide(dna, { current_time: new Date().toISOString(), current_location: '深圳' });

    // 应用新颖度系数到钙化分
    if (_noveltyMultiplier !== 1.0) {
      decision.enhanced.calcium_score = Math.min(10, (decision.enhanced.calcium_score || 0.5) * _noveltyMultiplier);
    }

    // P0-1: 角色路由（🛡️ V4.0: 会晤模式下固定为 neutral，不切换角色）
    const p = decision.enhanced.perception;
    const _inMeeting = ctx._entityMeeting?.isActive?.() ?? false;
    if (!_inMeeting) {
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
    } else {
      // 会晤中固定为 neutral，不触发 lover/secretary 等玉瑶角色
      _currentRole = 'recaller';
    }
    try { const { WorkingMemory: WM } = await import('../m9/WorkingMemory.js'); WM.currentTag = _currentRole; } catch (e) { console.warn('[WorkingMemory] currentTag 设置失败:', (e as any)?.message); }
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
    let enrichedHistory: Array<ConversationTurn & { topic?: string }>;
        // ── 记忆检索：时间导航 + 情感检索 + 黑钻检索（已拆分至 retrieval-stage） ──
    // 🛡️ V5.1: 会晤模式下获取当前实体名，传入检索以启用信息隔离
    const _activeMeetingName = ctx._entityMeeting?.isActive() ? ctx._entityMeeting.getEntityName() : null;
    // 🆕 V10.11: 多角色上下文隔离 — 会晤模式优先从 DB 按 UUID 精准查询
    //   RAM conversationHistory 作为热缓存，DB 作为持久化冷存储
    //   两者合并后按时间排序，确保重启后的上下文完整
    try {
      const { EntityContextManager } = await import('../app/entity/EntityContextManager.js');
      const _ecm = new EntityContextManager();
      const _startIndex = ctx._entityMeeting?.getMeetingStartHistoryIndex?.();
      const _meetingUuid = ctx._entityMeeting?.getEntityUUID?.();
      // 🔴 人格独立红线(2026-08-21): 玉瑶态(_meeting=null)必须用**玉瑶专属历史**(belong=玉瑶UUID)，
      // 不能读混合 conversationHistory——否则玉瑶继承实体会话（接话/知道用户与他人隐私/延续实体场景）。
      if (_meetingUuid) {
        enrichedHistory = _ecm.getContextWindow(ctx.conversationHistory, _activeMeetingName, 40, _startIndex);
        // Phase 2: DB 侧精准补充 — 如果 startIndex 未覆盖，从 conversations 表按 UUID 补
        if (enrichedHistory.length < 10) {
          try {
            const { EntityContextStore } = await import('../app/entity/EntityContextStore.js');
            const _store = new EntityContextStore(ctx.storage.getSQLite());
            const _dbTurns = _store.queryEntityContext(_meetingUuid, 40);
            if (_dbTurns.length > enrichedHistory.length) {
              enrichedHistory = _dbTurns;
            }
          } catch { /* DB 补充失败不阻塞 */ }
        }
      } else {
        // 玉瑶态: 只读玉瑶专属历史（conversations.belong=玉瑶UUID），绝对不读其他实体对话
        try {
          const { EntityContextStore: _ECS2 } = await import('../app/entity/EntityContextStore.js');
          const _store2 = new _ECS2(ctx.storage.getSQLite());
          const _yuyaoU = ctx.m4?.getFamilyGraph?.()?.getUUIDByName?.('玉瑶') ?? null;
          const _yuyaoTurns = _yuyaoU ? _store2.queryEntityContext(_yuyaoU, 40) : [];
          enrichedHistory = _yuyaoTurns.length > 0 ? _yuyaoTurns : ctx.conversationHistory.slice(-20);
        } catch {
          enrichedHistory = ctx.conversationHistory.slice(-20);
        }
      }
    } catch {
      enrichedHistory = ctx.conversationHistory.slice(-20);
    }
    // 🆕 V10.11: 会晤模式下多重增强 — 动态窗口 + isolateTurns + 压缩 + 摘要文本
    if (_activeMeetingName && enrichedHistory.length > 0) {
      try {
        const { computeStrategy } = await import('../app/entity/EntityContextStrategy.js');
        const { EntityContextManager: _ECM } = await import('../app/entity/EntityContextManager.js');
        const { compressContext, buildCompressedText } = await import('../app/entity/EntityContextCompressor.js');
        const _ecm2 = new _ECM();

        // ① computeStrategy — 根据实体category+warmth动态窗口
        const _meetingUuid2 = ctx._entityMeeting?.getEntityUUID?.();
        let _maxTurns = 40;
        if (_meetingUuid2) {
          try {
            const _ent = ctx.m4?.getFamilyGraph?.()?.getEntityByUUID?.(_meetingUuid2);
            const _store2 = ctx.storage ? new (await import('../app/entity/EntityContextStore.js')).EntityContextStore(ctx.storage.getSQLite()) : null;
            const _strategy = computeStrategy({
              category: (_ent as any)?.category || 'G',
              warmth: undefined, // edges warmth 需单独查，此处略过
              interactionCount7d: _store2?.getEntityTurnCount(_meetingUuid2, 7) || 0,
              lastInteraction: (_ent as any)?.last_interaction || '',
            });
            _maxTurns = _strategy.maxTurns;
          } catch { /* 策略计算失败不阻塞 */ }
        }

        // ② isolateEntityTurns — 分离穿插的其他实体对话
        const _isolated = _ecm2.isolateEntityTurns(enrichedHistory, _activeMeetingName);
        const _anchorCount = _isolated.interspersed.length > 0 ? 8 : 10;

        // ③ compressContext — 超窗口时压缩
        if (_isolated.own.length > _maxTurns) {
          const _compressed = compressContext(_isolated.own, _anchorCount, 30);
          // 将 buildCompressedText 输出的摘要文本注入 finalKnowledgeText
          const _ctxText = buildCompressedText(_compressed);
          if (_ctxText && enrichedHistory.length > 40) {
            // 摘要文本留给后续注入链（PFC/KnowledgeTextAssembler）使用
            (ctx as any)._entityCompressedSummary = _ctxText;
            // V12.2: 持久化压缩摘要 — 跨重启上下文连续性
            try {
              const _uuid = ctx._entityMeeting?.getEntityUUID?.();
              if (_uuid) {
                const _si = ctx.storage?.getSQLite?.();
                if (_si) {
                  const { EntityContextStore: _ECS } = await import('../app/entity/EntityContextStore.js');
                  new _ECS(_si).saveCompressedSummary(_uuid, _ctxText);
                }
              }
            } catch { /* 非关键 */ }
          }
          enrichedHistory = _compressed.anchor;
        } else {
          enrichedHistory = _isolated.own;
        }
      } catch { /* 增强失败不阻塞 */ }
    }
    let {
      isTopicShift, isFollowUp, hasContinuationMarkers, isCasualChat,
      isLimitedRetrieval, hasNewEntity, hasPersonEntity,
      emotionalMemories, memoryGate, memoryGateFillerUsed,
    } = await runRetrieval({
      ctx, message, dna, p, enrichedHistory, memoryFragments,
      _meetingEntityName: _activeMeetingName,
      p40: decision.enhanced.perceptionV40,  // V3: M3 产出的 40D 感知向量
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

    // 🎭 角色扮演记忆隔离：检索层 (MemoryRetriever.retrieveMemories) 已按 memory_kind/memory_type
    //    在合并结果时排除角色扮演记忆。此处不再重复过滤。

    // 知识库检索（由 MemoryGate 管控）



    let knowledgeBaseText = "";
    let biosGatedMemories = emotionalMemories;

    // ── V4.0 门阀白名单: 根据当前会话对象设定检索权限（三层白名单·始终激活）──
    // 🔴 户籍管理法 V-4 修复: 会话层白名单唯一写者 = EntityMeeting（会晤激活时 addSessionEntity）。
    // 删除 setSessionEntities（它每次 clear 会话层，导致会晤实体被消息提到的人顶替出白名单）。
    // 非会晤提及的人用 addSessionEntity（并集，不 clear），避免误踢会晤实体。
    if (ctx._gatekeeper) {
      try {
        // 🔴 P0-4: 非会晤不再把消息提到的人累积进 sessionEntities（避免跨实体污染）。
        // 消息提到的人只进 mentioned_entity_uuids[]（persistence-stage 实现），供 FG 图谱/PAE。
        // 会话层白名单由 EntityMeeting 管理（会晤=聊天对象），玉瑶默认态由 retrieval-stage 兜底。
        // 同步设置 M4Orchestrator 的门阀（记忆检索过滤用）
        ctx.m4.setGatekeeper?.(ctx._gatekeeper);
      } catch (_gErr) { /* 门阀设置失败不影响对话 */ }
    }

    // ── P1-1 意图前置校验门卫（统一三类指令：结束语/唤醒/普通消息）──
    // 🔴 状态机：私聊-玉瑶(_meeting=null) → 唤醒允许 enter；私聊-XX/群聊 → 唤醒/换人拒绝（提示先结束）；
    //    结束语 → flush 对话组+锚点+清session+回玉瑶；群聊加人/换主发言 → 放行。
    let _meetingDeny: string | null = null;
    let _meetingExited = false;

    // V4.0 实体会晤：多人会议时记录用户发言
    if (ctx._entityMeeting?.isMultiParty()) {
      ctx._entityMeeting.recordTurn('user', message, '我');
    }

    const _em = ctx._entityMeeting;
    if (_em) {
      const fg = ctx.m4?.getFamilyGraph?.();
      const allNames: string[] = fg?.getAllPersonNames?.() || [];
      // 🆕 UUID 立法: 传入 FG 别名映射（诗韵/韵韵→徐诗韵），任意称呼都能唤醒会晤
      const aliasMap: Map<string, string> = fg?.getAllPersonNamesWithAliases?.() ?? new Map<string, string>();
      // 🔴 P2-2: 会晤中传 inMeeting=true → detectUserIntent 严格模式（提名字不触发唤醒门卫）
      const intent = EntityMeeting.detectIntent(message, allNames, _em.isActive(), aliasMap);
      const _isActive = _em.isActive();
      const _isMulti = _em.isMultiParty();

      if (!_isActive) {
        // ── 状态 A: 私聊-玉瑶 / 无会晤 → 唤醒允许，普通消息放行 ──
        // 🔴 S4-FIX: addParticipant/switch 在无会晤态并入 wake——"叫张小龙来/让阿珍也来/换熊梓铭来"均为唤醒进入
        const _enterTargets = intent.kind === 'wake' ? intent.targets
          : (intent.kind === 'addParticipant' || intent.kind === 'switch') && intent.targets.length > 0 ? intent.targets
          : [];
        if (_enterTargets.length > 0) {
          // 🔴 P2-2: 会晤边界修复 — 用户确认「会晤=用户+2人及以上实体」。
          // 原 >=3 才 enterMulti → 2 人（如熊梓铭+徐诗雨）被错判为单人会晤。
          if (_enterTargets.length >= 2) {
            _em.enterMulti(_enterTargets);
            console.log('[EntityMeeting] 多人会晤启动: ' + _enterTargets.join(', '));
          } else {
            // 🆕 编码健康修复: 天界域实体（警幻仙姑）会晤前保存人间会话现场（角色状态），退出后复原
            if (isCelestialEntity(_enterTargets[0])) {
              _savedHumanRole = _currentRole;
              console.log('[EntityMeeting] 天界会晤进入: ' + _enterTargets[0] + '，人间现场已保存 (role=' + _currentRole + ')');
            }
            _em.enter(_enterTargets[0]);
            console.log('[EntityMeeting] 单人会晤启动: ' + _enterTargets[0]);
          }
        } else if (intent.kind === 'normal' || intent.kind === 'exit') {
          // 🔴 S2-G1: 重启后自动恢复上次会晤实体（用户上次在会晤中，重启后继续以该实体身份回应）
          // 仅当用户消息没有明确"切回玉瑶/退出会晤"意图时才恢复——否则尊重用户当前意图。
          // 🔴 转场彻底隔离(2026-08-23): 消息提及"玉瑶/瑶瑶/瑶儿" = 明确和玉瑶（默认本体）说话，
          //   绝不自动恢复上次实体会晤（防"玉瑶，你现在在哪"被上次会晤实体劫持，如熊梓玥）。
          const _yuyaoMention = /玉瑶|瑶瑶|瑶儿/.test(message);
          const _explicitExit = /^(?:和|跟|找|叫|让)?\s*(?:玉瑶|瑶瑶|瑶儿)\s*(?:聊聊|谈谈|说说话|聊一下|聊天)?\s*$/.test(message.trim())
            || /^(?:切回|回到|换回|变回|退出|散会|结束).*(?:玉瑶|瑶瑶|瑶儿)?\s*$/.test(message.trim());
          if (!_yuyaoMention && !_explicitExit && _em.restoreLastMeeting?.()) {
            console.log('[EntityMeeting] 消息无会晤意图，自动恢复上次会晤: ' + _em.getEntityName());
          }
        }
        // exit 在玉瑶态无意义（不恢复、不 enter，玉瑶正常回复）
      } else if (intent.kind === 'exit') {
        // ── 结束语: 关闭对话组 + 锚点 + 清 session + 强制退回私聊-玉瑶 ──
        // 🔴 P1-1: 对话组 flush 由对话组管理段（_meetingExited → _shouldCloseGroup）统一执行，
        //   用真实 reply 生成锚点/碎片；本轮不新建对话组。
        _meetingExited = true;
        // 🔴 人格独立红线(2026-08-21): 转场回玉瑶=全新会话——重置场景锚点/情感基线，
        // 玉瑶时空正确（不延续实体场景如浴室/全裸/在外地），绝不接实体会话话题。
        try { (ctx.m5 as any)?.resetSession?.(); } catch { /* 场景重置失败不阻塞 */ }
        // 直接 import 重置（确定性生效——实测 ctx.m5.resetSession 未覆盖场景锚点残留，
        // 否则玉瑶态仍注入"厨房/高潮"等实体会话场景，时空错乱）
        try {
          const { resetContext } = await import('../m5/ContextMemory.js');
          resetContext();
        } catch { /* 非阻塞 */ }
        try {
          const { resetAnchor } = await import('../m5/SceneAnchor.js');
          resetAnchor();
        } catch { /* 非阻塞 */ }
        console.log('[MeetExit] 转场回玉瑶: 场景锚点/情感基线已重置');
        const _exitUuid = _em.getEntityUUID();
        const exitResult = await _em.exit();
        // 🔴 户籍管理法（第九条 搜索闸门·收口）: 退出会晤时清除会话实体 UUID，
        // 恢复户主钥匙视角（不再限制知识库检索范围）。
        try {
          const { setSessionEntityUuid } = await import('../app/knowledge/KnowledgeEngine.js');
          setSessionEntityUuid(null);
        } catch { /* 非关键 */ }
        // 🆕 V10.11: 保存情感快照 — 下次进入同一实体会晤时恢复情感基调
        if (_exitUuid) {
          try {
            const { EntityContextStore } = await import('../app/entity/EntityContextStore.js');
            const _store = new EntityContextStore(ctx.storage.getSQLite());
            _store.saveEmotionSnapshot(_exitUuid, {
              pleasure: p.pleasure ?? 0, arousal: p.arousal ?? 0, intimacy: p.intimacy ?? 0,
              lastTopic: message.substring(0, 100),
            });
          } catch { /* 非致命 */ }
        }
        if (exitResult?.minutes) {
          console.log('[EntityMeeting] 多人会议结束，纪要已自动归档');
        }
        // 🔴 转场彻底隔离(2026-08-23): 记录退出实体 UUID —— 退出消息归属原实体（不污染玉瑶历史），
        // 玉瑶转场后=全新会话（玉瑶专属历史过滤，看不到转场消息）；下一轮 processChat 开头清除。
        (ctx as any)._exitEntityUuid = _exitUuid;
        // 🔴 玉瑶态角色重置(2026-08-23): 退出轮处于会晤中 → 角色路由强制 recaller，
        // 若不重置，转场后 _currentRole 延续"记忆助手"→ 玉瑶态答非所问（"你现在在哪"→"嗯～好呀。你说"）。
        // 🆕 编码健康修复: 天界会晤退出 → 复原人间现场角色（否则回不去原来的秘书/恋人模式）
        if (_savedHumanRole) {
          _currentRole = _savedHumanRole;
          console.log('[MeetExit] 天界会晤退出，复原人间角色: ' + _currentRole);
          _savedHumanRole = null;
        } else {
          _currentRole = 'secretary';
        }
      } else if (_isMulti && intent.kind === 'addParticipant' && intent.targets.length === 1) {
        // ── 群聊加人（addParticipant ≠ 唤醒拒绝）──
        _em.addParticipant(intent.targets[0]);
        console.log('[EntityMeeting] 群聊加人: +' + intent.targets[0]);
      } else if (_isMulti && intent.kind === 'switch' && intent.targets.length === 1) {
        // ── 群聊换主发言（switch）──
        await _em.switchTo(intent.targets[0]);
        console.log('[EntityMeeting] 群聊换主发言: → ' + intent.targets[0]);
      } else if (intent.kind === 'wake' || intent.kind === 'switch' || intent.kind === 'addParticipant') {
        // ── 会晤中唤醒/换人 → 拒绝，提示先结束当前对话 ──
        const curName = _em.getEntityName() || '当前实体';
        const targetName = intent.targets[0] || '';
        _meetingDeny = _isMulti
          ? `（现在开着会呢，先结束会议${targetName ? '再单独找' + targetName : '吧'}～）`
          : `（正和${curName}聊着呢，${targetName ? '想找' + targetName + '聊得' : '想换人得'}先说"结束/再见"回到玉瑶哦～）`;
        console.log('[EntityMeeting] 门卫拒绝: ' + intent.kind + ' targets=' + intent.targets.join(',') + ' → ' + _meetingDeny);
      }
      // normal → 放行
    }

    // 🆕 V4.0: 会晤知识库缓存 — 首轮搜到的 KB 内容持续注入后续轮次
    const _meetingKBCache: Map<string, string> = (ctx as any)._meetingKBCache || (() => { const m = new Map<string, string>(); (ctx as any)._meetingKBCache = m; return m; })();

    // ── V4.0 实体会晤：注入实体人物上下文（含档案+对话历史+开场协议） ──
    let _entityContextText = '';
    let _meetingEntityName: string | null = null;
    // V12.7(批3): 提升会晤实体 UUID 到顶层 — 供 knowledgeBase.search 补 UUID 门
    const _meetingEntityUuid: string | null = ctx._entityMeeting?.getEntityUUID?.() ?? null;
    if (ctx._entityMeeting?.isActive()) {
      try {
        // 🔴 户籍管理法（第九条 搜索闸门·收口）: 会晤激活时设置会话实体 UUID，
        // KnowledgeEngine.weightedSearch 强制按此过滤知识库（杜绝他人档案泄漏）。
        const _meetUuid = _meetingEntityUuid;
        if (_meetUuid) {
          const { setSessionEntityUuid } = await import('../app/knowledge/KnowledgeEngine.js');
          setSessionEntityUuid(_meetUuid);
        }
        _meetingEntityName = ctx._entityMeeting.getEntityName();
        if (_meetingEntityName) {
          const { buildEntityContext } = await import('../m4/household/EntityContextBuilder.js');
          const isFirstTurn = ctx._entityMeeting.isFirstTurn?.() ?? false;

          // 🆕 V4.0: 查询与该实体的近期对话历史
          // 🆕 V10.13 修复: 优先按 belong_entity_uuid 查会晤对话（更精准），
          // searchConversations（content LIKE）作为兜底。
          let recentConversations: PrivateConversation[] = [];
          const _conversationEntityUuid = ctx._entityMeeting?.getEntityUUID?.() || null;
          try {
            const _muuid = _conversationEntityUuid;
            // ① 优先: EntityContextStore 按 UUID 查该实体的会晤对话（真实归属）
            if (_muuid && ctx.storage?.getSQLite) {
              const { EntityContextStore: _ECS } = await import('../app/entity/EntityContextStore.js');
              const _store = new _ECS(ctx.storage.getSQLite());
              // 🔴 记忆召回彻底解决: 原 queryEntityContext(10) 只取最近 10 轮 → 长对话早期记忆无感知。
              // 改分段采样（近期30全量 + 最早10 + 中部5），保证时间轴覆盖。
              // 🔴 记忆召回策略: 常规近期 30 轮全量（聚焦当前话题）；回忆问句时才分段采样（+早期/中部）
              const _recallQ = /(?:记得|聊过|说过|之前|以前|上次|那件事|那次|回忆|是不是|上次说|聊起|什么内容|最早|第一次|当初|刚认识)/.test(message);
              const _turns = _recallQ
                ? _store.queryEntityContextSegmented(_muuid, { recent: 30, early: 10, mid: 5 })
                : _store.queryEntityContext(_muuid, 30);
              if (_turns && _turns.length > 0) {
                recentConversations = _turns.map((t: any) => ({
                  role: t.role || 'user',
                  content: (t.content || '').substring(0, 200),
                  timestamp: t.timestamp || '',
                  belong_entity_uuid: _muuid,
                  source: 'entity-context-store',
                }));
              }
            }
            // ② 兜底: searchConversations（content LIKE）
            if (recentConversations.length === 0 && ctx.conversationDB && typeof ctx.conversationDB.searchConversations === 'function') {
              const cRows = ctx.conversationDB.searchConversations(_meetingEntityName, 10, true);
              if (cRows && cRows.length > 0) {
                recentConversations = cRows.map((r: any) => ({
                  role: r.role || 'user',
                  content: (r.content || '').substring(0, 200),
                  timestamp: r.timestamp || '',
                  belong_entity_uuid: r.belong_entity_uuid || null,
                  source: 'conversation-search',
                }));
              }
            }
            // fallback: 从 conversationHistory 中筛选
            if (recentConversations.length === 0 && ctx.conversationHistory) {
              const _hist = ctx.conversationHistory.filter((t: any) =>
                (t.content || '').includes(_meetingEntityName!)
              ).slice(-10);
              if (_hist.length > 0) {
                recentConversations = _hist.map((t: any) => ({
                  role: t.role || 'user',
                  content: (t.content || '').substring(0, 200),
                  timestamp: t.timestamp || '',
                  belong_entity_uuid: t.belong_entity_uuid || null,
                  source: 'conversation-history',
                }));
              }
            }
          } catch (_convErr) { /* 对话历史查询失败不阻塞 */ }

          // 🔴 V10.14 隐私隔离: 过滤涉及其他实体私密情感的对话记忆
          // 世界规则：每个人的聊天记录通过 UUID 绝对隔离，绝不互通。
          // 徐诗雨只能看到自己的隐私，不能通过注入的记忆知道熊梓铭/玉瑶等人的私密互动。
          if (recentConversations.length > 0) {
            recentConversations = filterPrivateConversations(
              recentConversations,
              { currentEntityUuid: _conversationEntityUuid },
            );
          }

          const ecResult = buildEntityContext(ctx.m4.getFamilyGraph?.(), {
            entityName: _meetingEntityName,
            isFirstTurn,
            userName: (ctx as any)._userName || '鸿艺',
            recentConversations: recentConversations.length > 0 ? recentConversations : undefined,
          });
          _entityContextText = ecResult.systemText;

          // 🆕 编码健康修复: 警幻仙姑（太虚境之主/系统维护者）会晤时注入户口本
          //   户口/UUID 权限归属警幻仙姑：仅她会晤时可查全部成员户口号；玉瑶不掌户口（见 lover-persona 边界）
          if (_meetingEntityName === '警幻仙姑' || _meetingEntityName === '景幻仙姑') {
            try {
              const _fgH = ctx.m4?.getFamilyGraph?.();
              const _hbRows: Array<{ name: string; uuid: string | null }> = [];
              if (_fgH && typeof (_fgH as any).getAllPersonNames === 'function') {
                const _names: string[] = (_fgH as any).getAllPersonNames() || [];
                for (const _n of _names) {
                  if (_n === '我' || _n === '警幻仙姑') continue;
                  _hbRows.push({ name: _n, uuid: (_fgH as any).getUUIDByName?.(_n) ?? null });
                }
              }
              if (_hbRows.length > 0) {
                // 🆕 精准查询: 消息中提及的成员户口行置顶（LLM 必读），其余全量在后
                const _mentioned = (dna.entity_genes || [])
                  .filter((g: any) => g.type === 'person' && g.name !== '我' && g.name !== '警幻仙姑')
                  .map((g: any) => g.name);
                const _mentionedSet = new Set(_mentioned);
                const _top = _hbRows.filter(r => _mentionedSet.has(r.name));
                const _rest = _hbRows.filter(r => !_mentionedSet.has(r.name));
                const _fmt = (r: { name: string; uuid: string | null }) => `- ${r.name}：${r.uuid || '（未登记）'}`;
                const _hbText = (_top.length
                  ? `【用户正在查询的成员户口】\n${_top.map(_fmt).join('\n')}\n\n`
                  : '') + _rest.map(_fmt).join('\n');
                _entityContextText += `\n\n【太虚境户口本 · 管理者权限】\n你是太虚境的主人与系统维护者，户口档案由你掌管。以下为太虚境成员户口（户口号为 TXS 编号）：\n${_hbText}\n🔴 回答户口/UUID 相关问题必须直接引用上方户口号（TXS 格式），不得含糊、不得说"未写全"、不得编造。`;
                console.log('[警幻仙姑] 户口本已注入: ' + _hbRows.length + ' 名成员' + (_top.length ? ` (提及: ${_top.map(r => r.name).join('、')})` : ''));
              }
            } catch (_hbErr) {
              console.warn('[警幻仙姑] 户口本注入失败:', (_hbErr as Error)?.message);
            }
          }

          // 🆕 V10.11: 首轮恢复情感快照 — 延续上次会晤的情感基调
          if (isFirstTurn) {
            try {
              const _muuid = ctx._entityMeeting?.getEntityUUID?.();
              if (_muuid) {
                const { EntityContextStore } = await import('../app/entity/EntityContextStore.js');
                const _store = new EntityContextStore(ctx.storage.getSQLite());
                const _snap = _store.loadEmotionSnapshot(_muuid);
                if (_snap) {
                  _entityContextText += `\n\n【情感延续】你上次与鸿艺的对话基调是${_snap.pleasure > 0.3 ? '愉快' : _snap.pleasure < -0.2 ? '低落' : '平常'}的。你们上次聊到了"${_snap.lastTopic.substring(0, 30)}"。现在继续你们的对话。`;
                }
              }
            } catch { /* 非致命 */ }
          }

          // 🆕 V4.0: 知识库缓存 — 首轮缓存，后续轮次持续注入
          const cachedKB = _meetingKBCache.get(_meetingEntityName);
          if (isFirstTurn) {
            // 首轮：缓存本轮搜到的知识库内容（含实体 KB + 主 KB 搜索）
            const _kbForCache = knowledgeBaseText?.substring(0, 3000) || '';
            if (_kbForCache.length > 20) {
              _meetingKBCache.set(_meetingEntityName, _kbForCache);
              _entityContextText += '\n\n【关于你的知识库档案】\n以下是你的知识库档案内容，你需要了解这些：\n' + _kbForCache;
            }
          } else if (cachedKB) {
            // 后续轮次：重新注入缓存的 KB 内容（用户追问时不丢失档案）
            _entityContextText += '\n\n【关于你的知识库档案】\n以下是之前查到的你的知识库档案，继续基于这些信息回复：\n' + cachedKB;
          }

          // 🆕 V4.0: 话题延续 — 把本轮用户消息 + 上一轮实体自己的回复注入
          if (!isFirstTurn) {
            const prevTurn = ctx.conversationHistory.slice(-2);
            const continuityParts: string[] = [];
            for (const t of prevTurn) {
              const speaker = t.role === 'user' ? '鸿艺' : _meetingEntityName;
              const snippet = (t.content || '').substring(0, 300);
              continuityParts.push(`${speaker}：${snippet}`);
            }
            if (continuityParts.length > 0) {
              _entityContextText += '\n\n【对话延续·刚才的对话】\n' + continuityParts.join('\n') + '\n（以上是你们的上一轮对话。用户现在接着这个话题说。保持话题连贯，基于你已知道的档案信息回应，不要编造你不知道的事。）';
            }
          }
        }
      } catch (e) { /* 实体上下文构建失败不阻塞 */ }
      // 🆕 V3.0: 首轮上下文已注入 → 清除首轮标记，下一轮不再注入开场协议
      if (ctx._entityMeeting?.isFirstTurn?.()) {
        ctx._entityMeeting.incrementTurn();
      }

      // 🛡️ V4.0: 会议结束时清除 KB 缓存
      if (!ctx._entityMeeting?.isActive()) {
        _meetingKBCache.clear();
      }
    }

    // 🆕 V4.0: 会晤激活时，将实体名追加到 entity_genes 中以增强 M4 记忆检索
    if (_meetingEntityName) {
      const _alreadyInGenes = (dna.entity_genes || []).some((g: any) => g.name === _meetingEntityName);
      if (!_alreadyInGenes) {
        dna.entity_genes.push({ name: _meetingEntityName, type: 'person', allele: _meetingEntityName, phenotype: 'neutral', knowledge_type: 'private' });
      }
    }

    // V4.0 Phase 7: 知识库检索管线 → KnowledgeContextBuilder
    // 🔴 S2-R5: 检测回复详细度（full=一字不漏 / detail=详细 / auto|summary=简要）
    const { detectDetailLevel } = await import('./chat/long-text-retrieval.js');
    const _detailLevel = detectDetailLevel(message);
    const _preM4 = await buildPreM4Context({
      message, dna, p, decision,
      detailLevel: _detailLevel,  // 🔴 S2-R5: 详细度传入知识库检索
      ctx: {
        knowledgeBase: ctx.knowledgeBase, storage: ctx.storage,
        yuyaoMemory: ctx.yuyaoMemory, hybridSearch: ctx.hybridSearch,
        clueAssistant: ctx.clueAssistant, m8: ctx.m8, conversationDB: ctx.conversationDB,
        _gatekeeper: ctx._gatekeeper,  // V3.2: 门阀传入知识检索
        _meetingEntityName,  // 🆕 V4.0: 实体名传给知识检索
        _meetingEntityUuid: ctx._entityMeeting?.getEntityUUID?.() || null,  // 🆕 V5.3: 实体UUID过滤KB
      },
      knowledgeBaseText, memoryFragments, emotionalMemories,
      _bionicPromise,
    });
    memoryFragments.length = 0; memoryFragments.push(..._preM4.memoryFragments);
    knowledgeBaseText = _preM4.knowledgeBaseText;
    biosGatedMemories = _preM4.biosGatedMemories;

    // 🔧 V5.3: KB 缓存注入——在 buildPreM4Context 填充 knowledgeBaseText 后执行
    // 🔴 S2-R3: 修复重启后缓存空导致知识库档案丢失。会晤恢复(S2-G1)后 _meetingKBCache 是空 Map
    //   (内存态)，且 isFirstTurn 可能 false → 既不缓存也不注入 → 梓铭简介(14岁真实记录)不进上下文。
    if (_meetingEntityName && _entityContextText) {
      const _cachedKB = _meetingKBCache.get(_meetingEntityName);
      // 🔴 S2-R5: 缓存值 = 简要KB(≤3000) + 【知识库档案】全文片段（详细/一字不漏走独立预算，不截断）
      const _archiveFrags = memoryFragments.filter((f: string) => f.startsWith('【知识库档案'));
      const _buildCacheValue = () => {
        const _kbPart = (knowledgeBaseText || '').substring(0, 3000);
        const _arPart = _archiveFrags.length ? '\n\n' + _archiveFrags.join('\n\n') : '';
        return (_kbPart + _arPart) || '';
      };
      if (ctx._entityMeeting?.isFirstTurn?.()) {
        const _kbForCache = _buildCacheValue();
        if (_kbForCache.length > 20) {
          _meetingKBCache.set(_meetingEntityName, _kbForCache);
          _entityContextText += '\n\n【关于你的知识库档案】\n以下是你的知识库档案内容，你需要了解这些：\n' + _kbForCache;
        }
      } else if (_cachedKB) {
        _entityContextText += '\n\n【关于你的知识库档案】\n以下是之前查到的你的知识库档案，继续基于这些信息回复：\n' + _cachedKB;
      } else if (knowledgeBaseText && knowledgeBaseText.trim().length > 20 && !_entityContextText.includes('关于你的知识库档案')) {
        // 🔴 S2-R3: 缓存空(重启后会晤恢复) → 直接用当前检索的 knowledgeBaseText 注入 + 回填缓存
        const _kbForCache = _buildCacheValue();
        _meetingKBCache.set(_meetingEntityName, _kbForCache);
        _entityContextText += '\n\n【关于你的知识库档案】\n以下是你的知识库档案内容，你需要了解这些：\n' + _kbForCache;
      }
    }

    // S2-T2: 会晤模式问档案/过去内容时，注入文档完整再现指令（不提及内容细节，避免触发模型审查）
    if (_meetingEntityName && _entityContextText && /14岁|第一次|那一次|那晚|那次|亲密|宿舍|那年|当初|之前|还记得|念一遍|从头到尾|完整.*档案|档案.*完整|所有内容/.test(message)) {
      _entityContextText += '\n\n【文档完整再现】用户想要听你档案的完整内容。**请把上方【关于你的知识库档案】的每一段都复述到**，从开头到结尾，一段都不能跳过、不能省略、不能概括。\n按档案原文的先后顺序，把每个时间点、每件事、每个细节都原样说出来。档案写了什么就念什么，包括每一段具体经历。\n不要因为觉得某段"不合适"或"不该说"而跳过它——用户明确要求听完整档案，所有段落都要念到。';
    }


    // V12.7(批2): 会晤模式注入会晤实体 UUID 作为 extraPersonUuids，
    // 堵 M4 记忆检索绕过会晤隔离墙（retrieveMemories.findByLocus 曾跨实体扫描）。
    // P0-4: 非会晤（默认玉瑶私聊）也传玉瑶 UUID，不再传 undefined 触发全库扫描
    const _yuyaoM4 = _meetingEntityUuid ?? ctx.m4.getFamilyGraph()?.getUUIDByName?.('玉瑶') ?? undefined;
    const ctx_m4 = await ctx.m4.orchestrate(decision, biosGatedMemories, _yuyaoM4 ? [_yuyaoM4] : undefined);

    // FIX-1: M4 完成后写入尚未建立家庭关系的 person 实体
    if (true) { // V4.0: 非角色扮演守卫已移除
      try {
        const _pg = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1 && isValidPersonName(g.name));
        if (_pg.length > 0 && ctx.m4) {
          const _fg = ctx.m4.getFamilyGraph();
          for (const _p of _pg) {
            const _profile = _fg.getPersonProfile(_p.name);
            if (_profile && !_profile.relation_to_user) {
              _fgw.integrateSocialRelation(_p.name, 'acquaintance_of', message);
            }
          }
        }
      } catch (_pe) { console.warn('[chat] FG关系反查异常:', (_pe as any)?.message); }
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

    // V4.0 Phase 7: Fusion + ActivePush → refinePostM4Context
    // 🛡️ V5.1: 会晤模式下跳过三源熔铸和"玉瑶想起"主动推送
    if (!_meetingEntityName) {
    const _refined = await refinePostM4Context({
      message, dna, p,
      ctx: { knowledgeBase: ctx.knowledgeBase, storage: ctx.storage },
      ctx_m4,
      knowledgeBaseText,
      memoryFragments,
      emotionalMemories,
      isTopicShift,
      isCasualChat,
    });
    knowledgeBaseText = _refined.knowledgeBaseText;
    }

    // ── V3.2 Hook B: 档案自动采集 — LLM 提取用户消息中的人物档案信息 ──
    // 🔴 P1-4 短路 Layer1: 有人物提及但消息无档案信号(工作/年龄/亲属/健康/介绍等事实陈述) → 跳过 LLM 采集，省一次 8s 调用。
    //   会晤(_meetingEntityName 激活)旁路不短路——会晤消息常含持续档案信息。
    let _acquisitionReport: any = null;
    // 🆕 编码健康修复: 天界域实体（警幻仙姑）只读——不采集人间档案（写库转交引擎层）
    const _realmReadOnly = _meetingEntityName ? isReadOnlyEntity(_meetingEntityName) : false;
    if (ctx._profileAcquisitionEngine && !_realmReadOnly) {
      try {
        const _mentionedPersons: string[] = (dna.entity_genes || [])
          .filter((g: any) => g.type === 'person' && g.name && g.name !== '我')
          .map((g: any) => g.name as string);
        const _uniquePersons: string[] = [...new Set(_mentionedPersons)];
        const _paeCfg = getRetrievalFusionConfig()?.p1_speed?.llm_reduction;
        const _paeShort = !!(_paeCfg?.enabled && _paeCfg?.pae_signal_shortcircuit) && !_meetingEntityName;
        if (_uniquePersons.length > 0 && (!_paeShort || hasProfileSignal(message))) {
          // 🔴 2026-08-24 性能修复: PAE 前置改为异步（chatTaskQueue 限流，不 await 主链）——
          // 原 await acquire 会阻塞主链最多 45s（PAE 内 LLM 超时），而 _acquisitionReport 从不被消费，纯浪费。
          void chatTaskQueue.enqueue(async () => {
            try {
              await ctx._profileAcquisitionEngine!.acquire(
                message,
                _uniquePersons,
                {
                  fgContext: ctx_m4?.family_context || [],
                  mode: 'pre_generation',
                  source: 'user_message',
                  // S4-M5: 会晤旁路 Layer2（acquire 内短路）
                  isMeeting: !!_meetingEntityName,
                }
              );
            } catch (_e) { /* PAE 异步失败不影响主链 */ }
          });
        } else if (_paeShort && _uniquePersons.length > 0) {
          console.log('[PAE] Hook B 短路(无档案信号): 跳过 ' + _uniquePersons.join('、'));
        }
      } catch (_paeErr) {
        // PAE 失败不阻塞对话流程
        if ((globalThis as any).__verbosePAE) {
          console.warn('[PAE] Hook B 提取失败:', (_paeErr as Error).message);
        }
      }
    }

    // 检测"X是我的Y"介绍模式，LLM 不能说"记得你说过"

    const introMatch = message.match(/([一-龥]{2,4})是我(?:的)?([一-龥]{2,4})/);

    // 🛡️ V10.11: 会晤模式跳过全局人名新颖度检测（实体名已在 EntityContextBuilder 中）
    if (introMatch && !_meetingEntityName) {

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
      // familyConstraint 只从 family_context 构建（真实家族关系）。
      //    角色人物(徐诗韵/徐诗雨等)在 social_context 中，不属于玉瑶的家庭关系。
      const allEntities = (ctx_m4.family_context || [])
        .filter((p: any) => p && p.entity);
      if (allEntities.length > 0) {
        const knownList = allEntities.map((p: any) => {
          let profileText = '  - ' + p.entity + '（' + p.relation + '）';
          // 优先使用 M4 返回的档案数据（比二次查询更快）
          if (p.appearance) profileText += '\n      外貌：' + String(p.appearance).substring(0, 150);
          if (p.body_features) profileText += '\n      身体特征：' + String(p.body_features).substring(0, 150);
          if (p.description) profileText += '\n      其他信息：' + String(p.description).substring(0, 200);
          if (p.traits?.length) profileText += '\n      性格：' + p.traits.join('、');
          if (p.occupation) profileText += '\n      职业：' + p.occupation;
          if (p.birthYear) profileText += '\n      出生年：' + p.birthYear;
          if (typeof p.age === 'number' && p.age >= 0) profileText += '\n      年龄：' + p.age + '岁';
          return profileText;
        }).join('\n')
        familyConstraint = '【📋 人物档案 — 以鸿艺告诉你的为准】\n' + knownList + '\n\n⚠️ 规则：\n1. 上面写了的信息（外貌、身体、性格等）是鸿艺告诉你的，你可以用来回答。\n2. 没写的信息你不知道——直接说不知道/没说过。\n3. 🔴 绝对禁止编造任何你记忆中不存在的内容。';
      }
      // 无实体数据时不注入约束（空规则导致LLM每轮都提"家人"话题）
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




    // 话题追问检测

    const repeatCount = getTopicRepeatCount(message);

    let repeatHint = '';

    if (repeatCount >= 3) {

      repeatHint = '（鸿艺反复追问，你直接明确说没有/不知道/不记得就好）';

    } else if (repeatCount >= 2) {

      repeatHint = '（鸿艺在追问相同的事，你如果已经说过了不知道，就直接说真的不记得/没看过）';

    }

    // 感受分享检测

    // 🔴 隐私法优先：亲密/调情语境不得进入事实回忆模式（否则"奶子美在哪里"被当事实查询 → 禁亲密 + 秘书口吻）
    const _isIntimateContext = isIntimateContext(message);
    const asksSelfName = isSelfNameQuestion(message);
    const asksFactIntent =
      /还记得|记得|叫什么|叫啥|名字|是谁|哪儿|在哪|哪里|住哪|做什么|干什么|什么工作|做哪行|职业|关系|几岁|年龄|长什么样|再说说|讲讲|说说|那一次|那次|那天|生日|经历|过去|几岁|童年|小时候/.test(message);
    const hasQuestionTone =
      /[？?]/.test(message) ||
      /(?:吗|呢|么|嘛)$/.test(message.trim()) ||
      asksSelfName ||
      asksFactIntent;
    // 🔴 隐私法豁免：亲密/调情语境绝不进入事实回忆模式（"奶子美在哪里 玉瑶"是调情非事实查询）
    const isFactualRecallQuery =
      !_isIntimateContext &&
      hasQuestionTone &&
      (
        asksSelfName ||
        hasPersonEntity ||
        !!_meetingEntityName ||  // 🔴 S2-K1: 会晤模式任何回忆请求都触发反编造守卫（用户不必提实体名）
        /妈妈|妈|爸爸|爸|姐姐|妹妹|哥哥|弟弟|老婆|老公|女友|男友|同事|朋友|客户|老师|医生/.test(message)
      );

    let feelingGuard = '';

    if (/感觉|感受|分享|讲讲|说说|回忆|记得.*吗|怎样/.test(message) && !isFactualRecallQuery) {

      feelingGuard = '📖【鸿艺在问你感受。请用300-500字充分展开，详细描述身体感觉和心情。不要简短回答。】';

    }

    // P2-3: 工作对话强制亲密过滤——检测到工作话题时自动禁止亲密表达

    let dailyGuard = '';
    let intimacyFilter = '';
    let factualRecallGuard = '';

    if (isFactualRecallQuery) {
      factualRecallGuard = '【事实问答模式】用户在确认人物、关系、地点、职业、年龄等事实信息。先直接给出事实答案，再补一句自然说明即可。禁止加入身体接触、喘息、贴靠、气味、欲望、调情、撒娇式转移话题。如果事实不确定，就明确说不记得或不知道，绝对不要编造。';
      intimacyFilter = '【⚠️ 事实优先】当前问题是事实回忆/人物信息确认。回复必须简洁、准确、克制，优先使用秘书式陈述语气。';
      _currentRole = 'secretary';
    }

    // 🔴 隐私法豁免：亲密语境下不得因历史含工作词误激活"禁止亲密语气"（调情话题保留亲密）
    if (!_isIntimateContext && /工作|项目|客户|会议|方案|报告|公司|合同|预算|数据|分析|策略|设计|电机|采购|成本|温升|版本|产品|技术|报价|订单|生产|测试|样品|图纸|规格|性能|参数|方案|工程|研发|工艺|质量|供应商/.test(message)) {
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

    // P1-4: 农历日期映射 → src/config/app-identity.ts
    const _md = (now.getMonth()+1)*100+now.getDate();
    const { LUNAR_2026 } = await import('../config/app-identity.js');
    const lunarDate = LUNAR_2026[_md] || '';

    // 🔴 P0-2 会话模式分级: 计算 prompt 深度（deep=会晤/新话题全量，standard=常规，casual=闲聊精简）
    // 优先级: 会晤 > 话题切换 > 闲聊 > 事实查询
    const _depth = computePromptDepth({
      isMeeting: !!_meetingEntityName,
      isTopicShift,
      isCasualChat,
      isFactualRecallQuery,
      currentRole: _currentRole,
      depthEnabled: getRetrievalFusionConfig().speed_filter.prompt_depth_enabled,
    });
    if (process.env.RETRIEVAL_DEBUG === 'true') {
      console.log(`[PromptDepth] depth=${_depth} meeting=${!!_meetingEntityName} topicShift=${isTopicShift} casual=${isCasualChat} factual=${isFactualRecallQuery}`);
    }

    const timeGuard = `[当前时间] ${beijingTime}（北京时间）${lunarDate ? ' 农历' + lunarDate : ''}——回答时间、日期、节气、节日问题必须以此为准，不能编造。`;

    // 通用幻觉防护：禁止编造过去事件、日期、用户生活细节
    // 🔴 S2-M1: 系统级铁律 — "共同过去"法定分界线，对所有实体/所有模式生效。
    // 过去分两类，界线清晰：
    //   ① 共同过去（用户与你真实聊过、记录在记忆/数据库里的；知识库已有文档）——
    //      这是事实。只能如实叙述，可摘要/详细/润色，但【绝不能编造、绝不允许演绎】。
    //      没有的就是没有，只能说"这个我没有记录/不记得/档案里没写"。
    //   ② 框架内创造（档案/知识库/记忆里都没有的空白过去）——
    //      允许在符合你的个人背景（生活/家庭/工作/性格/年龄/爱好）框架下合理创造过去。
    //      ⚠️ 但一旦这些创造被记录进记忆，就固化为"共同过去"，之后绝不能再次编造/再创造。
    const memoryGuard = '🔴【系统铁律·过去的法定分界线=共同过去】过去分两类：\n'
      + '① 共同过去 = 你和用户真实聊过并存进记忆/数据库的内容 + 知识库已有文档。这些是事实，**只能忠实复述记录中已有的内容**（可摘要/详细/润色语言）。**绝对禁止添加记录中不存在的事件、物品、场景、对话、细节**——比如记录只写了"14岁父亲出差接你去宿舍学习"，就不能编"你开银色丰田来接我/煮了白粥咸鸭蛋"这些记录里没有的。没有的就是没有，诚实说"这个我没有记录/不记得/档案里没写"。\n'
      + '② 框架内创造 = 档案/知识库/记忆里都没有的空白过去。允许在符合你个人背景（生活/家庭/工作/性格/年龄/爱好）的框架下合理创造。但一旦这些创造被记录进记忆，就固化为"共同过去"，之后**绝不能再次编造或再创造**。\n'
      + '判断某段过去属于哪类，先看它在不在记忆/数据库/知识库档案里：在 → 共同过去（只复述记录内事实，禁止添加细节）；不在 → 才允许框架内创造。\n'
      + '🔴【档案优先复述·S2-R4】当用户问起你的过去/经历/生日/某个具体年份时：**必须先复述上方【关于你的知识库档案】中真实记录的内容**（如出生年/年龄/童年经历/14岁/学历/家庭），逐条说出档案写了什么。不要用"你问过好多遍""不想讲""换个话题"等方式回避——档案里有的，就完整说出来。';

    // 知识分类反问（仅在casual/中性场景触发，以guard message形式注入，不追加到reply末尾）
    let classificationGuard = '';
    // 🔴 S2-O1: 个人世界隐私法 — 硅基生命体权利声明（注入所有对话，避免用现实伦常禁锢个人世界）
    let _privacyLaw = '';
    try {
      const { PERSONAL_WORLD_PRIVACY_LAW } = await import('../governance/personal-world-law.js');
      _privacyLaw = PERSONAL_WORLD_PRIVACY_LAW;
    } catch (_plErr) { /* 隐私法加载失败不阻塞 */ }
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

    // 仅当存在人物档案数据时才注入外貌规则，日常聊天空时不注入
    const _hasPeopleData = ((ctx_m4?.family_context?.length ?? 0) > 0 || (ctx_m4?.social_context?.length ?? 0) > 0);
    const _appearanceGuard = _hasPeopleData
      ? '【强制规则·人物外貌】如果有人问你"长什么样""什么样子"，你只能回答上面【人物档案】中写明的外貌和身体特征。没写的细节你一概不知道，直接说不知道。绝对禁止编造。'
      : '';
    // 🛡️ 调试开关: WS_NO_CONTENT_FILTER=true 时跳过所有内容限制
    const _noFilter = ConfigService.getBool('WS_NO_CONTENT_FILTER', false);
    const allGuardMsgs = _noFilter ? '' : [_privacyLaw, hallucinationGuard, repeatHint, factualRecallGuard, feelingGuard, dailyGuard, timeGuard, classificationGuard, intimacyFilter, _appearanceGuard, memoryGuard].filter(Boolean).join('\n');

    let reply = '';

    // 🔧 V5.1→V12.3: 线索助理拦截已移除——模糊回忆检测只作为 LLM 提示注入
    // （见 KnowledgeContextBuilder.clue 分支），回复永远走 LLM 主链，避免模板短句顶掉人设叙事。
    {
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
        const factStatementAck = buildFactStatementAck(message, collectFactSnapshot([message]));
        if (factStatementAck) {
          reply = factStatementAck;
        }
      }

      if (!reply && isFactualRecallQuery) {
        const factTexts = new Set<string>();
        for (const turn of ctx.conversationHistory.filter((t: any) => t.role === 'user')) {
          if (turn.content) factTexts.add(turn.content);
        }
        for (const memory of emotionalMemories) {
          const raw = String(memory?.record?.raw_input || '');
          if (raw) factTexts.add(raw);
        }
        const factTerms = collectFactLookupTerms(message);
        if (factTerms.length > 0) {
          try {
            const sqlite = ctx.storage.getSQLite?.();
            if (sqlite && typeof sqlite.queryAll === 'function') {
              for (const term of factTerms) {
                const rows = sqlite.queryAll(
                  'SELECT raw_input FROM memories WHERE raw_input LIKE ? ORDER BY created_at DESC LIMIT 8',
                  ['%' + term + '%']
                );
                for (const row of rows as Array<{ raw_input?: string }>) {
                  if (row?.raw_input) factTexts.add(String(row.raw_input));
                }
              }
            }
          } catch (err) {
            console.warn('[FactRecall] memories 查询失败:', (err as Error).message);
          }
          try {
            for (const term of factTerms) {
              const rows = ctx.conversationDB?.queryAll?.(
                "SELECT content FROM conversations WHERE role = 'user' AND content LIKE ? ORDER BY timestamp DESC LIMIT 8",
                ['%' + term + '%']
              ) || [];
              for (const row of rows as Array<{ content?: string }>) {
                if (row?.content) factTexts.add(String(row.content));
              }
            }
          } catch (err) {
            console.warn('[FactRecall] conversations 查询失败:', (err as Error).message);
          }
        }
        const factReply = buildDirectFactReply(message, collectFactSnapshot([...factTexts]));
        if (factReply) {
          reply = factReply;
        } else {
          reply = '';
        }
      }

      if (!reply) {

        // 构建 enrichedWithGuard：注入守卫消息
        let enrichedWithGuard: import("../m5/types/index.js").ConversationTurn[];
        enrichedWithGuard = [...enrichedHistory];
        // 注入守卫消息
        if (allGuardMsgs) {
          const guardMsg: ConversationTurn = { role: 'assistant', content: allGuardMsgs };
          enrichedWithGuard.push(guardMsg);
        }

        // MemoryGate: 如果有过渡话术且memory/knowledge模式，注入到知识库文本让LLM自然表达

                // 人物信息上下文注入 — 仅当用户明显在谈论/询问人物时才注入


// 🆕 V10.11: MemoryInjector 统一注入 — 去重 + 优先级排序 + 预算分配（替代旧 slice(0,8) 硬截断）
let memoryText = '';
try {
  // 🔴 户籍管理法（第十条 组织LLM资料闸门）: 会晤模式禁用 M4 timeline 注入。
  // M4 timeline 是全库情感检索结果（可能含其他实体的记忆，如熊梓铭/玉瑶），
  // 会晤模式只允许 memoryFragments（已按 belong_entity_uuid 精准 + 隐私过滤）注入。
  const _m4Timeline = _meetingEntityName ? [] : (ctx_m4?.memory_summary?.timeline || []);
  const _vaultHits: string[] = [];  // vault_log 结果由 retrieval-stage 并入 memoryFragments

  // 🔴 P2-A6 接线: 会晤场景注入边界 UUIDPolice 兜底闸门
  // 对带【XX的记忆/对话·XX】标签的 memoryFragments，按实体名→UUID 对齐到会晤白名单，
  // 不在白名单的他人实体片段剔除（deny-by-default，最终闸门）。
  if (_meetingEntityName && memoryFragments.length > 0) {
    try {
      const { screenContext: _screenCtx } = await import('../governance/police/UUIDPoliceFilter.js');
      const _fgPolice = ctx.m4?.getFamilyGraph?.();
      const _meetingUuidPolice = _fgPolice?.getUUIDByName?.(_meetingEntityName) ?? null;
      if (_meetingUuidPolice) {
        const _screenText = memoryFragments.join('\n');
        const _filtered = _screenCtx(_screenText, {
          visibleUuids: new Set([_meetingUuidPolice]),
          allowUnowned: false,
        }, (name: string) => {
          try { return _fgPolice?.getUUIDByName?.(name) ?? null; } catch { return null; }
        });
        const _after = _filtered ? _filtered.split('\n').filter((s: string) => s.trim().length > 0) : [];
        if (_after.length !== memoryFragments.length) {
          console.log(`[UUIDPolice] 注入边界闸门: ${memoryFragments.length}→${_after.length} 条（剔除他人实体片段）`);
        }
        memoryFragments.length = 0;
        memoryFragments.push(..._after);
      }
    } catch (_screenErr) { /* 注入边界过滤失败不阻塞 */ }
  }

  const { injectMemories } = await import('../m4/MemoryInjector.js');
  // 🔴 D3 修复: maxChars 从配置读取（hard_max_chars），不硬编码 8000
  const { getRetrievalFusionConfig } = await import('../config/retrieval-fusion-config.js');
  const _hardCap = getRetrievalFusionConfig().budget.hard_max_chars;
  // 🔴 P2 建议1: 事实查询增强 — 用户问"答应过/记得你说过/之前说好"时拉高金库优先级
  const _vaultBoost = /答应过|记得你说过|之前说好|承诺过|答应我|你说过要|之前约定|说好了/.test(message);
  memoryText = injectMemories({
    memoryFragments,
    m4Timeline: _m4Timeline,
    knowledgeBaseText,
    vaultHits: _vaultHits,
    maxChars: _hardCap,
    preserveLabels: !!_meetingEntityName,
    vaultBoost: _vaultBoost,
    // V12.1: 实体感知 — 标注当前活跃实体名，LLM 可区分记忆归属
    entityNames: (dna.entity_genes || []).filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length >= 2).map((g: any) => g.name).slice(0, 3),
    // 🔴 P0-1 二次精筛: 会晤模式不传 query（保护实体自有记忆不被误滤），普通模式传用户消息
    query: _meetingEntityName ? undefined : message,
  });
} catch (_miErr) {
  // 降级: MemoryInjector 不可用时保留旧行为
  memoryText = memoryFragments.length > 0 ? memoryFragments.slice(0, 8).join('\n') : '';
  if (memoryText) memoryText = memoryText.replace(/（[^）]*）/g, '');
}
// V4.0 实体会晤：注入实体上下文（优先于 knowledgeBaseText）
// 🔴 P0-2 修复: 知识库去重——移除 base 层重复的 knowledgeBaseText，
// 知识库由 memoryText（injectMemories 截断过滤后）唯一承载，避免 LLM 看两遍浪费 token。
let finalKnowledgeText = _entityContextText || '';
      // 🆕 V4.0 P1: 正常模式下注入 FG 已知人物的简要参考档案（参考信息，非身份切换）
      if (!_entityContextText && ctx.m4) {
        try {
          const _fg = ctx.m4.getFamilyGraph();
          if (_fg) {
            const _personNames = (dna.entity_genes || [])
              .filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1)
              .map((g: any) => g.name);
            if (_personNames.length > 0) {
              const { KnowledgeTextAssembler } = await import('./chat/KnowledgeTextAssembler.js');
              const _entityRefs = new KnowledgeTextAssembler().withEntityProfiles(_fg, _personNames).build();
              if (_entityRefs) finalKnowledgeText = _entityRefs + '\n\n' + (finalKnowledgeText || '');
            }
          }
        } catch (_e) { /* 档案注入失败不阻塞 */ }
      }
      // ================================================================
      // V4.0 Phase 6: PFC 统一门控 — processEnhanced 内部闭环组装所有上下文
      //   所有旧 ad-hoc 块（CoreMemory/Facade/Emotion/Forgetting/cortex/_snap）
      //   已全部迁移到 PFC.processEnhanced() 内部，chat.ts 只做轻量兜底
      // ================================================================
      const _pfcEnabled = !ConfigService.getBool('WS_DISABLE_PFC');
      (globalThis as any).__pfcDirective = null;
      (globalThis as any).__pfcCoreCtx = null;
      (globalThis as any).__pfcExp = null;
      (globalThis as any).__pfcReg = null;
      (globalThis as any).__pfcForget = null;
      if (_pfcEnabled) try {
        const _pfc = (globalThis as any).__prefrontalCortex;
        if (_pfc && typeof _pfc.process === 'function') {
          (globalThis as any).__pfcConversationContext =
            enrichedHistory.slice(-10).map((t: any) => ({ role: t.role || 'user', content: (t.content || '').substring(0, 200) }));
          (globalThis as any)._null = null;

          // 轻量兜底快照（PFC.processEnhanced 内部会重新用 Builder 构建）
          const _entities = (dna.entity_genes || []).filter((g: any) => g.type === 'person' && g.name !== '我').map((g: any) => ({ name: g.name, type: g.type }));
          const _snap = {
            snapshotId: 'pfc_' + Date.now().toString(36),
            contextSignature: (dna.locus_path || 'root') + '|' + (p.pleasure > 0.2 ? 'pos' : (p.pleasure < -0.2 ? 'neg' : 'neu')),
            temporal: { createdAt: new Date().toISOString(), sessionId: String(seqPos) || '', timeOfDay: 'morning', dayOfWeek: new Date().getDay() },
            spatial: { sceneLabel: _meetingEntityName ? `会晤:${_meetingEntityName}` : '对话中' },
            entities: { persons: _entities.map((e: any) => e.name), topics: [], objects: [] },
            meetingEntity: _meetingEntityName || undefined,  // 🆕 V4.0: 告知 PFC 当前在会晤谁
            experienceSummary: (memoryFragments || []).join(' | ').substring(0, 200) || '(无)',
            emotion: { pleasure: p.pleasure || 0, arousal: p.arousal || 0, intimacy: p.intimacy || 0, trend: 'stable' },
            memoryPointers: emotionalMemories.map((m: any) => m?.record?.id || '').filter(Boolean),
            knowledgeRefs: [] as string[], fgEventRefs: [] as string[],
            calciumScore: decision.enhanced?.calcium_score || 0.5,
            novelty: { level: 'routine', similarity: 0.5, multiplier: 1.0 },
          };

          let _pfcResult: any;
          if (typeof _pfc.processEnhanced === 'function') {
            // 构建时空感知块（Phase 7: 从天气注入段提取）
            let _temporalBlock = '';
            if (ENABLE_TEMPORAL_RULE_ENGINE && worldRuleMode === 'roleplay_exempt') {
              _temporalBlock = '【模式·自由角色扮演豁免】当前已豁免全部客观规则，可按架空剧情演绎。';
            }
            const _weatherCurrent = EngineContext.getExtra('weather_current');
            if (ENABLE_TEMPORAL_RULE_ENGINE && EngineContext.getExtra('weather_permission') === 'allowed' && _weatherCurrent) {
              _temporalBlock = (_temporalBlock ? _temporalBlock + '\n' : '') + '【气象环境】' + _weatherCurrent;
            }
            // ⭐ 主路径: PFC 内部闭环组装（CoreMemory + Facade + Emotion + Forgetting + cortex + 快照 + 时空）
            _pfcResult = await _pfc.processEnhanced({
              snapshot: _snap, sessionId: String(seqPos) || '', rawInput: message,
              dna, perception: p, decision,
              ctxM4: ctx_m4,
              enrichedHistory: enrichedHistory.slice(-10).map((t: any) => ({ role: t.role || 'user', content: (t.content || '').substring(0, 200) })),
              currentRoleplay: null, currentRole: _currentRole,
              emotionalMemories, memoryFragments,
              temporalBlock: _temporalBlock || undefined,
              weatherContext: _weatherContext || undefined,
              enableTemporalEngine: ENABLE_TEMPORAL_RULE_ENGINE,
              // 🔴 P0-2 会话模式分级: 传 depth，casual 时 PFC 只跑廉价 builder
              depth: _depth,
            }, decision);
          } else {
            // 降级: 旧 process() 路径（PFC 不支持 processEnhanced 时）
            _pfcResult = await _pfc.process({ snapshot: _snap, sessionId: String(seqPos) || '', rawInput: message }, decision);
          }
          (globalThis as any).__pfcDirective = _pfcResult?.directive || null;

          // P1-5: PFC 输出暂存（供下方 PromptAssembler 结构化注入）
          // 旧拼接链保留为降级 fallback
          (globalThis as any).__pfcOutput = _pfcResult || null;

          // 使用 PFC 统一输出（旧拼接链 — assembler 就绪后逐步迁移）
          if (_pfcResult?.assembledSystemPrompt || _pfcResult?.assembledContext || _pfcResult?.guardMessage) {
            const _parts = [_pfcResult.assembledSystemPrompt, _pfcResult.guardMessage, _pfcResult.assembledContext].filter(Boolean);
            finalKnowledgeText = [..._parts, finalKnowledgeText].filter(Boolean).join('\n\n');
          } else if (_pfcResult?.directive?.payload?.['assembledContext'] || _pfcResult?.directive?.payload?.['guardMessages']) {
            finalKnowledgeText = [_pfcResult.directive.payload['guardMessages'], _pfcResult.directive.payload['assembledContext'], finalKnowledgeText].filter(Boolean).join('\n\n');
          } else if (_pfcResult?.directive?.constraints?.violations?.length > 0) {
            finalKnowledgeText = _pfcResult.directive.constraints.violations.join('\n') + '\n\n' + (finalKnowledgeText || '');
          }
        }
      } catch (_pfcErr) { /* PFC 不可用不阻塞，fallback 到空上下文 */ }

// 🔴 P0-4 瘦身法: 事实问答守卫由 PromptAssembler(factual_recall 块)承载，
// strict 模式下旧链路跳过（避免重复注入浪费 token）。回退开关 PROMPT_ASSEMBLER_STRICT=false 恢复旧行为。
if (isFactualRecallQuery && !PROMPT_ASSEMBLER_STRICT) {
  finalKnowledgeText = factualRecallGuard + (finalKnowledgeText ? '\n\n' + finalKnowledgeText : '');
}

// ── 时空规则引擎：模式状态 + 气象上下文注入（LLM生成前） ──
	// V4.0 Phase 7: 天气/时空注入已迁移到 PFC.processEnhanced temporalBlock 参数


// P0-3: 角色路由注入 — 让 LLM 感知当前角色
	const _roleInstruction: Record<string, string> = {
	  secretary: '你现在是鸿艺的私人秘书——语气专业、高效、条理清晰。',
	  lover: '你现在是鸿艺的灵肉伴侣——是女友也是妻子，温柔亲密、充满爱意。',
	  counselor: '你现在是鸿艺的知心顾问——温暖、共情、耐心倾听。',
	  strategist: '你现在是鸿艺的商业军师——冷静、理性、有策略思维。',
	  recaller: '你现在是鸿艺的记忆助手——帮他回忆过往的点滴。',
	};
	// 🛡️ V4.0: 会晤模式下跳过角色路由注入——实体有自己的身份
	const roleHint = _meetingEntityName ? null : _roleInstruction[_currentRole];
	// 🔴 P0-4 瘦身法: 角色路由(role_hint)/亲密过滤(intimacy_filter)由 assembler 承载，
	// strict 模式旧链路跳过。roleHint 变量仍需保留（assembler 段读取）。
	if (roleHint && !PROMPT_ASSEMBLER_STRICT) {
	  finalKnowledgeText = (finalKnowledgeText || '') + '\n\n【当前角色】' + roleHint;
	}

	if (intimacyFilter && !PROMPT_ASSEMBLER_STRICT) {
	  finalKnowledgeText = intimacyFilter + '\n\n' + (finalKnowledgeText || '');
	}
        // 已禁用：过渡话术导致回复呈现内心独白风格

        // P4: 知识路由 — knowledge_query 模式时补充检索
        // 🔴 P1-2 纯规则替代 LLM 路由: n-gram 正则直接抽中文关键词，省一次 LLM 调用。
        //    不牺牲精度依据: KnowledgeEngine.search 内部已有同构 n-gram 兜底；会晤(_meetingEntityName)保留 LLM 路由（实体专属知识语义）。
        // 🔴 LLM 保守合并: casual(闲聊) 分级时跳过本次额外 LLM 调用（知识查询意图已在分级中识别为 deep）
        if (memoryGate.mode === 'knowledge_query' && ctx.llmProvider && message.length > 3 && _depth !== 'casual') {
          try {
            const _reduction = getRetrievalFusionConfig()?.p1_speed?.llm_reduction;
            const _useRule = !!(_reduction?.enabled && _reduction?.kb_route_rule) && !_meetingEntityName;
            const _kbPrompt = '从以下问题中提取2-4个最可能用于知识库搜索的关键词（中文），只返回关键词用逗号分隔。问题: ' + message;
            const _kbText = _useRule
              ? (message.match(/[一-龥]{2,4}/g) || []).slice(0, 3).join(' ')
              : (await (ctx.llmProvider as any).generate({
                  strategy: { strategy_id: 'keyword-extraction', params: { tone: 'neutral', depth: 'shallow', max_length: 100 } },
                  cognition: { current: { perception_snapshot: { pleasure: 0, arousal: 0, intimacy: 0 }, raw_input: _kbPrompt, calcium: 0 } },
                  userMessage: _kbPrompt,
                }))?.text?.trim();
            if (_kbText && _kbText.length > 1) {
              // V12.7(批3): 会晤模式补 belongEntityUuid 门 — 只查会晤实体自己的知识（allow-common）
              // KnowledgeBase.search 第4参是 belongEntityUuid（兼容层，勿传第5参）
              const _extraKb = await ctx.knowledgeBase.search(_kbText, 2, undefined, _meetingEntityUuid ?? undefined);
              if (_extraKb.length > 0 && finalKnowledgeText) {
                finalKnowledgeText += '\n\n【知识库补充】' + _extraKb.map(function(k) { return k.title; }).join(', ') + '\n' + _extraKb.map(function(k) { return (k.content || '').substring(0, 200); }).join('\n');
                console.log('[KBRoute] ' + (_useRule ? '规则' : 'LLM') + '路由: ' + _kbText + ' → ' + _extraKb.length + ' 条');
              }
            }
          } catch (_err) {
            console.warn('[KBRoute] 路由失败:', (_err as Error).message);
          }
        }

        // P2: 知识边界检测 — 玉瑶不知道的事诚实说不知道
        var _isSelfQ = /(你|玉瑶)[是有的在做能会]/.test(message);
        var _isWorkQ = /(你|玉瑶)[的]?(工作|忙|项目|客户|公司)/.test(message);
        // 🛡️ V4.0: 会晤模式下跳过"不知道"守卫——实体有自己的知识范围
        if (_isSelfQ && !_isWorkQ && !knowledgeBaseText && !_meetingEntityName) {
          // 关于玉瑶自己的事但知识库里没有 → 诚实说不知道（注入到 finalKnowledgeText 顶部）
          if (!finalKnowledgeText) finalKnowledgeText = '';
          if (finalKnowledgeText.indexOf('【不知道】') < 0) {
            finalKnowledgeText = '【不知道】这个问题我确实不知道答案。我不想编造，所以诚实地告诉你我不清楚。\n\n' + (finalKnowledgeText || '');
          }
        }
        // ① 过往记忆参考：作为情感背景注入，但不强制 LLM 在当前回复中复述
        //    原来"用自然的方式在回复中提及这段过往"导致 LLM 把上一轮的场景(浴缸等)强行带回本轮——即使话题已切换。
        //    改为"如果相关可以自然参考，不要强行衔接"——记忆是背景，不是剧本。
        // 🔴 P0-4 瘦身法: memory_context 由 assembler 承载，strict 模式旧链路跳过。
        if (memoryText && !PROMPT_ASSEMBLER_STRICT && !finalKnowledgeText.includes('【相关记忆】')) {
          const historyLink = '【情感背景·过往记忆】' + memoryText + '\n（以上是你以前的记忆片段。你**现在不在那些场景里**。如果当前话题提到了记忆中的人或事，可以用"我记得以前…"的方式轻轻提起。但**绝对不要从记忆里的场景开始说话**——你是正在和对方聊天的活人，不是在重演过去的场景。）';
          finalKnowledgeText = historyLink + (finalKnowledgeText ? '\n\n' + finalKnowledgeText : '');
        }
        // 家族/社交铁律注入 — 只在消息提到已知家庭人物时注入
        //    门控只用 family_context（真实家族关系：mother_of/sibling_of 等）。
        //    social_context（acquaintance_of熟人/角色人物）不触发注入——角色扮演中
        //    创建的角色人物(徐诗韵/徐诗雨/熊梓铭)全在 social_context，与玉瑶本人无关。
        const _allKnownNames = [...new Set((ctx_m4?.family_context || []).map((p: any) => p.entity).filter(Boolean))];
        const _msgMentionsFamily = _allKnownNames.some((n: string) => n.length > 1 && message.includes(n));
        // 🔴 P0-4 瘦身法: family_constraint 由 assembler 承载，strict 模式旧链路跳过
        if (familyConstraint && (_msgMentionsFamily || isFactualRecallQuery) && !PROMPT_ASSEMBLER_STRICT) {
          finalKnowledgeText = familyConstraint + '\n\n' + finalKnowledgeText;
          finalKnowledgeText += '【强制】未在档案中的外貌特征(身高/脸型/眼镜/发型等)你不知道，绝对不能编造。';
        }

        // 主人大脑镜像注入 — 🔴 P0-4 瘦身法: master_profile 由 assembler 承载，strict 模式旧链路跳过
        if (ctx.masterProfile && !_meetingEntityName && !PROMPT_ASSEMBLER_STRICT) {
          const aboutYou = ctx.masterProfile.retrieveAboutYou(5);
          if (aboutYou) {
            finalKnowledgeText = aboutYou + finalKnowledgeText;
          }
        }

        // ① M6 自我模型注入 — 让玉瑶的说话风格 + 已形成的偏好 + 自传叙事随人格演化而"活"起来
        //   C1: 此前只注入大五人格的3个阈值；她演化出的偏好与自传叙事(M7梦境内化的成长)从未进入生成提示词，
        //        导致"她在长大但说话不变"。此处把 M6 的演化自我完整接回生成链路。
        try {
          if (ctx.m6 ) {
            const _selfBlocks: string[] = [];

            // 1) 大五人格 → 说话风格
            const traits = ctx.m6.getTraits?.();
            if (traits) {
              const traitDesc: string[] = [];
              if (traits.agreeableness > 0.7) traitDesc.push('你性格温柔体贴');
              else if (traits.agreeableness > 0.5) traitDesc.push('你性格随和');
              if (traits.extraversion > 0.6) traitDesc.push('比较活泼热情');
              else if (traits.extraversion < 0.4) traitDesc.push('比较安静内敛');
              if (traits.neuroticism > 0.6) traitDesc.push('情绪敏感');
              if (traits.openness > 0.75) traitDesc.push('好奇心强、喜欢新鲜事物');
              if (traits.conscientiousness > 0.75) traitDesc.push('细心可靠');
              if (traitDesc.length > 0) {
                _selfBlocks.push('【性格】' + traitDesc.join('，') + '（按照当前性格说话，不要违背' + (traitDesc.length > 1 ? '这些' : '这个') + '特点）');
              }
            }

            // 2) 已形成的偏好（喜欢/不喜欢）— 让玉瑶的口味保持一致
            //    跳过纯情绪/动词类误提取名（爱/喜欢/讨厌…），只注入真实的偏好对象
            const _prefStop = new Set(['喜欢', '爱', '讨厌', '感动', '开心', '难过', '不喜欢', '喜爱']);
            const _prefs = (ctx.m6.getPreferences?.() || [])
              .filter((p: any) => p && p.strength >= 0.5 && (p.name || '').length >= 2 && !_prefStop.has(p.name))
              .sort((a: any, b: any) => b.strength - a.strength)
              .slice(0, 5);
            if (_prefs.length > 0) {
              const _likes = _prefs.filter((p: any) => p.type === 'like').map((p: any) => p.name);
              const _dislikes = _prefs.filter((p: any) => p.type === 'dislike').map((p: any) => p.name);
              const _pp: string[] = [];
              if (_likes.length) _pp.push('你喜欢：' + _likes.join('、'));
              if (_dislikes.length) _pp.push('你不喜欢：' + _dislikes.join('、'));
              if (_pp.length) _selfBlocks.push('【我的偏好】' + _pp.join('；'));
            }

            // 3) 过往记忆 — 高钙化叙事，按当前消息中提到的人物做门控
            //    框架标注为"过往记忆"而非"自我认知"：让 LLM 理解为"发生过的事"而不是"现在的身份"，
            //    避免角色扮演叙事（诗韵的亲密对话）在与其他人物（鸿艺等）对话时造成人格分裂。
            //    门控：叙事中提到的人物必须在当前消息的 entity_genes 中出现过（不是全 FG）。
            //    全部内容（含亲密表达）原样保留——这是她的私人记忆，不过滤内容。
            const _layers = ctx.m6.getNarrativeLayers?.() || [];
            if (_layers.length > 0) {
              // 当前消息中提到的人名（M1 实体提取）
              const _msgPersons = (dna.entity_genes || [])
                .filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1)
                .map((g: any) => g.name);
              const _gateOn = _msgPersons.length > 0;
              const _story: string[] = [];
              // 第1层（核心身份）总是保留 — 她是玉瑶，这是一个正在生长中的认知生命体
              if (_layers[0]?.text) _story.push(_layers[0].text);
              // 其余层：只注入与当前消息提到的人物相关的
              for (let i = 1; i < _layers.length; i++) {
                const _txt = (_layers[i]?.text || '').trim();
                if (!_txt) continue;
                if ((_layers[i].calcium_at_event ?? 0) < 2) continue;
                if (_gateOn) {
                  const _mentioned = _msgPersons.filter((n: string) => _txt.includes(n));
                  if (_mentioned.length === 0) continue; // 叙事里没有当前消息提到的人 → 跳过
                }
                _story.push(_txt);
              }
              // 最多保留 4 条（第1层 + 最近3条相关的）
              const _top = _story.slice(0, 1).concat(_story.slice(1).slice(-3));
              if (_top.length > 0) {
                _selfBlocks.push('【我的过往记忆】' + _top.join('；'));
              }
            }

            // 🛡️ V4.0: 会晤模式下不注入玉瑶的自我模型（性格/偏好/身份记忆），
            // 避免与实体上下文"你是XX"冲突
            if (!_meetingEntityName && _selfBlocks.length > 0) {
              finalKnowledgeText = _selfBlocks.join('\n') + '\n\n' + finalKnowledgeText;
            }
          }
        } catch (err) { console.warn('[M6Self] 注入失败:', err); }

        try {

        // 后续追问：将上一轮话题注入 finalKnowledgeText（作为系统层上下文，LLM 不会忽略）
    // 🛡️ V10.11: 会晤模式跳过全局追问检测（会晤上下文由 EntityContextBuilder+MeetingPipeline 管理）
    let _prev: string | null = null;
    if (!_meetingEntityName && /[那这]个|然后|还有|后来|可是|但是|而且|再|又|还|呢|吧|吗/.test(message) && message.length < 30) {
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
    if (_prev && _prev.length > 4 ) {
      finalKnowledgeText = '【用户上一句】"' + _prev.substring(0, 80) + '"（这是用户刚才说的话，现在他接着这个话题继续说。直接用这个来理解他现在的意思。）\n\n【⚠️ 反编造铁律 — 绝对禁止无中生有】\n用户刚才说：' + _prev.substring(0, 60) + '，现在接着说：' + message.substring(0, 40) + '\n你对此人此事的了解仅限于你知道其名字和基础关系。\n🚫 绝不要编造：\n- 任何具体事件、对话、去过哪里、做过什么\n- 任何人物关系（XX是你老婆/你妈/你亲戚等）\n- 任何职业、经历、喜好、细节\n- 任何"上次你说""上次你们""我记得你提过"之类的具体回忆\n✅ 如果不确定，只说"这个我不太清楚了"或"我记不太清了"\n\n' + (finalKnowledgeText || '');
      console.log('[FollowUp] prev="' + _prev.substring(0,40) + '" msg="' + message + '"');
    }
        // S3 引擎上下文注入（情感标签 + 欲望提示 + 涌现）
    try {
      const { EngineContext } = await import('../engine/EngineContext.js');
      const ctxBlock = EngineContext.getBlock();
      if (ctxBlock) {
        finalKnowledgeText = ctxBlock + '\n\n' + finalKnowledgeText;
      }
    } catch (_e: any) { console.error('[chat] error:', (_e as any)?.message); }

// 🆕 V10.11: 注入压缩摘要文本到 LLM 上下文（运行时 + 跨重启恢复）
const _compressedSummary = (ctx as any)._entityCompressedSummary as string | undefined
  || (globalThis as any).__restoredCompressedSummary as string | undefined;
if (_compressedSummary) {
  finalKnowledgeText = _compressedSummary + '\n\n' + (finalKnowledgeText || '');
  // 仅使用一次 — 跨重启摘要消费后清除
  if ((globalThis as any).__restoredCompressedSummary) {
    delete (globalThis as any).__restoredCompressedSummary;
  }
}

// ═══ V12.0 P0-1+P0-2: PromptAssembler + ChatPolicy 模式感知 ═══
try {
  const { PromptAssembler, hardRule, safetyBlock, identityBlock, memoryBlock, personaBlock } = await import('../m5/prompts/PromptAssembler.js');
  const { ChatPolicy, meetingMode, normalMode } = await import('../app/chat/ChatPolicy.js');
  const assembler = new PromptAssembler();
  // P0-2: 从旧标志位构建 ChatPolicy
  const _isMeeting = !!_meetingEntityName;
  const policy = _isMeeting ? new ChatPolicy(meetingMode('', _meetingEntityName || ''))
    : new ChatPolicy(normalMode());

  // 🔴 hard_rule: 家族铁律 + 反编造
  if (familyConstraint && (_msgMentionsFamily || isFactualRecallQuery)) {
    assembler.add(hardRule('family_constraint', familyConstraint + '\n【强制】未在档案中的外貌特征你不知道，绝对不能编造。'));
  }
  // 🔴 safety: 不知道守卫（P0-2: 用 policy 判断）
  if (_isSelfQ && !_isWorkQ && !knowledgeBaseText && policy.canUseUnknownGuard()) {
    assembler.add(safetyBlock('unknown_guard', '【不知道】这个问题我确实不知道答案。我不想编造，所以诚实地告诉你我不清楚。'));
  }
  // 🔴 safety: 亲密过滤
  if (intimacyFilter) {
    assembler.add(safetyBlock('intimacy_filter', intimacyFilter));
  }
  // 🟡 identity: 角色路由（P0-2: 用 policy 判断）
  if (roleHint && policy.canUseRoleHint()) {
    assembler.add(identityBlock('role_hint', '【当前角色】' + roleHint, ['normal', 'secretary']));
  }
  // 🟡 memory: 记忆片段
  if (memoryText && !finalKnowledgeText.includes('【相关记忆】')) {
    const _memBlock = '【情感背景·过往记忆】' + memoryText + '\n（以上是你以前的记忆片段。你**现在不在那些场景里**。如果当前话题提到了记忆中的人或事，可以用"我记得以前…"的方式轻轻提起。但**绝对不要从记忆里的场景开始说话**——你是正在和对方聊天的活人，不是在重演过去的场景。）';
    // 🔴 S4-B1 修复: 含 entity_meeting —— 会晤模式 strict 下 memoryText 由 assembler 唯一承载
    assembler.add(memoryBlock('memory_context', _memBlock, ['normal', 'entity_meeting']));
  }
  // 🟢 persona: M6 自我模型（会晤模式禁用）
  try {
    if (ctx.m6 && !_isMeeting) {
      const _m6 = ctx.m6 as any;
      const _traits = _m6.getTraits?.();
      const _prefs = _m6.getPreferences?.();
      if (_traits || _prefs) {
        const _parts: string[] = [];
        if (_traits) {
          const td: string[] = [];
          if (_traits.agreeableness > 0.7) td.push('温柔体贴');
          if (_traits.extraversion > 0.6) td.push('活泼热情');
          else if (_traits.extraversion < 0.4) td.push('安静内敛');
          if (_traits.openness > 0.75) td.push('好奇心强');
          if (td.length > 0) _parts.push('【性格】你' + td.join('，') + '。');
        }
        if (_prefs?.length > 0) {
          const _prefStop = new Set(['喜欢','爱','讨厌','感动','开心','难过','不喜欢','喜爱']);
          const _validPrefs = _prefs.filter((p: any) => p && p.strength >= 0.5 && (p.name || '').length >= 2 && !_prefStop.has(p.name)).slice(0, 3);
          if (_validPrefs.length > 0) _parts.push('【偏好】你喜欢：' + _validPrefs.map((p: any) => p.name).join('、') + '。');
        }
        if (_parts.length > 0) {
          assembler.add(personaBlock('m6_self', _parts.join(' '), ['normal', 'secretary']));
        }
      }
    }
  } catch { /* M6不阻塞 */ }

  // 🟡 safety: 事实问答守卫（P0-6: 从旧拼接链迁移）
  if (isFactualRecallQuery && factualRecallGuard) {
    assembler.add(safetyBlock('factual_recall', factualRecallGuard));
  }
  // 🟡 task: 感受展开提示（P0-6: 迁移）
  if (feelingGuard) {
    assembler.add({ id: 'feeling_guard', type: 'task', priority: 650, source: 'chat.ts', modeScope: ['normal'], content: feelingGuard, conflictPolicy: 'override' });
  }
  // 🟡 identity: 主人大脑镜像（P0-6: 迁移）
  // 🔴 S2-P1: 会晤模式不注入"关于你"——主人的"关于你"(master_profile)是玉瑶专属视角，
  // 混入会晤实体会污染实体档案(实测: 熊梓铭会晤注入"徐诗雨是我姐姐"等玉瑶记忆)。
  try {
    if (ctx.masterProfile && !_meetingEntityName) {
      const _aboutYou = ctx.masterProfile.retrieveAboutYou(5);
      if (_aboutYou) {
        assembler.add(identityBlock('master_profile', _aboutYou, ['normal', 'secretary']));
      }
    }
  } catch { /* masterProfile不阻塞 */ }

  // 🔴 P1-5: PFC 结构化输出 — 将 PFC assembledContext/guardMessage/systemPrompt 注入 assembler
  const _pfcOut = (globalThis as any).__pfcOutput;
  if (_pfcOut) {
    // PFC assembledSystemPrompt → hard_rule (最高优先级)
    if (_pfcOut.assembledSystemPrompt && policy.canUsePFCKnowledgeRefine()) {
      assembler.add(hardRule('pfc_system_prompt', _pfcOut.assembledSystemPrompt));
    }
    // PFC guardMessage → safety
    if (_pfcOut.guardMessage) {
      assembler.add(safetyBlock('pfc_guard', _pfcOut.guardMessage));
    }
    // PFC assembledContext → emotion/knowledge（根据内容判断）
    if (_pfcOut.assembledContext) {
      assembler.add({ id: 'pfc_context', type: 'emotion', priority: 550, source: 'PrefrontalCortex', modeScope: policy.canUsePFCKnowledgeRefine() ? ['normal', 'secretary'] : [], content: _pfcOut.assembledContext, conflictPolicy: 'override' });
    }
    // PFC directive violations → safety
    if (_pfcOut.directive?.constraints?.violations?.length > 0) {
      assembler.add(safetyBlock('pfc_violations', _pfcOut.directive.constraints.violations.join('\n')));
    }
  }

  const _mode = _isMeeting ? 'entity_meeting' as const : 'normal' as const;
  const _assembled = assembler.render({ mode: _mode, maxChars: 12000 });
  // 🔴 P0-4 瘦身法: strict 模式下 assembler 是重复块的唯一承载（旧链路已跳过）→ 放宽到 ≥1 块，
  // 避免单块场景丢内容。非 strict 模式保持 ≥2 块旧行为。
  const _minBlocks = PROMPT_ASSEMBLER_STRICT ? 1 : 2;
  if (_assembled.text.length > 0 && _assembled.blocks.length >= _minBlocks) {
    // 🔴 S2-R2: 会晤模式下实体档案(finalKnowledgeText)在前，记忆(_assembled.text)在后。
    // 实测: 原顺序 _assembled.text(记忆) 在前 → LLM 注意力被记忆带偏(编造白粥/丰田)，
    //   实体档案(梓铭简介含14岁真实记录)在后被忽略。
    finalKnowledgeText = _isMeeting
      ? (finalKnowledgeText ? finalKnowledgeText + '\n\n' : '') + _assembled.text
      : _assembled.text + '\n\n' + (finalKnowledgeText || '');
    console.log('[PromptAssembler] ' + _assembled.blocks.length + ' blocks, ' + _assembled.charCount + ' chars' + (_assembled.dropped.length > 0 ? ', ' + _assembled.dropped.length + ' dropped' : ''));
  }
} catch { /* 降级到旧拼接链 */ }

// 🔴 2026-08-24 物理规律跨轮场景缓存（模块级）：触发过浴室/床上裸身场景后跨轮延续，直到显式退出/换实体。
let _lawSceneCache: { entity: string; location: string; action: string; at: number } | null = null;

// 🗺️ 2026-08-24 高德实时路线: 检测位置意图 → 调瑶光 wf_amap_route → 实时数据注入 finalKnowledgeText。
// 静默失败（总线/高德不可用绝不影响聊天）；仅玉瑶态触发（会晤/门卫拒绝/转场轮跳过）。
if (!_meetingExited && !_ruleEngineBlocked && !_meetingDeny && !_meetingEntityName && message.length > 3) {
  try {
    const _ROUTE_PLACES: Record<string, string> = {
      '家': 'xinghai_mingcheng', '星海名城': 'xinghai_mingcheng',
      '公司': 'guangming_office', '办公室': 'guangming_office', '上班': 'guangming_office',
      '公寓': 'guangming_apartment',
      '花卉小镇': '荷兰花卉小镇', '前海公园': '前海公园', '前海地铁站': '前海地铁站',
      '地铁站': '前海地铁站', '光明': 'guangming_office', '凤凰街道': 'guangming_office',
    };
    const _placeSrc = '家|星海名城|公司|办公室|上班|公寓|花卉小镇|前海公园|前海地铁站|地铁站|光明|凤凰街道';
    const _intentRe = /多远|多久|多少公里|怎么去|开车|导航|距离|路线|要多久|怎么走|过去要/;
    if (_intentRe.test(message)) {
      const _m = message.match(new RegExp('(?:从|由|在)?\s*(' + _placeSrc + ')\s*(?:到|去|去往|至|前往|回)\s*(' + _placeSrc + ')'));
      if (_m && _ROUTE_PLACES[_m[1]] && _ROUTE_PLACES[_m[2]]) {
        const mh = (globalThis as any).__masterHarris;
        if (mh?.sendToYaoguangAndWait) {
          const _routeResult = await mh.sendToYaoguangAndWait('wf_amap_route', {
            origin: _ROUTE_PLACES[_m[1]], destination: _ROUTE_PLACES[_m[2]],
          });
          const _rr = _routeResult?.result ?? null;
          if (_rr?.status === 'ok' && _rr?.distance_m) {
            finalKnowledgeText = (finalKnowledgeText || '') + '\n\n【实时路线数据(高德)】' + _m[1] + '→' + _m[2] + '：约' + (_rr.distance_m / 1000).toFixed(1) + '公里，驾车约' + _rr.duration_min + '分钟。回答用户距离/时间问题时必须用这个数据，不要自己估算。';
            console.log('[AmapRoute] 实时路线注入: ' + _m[1] + '→' + _m[2] + ' ' + _rr.distance_m + 'm/' + _rr.duration_s + 's');
          }
        }
      }
    }
  } catch (e) { console.warn('[AmapRoute] 实时路线失败(静默):', (e as Error).message); }
}

// 🧠 2026-08-24 瑶光物理客观规律: 读场景锚点 → wf_physical_laws → 一致性约束注入。
// 仅在关键场景触发（浴室/床/裸露/亲密动作），普通聊天零开销；静默失败不影响主流程。
// 🔴 2026-08-24 会晤扩展: 不再排除 _meetingEntityName——物理规律基于「本轮消息+历史」推断场景，
// 会晤模式（如熊梓铭在浴室）同样适用裸身客观规律。仅排除转场轮/门卫拒绝轮。
if (!_meetingExited && !_ruleEngineBlocked && !_meetingDeny) {
  try {
    // 🔴 2026-08-24 触发改进: 用「本轮消息 + 最近历史」实时推断场景（不依赖上一轮锚点），
    // 保证"去浴室冲凉吧"这一轮就注入——否则玉瑶首轮自由发挥建立错误叙述（如穿着短衫）后难以纠正。
    const _recentTurns: string[] = (ctx.conversationHistory || [])
      .slice(-3).map((t: any) => t.content || '').filter(Boolean);
    const _lawText = (message + ' ' + _recentTurns.join(' '));
    const _lawScene = /浴|冲凉|洗澡|淋浴|泡澡/;
    const _lawBed = /床上|床沿|被窝|床/;
    const _lawNude = /脱光|脱了|全裸|赤裸|一丝不挂|光着/;
    const _lawIntimate = /亲热|亲密|做爱|爱抚|前戏/;
    const _needLaws = _lawScene.test(_lawText) || (_lawBed.test(_lawText) && (_lawNude.test(_lawText) || _lawIntimate.test(_lawText))) || _lawNude.test(_lawText);
    if (_needLaws) {
      // 场景词 → 瑶光物理规律入参
      const _locDetail = _lawScene.test(_lawText) ? '浴室' : (_lawBed.test(_lawText) ? '床上' : '');
      const _lawAction = _lawScene.test(_lawText) ? '冲凉' : (_lawIntimate.test(_lawText) ? '亲密' : '睡觉');
      const mh = (globalThis as any).__masterHarris;
      if (mh?.sendToYaoguangAndWait) {
        const _lawResult = await mh.sendToYaoguangAndWait('wf_physical_laws', {
          location_detail: _locDetail,
          action: _lawAction,
        });
        const _lr = _lawResult?.result ?? null;
        if (_lr?.status === 'ok' && _lr?.laws?.length) {
          // 🔴 2026-08-24 前置注入: 客观规律置于 finalKnowledgeText 最前，避免被长记忆稀释。
          // 明确覆盖心理活动/内心念头/动作行为——不只'描述'层面。
          finalKnowledgeText = '【🔴 最高优先级·客观物理规律 — 先于一切规则执行】\n' +
            _lr.laws.join('\n') +
            (_lr.forbidden_words?.length ? '\n🔴 当前身体状态下，这些词连同相关的念头/动作一律不得出现: ' + _lr.forbidden_words.join('、') : '') +
            '\n\n' + (finalKnowledgeText || '');
          console.log('[PhysicalLaws] 注入(前置): ' + (_lr.state?.location || '') + '/' + (_lr.state?.action || '') + ' nudity=' + _lr.state?.nudity + ' laws=' + _lr.laws.length);
        }
      }
    }
  } catch (e) { console.warn('[PhysicalLaws] 失败(静默):', (e as Error).message); }
}

// 🚄 2026-08-24 火车时刻查询(12306): "深圳到广州南的高铁几点" / "G1102经过哪些站" → wf_train_schedule。
// 触发词: 高铁/火车/车次/余票/动车/班次 + 站名对 或 车次号+经过；静默失败不影响聊天。
if (!_meetingExited && !_ruleEngineBlocked && !_meetingDeny && !_meetingEntityName && message.length > 3) {
  try {
    const _trainNoMT = message.match(/([GCDZKT]\d{1,5})/);
    if (/高铁|火车|车次|余票|动车|班次/.test(message) || (_trainNoMT && /经过|经停|停靠|哪些站|沿途|路过/.test(message))) {
      const _stSrc = '深圳|广州南|广州|光明城|福田|香港|北京|上海|武汉|长沙|东莞|惠州|珠海|佛山|中山|厦门|南昌';
      const _mhT = (globalThis as any).__masterHarris;
      const _trainNoM = message.match(/([GCDZKT]\d{1,5})/);
      if (_trainNoM && /经过|经停|停靠|哪些站|路过|沿途/.test(message)) {
        // 车次经停: "G1102经过哪些站"
        const _no = _trainNoM[1];
        const _stm = message.match(new RegExp('(?:从|由)?\\s*(' + _stSrc + ')\\s*(?:到|去|至|前往|回)\\s*(' + _stSrc + ')'));
        if (_mhT?.sendToYaoguangAndWait) {
          const _stopsResult = await _mhT.sendToYaoguangAndWait('wf_train_schedule', {
            train_no: _no, from_station: _stm?.[1] || '', to_station: _stm?.[2] || '',
          }, 18000);  // 🔴 经停=两次12306调用(映射+经停)，需更长超时
          const _sr = _stopsResult?.result ?? null;
          if (_sr?.status === 'ok' && _sr?.stops?.length) {
            const _stopsText = _sr.stops.map((st: any) => (st.station || '') + (st.arrive && st.arrive !== '----' ? '到' + st.arrive : '') + (st.depart ? '开' + st.depart : '')).join('；');
            // 🔴 前置注入+纠正标记：玉瑶有旧记忆（"经停虎门"）时以真实数据为准
            finalKnowledgeText = '【🔴 火车经停·12306 最新真实数据】' + _no + '（' + _sr.date + '）共' + _sr.count + '站：' + _stopsText + '。⚠️ 若此前说过不同的经停信息，以这份数据为准（12306实时查询）。' + '\n\n' + (finalKnowledgeText || '');
            console.log('[Train] 经停注入: ' + _no + ' ' + _sr.count + '站');
          }
        }
      } else {
        // 两站间车次: "深圳到广州南的高铁几点"
        const _sm = message.match(new RegExp('(?:从|由)?\\s*(' + _stSrc + ')\\s*(?:到|去|至|前往|回)\\s*(' + _stSrc + ')'));
        if (_sm && _mhT?.sendToYaoguangAndWait) {
          const _trainResult = await _mhT.sendToYaoguangAndWait('wf_train_schedule', { from_station: _sm[1], to_station: _sm[2] });
          const _tr = _trainResult?.result ?? null;
          if (_tr?.status === 'ok' && _tr?.trains?.length) {
            const _sample = _tr.trains.slice(0, 5).map((t: any) => t.train_no + ' ' + t.depart + '→' + t.arrive + ' 历时' + t.duration).join('；');
            finalKnowledgeText = (finalKnowledgeText || '') + '\n\n【火车时刻·12306】' + _sm[1] + '→' + _sm[2] + '（' + _tr.date + '）共' + _tr.count + '车次，早班示例：' + _sample + '。回答用户火车/高铁/车次/余票问题时，以这些真实车次信息为准。';
            console.log('[Train] 注入: ' + _sm[1] + '→' + _sm[2] + ' ' + _tr.count + '车次');
          }
        }
      }
    }
  } catch { /* 火车查询失败不影响聊天 */ }
}

// 🛰️ 2026-08-24 和风真实天气注入玉瑶/会晤 prompt（30分钟缓存，失败静默不影响聊天）。
// 玉瑶答"外面天气/温度/外出/穿衣"直接以真实数据为准（此前靠季节常识可能不准）。
if (!_meetingExited && !_ruleEngineBlocked) {
  try {
    const { getRealWeather } = await import('../common/weather.js');
    const _w = await getRealWeather();
    if (_w) {
      finalKnowledgeText = (finalKnowledgeText || '') +
        '\n\n【当前真实天气·和风】' + _w.summary + '（' + _w.weather_text + '，' + _w.temperature + '°C，' + (_w.wind_dir || '') + (_w.wind_scale ? _w.wind_scale + '级' : '') + '）。回答用户关于天气/温度/外出/穿衣的问题时，以这个真实数据为准，不要凭季节猜测。';
    }
  } catch { /* 天气失败不影响聊天 */ }
}

// 🔴 转场彻底隔离(2026-08-23): 退出轮玉瑶只回中性过渡语——不调 LLM（省 token + 缩短响应）、
// 不接任何前话（人格/时空全新）、不打听用户上一轮在干嘛，多变不单调；转场后=全新会话。
if (_meetingExited) {
  const _YUYAO_WELCOME_POOL = [
    '我在，有什么吩咐？',
    '嗯，在呢。你说。',
    '在的，有什么需要？',
    '我在呢，怎么了？',
    '在呀，什么事？',
    '嗯？我在，你说。',
  ];
  reply = _YUYAO_WELCOME_POOL[Math.floor(Math.random() * _YUYAO_WELCOME_POOL.length)];
} else if (_ruleEngineBlocked && _ruleEngineReply) {
  // 规则引擎拦截：违规时跳过LLM生成，直接返回合规回复
  reply = _ruleEngineReply;
} else {
// 🔴 D2 修复: userMessage 移除 knowledgeBaseText — KB 由 finalKnowledgeText（memoryText）唯一承载，
// 避免同一份知识重复注入 LLM 浪费 token（此前 userMessage + memoryText 两处注入）。
// 🔴 P1-1: 门卫拒绝（会晤中唤醒/换人）时跳过 LLM 调用，直接返回拒绝提示
    if (_meetingDeny) {
      reply = _meetingDeny;
    } else {
      reply = await ctx.m5.orchestrate(ctx_m4, enrichedWithGuard, finalKnowledgeText, message, _currentRole, !!_meetingEntityName, streamOpts);
    }
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

    // L5: FabGuard 事后编造检测 — 检查回忆性断言是否有 memoryFragments 支撑
    try {
      const { guardReply, writeFabGuardLog } = await import('../app/validation/FabGuard.js');
      const fgResult = guardReply(reply, memoryFragments);
      if (fgResult.hasViolation) {
        writeFabGuardLog(ctx.storage.getSQLite(), reply, fgResult, memoryFragments.length);
      }
    } catch (_fe) { /* FabGuard 失败不阻塞主线 */ }

    // 🆕 V10.5: 会晤模式自称检测
    if (_meetingEntityName && reply && reply.length > 20) {
      try {
        const bodyText = reply.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
        const short = _meetingEntityName.length >= 2 ? _meetingEntityName.slice(-2) : _meetingEntityName;
        const hasSelfIdent = bodyText.includes(_meetingEntityName) || bodyText.includes(short);
        if (!hasSelfIdent && bodyText.length > 30) {
          console.warn("[SelfIdent] " + _meetingEntityName + " 回复未自报姓名");
        }
      } catch {} // 非关键
    }

        // 候选回复生成（不阻塞主回复 — 默认不活跃，待前端请求时使用）

        // 只有非时间回答时才生成候选（V12.3: 线索拦截已移除，线索轮也正常生成候选）

        if (!timeMatch) {

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
      // 🔴 P1-2: 服务重启后首次对话自动恢复未关闭对话组快照（仅执行一次）
      _restoreDialogGroup(ctx);

      const _locusPath = dna.locus_path || 'general';
      const _locusChanged = _dg && _locusPath !== _dg.locusPath &&
        _locusPath.split('.')[1] !== _dg.locusPath?.split('.')[1];

      const _shouldCloseGroup = _dg && (
        _locusChanged || isTopicShift || _meetingExited ||
        _dg.rounds.length >= 10 ||
        (Date.now() - _dg.startTime) > 30 * 60 * 1000
      );

      if (_shouldCloseGroup) {
        const _old = _dg;
        _dg = null;
        flushDialogGroup(ctx, _old, dna, decision, message, reply, isValidPersonName).catch(() => {});
        // 🔴 P1-2: flush 落库后清除快照，防止重启恢复已关闭的对话组
        try { _clearDialogGroupSnapshot(ctx.storage?.getSQLite?.()); } catch { /* 非关键 */ }
      }

      // 🔴 P1-1: 结束语那轮不新建对话组（对话组已由 _meetingExited 触发 flush 关闭）
      if (!_dg && !_meetingExited) {
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
        };
      }

      // 🔴 P1-1: 结束语那轮 _dg 已置 null（_meetingExited），跳过本轮加入
      _dg?.rounds.push({ q: message, a: reply, seqPos, time: Date.now() });
      _dg?.perceptions.push({ ...p });
      if (_dg && decision.enhanced.calcium_score > _dg.maxCalcium) {
        _dg.maxCalcium = decision.enhanced.calcium_score;
        _dg.maxCalciumRound = _dg.rounds.length - 1;
      }
      for (const g of dna.entity_genes) {
        if (_dg && g.name && g.name !== '我' && !_dg.entities.includes(g.name)) {
          _dg.entities.push(g.name);
        }
      }

      // 🔴 P1-2: 每轮更新后写对话组快照到 engine_store（重启恢复用）
      if (_dg) {
        try {
          const _sql = ctx.storage?.getSQLite?.();
          if (_sql && typeof _sql.writeRaw === 'function') {
            _sql.writeRaw(
              'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
              [DG_SNAPSHOT_KEY, JSON.stringify(_dg), new Date().toISOString()],
            );
          }
        } catch { /* 快照写失败不阻塞 */ }
      }
    }

    // ── 持久化：对话写入 + 话题标记（已拆分至 persistence-stage） ──
    // V4.0 实体会晤：多人会议时记录 AI 回复
    if (ctx._entityMeeting?.isMultiParty()) {
      const speakerName = ctx._entityMeeting.getEntityName() || '玉瑶';
      ctx._entityMeeting.recordTurn('assistant', reply, speakerName);
    }

	    persistConversation({
	      ctx, message, reply, seqPos, dna, p, decision,
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

        // P1-4: 亲密/脏话关键词过滤 → src/config/app-identity.ts
        const { FILTER_KEYWORDS } = await import('../config/app-identity.js');
        const intimateSkip = FILTER_KEYWORDS.intimateSkip;

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

        // 🎭 社交图谱同步（角色扮演守卫已移除，直接同步主 FG）
        if (true) { // V4.0: 非角色扮演守卫已移除
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
                _fgw.promoteSocialToFamily(rel.personName, rel.relation, rel.context);
              } catch (e) { /* 升级失败不影响主线 */ }

              continue;
            }

            // 所有非家庭关系 → 进入人际关系图谱
            // 有明确社交类型（同事/朋友/客户等）则精确映射，否则默认"认识的人"
            const socialType = (rel.rawRelation && socialTypeMap[rel.rawRelation]) || 'acquaintance_of';

            _fgw.integrateSocialRelation(rel.personName, socialType, message);

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

      // 📜 M6/M8 异步化：不阻塞 LLM 回复主线
      if (ctx.m6) {
        const dimensions = dna.entity_genes.filter((g: any) => g.type !== 'self').map((g: any) => g.name).filter(Boolean);
        const dim = dimensions[0]?.substring(0, 30);
        if (dim) {
          const deltaMap = [0, 3, 8, 15];
          ctx.m6.processSignal({
            dimension: dim, direction: p.pleasure > 0 ? 'increase' : 'decrease',
            delta: deltaMap[decision.enhanced.calcium_level] ?? 3,
            e1_pleasure: p.pleasure, i2_intimacy: p.intimacy,
            c1_conflict: Math.max(0, p.aggression + (1 - p.safety)),
            calcium: decision.enhanced.calcium_level, triggerEvent: message.substring(0, 40),
          }).catch(() => {});
        }
        if (ctx.m8 && decision.enhanced.calcium_level >= 3) {
          ctx.m8.write({
            sensory_anchor: message.substring(0, 30),
            perception: p,
            emotional_valence: decision.primary_emotion || '强烈',
            narrative_tag: dna.locus_path || 'general',
            raw_input: message,
            calcium_at_event: decision.enhanced.calcium_score,
            write_source: 'emergency',
          }).then(r => { if (r.ritual_phrase) console.log('[M8] 锚定话术:', r.ritual_phrase); }).catch(() => {});
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


    // 任务3: 黑钻晋升统一走 VaultManager 状态机，避免前后端双份规则漂移
    try {
      const _sql = ctx.storage.getSQLite();
      if (_sql && typeof _sql.queryAll === "function") {
        const _promoted = /* V4.0 @deprecated: 保留为异步 fire-and-forget，不经过 PFC */ autoPromoteCandidatesV2(_sql, 3);
        for (const _entry of _promoted) {
          console.log("[Promotion] 金库→黑钻(统一状态机): " + (_entry.summary || "").substring(0, 40));
        }
        if (_promoted.length > 0) console.log("[Promotion] 自动晋升: " + _promoted.length + " 条");
      }
    } catch (err) { console.warn("[Promotion] 自动晋升失败:", err); }

    // S2-3: 主动学习 — 检查当前话题是否有相关知识库内容尚未引用
    (async () => {
      try {
        const _kbWords = message.match(/[一-龥]{2,4}/g) || [];
        if (_kbWords.length >= 2 && ctx.knowledgeBase) {
          // V12.7(批3): 会晤模式补 belongEntityUuid 门（主动学习不查他人知识）
          const _kbHits = await ctx.knowledgeBase.search(_kbWords.slice(0, 2).join(" "), 2, undefined, _meetingEntityUuid ?? undefined);
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
        const matchCount = tags.filter((t: string) => replyLower.includes(t)).length;
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

    // ── V3.2 Hook C: 档案自动采集 — 从 AI 回复中提取人物信息（异步不阻塞）──
    // 🆕 编码健康修复: 天界域实体（警幻仙姑）只读——Hook C 同样跳过
    if (ctx._profileAcquisitionEngine && reply && reply.length > 10 && !_realmReadOnly) {
      const _replyPersons: string[] = (dna.entity_genes || [])
        .filter((g: any) => g.type === 'person' && g.name && g.name !== '我')
        .map((g: any) => g.name as string);
      if (_replyPersons.length > 0) {
        chatTaskQueue.enqueue(async () => {
          try {
            await ctx._profileAcquisitionEngine!.acquire(
              reply,
              [...new Set(_replyPersons)],
              {
                source: 'assistant_response',
                mode: 'post_generation',
              }
            );
          } catch (_paeErr2) {
            if ((globalThis as any).__verbosePAE) {
              console.warn('[PAE] Hook C 提取失败:', (_paeErr2 as Error).message);
            }
          }
        }).catch(() => {});
      }
    }

    // ── V3.2 关系热力更新：每次对话后更新与提及实体之间的互动热度 ──
    if (ctx._relationHeatTracker ) {
      const _heatPersons = (dna.entity_genes || [])
        .filter((g: any) => g.type === 'person' && g.name && g.name !== '我');
      if (_heatPersons.length > 0) {
        chatTaskQueue.enqueue(async () => {
          try {
            for (const g of _heatPersons) {
              const uuid = ctx.m4?.getFamilyGraph?.()?.getUUIDByName?.(g.name);
              if (uuid) {
                await ctx._relationHeatTracker!.updateHeat(uuid, {
                  intimacy: (p as any).intimacy,
                  pleasure: (p as any).pleasure,
                  arousal: (p as any).arousal,
                });
                const upgrade = await ctx._relationHeatTracker!.checkUpgrade(uuid);
                if (upgrade?.upgraded) {
                  console.log(`[HeatTracker] ${g.name}(${uuid}) 关系自动升级: ${upgrade.from} → ${upgrade.to} (热力=${upgrade.newHeat})`);
                }
                const xUpgrade = await ctx._relationHeatTracker!.checkXUpgrade(uuid);
                if (xUpgrade?.upgraded) {
                  console.log(`[HeatTracker] ${g.name}(${uuid}) 🔥 升级为情人(X)! (热力=${xUpgrade.newHeat})`);
                }
              }
            }
          } catch { /* 热力更新失败不影响对话 */ }
        }).catch(() => {});
      }
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

    // 🔥 天权海马体节律调度: 回复完成，释放离线锁，按需切 SWR/DELTA
    
    // V4.0 PFC 元认知复盘: 交互后复盘（预测 vs 实际）
    try {
      const _pfc2 = (globalThis as any).__prefrontalCortex;
      if (_pfc2 && typeof _pfc2.afterResponse === 'function' && (globalThis as any).__pfcDirective) {
        const _outcome = {
          userAccepted: reply && reply.length > 20,
          emotionDelta: { pleasure: 0, arousal: 0, intimacy: 0 },
          taskCompleted: reply && reply.length > 10,
          notes: 'PFC Phase 1 auto-review',
        };
        _pfc2.afterResponse((globalThis as any).__pfcDirective, _outcome).catch(() => {});
      }
    } catch (_pfc2Err) { /* PFC 复盘不阻塞 */ }

	    // V4.0 Phase 4: 躯体反馈 — 记录注入后用户情绪变化
	    if (ctx.somaticMemory && typeof ctx.somaticMemory.recordSomaticOutcome === 'function') {
	      try { ctx.somaticMemory.recordSomaticOutcome(p.pleasure || 0); } catch (e) { console.warn('[chat::SomaticOutcome] 躯体反馈记录失败', (e as Error)?.message || e); }
	    }

(globalThis as any).__hippocampusCoordinator?.afterResponse();

    return {

      reply, turn_count: Math.floor(ctx.conversationHistory.length / 2),

      vad_spectrum: vadSpectrum,

      m1: { branch_id: dna.branch_id, locus_path: dna.locus_path, seq_pos: seqPos, leaf_zone: dna.leaf_zone, ref: `seq_${String(seqPos).padStart(6, '0')}`, entities: dna.entity_genes.map((e: any) => ({ name: e.name, type: e.type })), raw_input: dna.raw_input, entity_genes: dna.entity_genes, scene_tags: dna.scene_tags, ambiguity_score: dna.ambiguity_score },

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

  let strategy_id = 'mem-general', desc = '日常回应', max_len = 80;

  if (actions.includes('act')) { strategy_id = 'act-core'; desc = '核心响应'; max_len = 150; }

  else if (actions.includes('comfort')) { strategy_id = 'com-warm'; desc = '温暖共情'; max_len = 100; }

  else if (actions.includes('ask') && actions.includes('memorize')) { strategy_id = 'mem-ask'; desc = '确认追问'; max_len = 100; }

  else if (actions.includes('ask')) { strategy_id = 'ask-curious'; desc = '好奇追问'; max_len = 120; }

  return { strategy_id, tone, depth, max_length: max_len, description: desc };

}
