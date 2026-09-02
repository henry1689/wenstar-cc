/**
 * retrieval-stage — 记忆检索（从 chat.ts 拆分）
 *
 * 职责：话题切换检测、情感记忆检索、黑钻检索
 * 包含：isTopicShift判断、多跳检索、黑钻FTS5+向量补充
 * 输出：emotionalMemories、memoryFragment推送、上下文标志位
 */
import type { ScoredMemory, SimilarityMode } from '../../m2/types/index.js';
import type { DNA } from '../../m1/types/dna.js';
import type { Perception24D } from '../../m3/types/perception.js';
import { rerank } from '../../m4/Reranker.js';
import { decompose, mergeDecomposedResults } from '../../m4/QueryDecomposer.js';
import { resolveReferent } from '../../app/works/ReferentResolver.js';
import { WorkRepository } from '../../app/works/WorkRepository.js';
import { passes as policePasses } from '../../governance/police/UUIDPoliceFilter.js';

export interface RetrievalIntent {
  isTopicShift: boolean;
  isFollowUp: boolean;
  hasContinuationMarkers: boolean;
  isCasualChat: boolean;
  isLimitedRetrieval: boolean;
  hasNewEntity: boolean;
  hasPersonEntity: boolean;
}

export interface RetrievalInput {
  ctx: any;
  message: string;
  /** 🆕 V5.1: 会晤实体名 — 非空时跳过所有记忆检索 */
  _meetingEntityName?: string | null;
  dna: DNA;
  p: Perception24D;
  /** V3: M3 直接产出的 40D 感知向量 — 透传给 searchV13 作为 40D 查询向量 */
  p40?: import('../../m3/types/perception-40d.js').PerceptionV40;
  enrichedHistory: Array<{ content: string }>;
  memoryFragments: string[];
  /** 独立网络检索可在意图确定后立即启动，但不得在回调中修改共享上下文。 */
  onIntentReady?: (intent: RetrievalIntent) => void;
}

export interface RetrievalOutput extends RetrievalIntent {
  emotionalMemories: ScoredMemory[];
  memoryGate: import('../../app/conversation/MemoryGate.js').MemoryGateOutput;
  memoryGateFillerUsed: boolean;
}

type FoundationRouteOptions = import('../../m4/retrieval/orchestrate.js').FoundationRouteOptions;
type FoundationRouteResult = import('../../m4/retrieval/orchestrate.js').FoundationRouteResult;

/**
 * 提前启动与主记忆链互不依赖的 Foundation 多源路由。
 * 只返回独立结果，不在异步任务内修改 memoryFragments；调用方在原注入点合并，
 * 因此并发完成顺序不会改变最终上下文顺序。
 */
export function startFoundationRouteTask(
  ctx: any,
  message: string,
  options: FoundationRouteOptions,
): Promise<FoundationRouteResult | null> {
  if (!ctx.storage?.getSQLite?.() || !ctx.knowledgeBase) return Promise.resolve(null);
  return import('../../m4/retrieval/orchestrate.js')
    .then(({ runFoundationRoutes }) => runFoundationRoutes(ctx, message, options))
    .catch(error => {
      console.warn('[FoundationRoutes] 并发路由失败，降级为空结果:', (error as Error)?.message);
      return null;
    });
}

