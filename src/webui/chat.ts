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
import { getTopicRepeatCount, isValidPersonName, isSelfNameQuestion, collectFactSnapshot, buildDirectFactReply, buildFactStatementAck, collectFactLookupTerms, isNonEmptyString, isDirectedEmotion, FALLBACK_REPLIES, LEVEL_NAMES, PERC_LABELS } from './chat-utils.js';
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


// S3-2: 从 guard-builder 导入角色路由和守卫
import { flushDialogGroup, persistConversation, runRetrieval } from './chat/index.js';



// P0-1: 角色路由模块级状态（函数外，跨轮次持久化）
let _currentRole: RoleType = 'secretary';  // 默认秘书——日常对话从专业模式开始，情感上升后自动切换
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

export async function processChat(message: string, ctx: ChatContext): Promise<ChatResponse> {

  try {
    // 🔥 天权海马体节律调度: 进入 θ 节律（活跃对话），暂停离线巩固
    (globalThis as any).__hippocampusCoordinator?.onUserMessage();

    // ChatEntry — entry guard pipeline (extracted)
    const entryResult = await runChatEntry(message, ctx, { _currentRole });
    const dna = entryResult.dna;
    let _ruleEngineBlocked = entryResult.ruleEngineBlocked;
    let _ruleEngineReply = entryResult.ruleEngineReply;
    const _weatherContext = entryResult.weatherContext || '';

    // 🔋 Token节省模式 — 时间/天气/生理按需一枪式触发
    _lazyTemporalFire(message, ctx);

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
                // 📜 写操作用真实FG（绕过角色扮演分支），读操作用_fgX保留角色视角
                const _realFg = ctx.m4?.getFamilyGraph?.() || _fgX;
                _realFg.updatePersonProfile(_n, _updates as any, { countMention: false });
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
                          try { ctx.m4?.getFamilyGraph()?.addFeatureEdge(_n, _featName, 'appearance').catch((e: any) => console.warn('[FG] addFeatureEdge失败:', e?.message)); } catch (e) { console.warn('[FG] addFeatureEdge调用异常:', (e as any)?.message); }
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
              const _realFg = ctx.m4?.getFamilyGraph?.() || graph;
              _realFg.updatePersonProfile(p.name, updates as any, { countMention: false });
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
    // 过滤历史：排除角色扮演期间的对话（按 persistence-stage 写入时的 rpChar 标记过滤）
    let enrichedHistory: Array<ConversationTurn & { topic?: string; rpChar?: string }>;
    enrichedHistory = ctx.conversationHistory.slice(-40).filter(function(t: any) { return !t.rpChar; });
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

    // 🎭 角色扮演记忆隔离：检索层 (MemoryRetriever.retrieveMemories) 已按 memory_kind/memory_type
    //    在合并结果时排除角色扮演记忆。此处不再重复过滤。

    // 知识库检索（由 MemoryGate 管控）



    let knowledgeBaseText = "";
    let biosGatedMemories = emotionalMemories;
    let clueReply: string | null = null;

    // ── V4.0 门阀白名单: 根据当前会话对象设定检索权限（三层白名单·始终激活）──
    if (ctx._gatekeeper) {
      try {
          // V4.0: 会话层 = 消息中提到的所有 FG 人物（支持多人会晤）
          const personUUIDs: string[] = [];
          for (const gene of (dna.entity_genes || [])) {
            if (gene.type === 'person' && gene.name && gene.name !== '我') {
              const uuid = ctx.m4.getFamilyGraph()?.getUUIDByName?.(gene.name);
              if (uuid) personUUIDs.push(uuid);
            }
          }
          if (personUUIDs.length > 0) {
            ctx._gatekeeper.setSessionEntities(personUUIDs);
          }
          // 无人提及 → 不改变会话层（保持基础层过滤）
        // 同步设置 M4Orchestrator 的门阀（记忆检索过滤用）
        ctx.m4.setGatekeeper?.(ctx._gatekeeper);
      } catch (_gErr) { /* 门阀设置失败不影响对话 */ }
    }

    // V4.0 实体会晤：多人会议时记录用户发言
    if (ctx._entityMeeting?.isMultiParty()) {
      ctx._entityMeeting.recordTurn('user', message, '我');
    }

    // V4.0 会议退出检测
    if (ctx._entityMeeting?.isActive() && /^(?:散会|结束.*会议|会议.*结束|不开了|今天就到这儿|今天就到这里|先这样|下了|拜拜|再见).*$/.test(message.trim())) {
      const exitResult = await ctx._entityMeeting.exit();
      if (exitResult?.minutes) {
        console.log('[EntityMeeting] 多人会议结束，纪要已自动归档');
      }
    }

    // ── V4.0 实体会晤意图检测 + 激活 ──
    if (ctx._entityMeeting && !ctx._entityMeeting.isActive()) {
      const fg = ctx.m4?.getFamilyGraph?.();
      const allNames: string[] = fg?.getAllPersonNames?.() || [];
      // 先尝试标准检测
      let intentNames = EntityMeeting.detectUserIntent(message, allNames);
      // Fallback: 直接用简单匹配检测 "跟X聊聊"/"和X聊聊"/"找X" 模式
      if (!intentNames) {
        const simpleMatch = message.match(/[跟和找叫喊]\s*([一-龥]{2,4})\s*(聊聊|聊一下|说说话|来一下|过来|出来)/);
        if (simpleMatch) {
          const candidateName = simpleMatch[1];
          if (allNames.includes(candidateName)) {
            intentNames = [candidateName];
          }
        }
      }
      if (intentNames && intentNames.length > 0) {
        if (intentNames.length >= 3) {
          ctx._entityMeeting.enterMulti(intentNames);
          console.log('[EntityMeeting] 多人会晤启动: ' + intentNames.join(', '));
        } else {
          ctx._entityMeeting.enter(intentNames[0]);
          console.log('[EntityMeeting] 单人会晤启动: ' + intentNames[0]);
        }
      }
    }

    // ── V4.0 实体会晤：注入实体人物上下文 ──
    let _entityContextText = '';
    if (ctx._entityMeeting?.isActive()) {
      try {
        const entityName = ctx._entityMeeting.getEntityName();
        if (entityName) {
          const { buildEntityContext } = await import('../m4/household/EntityContextBuilder.js');
          const ecResult = buildEntityContext(ctx.m4.getFamilyGraph?.(), { entityName });
          _entityContextText = ecResult.systemText;
        }
      } catch (e) { /* 实体上下文构建失败不阻塞 */ }
    }

    // V4.0 Phase 7: 知识库检索管线 → KnowledgeContextBuilder
    const _preM4 = await buildPreM4Context({
      message, dna, p, decision,
      ctx: {
        knowledgeBase: ctx.knowledgeBase, storage: ctx.storage,
        yuyaoMemory: ctx.yuyaoMemory, hybridSearch: ctx.hybridSearch,
        clueAssistant: ctx.clueAssistant, m8: ctx.m8, conversationDB: ctx.conversationDB,
        _gatekeeper: ctx._gatekeeper,  // V3.2: 门阀传入知识检索
      },
      knowledgeBaseText, memoryFragments, emotionalMemories,
      _bionicPromise,
    });
    memoryFragments.length = 0; memoryFragments.push(..._preM4.memoryFragments);
    knowledgeBaseText = _preM4.knowledgeBaseText;
    biosGatedMemories = _preM4.biosGatedMemories;
    clueReply = _preM4.clueReply;

    const ctx_m4 = await ctx.m4.orchestrate(decision, biosGatedMemories);

    // FIX-1: M4 完成后写入尚未建立家庭关系的 person 实体（角色扮演时跳过，避免污染主FG）
    if (true) { // V4.0: 非角色扮演守卫已移除
      try {
        const _pg = dna.entity_genes.filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1 && isValidPersonName(g.name));
        if (_pg.length > 0 && ctx.m4) {
          const _fg = ctx.m4.getFamilyGraph();
          for (const _p of _pg) {
            const _profile = _fg.getPersonProfile(_p.name);
            if (_profile && !_profile.relation_to_user) {
              _fg.integrateSocialRelation(_p.name, 'acquaintance_of', message).catch(function(e: any) { console.warn('[chat] FG关系写入失败:', e?.message); });
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

    // ── V3.2 Hook B: 档案自动采集 — LLM 提取用户消息中的人物档案信息 ──
    let _acquisitionReport: any = null;
    if (ctx._profileAcquisitionEngine ) {
      try {
        const _mentionedPersons: string[] = (dna.entity_genes || [])
          .filter((g: any) => g.type === 'person' && g.name && g.name !== '我')
          .map((g: any) => g.name as string);
        const _uniquePersons: string[] = [...new Set(_mentionedPersons)];
        if (_uniquePersons.length > 0) {
          _acquisitionReport = await ctx._profileAcquisitionEngine.acquire(
            message,
            _uniquePersons,
            {
              fgContext: ctx_m4?.family_context || [],
              mode: 'pre_generation',
              source: 'user_message',
            }
          );
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

    const asksSelfName = isSelfNameQuestion(message);
    const asksFactIntent =
      /还记得|记得|叫什么|叫啥|名字|是谁|哪儿|在哪|哪里|住哪|做什么|干什么|什么工作|做哪行|职业|关系|几岁|年龄|长什么样/.test(message);
    const hasQuestionTone =
      /[？?]/.test(message) ||
      /(?:吗|呢|么|嘛)$/.test(message.trim()) ||
      asksSelfName ||
      asksFactIntent;
    const isFactualRecallQuery =
      hasQuestionTone &&
      (
        asksSelfName ||
        hasPersonEntity ||
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

    // 仅当存在人物档案数据时才注入外貌规则，日常聊天空时不注入
    const _hasPeopleData = ((ctx_m4?.family_context?.length ?? 0) > 0 || (ctx_m4?.social_context?.length ?? 0) > 0);
    const _appearanceGuard = _hasPeopleData
      ? '【强制规则·人物外貌】如果有人问你"长什么样""什么样子"，你只能回答上面【人物档案】中写明的外貌和身体特征。没写的细节你一概不知道，直接说不知道。绝对禁止编造。'
      : '';
    const allGuardMsgs = [hallucinationGuard, repeatHint, factualRecallGuard, feelingGuard, dailyGuard, timeGuard, classificationGuard, intimacyFilter, _appearanceGuard].filter(Boolean).join('\n');

    let reply = '';

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
        const factStatementAck = buildFactStatementAck(message, collectFactSnapshot([message]));
        if (factStatementAck) {
          reply = factStatementAck;
        }
      }

      if (!reply && isFactualRecallQuery) {
        const factTexts = new Set<string>();
        for (const turn of ctx.conversationHistory.filter((t: any) => t.role === 'user' && !t.rpChar)) {
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
                "SELECT content FROM conversations WHERE role = 'user' AND content LIKE ? AND (roleplay_char IS NULL OR roleplay_char = '') ORDER BY timestamp DESC LIMIT 8",
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


let memoryText = memoryFragments.length > 0 ? memoryFragments.slice(0, 8).join('\n') : '';
// 剥离场景描写：raw_input 里存着 LLM 自己生成的"（我趴在浴缸边…）"等动作描写，
// 原样注入回去会让 LLM 读到自己的场景文本并自动进入那个场景——形成循环引用。
// 场景是生成的产物，不是记忆的内容。只保留语义/对话内容，不留场景。
memoryText = memoryText.replace(/（[^）]*）/g, '');// V4.0 实体会晤：注入实体上下文（优先于 knowledgeBaseText）
let finalKnowledgeText = _entityContextText ? (_entityContextText + '\n\n' + knowledgeBaseText) : knowledgeBaseText;
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
            spatial: { sceneLabel: '对话中' },
            entities: { persons: _entities.map((e: any) => e.name), topics: [], objects: [] },
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
            }, decision);
          } else {
            // 降级: 旧 process() 路径（PFC 不支持 processEnhanced 时）
            _pfcResult = await _pfc.process({ snapshot: _snap, sessionId: String(seqPos) || '', rawInput: message }, decision);
          }
          (globalThis as any).__pfcDirective = _pfcResult?.directive || null;

          // 使用 PFC 统一输出
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

if (isFactualRecallQuery) {
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
	const roleHint = _roleInstruction[_currentRole];
	if (roleHint ) {
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
        // ① 过往记忆参考：作为情感背景注入，但不强制 LLM 在当前回复中复述
        //    原来"用自然的方式在回复中提及这段过往"导致 LLM 把上一轮的场景(浴缸等)强行带回本轮——即使话题已切换。
        //    改为"如果相关可以自然参考，不要强行衔接"——记忆是背景，不是剧本。
        if (memoryText  && !finalKnowledgeText.includes('【相关记忆】')) {
          const historyLink = '【情感背景·过往记忆】' + memoryText + '\n（以上是你以前的记忆片段。你**现在不在那些场景里**。如果当前话题提到了记忆中的人或事，可以用"我记得以前…"的方式轻轻提起。但**绝对不要从记忆里的场景开始说话**——你是正在和对方聊天的活人，不是在重演过去的场景。）';
          finalKnowledgeText = historyLink + (finalKnowledgeText ? '\n\n' + finalKnowledgeText : '');
        }
        // 家族/社交铁律注入 — 只在消息提到已知家庭人物时注入
        //    门控只用 family_context（真实家族关系：mother_of/sibling_of 等）。
        //    social_context（acquaintance_of熟人/角色人物）不触发注入——角色扮演中
        //    创建的角色人物(徐诗韵/徐诗雨/熊梓铭)全在 social_context，与玉瑶本人无关。
        const _allKnownNames = [...new Set((ctx_m4?.family_context || []).map((p: any) => p.entity).filter(Boolean))];
        const _msgMentionsFamily = _allKnownNames.some((n: string) => n.length > 1 && message.includes(n));
        if (familyConstraint  && (_msgMentionsFamily || isFactualRecallQuery)) {
          finalKnowledgeText = familyConstraint + '\n\n' + finalKnowledgeText;
          finalKnowledgeText += '【强制】未在档案中的外貌特征(身高/脸型/眼镜/发型等)你不知道，绝对不能编造。';
        }

        // 主人大脑镜像注入
        if (ctx.masterProfile ) {
          const aboutYou = ctx.masterProfile.retrieveAboutYou(5);
          if (aboutYou) {
            finalKnowledgeText = aboutYou + finalKnowledgeText;
          }
        }

        // ① M6 自我模型注入 — 让玉瑶的说话风格 + 已形成的偏好 + 自传叙事随人格演化而"活"起来（角色扮演时跳过）
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

            if (_selfBlocks.length > 0) {
              finalKnowledgeText = _selfBlocks.join('\n') + '\n\n' + finalKnowledgeText;
            }
          }
        } catch (err) { console.warn('[M6Self] 注入失败:', err); }

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

// 规则引擎拦截：违规时跳过LLM生成，直接返回合规回复
if (_ruleEngineBlocked && _ruleEngineReply) {
  reply = _ruleEngineReply;
} else {
reply = await ctx.m5.orchestrate(ctx_m4, enrichedWithGuard, finalKnowledgeText, knowledgeBaseText ? (knowledgeBaseText.split('\n').filter(l => l.trim()).join('\n') + '\n\n' + message) : message, _currentRole);
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
        flushDialogGroup(ctx, _old, dna, decision, message, reply, isValidPersonName).catch(() => {});
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
    if (ctx._profileAcquisitionEngine && reply && reply.length > 10) {
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