export async function runRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { ctx, message, dna, p, enrichedHistory, memoryFragments, _meetingEntityName } = input;

  // 🔴 V22 作品召回: 指称词解析（"那篇小说/继续写/标题"）→ 作品主键 → 注入完整作品全文
  // 放在会晤隔离墙之前：户主钥匙和会晤场景都能解析（会晤场景在隔离墙内提前 return）
  if (ctx?.storage?.getSQLite && message.trim().length >= 2) {
    try {
      const _sqlite = ctx.storage.getSQLite();
      if (_sqlite && typeof _sqlite.queryAll === 'function') {
        const _workRepo = new WorkRepository(_sqlite);
        // 解析当前作用域 UUID：会晤实体优先，否则户主活跃实体（供 ReferentResolver 按实体隔离）
        let _scopeUuids: string[] = [];
        try {
          const _fg = ctx.m4?.getFamilyGraph?.();
          if (_meetingEntityName) {
            const _uuid = _fg?.getUUIDByName?.(_meetingEntityName);
            if (_uuid) _scopeUuids = [_uuid];
          } else {
            const _personNames = (dna.entity_genes || [])
              .filter((g: any) => g.type === 'person' && g.name !== '我')
              .map((g: any) => g.name);
            for (const _pn of _personNames.slice(0, 3)) {
              const _uuid = _fg?.getUUIDByName?.(_pn);
              if (_uuid) _scopeUuids.push(_uuid);
            }
          }
        } catch { /* 作用域解析失败 → 空 = 户主钥匙 master 作用域 */ }

        const _ref = resolveReferent(message, _workRepo, _scopeUuids);
        if (_ref.matched && _ref.work) {
          const _wk = _ref.work;
          // 🔴 P2-E 户籍鉴权: 作品归属 UUID 按户主钥匙/会晤场景严格校验（deny-by-default）
          //  - 会晤场景: allowUnowned=false，作品必须属于当前会晤实体
          //  - 户主场景: allowUnowned=true，无归属作品（belong NULL）放行，白名单实体作品放行
          const _isMeeting = !!_meetingEntityName;
          // S5-评审: 户主钥匙场景放行所有归属作品（户主为全库最高权限，名下实体作品皆可见）
          // 会晤场景严格按实体隔离（deny-by-default，仅会晤实体作品）。
          const _wkOwner = (_wk as any).belong_entity_uuid ?? null;
          const _allowed = _isMeeting
            ? policePasses(_wkOwner, {
                visibleUuids: new Set(_scopeUuids),
                allowUnowned: false,   // 会晤：仅会晤实体作品，无归属作品 deny
              })
            : true;  // 户主钥匙：户主拥有全部实体，作品皆可见（会晤私密由隔离墙在会话层管理）
          if (!_allowed) {
            console.log(`[WorkReferent] 越权拦截《${_wk.title}》 scope=${_ref.scope}（${_isMeeting ? '会晤' : '户主'}）`);
          } else {
            // S5-评审: 强指称（取回/续写意图）→ 全文注入；弱指称（讨论句/标题）→ 仅标题+摘要
            const _fullText = _ref.isStrong
              ? (_wk.full_text || '').substring(0, 4000)
              : '【作品摘要】' + (_wk.summary || (_wk.full_text || '').substring(0, 200));
            const _tag = '【作品】《' + _wk.title + '》(' + _wk.work_type + ')\n' + _fullText;
            if (_fullText.length > 4 && !memoryFragments.some((f: string) => f.includes(_wk.title))) {
              memoryFragments.push(_tag);
              console.log(`[WorkReferent] 指称解析命中《${_wk.title}》 scope=${_ref.scope} strong=${_ref.isStrong} 注入${_fullText.length}字`);
            }
          }
        }
      }
    } catch (_wrErr) { /* 指称解析失败不阻塞主流程 */ }
  }

    // 🛡️ V5.2: 会晤信息隔离墙 — 阻断用户记忆，检索实体自有记忆
  if (_meetingEntityName) {
    try {
      const _fg = ctx.m4?.getFamilyGraph?.();
      const _entityUuid = _fg?.getUUIDByName?.(_meetingEntityName);
      const _sqlite = ctx.storage?.getSQLite?.();
      if (_entityUuid && _sqlite && typeof _sqlite.queryAll === 'function') {
        // 🔴 P1-3: 会晤记忆检索排序 — 废弃单一 ORDER BY calcium_score DESC（把近期低钙化记忆挤出 TOP20，
        // 实测"树林记忆 0.56 排第21+ 检索不到"即此根因）。改为**近期+历史双槽位**：
        //   近期槽（当日 <1天）：保底命中当天对话记忆（"回头就忘"直接修复）；
        //   历史槽（>=1天）：保留重要历史地标（钙化 10/9.99 不被整体挤出，避免时间主导的历史高钙饥饿）。
        // 🔴 记忆召回策略(2026-08-21): 三槽位时间覆盖导致早期无关记忆**默认注入**，冲散当前话题（用户反馈"一会东一会西"）。
        // 调整为**早期按需触发**: 常规只注入近期钙化8 + 历史地标6（聚焦当前话题）；
        //   用户明确问过去的事（回忆问句）时才追加最早6条（时间轴兜底，早期记忆仍可召回）。
        const _recentRows = _sqlite.queryAll(
          `SELECT id, raw_input, calcium_score, effective_strength, perception_40d FROM memories
           WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) < 1
           ORDER BY calcium_score DESC LIMIT 8`,
          [_entityUuid]
        ) || [];
        const _histRows = _sqlite.queryAll(
          `SELECT id, raw_input, calcium_score, effective_strength, perception_40d FROM memories
           WHERE belong_entity_uuid = ? AND julianday('now') - julianday(created_at) >= 1
           ORDER BY calcium_score DESC LIMIT 6`,
          [_entityUuid]
        ) || [];
        const _isRecallQuestion = /(?:记得|聊过|说过|之前|以前|上次|那件事|那次|回忆|是不是|上次说|聊起|什么内容|最早|第一次|当初|刚认识)/.test(message);
        let _entityMems = [..._recentRows, ..._histRows];
        if (_isRecallQuestion) {
          // 回忆问句: 追加最早 6 条（时间轴兜底，早期低钙化记忆此时才可被召回）
          const _earlyRows = _sqlite.queryAll(
            `SELECT id, raw_input, calcium_score, effective_strength, perception_40d FROM memories
             WHERE belong_entity_uuid = ?
             ORDER BY seq_pos ASC LIMIT 6`,
            [_entityUuid]
          ) || [];
          _entityMems = [..._entityMems, ..._earlyRows];
        }
        // 去重
        const _seenMId = new Set<string>();
        _entityMems = _entityMems.filter((_m: any) => {
          if (_seenMId.has(_m.id)) return false;
          _seenMId.add(_m.id);
          return true;
        });
        // 🔴 S2-J1b: 过滤编造特征记忆 — LLM 单方面输出的"过去经历"类内容(海边/比基尼/营销总监/来月经等)
        // 被当真实记忆检索注入 → 巩固谎言。命中特征词的记忆不注入。
        const FABRICATION_PATTERNS = /海边|比基尼|营销总监|全职太太|来月经|身体开始变|刻骨铭心|从零到一|泳衣|穿拖鞋/;
        let _fabFiltered = 0;
        const _cleanMems = (_entityMems || []).filter((_em: any) => {
          const _body = String(_em.raw_input || '');
          if (FABRICATION_PATTERNS.test(_body)) { _fabFiltered++; return false; }
          return true;
        });
        if (_fabFiltered > 0) console.log('[EntityMem] 编造特征记忆过滤: ' + _fabFiltered + ' 条');
        // 🔴 S2-R5: 简要模式(auto/summary)按 40D 情感相似度重排 — 用户泛泛问("介绍一下你/说说你")时，
        // 40D 权重高的记忆优先注入（与当前感知最贴近）。详细/一字不漏保持钙化序（覆盖过程）。
        // 注意: 会晤隔离墙在 searchV13 前 return(L240-246)，L6.5 40D 重排不执行 → 此处补充。
        const { detectDetailLevel } = await import('./long-text-retrieval.js');
        const _detailLevel = detectDetailLevel(message);
        let _rankedMems = _cleanMems;
        const _p40q = input.p40;  // 捕获局部变量（TS 闭包收窄）
        if ((_detailLevel === 'auto' || _detailLevel === 'summary') && _p40q) {
          try {
            const { decodePerceptionV40, cosineSimilarity40D } = await import('../../m2/PerceptionVector40DCodec.js');
            const { isPerception40DEnabled } = await import('../../config/perception-40d-config.js');
            if (isPerception40DEnabled()) {
              _rankedMems = _cleanMems
                .map((_m: any) => {
                  const _mem40 = decodePerceptionV40(_m.perception_40d ? String(_m.perception_40d) : null);
                  return { m: _m, sim: _mem40 ? cosineSimilarity40D(_p40q, _mem40) : -1 };
                })
                .sort((a: any, b: any) => b.sim - a.sim)
                .map((x: any) => x.m);
              console.log('[EntityMem·40D] 简要模式按40D情感相似度重排: ' + _rankedMems.length + ' 条');
            }
          } catch (_p40e) { /* 40D 重排失败 → 保持钙化序 */ }
        }
        // 🔴 S2-O2: 记忆条数 5→8，颗粒度更精细（用户问过去时覆盖更多关键记忆，回复更完整真实）
        // 🔴 记忆召回彻底解决: 8→15（配合三槽位时间覆盖，早期记忆也可注入）
        // 🆕 统一检索中枢接入：会晤场景也走 SearchOrchestrator 多路并行 + RRF 融合
        //   现有三槽位（MeetingWallAdapter）+ Foundation 额外域（黑钻/金库/记事）并行检索，
        //   融合结果优先注入（更相关的在前），三槽位原有逻辑保留为兜底去重。
        try {
          const { MeetingWallAdapter } = await import('../../m4/retrieval/adapters/MeetingWallAdapter.js');
          const { createDefaultRegistry } = await import('../../m4/retrieval/index.js');
          const { SearchOrchestrator } = await import('../../m4/retrieval/SearchOrchestrator.js');
          const _orchestrator = new SearchOrchestrator();
          const _reg = createDefaultRegistry({ sqlite: _sqlite as any });
          _reg.register(new MeetingWallAdapter(_sqlite as any));
          const _orRes = await _orchestrator.runSearch(_reg, {
            query: message,
            entityUuids: [_entityUuid],
            policy: { enforce: false } as any,
            mode: 'balanced',
            nowMs: Date.now(),
          });
          if (_orRes.hits.length > 0) {
            const _orSeen = new Set(memoryFragments.map((f: string) => f.substring(0, 20)));
            let _orInjected = 0;
            for (const _oh of _orRes.hits) {
              const _t = String(_oh.text || '').substring(0, 250);
              if (_t.length > 4 && !_orSeen.has(_t.substring(0, 20))) {
                _orSeen.add(_t.substring(0, 20));
                memoryFragments.push('【' + _meetingEntityName + '的记忆】' + _t);
                _orInjected++;
              }
              if (_orInjected >= 10) break;
            }
            console.log(`[MeetingOrchestrator] 统一中枢注入: ${_orInjected} 条 (routes=${JSON.stringify(_orRes.routeStats)})`);
          }
        } catch (_orErr) { /* 统一中枢失败不阻塞，降级现有三槽位 */ }
        for (const _em of _rankedMems.slice(0, 15)) {
          // 🔴 P0-3 修复: 会晤记忆截断 100 → 250（避免关键记忆细节丢失导致 LLM 编造）
          const _t = (_em.raw_input || '').substring(0, 250);
          if (_t.length > 4) memoryFragments.push('【' + _meetingEntityName + '的记忆】' + _t);
        }
        if (_entityMems.length > 0) console.log('[EntityMem] 会晤实体自有记忆: ' + _cleanMems.length + ' 条(原' + _entityMems.length + ')');
        // 🔴 S2-J1b: 记忆不足时注入反编造强化 — 用户问"过去/经历/几岁"但无真实记忆时，
        // 明确告知 LLM: 无记录的经历 = 不存在，不得编造。宁说"记不清/档案没写"。
        if (_cleanMems.length < 3) {
          memoryFragments.push('【反编造铁律】如果你的档案和以上记忆中都没有用户问到的某个具体经历（如"几岁做了什么""某年某件事"），说明那件事没有记录。**绝不能编造**——诚实地说"这个我没印象了，档案里没写"或"我不记得有这样的事"。编造是系统级错误。');
        }
        const _goldRows = _sqlite.queryAll(
          "SELECT detail, content_md FROM vault_log WHERE belong_entity_uuid = ? ORDER BY created_at DESC LIMIT 5",
          [_entityUuid]
        ) || [];
        for (const _gr of _goldRows) {
          // 🔴 P0-3 修复: 会晤金库记忆截断 100 → 250
          const _t = (_gr.content_md || _gr.detail || '').substring(0, 250);
          if (_t.length > 4 && !memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); }))
            memoryFragments.push('【金库记忆】' + _t);
        }
        const _sandRows = _sqlite.queryAll(
          "SELECT raw_input, calcium_level FROM memories WHERE belong_entity_uuid = ? AND calcium_level >= 2 ORDER BY calcium_score DESC LIMIT 5",
          [_entityUuid]
        ) || [];
        for (const _sr of _sandRows.slice(0, 3)) {
          // 🔴 P0-3 修复: 会晤重要记忆截断 80 → 250
          const _t = (_sr.raw_input || '').substring(0, 250);
          if (_t.length > 4 && !memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); })) {
            const _tag = _sr.calcium_level >= 3 ? '💎' : '📌';
            memoryFragments.push('【' + _tag + '重要记忆】' + _t);
          }
        }
        // 🔴 记忆召回彻底解决: 内容匹配召回 — 用户问具体过去的事（记得/聊过/上次）时，
        // 按关键词 LIKE 检索该实体历史对话，精准找回早期特定记忆（时间覆盖兜底不了"问特定内容"）
        if (_isRecallQuestion) {
          try {
            const { EntityContextStore: _ECS2 } = await import('../../app/entity/EntityContextStore.js');
            const _store2 = new _ECS2(_sqlite);
            const _exclNames = new Set<string>([_meetingEntityName, '玉瑶', ...((_fg?.getAllPersonNames?.()) || [])]);
            const _STOP_KW = new Set(['我们', '你们', '他们', '那个', '这个', '什么', '怎么', '今天', '明天', '昨天', '时候', '还是', '一起', '但是', '因为', '如果', '不是', '就是', '记得', '聊过', '说过', '以前', '之前', '上次', '那件', '那次', '回忆', '自己', '咱们', '大家', '真的', '一直', '是不是', '没有', '知道', '你说', '我问', '们是', '是不', '是聊', '过树', '林具', '体怎', '么回', '回事', '具体', '还有', '然后', '后来', '那些', '别的', '其他', '我们是', '们是不', '是聊过', '聊过树', '过树林', '树林具', '林具体', '具体怎', '体怎么', '怎么回', '我们这']);
            // 关键词提取改进: 2字+3字滑动窗口（原 [一-龥]{2,4} 贪婪切块会把"树林"切成"林具体怎"导致 LIKE 检索失效）
            const _kwCandidates: string[] = [];
            for (let _wi = 0; _wi + 2 <= message.length; _wi++) {
              const _s2 = message.slice(_wi, _wi + 2);
              if (/^[一-龥]{2}$/.test(_s2) && !_STOP_KW.has(_s2) && !_exclNames.has(_s2)) _kwCandidates.push(_s2);
              if (_wi + 3 <= message.length) {
                const _s3 = message.slice(_wi, _wi + 3);
                if (/^[一-龥]{3}$/.test(_s3) && !_STOP_KW.has(_s3) && !_exclNames.has(_s3)) _kwCandidates.push(_s3);
              }
            }
            const _kwList = [...new Set(_kwCandidates)].slice(0, 4);
            for (const _kw of _kwList) {
              const _hits = _store2.searchEntityContext(_entityUuid, _kw, 2);
              for (const _ht of _hits) {
                const _cbody = (_ht.content || '').substring(0, 250);
                if (_cbody.length > 4 && !memoryFragments.some((f: string) => f.includes(_cbody.substring(0, 20)))) {
                  memoryFragments.push('【对话·' + _meetingEntityName + '】' + _cbody);
                }
              }
            }
          } catch (_kwErr) { /* 内容匹配失败不阻塞 */ }
        }
        // 🔴 V10.14 隐私隔离: 过滤会晤实体记忆中的他人私密内容
        // 世界规则：每个人的聊天记录通过 UUID 绝对隔离，绝不互通。
        // 徐诗雨的记忆即使提到熊梓铭/玉瑶，涉及私人情感的也要剔除。
        if (_meetingEntityName && memoryFragments.length > 0) {
          try {
            const { isIntimateAboutOthers } = await import('../../m4/household/EntityPrivacyFilter.js');
            const _fg2 = ctx.m4?.getFamilyGraph?.();
            const _allNames = _fg2?.getAllPersonNames?.() || [];
            const _otherEntities = _allNames.filter((n: string) => n && n !== _meetingEntityName);
            const _before = memoryFragments.length;
            // memoryFragments 是函数参数（const），原地过滤
            for (let _fi = memoryFragments.length - 1; _fi >= 0; _fi--) {
              const _f = memoryFragments[_fi];
              // 只过滤"会晤实体记忆/对话"类（【徐诗雨的记忆】/【金库记忆】/【对话·徐诗雨】）
              if (!_f.includes('记忆') && !_f.includes('对话·') && !_f.includes('重要记忆')) continue;
              const _body = _f.replace(/^【[^】]*】/, '');  // 去掉前缀标签
              if (isIntimateAboutOthers(_body, _meetingEntityName, _otherEntities)) {
                memoryFragments.splice(_fi, 1);
              }
            }
            if (memoryFragments.length < _before) {
              console.log(`[PrivacyFilter] ${_meetingEntityName}会晤记忆过滤: ${_before}→${memoryFragments.length} 条（剔除他人私密）`);
            }
          } catch (_pfErr) { /* 过滤失败不阻塞 */ }
        }
        // V5.3: 记忆不足时降级检索 conversations
        if (memoryFragments.length < 5) {
          try {
            const _convRows = _sqlite.queryAll(
              "SELECT dialog_group_id, content, role, timestamp FROM conversations WHERE belong_entity_uuid = ? ORDER BY timestamp DESC LIMIT 80",
              [_entityUuid]
            ) || [];
            const _seenGroups: Record<string, boolean> = {};
            const _convTopics = [];
            for (let _ci = 0; _ci < _convRows.length && _convTopics.length < 10; _ci++) {
              if (_seenGroups[_convRows[_ci].dialog_group_id]) continue;
              _seenGroups[_convRows[_ci].dialog_group_id] = true;
              const _t = (_convRows[_ci].content || '').substring(0, 100);
              if (_t.length > 4 && !memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); }))
                _convTopics.push('【对话·' + _meetingEntityName + '】' + _t);
            }
            for (let _ti = 0; _ti < _convTopics.length; _ti++) {
              memoryFragments.push(_convTopics[_ti]);
            }
            if (_convTopics.length > 0) console.log('[EntityMem] V5.3对话降级: ' + _convTopics.length + ' 条');
          } catch (_ce) { /* non-critical */ }
        }
        // 🔴 V23 会晤长文直取: 会晤场景也要支持长文完整返回（详细/概要意图）
        // 用户问"梓铭写的那篇纪实详细讲讲" → 直取会晤实体最长长对话全文注入。
        // 绕过 is_compacted 归档过滤，绕过会晤记忆 100 字截断。
        // 🔴 V23 会晤长文直取: 会晤实体自己的长文创作（纪实/小说）完整返回。
        // 实测修复1: 此前对全文跑 isIntimateAboutOthers 把梓铭自己的纪实（含对妈妈的描写）
        //   误判为"他人私密"拦截 → LLM 只能靠零散记忆编造。
        //   依据 filterPrivateConversations L101: 当前实体(assistant)自己的发言不涉及他人隐私 → 豁免。
        // 实测修复2（时空时序）: 原 ORDER BY LENGTH(content) DESC 破坏时间线——
        //   把 8-05 的抱抱闲聊(26719)混进 7-19 的纪实序列 → "前后混乱/扯进无关内容"。
        //   改 ORDER BY timestamp ASC 按时间正序，且按主题收束（含纪实/研究/记录等创作特征），
        //   排除纯亲密闲聊（抱抱/贴贴/想你等）。
        try {
          // 🔴 S2-R7: 接入语义推断还原度 — 系统体会"你说说/仔细说说/再详细点"等口语推断还原度
          const { detectDetailLevel: _mDetail, inferDetailPercent: _mPct, buildLongTextFragment: _mFrag, sliceByPercent: _mSlice } = await import('./long-text-retrieval.js');
          const _mLevel = _mDetail(message);
          const _mPercent = _mPct(message);
          // 明确概要/详细意图 或 有推断还原度 才直取
          if (_mLevel !== 'auto' || _mPercent !== null) {
            const _longRows = _sqlite.queryAll(
              "SELECT id, content, timestamp FROM conversations WHERE belong_entity_uuid = ? AND role = 'assistant' AND LENGTH(content) > 800 AND (content LIKE '%纪实%' OR content LIKE '%实验%' OR content LIKE '%研究%' OR content LIKE '%记录%' OR content LIKE '%第一章%' OR content LIKE '%第二章%' OR content LIKE '%第三章%') ORDER BY timestamp ASC LIMIT 5",
              [_entityUuid]
            ) || [];
            for (const _lr of _longRows) {
              const _lc = String(_lr.content || '');
              if (_lc.length <= 800) continue;
              // 🔴 百分比还原度优先: 按比例均匀截取（隐私法: 内容为个人世界真实记录，不伦常过滤）
              const _mf = _mPercent !== null
                ? '【对话原文·权威记录】\n' + _mSlice(_lc, _mPercent)
                : _mFrag(_lc, _mLevel);
              if (!memoryFragments.some(function(f) { return f.includes(_lc.substring(0, 20)); })) {
                memoryFragments.push(_mf);
                console.log(`[LongText·会晤] 直取 ${_meetingEntityName} 长文 id=${_lr.id} (${_lc.length}字, level=${_mLevel}, pct=${_mPercent})`);
              }
            }
          }
        } catch (_mlErr) { /* 会晤长文直取失败不阻塞 */ }
      }
    } catch (_e) { /* non-critical */ }
    return {
      isTopicShift: false, isFollowUp: false, hasContinuationMarkers: false,
      isCasualChat: true, isLimitedRetrieval: false, hasNewEntity: false, hasPersonEntity: false,
      emotionalMemories: [],
      memoryGate: { mode: 'casual' as const, needsMemorySearch: false, needsKnowledgeSearch: false, fillerPhrase: '', hallucinationGuard: '', strictMode: false },
      memoryGateFillerUsed: false,
    };
  }

  // 🔴 P0-A4: 时间导航前提前收集活跃实体 UUID（供时间检索做 UUID 过滤，防跨实体泄漏）
  const _tmActiveUuids: string[] = [];
  try {
    if (ctx.m4?.getFamilyGraph) {
      const _tmFg = ctx.m4.getFamilyGraph();
      const _tmPersonNames = (dna.entity_genes || [])
        .filter((g: any) => g.type === 'person' && g.name !== '我')
        .map((g: any) => g.name);
      for (const _tpn of _tmPersonNames.slice(0, 3)) {
        const _tuuid = _tmFg.getUUIDByName?.(_tpn);
        if (_tuuid) _tmActiveUuids.push(_tuuid);
      }
    }
  } catch { /* UUID 收集失败 → 时间导航放行全部（户主场景合理） */ }

  // 时间导航：检测用户是否在问"昨天/上周说了什么"
  const _tmMatch = message.match(/(昨天|前天|上周|上个月|前几天|最近|刚才)/);
  if (_tmMatch && (message.indexOf('说') >= 0 || message.indexOf('聊') >= 0 || message.indexOf('提') >= 0)) {
    try {
      const _tmNow = new Date();
      const _tmStart = new Date();
      const _tmEnd = new Date();
      const _tmUnit = _tmMatch[1];
      if (_tmUnit === '昨天') { _tmStart.setDate(_tmNow.getDate() - 1); }
      else if (_tmUnit === '前天') { _tmStart.setDate(_tmNow.getDate() - 2); _tmEnd.setDate(_tmNow.getDate() - 1); }
      else if (_tmUnit === '上周') { _tmStart.setDate(_tmNow.getDate() - 7); }
      else if (_tmUnit === '上个月') { _tmStart.setMonth(_tmNow.getMonth() - 1); }
      else if (_tmUnit === '前几天') { _tmStart.setDate(_tmNow.getDate() - 3); }
      else if (_tmUnit === '刚才') { _tmStart.setHours(_tmNow.getHours() - 1); }
      const _tmRows = ctx.conversationDB?.findByTimeRange(_tmStart.toISOString(), _tmEnd.toISOString(), 8, _tmActiveUuids.length > 0 ? _tmActiveUuids : undefined);
      if (_tmRows && _tmRows.length > 0) {
        const _tmTexts = _tmRows.map(function(r: any) { return r.content; }).filter(Boolean).join(' | ').substring(0, 300);
        memoryFragments.push('【时间检索】' + _tmUnit + '的对话：' + _tmTexts);
        console.log('[TimeNav] ' + _tmUnit + ' 检索到 ' + _tmRows.length + ' 条');
      }
    } catch (err) {
      console.warn('[TimeNav] 检索失败:', err);
    }
  }

  let emotionalMemories: ScoredMemory[] = [];

  // 上下文连续性检测 —— 优先保持当前话题，记忆只在话题切换时注入

  const recentContext = enrichedHistory.slice(-3).map((t: { content: string }) => t.content).join('').slice(-200);

  const isFollowUp = /[那这]个|然后|还有|后来|可是|但是|而且|再|又|还|呢|吧|吗/.test(message) && message.length < 30;

  const hasNewEntity = dna.entity_genes.some(g => g.name && !recentContext.includes(g.name));

  const hasPersonEntity = dna.entity_genes.some((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1);

  // 🔴 P0-4: 聊天检索过滤条件强制取自 UUIDGatekeeper.sessionEntities（+ 玉瑶默认兜底）
  // 不再从消息文本提取人名作为检索过滤——消息人名留给图谱/关联分析（mentioned_entity_uuids）
  const _activeEntityUuids: string[] = [];
  try {
    const _session = ctx._gatekeeper?.getSessionEntities?.() ?? [];
    const _yuyaoU = ctx.m4?.getFamilyGraph?.()?.getUUIDByName?.('玉瑶') ?? null;
    if (_session.length > 0) {
      _activeEntityUuids.push(..._session);
    } else if (_yuyaoU) {
      _activeEntityUuids.push(_yuyaoU);  // 玉瑶默认态兜底（私聊-玉瑶检索自己的记忆）
    }
  } catch { /* 不阻塞 */ }

  const hasContinuationMarkers = /嗯|对|好|行|是|是的|没错|就是|[那这]样/.test(message) && message.length < 20;

  // 日常闲聊检测 — 短消息/日常问候 → 不触发记忆检索
  const isCasualChat = /^(在干嘛|忙什么|吃了吗|睡了|晚安|早安|早上好|晚上好|刚起来|下班|到家|今天天气|好开心|好累|心情|感觉|今天.*不错|今天.*好|嗯|好|行|对|是|好的|知道了|没事|算了|哈哈|嘿嘿|哎|唉)$/i.test(message.trim())
    || (message.length < 10 && /今天|天气|吃|睡|累|困|忙|下班|到家|早安|晚安/.test(message));
  let memoryGate: import('../../app/conversation/MemoryGate.js').MemoryGateOutput = { mode: 'casual', needsMemorySearch: false, needsKnowledgeSearch: false, fillerPhrase: '', hallucinationGuard: '', strictMode: false };
  let memoryGateFillerUsed = false;

  // 🔴 V7.0: 记忆每轮检索 — isTopicShift 控制深度而非开关
  const isTopicShift = hasNewEntity || isFollowUp || (!isFollowUp && !hasContinuationMarkers && !isCasualChat);
  const isLimitedRetrieval = isFollowUp && !hasNewEntity;
  // V10.4: 话题切换深度检索(10-15条)，日常闲聊常用检索(5-8条)
  const _memLimit = isTopicShift ? 15 : 8;
  const _memFinalLimit = isTopicShift ? 8 : 5;

  try {
    input.onIntentReady?.({
      isTopicShift,
      isFollowUp,
      hasContinuationMarkers,
      isCasualChat,
      isLimitedRetrieval,
      hasNewEntity,
      hasPersonEntity,
    });
  } catch (error) {
    console.warn('[RetrievalStage] 独立检索启动失败，继续主链:', (error as Error)?.message);
  }

  // Foundation 与情感记忆/V13 主链无数据依赖，提前启动；仍在原位置等待并注入。
  const _foundationPromise = startFoundationRouteTask(ctx, message, {
    meetingMode: !!_meetingEntityName,
    activeEntityUuids: _activeEntityUuids,
    isTopicShift,
    perception: p,
    perception40d: input.p40,
    locusPath: (dna as any).locus_path || 'default',
    entities: dna.entity_genes.map(g => ({ name: g.name, type: g.type })),
  });

  try {
    // V7.0: 始终检索记忆，不再用 isTopicShift 做总开关
    const currentEntityNames = dna.entity_genes.map(g => g.name).filter(Boolean);

      // P0-2: 定向检索模式（isLimitedRetrieval）— 跳过分解和实体扩展，只查当前实体
      if (isLimitedRetrieval) {
        const limMode: SimilarityMode = p.intimacy > 0.4 ? 'intimacy_search' : 'balanced';
        let limMemories = ctx.storage.findByEmotionalSimilarity({
          current_perception: p, similarity_mode: limMode,
          entities: currentEntityNames, limit: _memLimit + 3,
          entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
        });
        limMemories = rerank(limMemories, message);
        // P0-2: 情感阈值过滤
        emotionalMemories = limMemories.filter((m: any) =>
          (m.scores.emotional > 0.5 || m.composite > 0.25)
          && m.record.id !== dna.branch_id
          && (m.record.effective_strength || 0) >= 0.15
          && (m.record.calcium_level || 0) >= 1
        ).slice(0, _memFinalLimit + 2);
        if (emotionalMemories.length > 0) {
          memoryFragments.push('【用户曾提到】"' + emotionalMemories[0].record.raw_input?.substring(0, 60) + '"');
        }
      } else {
        // 🆕 V8.0: 空实体快速路径 — entity_genes=[] 时跳过复杂多跳，直接用钙化分扫描
        if (currentEntityNames.length === 0) {
          const _scanMode: SimilarityMode = 'by_calcium';
          const _scan = ctx.storage.findByEmotionalSimilarity({
            current_perception: p, similarity_mode: _scanMode,
            entities: [], limit: 8,
            entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
          });
          const _reranked = rerank(_scan, message);
          emotionalMemories = _reranked
            .filter((m: any) => m.record.id !== dna.branch_id && (m.record.calcium_score || 0) > 0.05)
            .slice(0, _memFinalLimit);
          if (emotionalMemories.length > 0) {
            const _top = emotionalMemories[0];
            memoryFragments.push('【回忆】' + (_top.record.raw_input || '').substring(0, 80));
          }
        } else {
        // P1-3: 多跳检索（1度→不足3条升2度）
        let relatedEntities: Array<{ name: string; relation: string; strength: number }> = [];
        if (currentEntityNames.length > 0) {
          let anyType = ctx.storage;
          let hop1 = (anyType as any).findRelatedEntitiesN(currentEntityNames, 1, 0.3) || [];
          if (hop1.length < 3) {
            let hop2 = (anyType as any).findRelatedEntitiesN(currentEntityNames, 2, 0.3) || [];
            relatedEntities = [...hop1, ...hop2];
          } else {
            relatedEntities = hop1;
          }

          // P1-3b: 从 FamilyGraph 补充人物关系
          try {
            const _fg = ctx.m4?.getFamilyGraph();
            if (_fg) {
              const _familyNames = _fg.getAllPersonNames();
              const _matchedPerson = currentEntityNames.find((n: string) => _familyNames.includes(n));
              if (_matchedPerson) {
                const _profile = _fg.getPersonProfile(_matchedPerson);
                if (_profile?.relation_to_user) {
                  relatedEntities.push({
                    name: _matchedPerson,
                    relation: 'known_person',
                    strength: 0.5,
                  });
                }
              }
            }
          } catch (_fgErr) { /* 图谱扩展不阻塞 */ }
        }

        const uniqueExpanded = [...new Set([...currentEntityNames, ...relatedEntities.map(r => r.name)])];
        const decomposed = decompose(message);
        const allQueryTexts = [message, ...decomposed.subQueries.filter((q: string) => q !== message)];
        const allResultSets: ScoredMemory[][] = [];

        const mode: SimilarityMode =
          p.pleasure < -0.2 ? 'mood_congruent' :
          p.intimacy > 0.4 ? 'intimacy_search' :
          p.arousal > 0.6 ? 'by_calcium' : 'balanced';

        for (const q of allQueryTexts) {
          let memories = ctx.storage.findByEmotionalSimilarity({
            current_perception: p, similarity_mode: mode,
            entities: uniqueExpanded, limit: _memLimit + 3,
            entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
          });
          memories = rerank(memories, q);

          const _hasPerson = dna.entity_genes.some((g: any) => g.type === 'person' && g.name !== '我');
          // V7.0: 日常闲聊降低阈值，确保轻量检索也能命中
          const _emoThreshold = isTopicShift ? (_hasPerson ? 0.25 : 0.5) : 0.15;
          const _compThreshold = isTopicShift ? (_hasPerson ? 0.15 : 0.25) : 0.10;
          const valid = memories.filter((m: any) =>
            (m.scores.emotional > _emoThreshold || m.composite > _compThreshold) && m.record.id !== dna.branch_id
          );
          if (valid.length > 0) allResultSets.push(valid);
        }

        emotionalMemories = mergeDecomposedResults(allResultSets, _memLimit);

        if (relatedEntities.length > 0) {
          const relationMemories = ctx.storage.findMemoriesByEntityNames(relatedEntities.map((r: any) => r.name), _memLimit);
          for (const rm of relationMemories) {
            if (!emotionalMemories.some((e: any) => e.record.id === rm.id) && rm.id !== dna.branch_id) {
              emotionalMemories.push({
                record: rm, scores: { emotional: 0.5, topic: 0, entity: 0.8, calcium: rm.calcium_score },
                composite: 0.5 * rm.effective_strength,
              });
            }
          }
        }
      } // ← V8.0 多跳分支闭合
      } // ← else闭合

      const recentHistoryRaw = enrichedHistory.slice(-4).map((t: any) => t.content).join('');
      let freshMemories = emotionalMemories.filter((m: any) => !recentHistoryRaw.includes(m.record.id));
      if (freshMemories.length < 2 && !hasContinuationMarkers) {
        const fallback = ctx.storage.findByEmotionalSimilarity({ current_perception: p, similarity_mode: 'balanced', limit: 2, entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined });
        freshMemories = fallback.filter((m: any) =>
          (m.scores.emotional > 0.3 || m.scores.calcium > 0.3) && m.record.id !== dna.branch_id && !recentHistoryRaw.includes(m.record.id)
        );
      }
      const finalMemories = freshMemories.length > 0 ? freshMemories : emotionalMemories.slice(0, _memFinalLimit);
      if (finalMemories.length > 0) {
        const top = finalMemories[0];
        const userSaid = top.record.raw_input.substring(0, 60);
        memoryFragments.push('【用户曾提到】"' + userSaid + '"——这是用户以前说的，不记得就说"不太记得了"');
      }
  } catch (err) { console.warn('[EmotionContagion] 检索失败:', err); }

  // ── V11.0: 统一语义搜索 — n-gram初筛 + 自有32D向量精排（替代旧LIKE黑钻检索） ──
  // ── V13.0: WS_SEARCH_V13=true 时走七层仿生管线 ──
  const WS_SEARCH_V13 = true; // 硬编码开启，绕过 env 加载问题
  console.error('[RETRIEVAL-STAGE-V13] ENTERED runRetrieval, WS_SEARCH_V13=' + WS_SEARCH_V13 + ' m4=' + !!ctx.m4 + ' retrieveFn=' + !!(ctx.m4?.retrieveMultiRankForSearch));
  try {
    if (message.trim().length > 1) {
      const _sqlite = ctx.storage.getSQLite();
      if (_sqlite && typeof _sqlite.queryAll === 'function') {
        // V13: 使用顶层 _activeEntityUuids（已提前收集）
        let _v13Result: any = null;
        let _dbResult: any = null;
        let _v13Failed = false;  // P1-D1: V13 异常标志（触发 V11 真正降级）

        // ── V13 七层仿生管线 ──
        if (WS_SEARCH_V13 && ctx.m4?.retrieveMultiRankForSearch) {
          try {
            const { searchV13: v13Search } = await import('../../m4/UnifiedSearchEngine.js');
            const { MemoryAssociationRepository } = await import('../../m4/graph/MemoryAssociationRepository.js');

            const _locusPath = (dna as any).locus_path || 'default';
            const _entities = dna.entity_genes.map((g: any) => ({ name: g.name, type: g.type }));

            const _multiRank = await ctx.m4.retrieveMultiRankForSearch(_locusPath, _entities, {
              perception: p,
              entityUuids: _activeEntityUuids,
              sessionId: ctx.sessionId,
            });

            // 🔴 DAG Repo 必须用 SQLiteAdapter 实例（有 queryAll 方法），不能用 rawDb
            const _dagRepo = new MemoryAssociationRepository(_sqlite);

            _v13Result = await v13Search(
              _sqlite.rawDb || _sqlite, _multiRank, message, p,
              {
                mode: isTopicShift ? 'full' : 'balanced',
                entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
                limit: isTopicShift ? 6 : 3,
                includeKnowledgeBase: true,
              },
              {
                enableRRF: true,
                enableDAGClosure: true,
                enableCrossEncoder: true,
                enableForesightFilter: true,
                enableMMR: true,
                enableNarrativeAssembler: true,
              },
              _dagRepo,
              input.p40,  // V3: M3 产出的 40D 感知向量（40D 查询向量）
            );

            // 注入 V13 叙事或普通结果到 memoryFragments
            if (_v13Result.narrative?.compactText) {
              memoryFragments.push(_v13Result.narrative.compactText);
            }
            for (const _item of _v13Result.items) {
              if (!memoryFragments.some(f => f.includes(_item.substring(0, 40)))) {
                memoryFragments.push(_item.startsWith('💎') ? `【珍藏记忆】${_item.substring(1).trim()}` : _item);
              }
            }
            if (_v13Result.items.length > 0) {
              console.log(`[searchV13] 七层管线 → ${_v13Result.totalCandidates}候选 → ${_v13Result.items.length}条 | layers: ${JSON.stringify(_v13Result.layerLatency)}`);
            }
          } catch (_v13Err) {
            console.warn('[searchV13] 七层管线异常, 降级到 V11:', (_v13Err as Error)?.message);
            // 🔴 P1-D1 修复: 原 catch 只打印"降级到 V11"但 V11 条件恒假（WS_SEARCH_V13=true 硬编码），
            //   V13 失败后 V11 不执行 → 全链路空检索。改为设标志，让下方 V11 块真正执行。
            _v13Failed = true;
          }
        }

        // ── V11 旧管线（默认 / V13 失败降级） ──
        // 🔴 P1-D1 修复: V13 失败（_v13Failed）时也执行 V11，真正降级兜底
        if (!WS_SEARCH_V13 || !ctx.m4?.retrieveMultiRankForSearch || _v13Failed) {
          const { search: unifiedSearch } = await import('../../m4/UnifiedSearchEngine.js');
          _dbResult = unifiedSearch(_sqlite.rawDb || _sqlite, message, p, {
            mode: isTopicShift ? 'full' : 'balanced',
            entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
            limit: isTopicShift ? 6 : 3,
            includeKnowledgeBase: true,
          });

          for (const _item of _dbResult.items) {
            if (!memoryFragments.some(f => f.includes(_item.substring(0, 40)))) {
              memoryFragments.push(_item.startsWith('💎') ? `【珍藏记忆】${_item.substring(1).trim()}` : _item);
            }
          }
          if (_dbResult.items.length > 0) {
            console.log(`[UnifiedSearch] n-gram→${_dbResult.totalCandidates}候选→向量精排${_dbResult.raw.length}条→注入${_dbResult.items.length}条 | ${JSON.stringify(_dbResult.hitsBySource)}`);
          }
        }

        // ── V23 长文直取：命中长文候选时绕过截断管线，直取全文注入 ──
        // 🔴 S4-评审修复:
        //   - 仅 V11（_dbResult）raw 的 conversation 候选可直取（id 是真实 conversations.id）。
        //   - V13 raw 的 conversation/memory 是假映射（id 是 memories UUID/work_id），
        //     直取会静默失效或 id 碰撞误取他人对话 → 一律跳过。
        //   - fetchLongText 带 belong 白名单校验（会晤场景传活跃实体，户主空 = 最高权限）。
        try {
          // 🔴 S2-R7: 普通模式长文直取接入语义推断还原度
          const { detectDetailLevel: _detectLevel, inferDetailPercent: _detectPct, fetchLongText: _fetchLong, buildLongTextFragment: _buildFrag, sliceByPercent: _slicePct } =
            await import('./long-text-retrieval.js');
          const _detailLevel = _detectLevel(message);
          const _detailPct = _detectPct(message);
          // 仅用 V11 结果（真实 conversation id）；V13 raw 的 id 不可靠，禁用
          const _rawAll = _dbResult?.raw || [] as any[];
          for (const _r of _rawAll.slice(0, 5)) {
            const _it = _r?.item;
            if (!_it) continue;
            // 仅真实 conversation 候选可直取（id 是 conversations.id）；memory/black_diamond/work 禁用
            if (_it.source !== 'conversation') continue;
            // 归属校验：fetchLongText 内部带 belong 白名单，此处再兜底
            const _full = _fetchLong(_sqlite, _it.id, _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined);
            if (!_full) continue;  // 非长文/越权/直取失败，回落截断路径
            // 🔴 S2-R6: 百分比还原度优先（隐私法: 个人世界真实记录，不伦常过滤）
            const _frag = _detailPct !== null
              ? '【对话原文·权威记录】\n' + _slicePct(_full, _detailPct)
              : _buildFrag(_full, _detailLevel);
            if (!memoryFragments.some((f: string) => f.includes(_it.id) || f.includes(_frag.substring(0, 30)))) {
              memoryFragments.push(_frag);
              console.log(`[LongText] 直取长文 id=${_it.id} (${_full.length}字, level=${_detailLevel}, pct=${_detailPct})`);
            }
          }
        } catch (_ltErr) { /* 长文直取失败不阻塞 */ }

        // 更新召回计数（V13/V11 共用）
        for (const _r of (_v13Result?.raw || _dbResult?.raw || []).slice(0, 3)) {
          try {
            if (_r.item?.source === 'black_diamond') {
              _sqlite.writeRaw?.('UPDATE black_diamond SET recall_count = recall_count + 1, updated_at = ? WHERE id = ?',
                [new Date().toISOString(), _r.item.id]);
            }
          } catch { /* 非关键 */ }
        }
      }
    }
  } catch (err) { console.warn('[UnifiedSearch] 检索失败:', (err as Error)?.message); }

  // ═══════════════════════════════════════════════════════════════
  // Foundation V1.0: 多路并行检索底座统一路由（适配器 + RRF + 近因 + MMR）
  // 🔴 S4 影子模式（false）：旧 4 块原样执行 + 新块影子比对日志（不注入）
  // 🔴 S5 翻转 true：新块注入，旧 KB/金库 块跳过（可回滚）
  // ═══════════════════════════════════════════════════════════════
  const WS_FOUNDATION_ROUTES = true;
  if (!WS_FOUNDATION_ROUTES) {

  // ── 知识库直接接入检索链路（V11.0：不再依赖LLM路由触发）──
  // V12.1: 追加 belongEntityUuid 过滤，防止跨实体知识泄漏
  try {
    if (message.trim().length > 3 && ctx.knowledgeBase) {
      const _kbHits = await ctx.knowledgeBase.search(message, 5); // 多搜2条留裁减空间
      if (_kbHits.length > 0) {
        for (const _kb of _kbHits) {
          const _kbUUID = _kb.belong_entity_uuid || null;
          // 实体过滤：结果无UUID(通用) 或 UUID 匹配活跃实体 → 放行
          if (_activeEntityUuids.length > 0 && _kbUUID && !_activeEntityUuids.includes(_kbUUID)) continue;
          const _text = (_kb.title || '') + ': ' + (_kb.content || '').substring(0, 200);
          if (_text.length > 10 && !memoryFragments.some(f => f.includes(_text.substring(0, 30)))) {
            memoryFragments.push('📖 ' + _text);
          }
        }
        console.log(`[KBDirect] 知识库命中 ${_kbHits.length} 条`);
      }
    }
  } catch (_kbErr) { /* 知识库检索不阻塞 */ }

  // V10.0: 金库检索 — vault_log 中 content_md 不为空的金库记忆
  try {
    const _hasPerson = dna.entity_genes.some((g: any) => g.type === 'person' && g.name !== '我');
    const _glLimit = isTopicShift ? 3 : (_hasPerson ? 2 : 1);
    const _sqlite = ctx.storage.getSQLite();
    if (_sqlite && typeof _sqlite.queryAll === 'function') {
      // priority: hasPerson → query by entity names; else → recent gold vault
      // 🔴 P2-A7 修复: 金库检索加 belong_entity_uuid 白名单过滤（防跨实体拉他人金库）
      const _goldUuidFilter = _activeEntityUuids.length > 0
        ? ' AND belong_entity_uuid IN (' + _activeEntityUuids.map(() => '?').join(',') + ')'
        : '';
      const _goldUuidParams: any[] = _activeEntityUuids.length > 0 ? _activeEntityUuids : [];
      let _goldRows: any[] = [];
      if (_hasPerson) {
        const _names = dna.entity_genes.filter((g: any) => g.name && g.name.length > 1).map((g: any) => g.name);
        for (const _n of _names.slice(0, 3)) {
          const _r = _sqlite.queryAll("SELECT detail, content_md FROM vault_log WHERE (detail LIKE ? OR content_md LIKE ?) AND operation='promote'" + _goldUuidFilter + " ORDER BY created_at DESC LIMIT 2", ['%' + _n + '%', '%' + _n + '%', ..._goldUuidParams]);
          _goldRows.push(..._r);
        }
      }
      if (_goldRows.length === 0) {
        _goldRows = _sqlite.queryAll("SELECT detail, content_md FROM vault_log WHERE content_md IS NOT NULL OR detail IS NOT NULL" + _goldUuidFilter + " ORDER BY created_at DESC LIMIT 5", _goldUuidParams) || [];
      }
      for (const _gr of _goldRows.slice(0, _glLimit)) {
        const _t = (_gr.content_md || _gr.detail || '').substring(0, 100);
        if (_t.length > 4 && !memoryFragments.some(f => f.includes(_t.substring(0, 20)))) {
          memoryFragments.push('【金库记忆】' + _t);
        }
      }
      if (_goldRows.length > 0) console.log(`[GoldVault] 金库命中 ${Math.min(_goldRows.length, _glLimit)} 条`);
    }
  } catch (_gvErr) { /* 金库检索不阻塞 */ }
  }  // 🔴 Foundation: 旧 KB+金库 作用域结束（S5 后由适配器路由接管；砂金块 S6 MemoryAdapter 再收编）

  // V10.0: 砂金库高钙化检索 — memories 中 calcium_level>=2 的经过加权检索
  // 🔴 S5 后仍执行（无对应适配器，S6 MemoryAdapter 收编 memory 域后再跳过）
  try {
    const _sLimit = isTopicShift ? 3 : 1;
    const _sqlite = ctx.storage.getSQLite();
    if (_sqlite && typeof _sqlite.queryAll === 'function') {
      // V13: 加上 entity UUID 过滤，不跨人物泄露重要记忆
      // 🔴 户籍管理法：收编 → UUIDPoliceFilter（deny-by-default，杜绝 OR IS NULL 逃生口）
      let _sandQuery = "SELECT raw_input, calcium_level FROM memories WHERE leaf_zone='user' AND calcium_level >= 2";
      const _sandParams: any[] = [];
      if (_activeEntityUuids.length > 0) {
        const { buildSqlClause: _policeClause } = await import('../../governance/police/UUIDPoliceFilter.js');
        const _police = _policeClause({ visibleUuids: new Set(_activeEntityUuids) });
        _sandQuery += _police.clause;
        _sandParams.push(..._police.params);
      }
      _sandQuery += ' ORDER BY calcium_score DESC LIMIT 10';
      const _sandRows = _sqlite.queryAll(_sandQuery, _sandParams) || [];
      for (const _sr of _sandRows.slice(0, _sLimit)) {
        const _t = (_sr.raw_input || '').substring(0, 80);
        if (_t.length > 4 && !memoryFragments.some(f => f.includes(_t.substring(0, 20)))) {
          const _tag = _sr.calcium_level >= 3 ? '💎' : '📌';
          memoryFragments.push(`【${_tag}重要记忆】${_t}`);
        }
      }
    }
  } catch {} // 砂金检索不阻塞

  // ── Foundation 统一路由块（S4 影子比对 / S5 注入） ──
  try {
    const _fResult = await _foundationPromise;
    if (_fResult) {
      if (WS_FOUNDATION_ROUTES) {
        for (const _f of _fResult.fragments) {
          if (!memoryFragments.some(f => f.includes(_f.substring(0, 20)))) memoryFragments.push(_f);
        }
        console.log(`[FoundationRoutes] 适配器统一路由 → ${_fResult.fragments.length} 片段 (executed=${_fResult.executed})`);
      } else {
        console.log(`[FoundationRoutes-shadow] 影子比对 → ${_fResult.fragments.length} 片段 (executed=${_fResult.executed}, latency=${JSON.stringify(_fResult.latency)})`);
      }
    }
  } catch (_fErr) { console.warn('[FoundationRoutes] 影子/注入失败:', (_fErr as Error)?.message); }

  return {
    isTopicShift,
    isFollowUp,
    hasContinuationMarkers,
    isCasualChat,
    isLimitedRetrieval,
    hasNewEntity,
    hasPersonEntity,
    emotionalMemories,
    memoryGate,
    memoryGateFillerUsed,
  };
}
