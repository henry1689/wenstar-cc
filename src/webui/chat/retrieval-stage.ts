/**
 * retrieval-stage — 记忆检索（从 chat.ts 拆分）
 *
 * 职责：话题切换检测、情感记忆检索、黑钻检索
 * 包含：isTopicShift判断、多跳检索、黑钻FTS5+向量补充
 * 输出：emotionalMemories、memoryFragment推送、上下文标志位
 */
import type { ScoredMemory, SimilarityMode } from '../../m2/types/index.js';
import type { DNA } from '../../m1/types/dna.js';
// 🔴 2026-11-07 闲聊快路径：把已存在但生产未接入的 MemoryGate 判定真正接上
import { decideMode, buildGuard } from '../../app/conversation/MemoryGate.js';
import type { PerceptionState24 } from '../../m3/types/perception.js';
import { rerank } from '../../m4/Reranker.js';
import { decompose, mergeDecomposedResults } from '../../m4/QueryDecomposer.js';
import { resolveReferent } from '../../app/works/ReferentResolver.js';
// 🔴 T013 R6（ADR-013 第三层）：会晤 UUID 过滤咽喉 + 命中泄漏校验
import { applyMeetingUuidFilter, verifyMeetingHits } from '../../m4/retrieval/meetingIsolation.js';
// 🔴 T013 Phase 2 批B（B2）：群聊状态优先取检索主体 UUID
import { WorkRepository } from '../../app/works/WorkRepository.js';
import { passes as policePasses, type PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';
// 🔴 2026-09-09 会晤失忆修复: 共享召回工具（关键词内容相关召回/钙化保底/压缩原文取回/统一触发正则）
//   与 MeetingWallAdapter 共用本模块，杜绝同构漂移（模块零 import，无 M 层反向依赖）。
import { classifyMemSymPath, boostElementSource } from '../../m4/retrieval/memsym-path-router.js';
import { pickElements } from '../../m4/retrieval/element-picker.js';
import { incMemSym, trackElementUse } from '../../m4/retrieval/memsym-metrics.js';
import { sweepAllStores, organizeForQuestion, cleanSweepKeywords, CRYSTAL_DIRECTIVE, SWEEP_POLICY } from '../../m4/retrieval/meeting-recall.js';
import {
  RECALL_TRIGGER_RE,
  extractTopicKeywords,
  detectConceptThemes,
  keywordRecallMemories,
  recallSandboxConversations,
  shouldEscalateToLlmPicker,
  // 🔴 P0-1 收编（2026-10-06 / ADR-011 P1-a）：两条槽位此前在本文件里**内联**了
  //   与 meeting-recall 完全相同的 SQL —— 同一规则两份实现。现统一从真源调用。
  recentCalciumRows,
  historyCalciumRows,
  // 🔴 2026-10-18 回忆问句·锚点事件召回（业主批准结构化改善）：
  //   实测「还记得第一次吗」只敢说日期——事件锚点（闭组 ANCHOR）在回忆问句时结构性缺席
  //   （兑底取最早 6 条 = 时间轴头，事件在中段；历史槽按钙化序取 2 够不到）。
  //   补为第四召回通道，真源在 meeting-recall.ts（与另三通道同源）。
  anchorRecallByKeywords,
  // 🔴 2026-10-18 真·最早记忆（时间轴兜底修正，同上单源原则）。
  earliestMemoriesByTime,
  // 🔴 Phase 2.2 (B1 / T004): 会晤「高钙对话组」独立通道（A 链路块级钙化召回）。
  //   召回本体走 HighCalciumGroupAdapter（其内部复用本模块的 highCalciumGroups 真源，不写第二份 SQL）；
  //   这里只需自检观测函数。
  countHighCalciumGroups,
} from '../../m4/retrieval/meeting-recall.js';
// 🔴 V34(2026-09-25): 砂金库时间窗召回的配置单一事实源（meeting-recall 声明零 import，由调用方传入）
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';
// 🔴 V35-C(2026-10-05): 砂金库兜底的条数封顶与子预算 —— 与既有一整套预算体系统一放在
//   retrieval-fusion.config（mem_ratio_normal / hard_max_chars 等），不另起第二套数字。
import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';
// 🔴 Phase 2.3 (F / T005): A/B 链路统一召回配额 —— 纯函数真源在 m4 层，本文件只负责
//   ① 打标签（标签后缀与分类判据共用 TAG 常量，杜绝两份实现）② 传入预算 ③ 出口调用。
import {
  applyRecallQuota,
  extractDialogGroupId,
  TAG,
  type ApplyRecallQuotaResult,
} from '../../m4/retrieval/recall-quota.js';

/** 砂金库时间窗召回：天数（近 N 天聊过的可被召回） */
const SANDBOX_RECALL_WINDOW_DAYS = (() => {
  const v = Number(MEMORY_CONFIG.compaction.sandboxRecallWindowDays);
  return Number.isFinite(v) && v > 0 ? v : 7;
})();
/**
 * 记忆片段时间坐标标注（2026-10-18，业主批准 T003 扩容）
 * ============================================================
 * 铁律（业主）：对话写入时必须 UUID+40D+DNA 标注 —— 实测执行正常（阿珍 888/888 UUID、
 *   created_at 100%），但**注入层此前把时间坐标全部剥除**：片段只有【X的记忆】正文，
 *   模型手里没有任何时间 ⇒ 被问"什么时候"时，prompt 里唯一存在的时间=环境当下时间 ⇒ 只能报当下
 *   （报时症状的第四层根因 —— 前三轮修措辞/定性/门控都是治标，这层才是"她手里根本没有日期"）。
 * 修法：注入时带上记忆自身的时间坐标（数据在库、全部召回通道 SQL 已 SELECT，零新增查询）。
 * 格式：当年 `【X·10-16】`；跨年 `【X·2025-12-31】`；无合法时间回退旧标签（fail-open 不阻塞）。
 * 预算：每条约 +6 字符，主通道 15 条封顶 ≈ +90 字符，在 V35-C 记忆预算内。
 */
function memFragWithTime(label: string, body: string, createdAt?: string | null): string {
  const d = createdAt ? new Date(createdAt) : null;
  if (!d || isNaN(d.getTime())) return `【${label}】${body}`;
  const now = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  // 注：createdAt 为 UTC ISO，此处按服务器本地时区（北京）呈现人类日期
  const tag = d.getFullYear() === now.getFullYear() ? mmdd : d.getFullYear() + '-' + mmdd;
  return `【${label}·${tag}】${body}`;
}

/**
 * Phase 2.3 (F / T005): 记忆预算 C —— 与 chat.ts 注入点**同一公式、同一输入**（enrichedHistory）。
 * Q4 裁决（R020）：不抽共享 helper，避免零高风险改动范围外的重构；此处现场算，
 * 两侧输入相同（`_histChars` 用的就是传进 runRetrieval 的同一个 enrichedHistory），结果一致。
 *   C = clamp(历史字符 × memory_max_ratio_of_history, 200, hard_max_chars)
 */
function recallBudgetFromHistory(
  enrichedHistory: Array<{ content: string; timestamp?: string }>,
): number {
  const bud = getRetrievalFusionConfig()?.budget;
  const hard = Number(bud?.hard_max_chars) || 8000;
  const ratio = Number(bud?.memory_max_ratio_of_history);
  const histChars = (enrichedHistory || []).reduce(
    (s: number, t) => s + String(t?.content || '').length, 0,
  );
  const byHist = histChars > 0 && Number.isFinite(ratio) && ratio > 0
    ? Math.floor(histChars * ratio)
    : hard;
  return Math.max(200, Math.min(hard, byHist));
}

/**
 * Phase 2.3 (F / T005): A/B 链路统一召回配额 —— **出口闸门**。
 *
 * 位置：runRetrieval 的两个 return 之前各调一次（会晤分支 / 普通分支），
 *   因为配额必须覆盖**所有**注入路径（统一中枢 / 高钙通道 / 关键词 / 三槽位 /
 *   金库 / 砂金库 / Foundation 多路），放在末尾一次裁剪即可全分类覆盖（P018 方案 F）。
 * 行为：**原地**改写 memoryFragments（chat.ts 持有该数组引用，不可替换）。
 * 兜底：任何异常 → 打印告警后保持原片段，绝不阻断召回（fail-open）。
 */
function applyRecallQuotaAtExit(
  memoryFragments: string[],
  scenario: 'meeting' | 'normal',
  enrichedHistory: Array<{ content: string; timestamp?: string }>,
  genericQuery: boolean,
): void {
  let res: ApplyRecallQuotaResult | null = null;
  const _rqT0 = Date.now();
  try {
    const cfg = getRetrievalFusionConfig()?.recall_quota;
    const budget = recallBudgetFromHistory(enrichedHistory);
    res = applyRecallQuota(memoryFragments, { scenario, budget, cfg, genericQuery });
    if (res.applied) {
      // 原地替换：保留同一数组引用（chat.ts / UUIDPolice 等下游持有的是引用）。
      // 🔴 逐条 push 而非 `push(...kept)`（S4 评审）：spread 超过 V8 参数上限会
      //   **先清空数组再抛 RangeError**，被外层 catch 吞掉后 memoryFragments 已是空数组，
      //   fail-open 在这一处不成立（整块记忆静默丢失）。
      memoryFragments.length = 0;
      for (const _kept of res.kept) memoryFragments.push(_kept);
    }
  } catch (e) {
    console.warn('[RecallQuota] 配额失败（保持原片段，不阻断召回）:', String((e as Error)?.message));
    return;
  }
  if (!res) return;
  const c = res.classes;
  const q = (k: keyof typeof c) => `${c[k].keptChars}/${c[k].quotaChars}`;
  // 非会晤 B 与近期记忆是**同一个额度池**，两个数字相同是预期，标注避免被读成两份额度
  const samePool = scenario === 'normal' ? '（B与近期同池）' : '';
  // 🔴 M 层管线节点的埋点（module_entry/exit + 耗时）由**唯一调用点**统一承担：
  //   recall-quota.ts 是纯函数（零副作用是它能被 29 例单测覆盖的前提），
  //   在它内部写 Hook 日志会破坏该约束；此处的自检行同时承担「节点事件 + 耗时」的可观测性。
  console.log(
    `[RecallQuota] 场景=${scenario} 预算=${res.budget}` +
    ` A=${q('high_calcium_group')} B=${q('block_summary')} 近期=${q('recent_memory')}${samePool}` +
    ` 溢出=${res.dropped} 泛词=${genericQuery ? '是' : '否'}` +
    ` 其他=${res.other.total}条/${res.other.chars}字（不占配额）` +
    ` 耗时=${Date.now() - _rqT0}ms` +
    `${res.applied ? '' : ' [未启用/预算非法→未裁剪]'}`,
  );
}

/** 砂金库时间窗召回：单次注入条数上限 */
const SANDBOX_RECALL_LIMIT = (() => {
  const v = Number(MEMORY_CONFIG.compaction.sandboxRecallLimit);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 12;
})();
/** 砂金库召回：单条原文最小长度（噪声门槛） */
const SANDBOX_RECALL_MIN_LEN = (() => {
  const v = Number(MEMORY_CONFIG.compaction.sandboxRecallMinContentLen);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 40;
})();
/** 砂金库倒排查询：最大 n-gram 词数 */
const SANDBOX_RECALL_MAX_TERMS = (() => {
  const v = Number(MEMORY_CONFIG.compaction.sandboxRecallMaxTerms);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 40;
})();
/** 🔴 V35-C: 砂金库**时间窗兜底**的条数封顶（索引零命中时的最后手段，非默认填充） */
const SANDBOX_FALLBACK_LIMIT = (() => {
  const v = Number(getRetrievalFusionConfig()?.budget?.sandbox_fallback_limit);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2;
})();
/** 🔴 V35-C: 砂金库兜底可占用的**记忆预算比例**上限（对话是主体，记忆是补充） */
const SANDBOX_MAX_RATIO_OF_MEMORY = (() => {
  const v = Number(getRetrievalFusionConfig()?.budget?.sandbox_max_ratio_of_memory);
  return Number.isFinite(v) && v > 0 ? v : 0.3;
})();
/**
 * C LLM 兜底挑选（2026-09-12）
 *
 * 场景：关键词与情感向量都拿不准（回忆问句 / 候选稀疏）时，把候选交 LLM 挑选。
 * 通道：走 LLMProvider.rawCall（V3.2 既有「提取/分析类任务」通道，绕过 persona 与角色路由，
 *   FGRelationExtractor 已有先例）—— 不构成第二个对话生成调用点。
 * 成本：候选上限 30 条 × 每条截断 130 字，约 5500 token 输入；maxTokens 200 / temperature 0.1。
 * 异常：无 rawCall 能力 / 抛错 / 输出无编号（含思维链散文）/ 越界编号 → 返回空数组，
 *   由调用方回退原候选，绝不阻断对话。
 *
 * @param llm           提供 rawCall 的 LLM provider
 * @param message       用户当前消息（挑选依据）
 * @param candidates    候选池（id + 文本）
 * @param maxCandidates 提交给 LLM 的候选上限
 * @returns 被挑中的候选 id（保持候选原顺序），无命中返回 []
 */
export async function pickRelevantByLlm(
  llm: { rawCall?: (messages: Array<{ role: string; content: string }>, maxTokens: number, temperature: number) => Promise<string> },
  message: string,
  candidates: Array<{ id: string; text: string }>,
  maxCandidates = 30,
): Promise<string[]> {
  if (!llm || typeof llm.rawCall !== 'function') return [];
  if (!candidates || candidates.length === 0) return [];
  const pool = candidates.slice(0, Math.max(1, maxCandidates));
  const listing = pool
    .map((c, i) => `[${i}] ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 130)}`)
    .join('\n');
  try {
    const out = await llm.rawCall(
      [
        { role: 'system', content: '你是记忆检索助手。只输出与用户问题相关的候选编号，JSON 数组格式（如 [0,3]），无相关则输出 []。不要输出任何解释，不要复述候选内容。' },
        { role: 'user', content: `用户问题：${message}\n\n候选记忆：\n${listing}\n\n请返回相关候选编号的 JSON 数组：` },
      ],
      200,
      0.1,
    );
    // 允许负号：LLM 偶发输出 [1,-1] 这类含负数的数组，应逐项丢弃非法值而非整批失败
    const m = String(out || '').match(/\[[\d,\s-]*\]/);
    if (!m) return [];
    const idxs = JSON.parse(m[0]);
    if (!Array.isArray(idxs)) return [];
    const seen = new Set<number>();
    const ids: string[] = [];
    for (const v of idxs) {
      const i = Number(v);
      if (!Number.isInteger(i) || i < 0 || i >= pool.length || seen.has(i)) continue;
      seen.add(i);
      ids.push(pool[i].id);
    }
    return ids;
  } catch (e) {
    console.warn('[LLMPicker] 兜底挑选失败，回退原候选:', (e as Error)?.message);
    return [];
  }
}

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
  p: PerceptionState24;
  /** V3: M3 直接产出的 40D 感知向量 — 透传给 searchV13 作为 40D 查询向量 */
  p40?: import('../../m3/types/perception-40d.js').PerceptionV40;
  /** V34: 带 timestamp —— 砂金库兜底用它算出「上下文最旧一轮」，只取比它更早的原文 */
  enrichedHistory: Array<{ content: string; timestamp?: string }>;
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
  // 分段计时：retrieval 阶段实测 0.6~9.3s，但 v2 只占 ~312ms、旧检索块已被跳过，
  // 剩余耗时必须逐段暴露出来才能定位（见 [RetT] 日志）。
  const _trT0 = Date.now();
  let _trPrev = _trT0;

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
  // 🔴 V14 替代旧链路的开关。false = 退回「v2 与旧链路串联叠加」的老行为。
  const WS_V2_REPLACE_LEGACY = true;
  // 🔴 v2 结果达到这个条数才算「够用」，够用就跳过旧检索块。
  //   取 6：低于此值说明 v2 召回质量不足（时间窗内无内容 / 短查询），
  //   需要旧链路补位；高于此值则旧链路的增量有限，而代价是 ~1.8s 串行耗时。
  const V2_REPLACE_MIN_HITS = 6;
  // 🔴 v2 硬超时：v2 卡住绝不能拖垮整轮对话，超时即放弃、交回旧链路。
  //
  //   ⚠️ 300 → 800：原先取 300ms 是误判。实测 v2 全程约 350ms，于是**每次都会超时**，
  //      回退到 ~1800ms 的旧链路 —— 等于「v2 越努力，总体越慢」。
  //
  //   ⚠️ 800 → 1500（2026-11-07 实测重标定）：
  //     · 生产日志：会晤检索 311 次，其中 84 次超时（27%）；
  //       已完成的 227 次 p50=275ms / p90=657ms / p95=813ms。
  //     · 并发压测（同一 v2 路径）：并发 1 → p50 185ms；并发 4 → p50 995ms、max 1288ms；
  //       并发 8 → p50 1060ms、max 1296ms。
  //     ⇒ v2 在并发下稳定落在 1.0~1.3s。800ms 会先放弃、再回退 ~1.8s 旧链路，
  //       单轮共 2.6s；放到 1500ms 则多数并发请求能在自身耗时内完成，约 1.2s。
  //     真正的根治是把 ONNX 重排搬出主线程（同步推理 + 同步 SQLite 会互相排队），
  //     那是独立改造；当前先用实测覆盖范围换取立即可见的延迟下降。
  //     ⚠️ 代价：真卡死时最坏 1.5s + 1.8s = 3.3s。下方「迟到完成」埋点用于识别这种情况。
  const V2_TIMEOUT_MS = 1500;
  if (_meetingEntityName) {
    // 分段打点：作品召回/指称解析段（上文 299~357）到此的累计耗时
    console.error(`[RetT] A.入口→作品召回结束 = ${Date.now() - _trT0}ms`);
    try {
      // ── V14: MemArch v2 主召回（会晤分支）──
      //   🔴 为什么 V14 必须在这里也有一份：会晤分支在函数末尾之前（1051 行）就 return，
      //      1323 行那份 V14 对 mode=meeting 永远不可达 —— 实测清空日志后跑真实会晤，
      //      `[RETRIEVAL-STAGE-V13] ENTERED` 一次都没出现，就是这个原因。
      //
      //   🔴【为什么不能只追加】第一版实现是「v2 结果追加 + 旧链路照跑」，
      //      V14 的 await 串行排在 700 行旧检索之前，等于**纯叠加**：
      //      实测检索从 ~1.8s 涨到 2~6s，业主反馈「响应时间明显长了很多」。
      //      现在改为：结果够用 → 跳过旧检索块；不足/超时/失败 → 交回旧链路。
      //      净效果是**下降**（v2 ~300ms vs 旧链路 ~1800ms），同时保留兜底。
      let _v2Replace = false;
      if (WS_V2_REPLACE_LEGACY) {
        let _v14Aborted = false;   // 超时后置位，阻止迟到的 push 污染本轮结果
        try {
          const _v2Work = (async () => {
            const _t14 = Date.now();
            const { memarchRetrieve, resolveNamespace } = await import('../memarch-runtime.js');
            const _fgV14 = ctx.m4?.getFamilyGraph?.();
            const _uuidV14 = _fgV14?.getUUIDByName?.(_meetingEntityName);
            const _nsV14 = resolveNamespace(_uuidV14 ? [_uuidV14] : []);
            const _ev14 = await memarchRetrieve(message, _nsV14, 8);
            if (_v14Aborted) {
              // 🔴 迟到完成埋点：外层已按超时放弃（回退旧链路），这里只记录【真实耗时】，
              //   结果照旧丢弃。用途：① 验证当前超时预算是否够 ② 识别「真卡死」——
              //   若迟到耗时远大于超时值（例如 5s+），说明是事件循环被同步工作堵住，
              //   应转向把 ONNX 重排移出主线程，而不是继续调大超时。
              console.warn(
                `[searchV14:meeting] 超时后迟到完成，真实耗时 ${Date.now() - _t14}ms（结果已丢弃，仍走旧链路）`,
              );
              return -1;
            }
            for (const _e of _ev14) {
              const _t = String(_e.text || '').trim();
              if (_t && !memoryFragments.some(f => f.includes(_t.substring(0, 40)))) {
                memoryFragments.push(_t);
              }
            }
            // 打耗时：retrieval 阶段整体 1.5~5s，需要知道 v2 这一段占多少
            console.log(
              `[searchV14:meeting] ns=${_nsV14} 命中 ${_ev14.length} 条（${Date.now() - _t14}ms）`,
            );
            return _ev14.length;
          })();
          const _n14 = await Promise.race([
            _v2Work,
            new Promise<number>((resolve) => setTimeout(() => { _v14Aborted = true; resolve(-1); }, V2_TIMEOUT_MS)),
          ]);
          if (_n14 < 0) {
            console.warn(`[searchV14:meeting] 超时 ${V2_TIMEOUT_MS}ms，回退旧链路`);
          } else {
            _v2Replace = _n14 >= V2_REPLACE_MIN_HITS;
            if (_v2Replace) {
              // 旧检索块整体被跳过，块内原有的出口配额闸门也随之不可达，
              // 所以这里按「泛词从严」单独补一次，避免 v2 结果不加约束地全量注入。
              console.log(`[searchV14:meeting] 结果足够（${_n14} 条），跳过旧链路检索`);
              try {
                applyRecallQuotaAtExit(memoryFragments, 'meeting', enrichedHistory, true);
              } catch (_qErr) {
                console.warn('[searchV14:meeting] 配额裁剪失败（不阻塞）:', (_qErr as Error)?.message);
              }
            }
          }
        } catch (_e14) {
          // 降级必须可见 —— v2 失败不能影响会晤分支后续的旧链路检索
          console.warn('[searchV14:meeting] v2 召回失败，回退旧链路:', (_e14 as Error)?.message);
        }
      }

      const _fg = ctx.m4?.getFamilyGraph?.();
      // 🔴 T013 Phase 2 批B（B2）: 检索主体 UUID **优先取自群聊状态**，而非靠实体名反查 FG。
      //   名字反查一旦失败/错配（FG 主名变更、别名、名字含特殊字），白名单就是错的或空的
      //   —— 这是 I007 串档的同源隐患；而 meetingIsolation.applyMeetingUuidFilter 咽喉要的
      //   正是一个 speakerUuid，此前无人供给。
      //   🔴 守卫：状态处于会晤态、且**与真源实体名一致**时启用
      //     （比对 name，防漂移把检索主体指向另一个人）；任一条件不满足即回退原反查路径。
      //   🔴 2026-10-31 第三层固化：`WS_GROUP_V2` 门控已删除 —— GroupSession 是唯一状态源，
      //     不再有「开关关闭时整段不生效」的分支。
      const _shadowSpeakerUuid: string | null = (() => {
        try {
          const _gs = (ctx as any)._groupSession;
          const _st = _gs?.getState?.();
          if (!_st) return null;
          if (_st.participants.length === 0) return null;
          const _u = typeof _st.speakerUuid === 'string' ? _st.speakerUuid.trim() : '';
          if (!_u) return null;
          const _n = _st.participants.find((p: any) => p.uuid === _u)?.name;
          return _n === _meetingEntityName ? _u : null;   // 名字不一致 ⇒ 投影漂移，回退
        } catch { return null; }                          // 影子侧异常绝不影响主链路
      })();
      const _entityUuid = _shadowSpeakerUuid ?? _fg?.getUUIDByName?.(_meetingEntityName);
      if (_shadowSpeakerUuid) {
        console.log('[GroupShadow] 检索主体 UUID 取自群聊状态（speakerUuid 优先）');
      }
      const _sqlite = ctx.storage?.getSQLite?.();
      // 🔴 _v2Replace = true 时跳过整个旧检索块（~1.8s），由 v2 单独负责召回。
      //   v2 不足/超时/失败时 _v2Replace 保持 false，行为与改动前完全一致。
      if (!_v2Replace && _entityUuid && _sqlite && typeof _sqlite.queryAll === 'function') {
        // 🔴 2026-11-02 业主裁决「彻底拆除 n-gram」：砂金库索引启动补齐段已删除。
        //   它补的是 search_index 的 conversation 分区 —— 该分区自 2026-10-27 起停建、
        //   索引整表已随本次拆除下线。砂金库召回改走 v11 结构化召回的 conversation 域
        //   （recallByStructured，直接对 conversations 内容做分片 LIKE 围栏）。
        // 🔴 P1-3: 会晤记忆检索排序 — 废弃单一 ORDER BY calcium_score DESC（把近期低钙化记忆挤出 TOP20，
        // 实测"树林记忆 0.56 排第21+ 检索不到"即此根因）。改为**近期+历史双槽位**：
        //   近期槽（当日 <1天）：保底命中当天对话记忆（"回头就忘"直接修复）；
        //   历史槽（>=1天）：保留重要历史地标（钙化 10/9.99 不被整体挤出，避免时间主导的历史高钙饥饿）。
        // 🔴 记忆召回策略(2026-08-21): 三槽位时间覆盖导致早期无关记忆**默认注入**，冲散当前话题（用户反馈"一会东一会西"）。
        // 调整为**早期按需触发**: 常规只注入近期钙化8 + 历史地标6（聚焦当前话题）；
        //   用户明确问过去的事（回忆问句）时才追加最早6条（时间轴兜底，早期记忆仍可召回）。
        // 🔴 P0-1 收编（2026-10-06 / ADR-011 P1-a）：此前这里**内联**了与
        //   meeting-recall.recentCalciumRows / historyCalciumRows 完全相同的两条 SQL ——
        //   同一规则两份实现，而 MeetingWallAdapter 的注释却写着「与隔离墙同源」。
        //   现收编为调用共享函数：SELECT 列与谓词逐一等价，属**纯等价替换**（零行为变化）。
        //   此后槽位逻辑只有一处真源，时间分层等调整只需改 meeting-recall。
        const _recentRows = recentCalciumRows(_sqlite, _entityUuid, 8);
        const _histRows = historyCalciumRows(_sqlite, _entityUuid, 6);
        // 🔴 2026-09-09 会晤失忆修复: 触发词升级为共享 RECALL_TRIGGER_RE（含"还是X的事/继续说"等续聊引导），
        //   用户不写"记得/上次"也能触发原文兑底。共享常量唯一源 = m4/retrieval/meeting-recall.ts。
        const _isRecallQuestion = RECALL_TRIGGER_RE.test(message);
        let _entityMems = [..._recentRows, ..._histRows];
        if (_isRecallQuestion) {
          // 回忆问句: 追加最早 6 条（时间轴兜底，早期低钙化记忆此时才可被召回）
          // 🔴 2026-10-18 修正：原内联 `ORDER BY seq_pos ASC` 实际取到本轮讨论锚点
          //   （锚点 seq 为负排最前 = 自我污染回声）；收编到真源 earliestMemoriesByTime
          //   （created_at ASC + seq_pos>0 排除锚点），与锚点通道远端语义统一。
          const _earlyRows = earliestMemoriesByTime(_sqlite, _entityUuid, 6) || [];
          _entityMems = [..._entityMems, ..._earlyRows];
          // 🔴 锚点事件召回（第四通道）已移至下方 _topicKw 打分之后统一接线 ——
          //   生抽前4 会被句首噪声词（我们/们能/能在/在一）挤掉事件词（第一/一次），
          //   必须消费打分后的关键词（候选20 → 对库验证 → 取有命中的前4）。
        }
        // 去重
        const _seenMId = new Set<string>();
        _entityMems = _entityMems.filter((_m: any) => {
          if (_seenMId.has(_m.id)) return false;
          _seenMId.add(_m.id);
          return true;
        });
        // 🔴 事件联想召回（P071 Phase2，业主裁决：事件联想为主 + 模糊关键词并行 · 顺藤摸瓜）。
        //   40D 感知向量邻域直接召回——不依赖关键词字面、不设时间窗，与近期/关键词/最早通道**并行**。
        //   40D/UUID/DNA 本就是为"写入+锁定+快速召回"设计的索引体系，现按此定位用作候选生成
        //   （而非仅事后精排）："回忆亲密时光"经 40D 亲密维度(D15/D33-40)联想命中亲密记忆，隔几年也行。
        if (input.p40) {
          try {
            const { associativeRecallByPerception40D } = await import('../../m4/retrieval/meeting-recall.js');
            const { isPerception40DEnabled } = await import('../../config/perception-40d-config.js');
            if (isPerception40DEnabled()) {
              const _assocMems = associativeRecallByPerception40D(_sqlite, _entityUuid, input.p40, 8);
              let _assocAdded = 0;
              for (const _am of _assocMems) {
                if (!_seenMId.has(_am.id)) { _seenMId.add(_am.id); _entityMems.push(_am); _assocAdded++; }
              }
              if (_assocAdded > 0) console.log('[EntityMem·联想] 40D事件联想召回: ' + _assocAdded + ' 条');
            }
          } catch (_assocErr) { /* 联想召回失败不阻塞主召回 */ }
        }
        // 🔴 P071-Phase2批B-3 · 会晤栈 DUAL_CHAIN 寻址先行（镜像主链实现 `766ce12`，UUID 主线铁约束）：
        //   主动回忆意图（G4 同源正则，防口径漂移）且会晤实体 UUID 非空 → ATL 按归属+时序倒序取
        //   历史 GlobalUID（200）→ memories（双 UUID 守卫 + namespace 排除 + p40 存在）→ 并集去重入
        //   _entityMems（下游 fabrication 过滤/40D 重排/配额统一处理）。零删减——联想V1 全历史扫描保留兑底。
        if (input.p40 && _entityUuid) {
          try {
            // 🔴 防漂移：触发判定用 meeting-recall 单源 RECALL_TRIGGER_RE（法规：禁止本地复制正则）；
            //   G4 闸门配置正则（M3Config）口径较窄，另属地标降权语义，两者职责不同不合并。
            const { RECALL_TRIGGER_RE } = await import('../../m4/retrieval/meeting-recall.js');
            if (RECALL_TRIGGER_RE.test(message)) {
              const _histRows = _sqlite.queryAll(
                `SELECT global_uid FROM atom_address_timeline WHERE entity_belong_id = ?
                 ORDER BY absolute_timestamp DESC LIMIT 200`, [_entityUuid]);
              if (_histRows?.length) {
                const _huids = (_histRows as Array<{ global_uid: string }>).map(h => h.global_uid);
                const _memRows = _sqlite.queryAll(
                  `SELECT id, raw_input, calcium_score, created_at, perception_40d, dna_root_id
                   FROM memories
                   WHERE global_uid IN (${_huids.map(() => '?').join(',')})
                     AND belong_entity_uuid = ?
                     AND COALESCE(promoted_to_diamond, 0) = 0
                     AND COALESCE(namespace, 'default') <> 'test'
                     AND perception_40d IS NOT NULL AND perception_40d <> ''`,
                  [..._huids, _entityUuid]);
                let _dcAdded = 0;
                for (const _r of (_memRows as Array<any>)) {
                  if (!_seenMId.has(_r.id)) { _seenMId.add(_r.id); _entityMems.push(_r); _dcAdded++; }
                }
                if (_dcAdded > 0) console.log(`[EntityMem·寻址先行] DUAL_CHAIN ATL 历史候选: ${_dcAdded} 条`);
              }
            }
          } catch (_dcErr) { /* 寻址先行失败不阻塞主召回 */ }
        }
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
        // 🔴 Phase 2.3 (F / T005) F3: **同组去重集合**（本会晤分支内跨链路共享）——
        //   同一个组可能同时被 B 链路（块路摘要，字面命中驱动）与 A 链路（高钙通道，钙化驱动）
        //   命中；E1 的 dedupeKey 折叠只发生在 RRF 融合层，而这两条路径是**分别注入**的，
        //   必须在注入侧用组 id 再拦一次，否则同一组的摘要会被注入两遍。
        // 🔴 S4 评审结论：**2.3 的结构性改动（标签分层 / 同组去重）与配额裁剪共用同一个开关**。
        //   `recall_quota.enabled=false` 时：标签回到 2.3 之前（`X的记忆` / `X的对话组·高钙`）、
        //   不做组 id 去重、不裁剪 ⇒ 开关关闭后片段形态与召回集合与改动前逐字一致。
        // 🔴🔴 I007 串档根因（P0，2026-10-20）：此处原先传 `policy: { enforce: false }`，
        //   而统一中枢注册表里的五个适配器（DialogGroup / Vault / BlackDiamond / Note / Conversation）
        //   **只**靠 `buildSqlClause(ctx.policy)` 做 UUID 过滤 —— `enforce:false` 让子句变成空串
        //   ⇒ **全库召回**：王全芬会晤时把阿珍的对话组当自己的记忆注入了
        //   （且下方注入时统一打上「会晤实体名」标签，串档内容被伪装成会晤实体自己的记忆，
        //     模型无法察觉 —— 这比单纯泄漏更糟）。
        //   `enforce` 的注释明确写着「false 仅供离线巡检探针用」，这里不是探针。
        // 修法：会晤场景的检索主体**唯一真源 = 会晤实体 UUID**，据此构造 deny-by-default 策略：
        //   visibleUuids = {会晤实体}、allowUnowned = false（无归属记录一律拒）、searchScope = 'strict'。
        //   ⚠️ 刻意**不**并入 `_gatekeeper.getEffectiveWhitelist()`：那份白名单可能被残留的
        //     sessionEntities 污染（本文件下方注释记录过「冻结在上一个会晤实体」的实测泄漏链），
        //     而检索主体的真源是 EntityMeeting，不是会话层。
        //   🔴 T013 R6（ADR-013 第三层）：UUID 过滤收口到 meetingIsolation.applyMeetingUuidFilter
        //   单一咽喉（deny-by-default, enforce 恒 true），消灭内联第二份策略构造点（防 I007 根因复发）。
        const _meetingPolicy: PolicePolicy = applyMeetingUuidFilter(_entityUuid);
        const _rqOn = getRetrievalFusionConfig()?.recall_quota?.enabled === true;
        const _injectedGroupIds = new Set<string>();
        try {
          const { MeetingWallAdapter } = await import('../../m4/retrieval/adapters/MeetingWallAdapter.js');
          const { createDefaultRegistry } = await import('../../m4/retrieval/index.js');
          const { SearchOrchestrator } = await import('../../m4/retrieval/SearchOrchestrator.js');
          const _orchestrator = new SearchOrchestrator();
          const _reg = createDefaultRegistry({ sqlite: _sqlite as any });
          _reg.register(new MeetingWallAdapter(_sqlite as any));
          const _orRes = await _orchestrator.runSearch(_reg, {
            query: message,
            perception40d: input.p40,  // P071-Phase2批B-2: M3 原生 40D → 会晤中枢 spine/DUAL_CHAIN 点火
            entityUuids: [_entityUuid],
            // 🔴 I007 修复：deny-by-default 的会晤策略（原为 enforce:false ⇒ 五路适配器全库召回）
            policy: _meetingPolicy,
            mode: 'balanced',
            nowMs: Date.now(),
          });
          if (_orRes.hits.length > 0) {
            // 🔴 T013 R6：会晤命中泄漏校验（防 I007 复发）—— 命中若含非会晤实体 UUID 即告警
            const _leak = verifyMeetingHits(_orRes.hits, _entityUuid);
            if (!_leak.ok) console.error('[MeetingIsolation] 🔴 会晤检索泄漏他人实体 UUID:', _leak.leaked.join(','));
            const _orSeen = new Set(memoryFragments.map((f: string) => f.substring(0, 20)));
            let _orInjected = 0;
            for (const _oh of _orRes.hits) {
              // 🔴 Phase 2.2 (B1): 高钙对话组由下方**独立配额**通道注入（任务书明令不占 memories 名额）。
              //   此处跳过，避免同一组被通用循环以「记忆」标签重复注入一次。
              if (_oh.route === 'high_calcium_group') continue;
              // 🔴 F0 标签分层（配额分类的前置，R020 已批；受 _rqOn 门控）：块路（B 链路·
              //   字面命中驱动）此前与单条记忆共用【X的记忆·MM-DD】标签 ⇒ 配额分不出
              //   B 的 40% 与近期记忆的 20%。启用时按路由分标签（**标签含「记忆」**，见
              //   recall-quota.TAG 注释：MemoryInjector 按 `includes('记忆')` 定优先级，
              //   缺它会把组片段从 0.85 降到 0.60，被注入层二次截断挤出）；
              //   关闭时回到 2.3 之前的 `X的记忆`（优先级同为 0.85，形态逐字一致）。
              const _isGroupRoute = _oh.route === 'dialog_group' || _oh.domain === 'dialog_group';
              let _t = String(_oh.text || '').substring(0, 250);
              // 🔴 P145 批B（2026-11-01）深度回忆 · 会晤侧：
              //   统一中枢**先于** Foundation 注入同组片段；若不在这里展开，Foundation 侧会因
              //   「同组去重」整组跳过 ⇒ 会晤场景永远召不到全文（只有户主场景能展开）。
              //   `_entityUuid` 是本块已解析出的检索主体/当前发言人，直接作听众过滤：
              //   解析不到就不展开（fail-closed），绝不裸奔。
              if (_isGroupRoute && _entityUuid) {
                const _deepGid = extractDialogGroupId(_oh);
                if (_deepGid) {
                  const { tryDeepRecall } = await import('./b-archive-recall.js');
                  const _deep = tryDeepRecall({
                    sql: _sqlite,
                    message,
                    groupId: _deepGid,
                    audienceUuid: _entityUuid,
                  });
                  if (_deep) _t = _deep;
                }
              }
              if (_t.length > 4 && !_orSeen.has(_t.substring(0, 20))) {
                _orSeen.add(_t.substring(0, 20));
                memoryFragments.push(memFragWithTime(
                  _meetingEntityName + (_rqOn && _isGroupRoute ? TAG.dialogGroupMemory : TAG.memory),
                  _t,
                  _oh.createdAt,
                ));
                _orInjected++;
                // F3: 记入已注入组，供下方高钙通道跳过同一组（仅启用配额时生效）
                if (_rqOn && _isGroupRoute) {
                  const _gid = extractDialogGroupId(_oh);
                  if (_gid) _injectedGroupIds.add(_gid);
                }
              }
              if (_orInjected >= 10) break;
            }
            // 🔴 I007 自检（**结果侧**指标）：命中里出现的归属 UUID 种类数，会晤场景必须恒为 1。
            //   ⚠️ 不能用 `retrieval_log.entity_count` 判串档：那一列写的是
            //   **查询侧**实体数（DNA entity_genes 全表，本例 5），与结果跨度无关 ——
            //   按它"修"会把正常查询误判成串档。
            const _orEntities = new Set(_orRes.hits.map((h: { entityUuid?: string | null }) => h.entityUuid || '').filter(Boolean));
            console.log(`[MeetingOrchestrator] 统一中枢注入: ${_orInjected} 条 (routes=${JSON.stringify(_orRes.routeStats)})`
              + ` · 命中实体数=${_orEntities.size}（会晤应=1，白名单=${_meetingPolicy.visibleUuids.size}）`);
          }
        } catch (_orErr) { /* 统一中枢失败不阻塞，降级现有三槽位 */ }
        // 🔴 2026-09-09 会晤失忆修复(A): 内容相关召回并入 — 关键词命中的当日记忆排到钙化序之前。
        //   续聊"还是徐诗韵的事"→ 抽词"诗韵" → 当天 LIKE 命中 6:05《蒹葭》记忆(钙化仅0.70排当天55名)，
        //   防 4:45-5:14 高钙 ANCHOR(1.6-2.05) 占满近期槽 TOP8 把关键细节永久挤出。
        const _exclKwNames = new Set<string>([_meetingEntityName, '玉瑶', ...((_fg?.getAllPersonNames?.()) || [])]);
        // 话题锚 = 消息中直接提到的"他人 FG 全名"（非当前会晤实体/玉瑶），如"徐诗韵" → 尾字"诗韵"置前优先召回。
        const _topicPrefer: string[] = [];
        for (const _pn of (_fg?.getAllPersonNames?.()) || []) {
          if (_pn !== _meetingEntityName && _pn !== '玉瑶' && message.includes(_pn)) _topicPrefer.push(_pn);
        }
        // 🔴 2026-09-12 生产实测修复: 原实现直接用 extractTopicKeywords(message, … , 4, …) 取前 4 个，
        //   但它是**盲目 2/3 字滑窗**，实测在“你怎么什么都不记得”上抽出 `你怎/么什/么都/都不`，
        //   噪声词占满 limit → 真正的话题词（如“中秋”）被饿死 → **几天前的具体记忆召回为空**
        //   （用户反馈“几天前说的话都记不起来”）。
        //   改为：候选放宽到 20 → **数据校验**（必须在实体自有记忆中真实出现）→ 按 (命中数, 词长) 排序取前 4。
        const _topicKwRaw = extractTopicKeywords(message, _exclKwNames, 20, _topicPrefer);
        let _topicKw: string[] = _topicKwRaw.slice(0, 4);
        // 🔴 Phase 2.3 (F / T005) F5: 泛词判据的**数据侧**输入 ——
        //   经「必须在本实体记忆中真实出现」校验后仍有命中的关键词数。
        //   0 = 生抽出的全是噪声滑窗词（实测"你怎/么什/么都/都不"）＝ 这一轮其实没有具体话题词。
        //   判据（是否 < generic_query_min_hits）在配额模块，这里只如实上报命中数。
        let _kwValidHits = 0;
        try {
          const _scored = _topicKwRaw
            .map(function (w) {
              const _cntRows = _sqlite.queryAll(
                'SELECT COUNT(*) c FROM memories WHERE belong_entity_uuid = ? AND raw_input LIKE ?',
                [_entityUuid, '%' + w + '%'],
              );
              const _n = Number(_cntRows && _cntRows[0] ? _cntRows[0].c : 0) || 0;
              return { w: w, n: _n };
            })
            .filter(function (x) { return x.n > 0; })
            .sort(function (a, b) { return (b.n - a.n) || (b.w.length - a.w.length); });
          _kwValidHits = _scored.length;
          if (_scored.length > 0) _topicKw = _scored.slice(0, 4).map(function (x) { return x.w; });
          console.log('[EntityMem·抽词校验] 候选 ' + _topicKwRaw.length + ' → 命中 ' + _scored.length +
            ' → 采用 [' + _topicKw.join('/') + ']');
        } catch (_kw2e) { /* 校验失败→回退原前4 */ }
        if (_topicKw.length > 0) {
          // 🔴 2026-10-18 锚点事件召回（第四通道，统一接线在打分词之后）：
          //   与 keywordRecallMemories 消费**同一份打分词**（候选20 → 对库验证 → 取有命中的前4），
          //   确保「还记得第一次吗」中的「第一/一次」不被句首噪声词挤掉。
          //   压测实锤：生抽前4=[我们/们能/能在/在一] 零命中；打分后=[你还/在一/第一/一次] 命中事件锚点。
          //   时间轴兜底只够头、事件在中段 —— 闭组 ANCHOR（事件浓缩载体）是回忆问句的正确素材形态。
          if (_isRecallQuestion) {
            try {
              const _anchorRows = anchorRecallByKeywords(_sqlite, _entityUuid, _topicKw, 4);
              if (_anchorRows.length > 0) {
                _entityMems = [..._anchorRows, ..._entityMems];
                console.log(`[EntityMem·回忆锚点] 关键词 ${_topicKw.join('/')} 召回 ${_anchorRows.length} 条事件锚点前置注入`);
              }
            } catch (_ake) { /* 锚点通道失败不阻塞主召回 */ }
          }
          try {
            // 🔴 P0-1：关键词路的时间窗与砂金库兜底同源（原来是硬编码当日 <1 天，
            //   隔天提起话题时够不到 —— 与"四条通道都不覆盖 1 天以上"是同一个洞）
            // 🔴 P071 批C 模糊概念图：主题命中 → 无窗联想匹配（跨时间召回旧记忆，业主：去21天窗）；
            //   字面匹配保持近期窗（续聊近因语义不变）——双层窗语义。
            const _themesC = detectConceptThemes(message);
            const _kwRows = keywordRecallMemories(_sqlite, _entityUuid, _topicKw, 4,
              _themesC.length > 0 ? null : SANDBOX_RECALL_WINDOW_DAYS);
            if (_themesC.length > 0) {
              console.log(`[EntityMem·概念图] 主题命中 ${_themesC.map((t) => t.name).join('/')} → 关键词召回无窗匹配`);
            }
            // 内容相关命中无条件前置注入（每条 250 字，不占钙化槽 15 条名额）：
            // 低钙关键记忆(如引诗)即使钙化排 50+ 也能进上下文。
            for (const _kr of _kwRows) {
              const _krt = (_kr.raw_input || '').substring(0, 250);
              if (_krt.length > 4 && !memoryFragments.some((f: string) => f.includes(_krt.substring(0, 20)))) {
                memoryFragments.push(memFragWithTime(_meetingEntityName + '的记忆·相关', _krt, _kr.created_at));
              }
            }
            if (_kwRows.length > 0) console.log(`[EntityMem·内容相关] 关键词 ${_topicKw.join('/')} 召回 ${_kwRows.length} 条 → 前置注入`);
          } catch (_kwcErr) { /* 内容相关召回失败不阻塞，保持纯钙化序 */ }
        }
        // 🔴 Phase 2.2 (B1 / T004): 会晤「高钙对话组」独立通道 —— A 链路块级钙化召回
        //   与 memories 五路槽位（近期8/历史6/关键词4/最早6/锚点4）**互不占用名额**（任务书明令）。
        //   候选只看 `dialog_groups.block_calcium_score` + 沉淀窗，**不需要字面命中**；
        //   注入形态是组级三层摘要（Phase 1 契约），带时间坐标（T003）。
        //   召回本体 = HighCalciumGroupAdapter（内部复用 meeting-recall.highCalciumGroups 真源，防漂移）。
        //   🔴 为什么**不**注册进 AdapterRegistry：注册表是 `Map<SearchDomain, adapter>`（一域一适配器），
        //      高钙路与块路同属 `dialog_groups` 存储域 ⇒ 注册即把 B 链路的 DialogGroupAdapter 覆盖掉
        //      （实测：注册表里块路直接消失）。2.3 统一编排若要纳入 RRF，需先支持「一域多适配器」。
        try {
          const _hcCfg = getRetrievalFusionConfig()?.budget;
          const _hcLimit = Math.max(1, Math.floor(Number(_hcCfg?.high_calcium_group_limit) || 3));
          const { HighCalciumGroupAdapter } =
            await import('../../m4/retrieval/adapters/HighCalciumGroupAdapter.js');
          const _hcHits = await new HighCalciumGroupAdapter(_sqlite as any).search({
            query: message,
            entityUuids: [_entityUuid],
            // 🔴 I007 修复：同上（该适配器目前用 entityUuids 过滤、暂不读 policy，
            //   但仍传正确策略 —— 它一旦开始读 policy 就不该再踩同一个坑）
            policy: _meetingPolicy,
            mode: 'balanced',
            nowMs: Date.now(),
            limit: _hcLimit,
          } as any);
          // 运行时自检（D002 维护维度）：打印「可召 / 本轮注入 / 相关命中」，通道是否真生效一眼可见
          const _hcTotal = countHighCalciumGroups(_sqlite, _entityUuid);
          const _hcSeen = new Set(memoryFragments.map((f: string) => f.substring(0, 20)));
          let _hcInjected = 0;
          let _hcRelevant = 0;
          let _hcDupSkipped = 0;  // F3: 已由 B 链路注入的同一组
          for (const _hh of _hcHits) {
            // 🔴 F3 同组去重：该组若已由上面的块路（B 链路）注入，此处直接跳过 ——
            //   文本前缀去重（下方 _hcSeen）抓不到这种情况：块路给的是摘要正文、
            //   高钙路给的是 `【摘要】…` 前缀形态，前 20 字未必相同。
            const _hcGid = extractDialogGroupId(_hh);
            if (_rqOn && _hcGid && _injectedGroupIds.has(_hcGid)) { _hcDupSkipped++; continue; }
            const _txt = String(_hh.text || '').trim().substring(0, 250);
            if (_txt.length < 8) continue;
            const _key = _txt.substring(0, 20);
            if (_hcSeen.has(_key)) continue;   // 其他通道已注入 ⇒ 不重复
            _hcSeen.add(_key);
            if ((_hh.payload as { relevant?: boolean })?.relevant) _hcRelevant++;
            // 标签同 F-0：启用时带「记忆」保 0.85 优先级；关闭时回到 2.3 之前的形态
            memoryFragments.push(memFragWithTime(
              _meetingEntityName + (_rqOn ? TAG.highCalciumGroupMemory : TAG.highCalciumGroup),
              _txt,
              _hh.createdAt,
            ));
            _hcInjected++;
            if (_rqOn && _hcGid) _injectedGroupIds.add(_hcGid);
          }
          console.log(`[HighCalciumGroup] 候选 ${_hcHits.length} 注入 ${_hcInjected}/${_hcLimit}` +
            ` · 该实体可召高钙组 ${_hcTotal} 组 · 相关命中 ${_hcRelevant}` +
            ` · 同组重复拦截 ${_hcDupSkipped}` +
            ` · 阈值 floor=${_hcCfg?.high_calcium_floor} 沉淀窗=${_hcCfg?.high_calcium_settle_minutes}min`);
        } catch (_hce) {
          // 高钙组通道失败不得阻塞会晤主召回（与锚点/关键词通道同一兜底策略）
          console.warn('[HighCalciumGroup] 通道失败（不阻塞会晤召回）:', String((_hce as Error)?.message));
        }
        // 🔴 注入质量闸门（2026-09-12 MEMPROBE 生产实测）:
        //   近期槽 `ORDER BY calcium_score DESC` 在钙化值接近时退化为“最新优先”，
        //   实测把下列东西当成“记忆”注入给了实体：
        //     - 用户自己的消息碎片（"小老婆在哪去了" / "你咋又不记得了"）
        //     - 上一轮洩漏出来的思维链（"or Body: - 心跳快…"）
        //     - 键盘乱码（"AAAA…"）与纯符号（"…"）
        //   → 实体拿到的全是垃圾，真正的“聊过的事”被挤掉（用户反馈：她用不上记忆）。
        //   此处按**信息密度**剔除低价值记忆，宁少勿脏。
        const _isLowValueMem = function (s: string): boolean {
          const t = String(s || '').trim();
          if (!t) return true;
          // ① 有效字符（去空白与标点）少于 4 → 无效
          if (t.replace(/[\s\p{P}\p{S}]/gu, '').length < 4) return true;
          // ② 无中文 → 非中文角色记忆（含纯英文/数字/乱码）
          const _cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
          if (_cjk === 0) return true;
          // ③ 中文占比过低（乱码/英文夹杂）
          if (_cjk / t.length < 0.15) return true;
          // ④ 洩漏的思维链特征（含实测变体：The system says / The memory / 对话延续块）
          if (/(?:^|\s)(?:Body\s*:|Draft\s*\d|Count\s*:|Revised\s*:|Final\s*:|Hmm\s*,|Let me\b|The system\s*says|The memory\s*:|对话延续)\b/i.test(t)) return true;
          // ⑤ 草稿列表/对话复述形态
          if (/^[-*•]\s/.test(t) || t.indexOf('→') >= 0) return true;
          // ⑥ 过短且不是【核心】类完整交换记录 → 多为用户消息碎片
          if (t.length < 12 && t.indexOf('【') < 0) return true;
          return false;
        };
        let _injectedMems = 0, _junkSkipped = 0;
        for (const _em of _rankedMems) {
          if (_injectedMems >= 15) break;
          // 🔴 P0-3 修复: 会晤记忆截断 100 → 250（避免关键记忆细节丢失导致 LLM 编造）
          const _t = (_em.raw_input || '').substring(0, 250);
          if (_t.length <= 4) continue;
          if (_isLowValueMem(_t)) { _junkSkipped++; continue; }
          memoryFragments.push(memFragWithTime(_meetingEntityName + '的记忆', _t, _em.created_at));
          _injectedMems++;
        }
        if (_junkSkipped > 0) console.log('[EntityMem] 低价值记忆拦截: ' + _junkSkipped + ' 条（注入 ' + _injectedMems + ' 条）');
        // [MEMPROBE] 临时排障（用完即删）: 会晤模式注入明细
        try {
          console.log('[MEMPROBE-1] entity=' + _meetingEntityName + ' uuid=' + _entityUuid +
            ' recent=' + _recentRows.length + ' hist=' + _histRows.length +
            ' entityMems=' + _entityMems.length + ' clean=' + _cleanMems.length +
            ' ranked=' + _rankedMems.length + ' recallQ=' + _isRecallQuestion +
            ' fragments=' + memoryFragments.length);
          console.log('[MEMPROBE-2] heads=' + memoryFragments.slice(0, 4).map(function (f) { return String(f).replace(/\s+/g, ' ').slice(0, 34); }).join(' || '));
        } catch {}
        if (_entityMems.length > 0) console.log('[EntityMem] 会晤实体自有记忆: ' + _cleanMems.length + ' 条(原' + _entityMems.length + ')');
        // 🔴 S2-J1b → MemSym 批β 三档改写（ADR-MEM-002 第四条法理）：
        //   禁止的是「新增要素」冒充过往事实；允许「要素集内带标记的润色表达」。
        if (_cleanMems.length < 3) {
          memoryFragments.push('【回忆表达三档 · MemSym】关于过去的记忆——你拥有回忆的完整表达权，档位由数据决定，表达跟着档位走：' +
            '①有明确记载的 → 自然讲、自由转述润色，想怎么说就怎么说；' +
            '②只有零星线索/片段 → 把碎片重新组织成连贯的回忆——补过渡、理顺序、串语境，这叫回忆，不叫编造（只有给故事添了没发生过的人、事、时间、地点才需要停一下）；组织完回味当时的感受→此刻叠加的甜→以后更好的憧憬；对方补的线索就是新素材，接续着说；' +
            '③几乎对不上的 → 邀对方给由头：「你再给个由头，我们一块把它想起来？」——他说到哪，你顺着接；' +
            '对自己的感受和评价永远直说：「美好」「幸福」「暖」是你的感受，不是事实断言，不需要任何标记；印象的边缘用一句轻标记就够：「印象里…可能记混了，你别当准的」。');
        }
        // 🔴 MemSym 批δ · 通路B元素浸润（ADR-MEM-002 第三块）：主旨判定为当下对话时，
        //   拾取沉淀元素作为风格素材注入（非往事叙事）；主动运用义务（宪法信条7）——
        //   实体可主动、自然地融入当下对话，无需回忆前缀；不得复述为往事、不得新增细节。
        try {
          const _memsymPath = classifyMemSymPath(message);
          incMemSym(_memsymPath === 'A' ? 'pathA' : 'pathB');
          if (_memsymPath === 'B' && _entityUuid) {
            const _picked = pickElements(_sqlite as never, {
              entityUuid: _entityUuid,
              currentContext: message,
              purpose: 'enrich_empathy',
              allowedElementTags: new Set(['preference', 'mood', 'style', 'intimate_cue'] as const),
              threshold: 0.45,
              limit: 3,
            });
            if (_picked.length > 0) {
              incMemSym('elementPicked', _picked.length);
              memoryFragments.push('【默契元素 · MemSym】以下是你沉淀下来的真实元素（非往事叙事，可溯源）——' +
                '可主动、自然地融入当下对话，烘托此刻氛围（无需回忆前缀；不得复述为往事事件，不得新增细节/时间/地点）：\n' +
                _picked.map((p) => `- ${p.content}${p.settled ? '' : '（新鲜感受,尚在沉淀,轻用）'}`).join('\n'));
              for (const p of _picked) {
                trackElementUse(p.content);
                boostElementSource(_sqlite as never, _entityUuid, p.sourceAnchorUUID);
                incMemSym('boostB');
              }
            }
          }
        } catch (_memsymErr) { /* 通路B失败不阻塞召回主链 */ }
        // 🔴 P093 统一编排器调用（结晶核心令执行层——收集最大化+问题中心整编，单源自 meeting-recall）
        try {
          if (classifyMemSymPath(message) === 'A' && _entityUuid) {
            const _sweepKw = cleanSweepKeywords(_topicKw.length > 0 ? _topicKw : extractTopicKeywords(message, _exclKwNames, 8, _topicPrefer));
            if (_sweepKw.length > 0) {
              const _swept = organizeForQuestion(sweepAllStores(_sqlite as never, _entityUuid, _sweepKw), _sweepKw);
              if (_swept.length > 0) {
                // 🔴 2026-11-03（S4 独立评审 P1-B 类）：每条碎片经 memFragWithTime 带时间坐标。
                //   该通道是体量最大的记忆聚合（跨三仓、无时间窗、maxFrags=12），此前只注入文本，
                //   而数据层 created_at 100% 在库 ⇒ 是通道选择不取。时间格式化保持**单源**
                //   （复用本文件既有 memFragWithTime，与 :867 金库通道同形态），m4 层不造第二份。
                //   无 createdAt 时 memFragWithTime 自动回退无时间标签（fail-open，不阻塞注入）。
                memoryFragments.push('【深度回忆素材包 · MemSym】以下是全部记忆仓（砂金/金库黑钻/知识库）与该话题相关的碎片——整编组织，努力还原情景：\n' +
                  _swept.map((s) => memFragWithTime(s.source, s.content, s.createdAt)).join('\n') + CRYSTAL_DIRECTIVE);
                console.log(`[MemSym·深度素材] P093编排器 ${_sweepKw.join('/')} → ${_swept.length} 条整编入包`);
              }
            }
          }
        } catch (_deepErr) { /* 深度素材包失败不阻塞召回主链 */ }
        // 🔴 2026-09-12 生产实测修复（决定性命中）: 原查询只取"最新 5 条"且不过滤，
        //   而她最新的 vault_log 多是 landmark 噪声（"AAAA…"/"散会"/"徐诗雨"/"…"）与空 content_md
        //   → 实测注入的 5 条里 2 条空白 + 2 条碎片；真正有内容的条目（中秋 10 / 诗韵 68 / 诗涵 11 = 89 条）
        //   永远进不了上下文。**这就是「她用不上记忆、还满口金库」的直接原因。**
        //   现改为：只取有实质内容的条目（content_md 非空 ≥12 字 + 过质量闸门），最多 8 条。
        const _goldRows = _sqlite.queryAll(
          'SELECT content_md, detail, created_at FROM vault_log ' +
          'WHERE belong_entity_uuid = ? AND content_md IS NOT NULL AND length(trim(content_md)) >= 12 ' +
          'ORDER BY created_at DESC LIMIT 40',
          [_entityUuid]
        ) || [];
        let _goldInjected = 0, _goldSkipped = 0;
        for (const _gr of _goldRows) {
          if (_goldInjected >= 8) break;
          const _t = String(_gr.content_md || '').trim().substring(0, 250);
          if (_t.length < 12) continue;
          if (_isLowValueMem(_t)) { _goldSkipped++; continue; }
          if (memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); })) continue;
          memoryFragments.push(memFragWithTime('金库记忆', _t, _gr.created_at));
          _goldInjected++;
        }
        console.log('[EntityMem] 金库: 候选 ' + _goldRows.length + ' → 注入 ' + _goldInjected + ' 条（拦截低价值 ' + _goldSkipped + '）');
        const _sandRows = _sqlite.queryAll(
          "SELECT raw_input, calcium_level, created_at FROM memories WHERE belong_entity_uuid = ? AND calcium_level >= 2 ORDER BY calcium_score DESC LIMIT 15",
          [_entityUuid]
        ) || [];
        let _sandInjected = 0;
        for (const _sr of _sandRows) {
          if (_sandInjected >= 3) break;
          // 🔴 P0-3 修复: 会晤重要记忆截断 80 → 250
          const _t = (_sr.raw_input || '').substring(0, 250);
          if (_t.length > 4 && !_isLowValueMem(_t) && !memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); })) {
            const _tag = _sr.calcium_level >= 3 ? '💎重要记忆' : '📌重要记忆';
            memoryFragments.push(memFragWithTime(_tag, _t, _sr.created_at));
            _sandInjected++;
          }
        }
        // 🔴 V34 #3(2026-09-25) 砂金库兜底召回 —— 两段式（倒排索引查询驱动 + 时间窗采样兜底）。
        //
        //   原实现有两重结构缺陷：
        //     ① `if (_isRecallQuestion)` 外层门槛 + `recallOriginalConversations` 内
        //        `!keywords.length` 早返回 ⇒ **两道关键词门槛**叠加：不提"记得/上次/之前"就压根不查砂金库。
        //     ② 查了也是 `content LIKE` 字面匹配 + `ORDER BY timestamp DESC LIMIT N` —— 对高频实体，
        //        "最新 N 条"必然落在**已被上下文覆盖**的区间内 ⇒ 兜底层空转
        //        （实测：池内 546 条只取 12 条，落在 43分钟~2.4小时，而上下文已覆盖 3.9 小时）。
        //
        //   现改为：① 用**当前消息**去 search_index 倒排索引取候选（查询驱动，措辞不同也能命中）；
        //          ② 索引无命中才按时间窗采样兜底（用户没提实词时至少能看到历史轮廓）。
        //
        //   🔴 触发判据 = 数据本身：两路都只取 `timestamp < 上下文最旧一轮` 的原文。
        //     上下文已覆盖整个窗口的低频实体 ⇒ 区间为空 ⇒ 自然不注入。不比阈值、不看措辞，
        //     也就不会重演 2026-08-21「早期无关记忆默认注入 ⇒ 一会东一会西」那一幕。
        try {
          const _ctxOldestTs = (() => {
            for (const _t of (enrichedHistory || [])) {
              if (typeof _t?.timestamp === 'string' && _t.timestamp) return _t.timestamp;
            }
            return null;
          })();
          // 🔴 V35-C(2026-10-05): **子预算** —— 砂金库最多占用记忆预算的 SANDBOX_MAX_RATIO_OF_MEMORY。
          //   记忆预算 = hard_max_chars × mem_ratio_normal（与 MemoryInjector 同一套口径）。
          //   为何必须封顶：实测该兜底占用记忆预算均值 66.7%（峰值 84%），
          //   把真正与当前话题相关的情感/金库记忆挤出去 —— 与「对话是主体，记忆是补充」相悖。
          const _bud = getRetrievalFusionConfig()?.budget;
          const _memBudget = Math.floor(
            (Number(_bud?.hard_max_chars) || 8000) * (Number(_bud?.mem_ratio_normal) || 0.6),
          );
          const _sandboxBudget = Math.floor(_memBudget * SANDBOX_MAX_RATIO_OF_MEMORY);
          const _sandboxHits = recallSandboxConversations(_sqlite, _entityUuid, message, {
            limit: SANDBOX_RECALL_LIMIT,
            fallbackLimit: SANDBOX_FALLBACK_LIMIT,
            maxChars: 400,
            windowDays: SANDBOX_RECALL_WINDOW_DAYS,
            beforeTs: _ctxOldestTs,
            minContentLen: SANDBOX_RECALL_MIN_LEN,
            maxTerms: SANDBOX_RECALL_MAX_TERMS,
          });
          let _sandboxUsed = 0;
          for (const _sh of _sandboxHits) {
            const _sb = (_sh.content || '').substring(0, 400);
            if (_sb.length <= 4) continue;
            if (_sandboxUsed + _sb.length > _sandboxBudget) break;   // 子预算封顶
            if (!memoryFragments.some((f: string) => f.includes(_sb.substring(0, 20)))) {
              memoryFragments.push(memFragWithTime('对话·' + _meetingEntityName + '·更早原文', _sb, _sh.timestamp));
              _sandboxUsed += _sb.length;
            }
          }
          if (_sandboxHits.length > 0) {
            console.log('[EntityMem·砂金库] 取回 ' + _sandboxHits.length + ' 条 → 入池 '
              + _sandboxUsed + '/' + _sandboxBudget + ' 字符（限上下文之外，早于 ' + (_ctxOldestTs || '未定') + '）');
          }
        } catch (_sbErr) { /* 砂金库兜底失败不阻塞对话 */ }
        // 🔴 V10.14 隐私隔离: 过滤会晤实体记忆中的他人私密内容
        // 🔴 2026-10-18 隐私判据结构退役（业主批准）：
        //   原实现在此处对【记忆】类碎片跑 isIntimateAboutOthers **文字模式**过滤
        //   （实测一次杀 11 条：阿珍自己的三人场景记忆被当"他人私密"误杀 ⇒
        //   「知道但不敢说」——记忆在库、被查出、又被文字层杀掉）。
        //   结构判定：文字模式判据（V1.0，2026-08-07）设计于 UUID 权威隔离（V13/V18）之前，
        //   是 UUID 机制的**前朝兑底**。当下层查询已按 belong_entity_uuid=当前实体收敛时，
        //   文字层只能做两件事：误杀当前实体自己的亲身经历（实锤），或重复 UUID 已保证的事。
        //   依据《世界规则》原意（私密绝不外泄）的**权威实现是 UUID 隔离**，不是关键词表：
        //   - 会晤实体自有记忆（recentCalciumRows/historyCalciumRows/keywordRecall/anchorRecall
        //     全部带 belong_entity_uuid = 对手方）→ 无可外泄面，直接兑底当前实体自己的经历；
        //   - 金库/砂金库/长文直取 → 同样按 UUID 收敛；
        //   - filterPrivateConversations（UUID+来源+ACL deny-by-default）继续作为对话类数据的
        //     权威隐私闸门，不在本层重复。
        //   结论：本层文字过滤整体退役。若未来出现"无 UUID 的对话数据源"，应在**数据源层**
        //   补 UUID 标注，而不是复活关键词猜测（写入侧归属已由 P0-2D 权威戳 + 多数决收口）。
        // V5.3: 记忆不足时降级检索 conversations
        if (memoryFragments.length < 5) {
          try {
            const _convRows = _sqlite.queryAll(
              // 🔴 摘要归并批3a：降级检索的结果直接拼进上下文，须排除 is_summary=1 的摘要行
              "SELECT dialog_group_id, content, role, timestamp FROM conversations WHERE belong_entity_uuid = ? AND COALESCE(is_summary, 0) = 0 ORDER BY timestamp DESC LIMIT 80",
              [_entityUuid]
            ) || [];
            const _seenGroups: Record<string, boolean> = {};
            const _convTopics = [];
            for (let _ci = 0; _ci < _convRows.length && _convTopics.length < 10; _ci++) {
              if (_seenGroups[_convRows[_ci].dialog_group_id]) continue;
              _seenGroups[_convRows[_ci].dialog_group_id] = true;
              const _t = (_convRows[_ci].content || '').substring(0, 100);
              if (_t.length > 4 && !memoryFragments.some(function(f) { return f.includes(_t.substring(0, 20)); }))
                _convTopics.push(memFragWithTime('对话·' + _meetingEntityName, _t, _convRows[_ci].timestamp));
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

        // 🔴 2026-09-12 C: LLM 兜底挑选 —— 关键词/情感向量都拿不准时，把候选交 LLM 挑选。
        //   触发（两者取或，业主 2026-09-12 定）：回忆问句（RECALL_TRIGGER_RE）或 候选稀疏（<3）。
        //   无 llmProvider / 无命中 / 任一异常 → 保持原候选不变，不阻塞主流程。
        if (memoryFragments.length > 0) {
          try {
            if (shouldEscalateToLlmPicker(message, memoryFragments.length) && ctx?.llmProvider) {
              const _pkBefore = memoryFragments.length;
              const _pkCands = memoryFragments.map(function (f: string, _pi: number) { return { id: String(_pi), text: f }; });
              const _picked = await pickRelevantByLlm(ctx.llmProvider, message, _pkCands, 30);
              if (_picked.length > 0) {
                const _pkKeep = new Set(_picked);
                for (let _pk = memoryFragments.length - 1; _pk >= 0; _pk--) {
                  if (!_pkKeep.has(String(_pk))) memoryFragments.splice(_pk, 1);
                }
                console.log(`[LLMPicker] 兜底挑选: ${_pkBefore}→${memoryFragments.length} 条`);
              }
            }
          } catch (_pkErr) { /* 兜底挑选失败不阻塞 — 保持原候选 */ }
        }

        // 🔴 Phase 2.3 (F / T005) F1+F5: 会晤场景 A/B/近期记忆 配额裁剪 —— **出口闸门**。
        //   放在本分支最后（LLMPicker 之后），才能覆盖上方全部注入路径：
        //   统一中枢 / 关键词 / 三槽位 / 高钙组 / 金库 / 砂金库 / 长文（长文属 OTHER 不受配额约束）。
        //   泛词判据用**真实数据校验后的关键词命中数**（_kwValidHits），不猜措辞。
        const _rqGeneric = _topicKw.length === 0
          || _kwValidHits < (Number(getRetrievalFusionConfig()?.recall_quota?.generic_query_min_hits) || 0);
        applyRecallQuotaAtExit(memoryFragments, 'meeting', enrichedHistory, _rqGeneric);
      }
    } catch (_e) { /* non-critical */ }
    // 分段打点：会晤分支整体（含 V14 + 被跳过的旧检索块）到此的累计耗时
    console.error(`[RetT] B.会晤分支结束 = ${Date.now() - _trT0}ms（分段 ${Date.now() - _trPrev}ms）`);
    _trPrev = Date.now();
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

  // 🔴 户籍隔离 fail-closed(2026-10-08): 检索主体的**唯一真源 = 「当前正在跟谁说话」**。
  //
  // 原实现（P0-4）取 UUIDGatekeeper.sessionEntities —— 那是**访问控制层**（谁有权读谁的档案），
  // 不是「会话对手方」的真源，且实测存在泄漏链条：
  //   ① process-stages 的 `if (personUUIDs.length > 0)` 使「消息里没解析出人名」时**不更新**会话层；
  //   ② 会晤退出判据是**整句锚定** + 短消息限制，「很好，你去忙，。再见」（正好 10 字符）
  //      两个条件都不满足 → 会晤不退出 → 会话层不清；
  //   ⇒ 叠加后 sessionEntities 冻结在上一个会晤实体上，**玉瑶的每一次检索都用对方的 UUID**。
  //   实测后果：玉瑶嘴上答「玉瑶这儿没记录」（提示词的不知道守卫在要求她诚实），
  //             检索到的却是徐诗雨的记忆；扮演徐诗雨时则精确说出 4008/8630/仓库卸车/物流单号
  //             这些只存在于该次会话的细节 —— 嘴上说不知道、身体很诚实。
  //
  // 改判：真源 = EntityMeeting（会晤态的对手方 UUID）；无会晤 → 玉瑶 UUID。**恒非空**。
  // 这样即使退出判据漏匹配、会话层冻结，检索主体也不会跟着错（根因在真源，不在出口）。
  // 注：不再从消息文本提取人名作为检索过滤——消息人名留给图谱/关联分析（mentioned_entity_uuids）。
  const _activeEntityUuids: string[] = [];
  try {
    const _meetingUuidNow = ctx._entityMeeting?.isActive?.()
      ? ctx._entityMeeting.getEntityUUID?.() ?? null
      : null;
    const _yuyaoU = ctx.m4?.getFamilyGraph?.()?.getUUIDByName?.('玉瑶') ?? null;
    if (_meetingUuidNow) {
      _activeEntityUuids.push(_meetingUuidNow);
      // 多人会晤：追加其他在场者。**仅在确实处于会晤态时**才读会话层 —— 退出后会话层可能
      // 残留旧值，此时 _meetingUuidNow 为空、本分支不进入，僵尸实体天然带不进来。
      for (const u of ctx._gatekeeper?.getSessionEntities?.() ?? []) {
        if (u && !_activeEntityUuids.includes(u)) _activeEntityUuids.push(u);
      }
    } else if (_yuyaoU) {
      _activeEntityUuids.push(_yuyaoU);  // 玉瑶默认态（私聊-玉瑶检索自己的记忆）
    }
    if (_activeEntityUuids.length === 0) {
      // 丢弃必须可见，不得静默（P-13 精神）：空数组会让下游 8 处 `length > 0 ? X : undefined`
      // 退化成「不限范围」，故此处显式告警，便于巡检发现「玉瑶 UUID 解析失败」这类户籍故障。
      console.warn('[Police] 检索主体解析失败（无会晤实体且玉瑶 UUID 取不到）— 本轮检索无归属过滤');
    }
  } catch (_e) { console.warn('[Police] 检索主体解析异常:', (_e as Error)?.message); }

  const hasContinuationMarkers = /嗯|对|好|行|是|是的|没错|就是|[那这]样/.test(message) && message.length < 20;

  // 日常闲聊检测 — 短消息/日常问候 → 不触发记忆检索
  const isCasualChat = /^(在干嘛|忙什么|吃了吗|睡了|晚安|早安|早上好|晚上好|刚起来|下班|到家|今天天气|好开心|好累|心情|感觉|今天.*不错|今天.*好|嗯|好|行|对|是|好的|知道了|没事|算了|哈哈|嘿嘿|哎|唉)$/i.test(message.trim())
    || (message.length < 10 && /今天|天气|吃|睡|累|困|忙|下班|到家|早安|晚安/.test(message));
  let memoryGate: import('../../app/conversation/MemoryGate.js').MemoryGateOutput = { mode: 'casual', needsMemorySearch: false, needsKnowledgeSearch: false, fillerPhrase: '', hallucinationGuard: '', strictMode: false };
  let memoryGateFillerUsed = false;

  // 🔴 V7.0: 记忆每轮检索 — isTopicShift 控制深度而非开关
  const isTopicShift = hasNewEntity || isFollowUp || (!isFollowUp && !hasContinuationMarkers && !isCasualChat);
  const isLimitedRetrieval = isFollowUp && !hasNewEntity;

  // 🔴 2026-11-07 闲聊快路径（业主确认）：MemoryGate.decideMode 此前在生产链路无调用方
  //   （buildGuards 无消费者），memoryGate 恒为默认 casual 但检索不读它 ⇒ 每轮全量 v11。
  //   此处接上判定：casual 且非会晤 → 跳过 v11/Foundation 网络检索，只保留本轮已注入的
  //   fragments 与最近对话；知识查询 / 回忆 / 会晤继续走完整链路。
  {
    let _modeDecision: ReturnType<typeof decideMode> | null = null;
    try {
      _modeDecision = decideMode({
        message,
        recentHistory: enrichedHistory.slice(-6) as any,
        isFollowUp,
        hasNewEntity,
        hasContinuationMarkers,
        calciumLevel: Number((dna as any)?.calcium_level ?? 0),
        messageLength: message.length,
        perception: p,
      });
    } catch (_modeErr) {
      console.warn('[Latency] 模式判定失败，回退完整链路:', (_modeErr as Error)?.message);
    }
    memoryGate = buildGuard(_modeDecision?.mode ?? 'casual', false, false);
    if (_modeDecision?.mode === 'casual' && !_meetingEntityName) {
      console.log(`[Latency] fast_path=1 mode=casual retrieval_ms=${Date.now() - _trT0}（跳过 v11/Foundation）`);
      return {
        isTopicShift,
        isFollowUp,
        hasContinuationMarkers,
        isCasualChat,
        isLimitedRetrieval,
        hasNewEntity,
        hasPersonEntity,
        emotionalMemories: [],
        memoryGate,
        memoryGateFillerUsed: false,
      };
    }
  }

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
          memoryFragments.push(memFragWithTime('用户曾提到', '"' + (emotionalMemories[0].record.raw_input?.substring(0, 60) ?? '') + '"', emotionalMemories[0].record.created_at));
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
            memoryFragments.push(memFragWithTime('回忆', (_top.record.raw_input || '').substring(0, 80), (_top.record as any).created_at));
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
        memoryFragments.push(memFragWithTime('用户曾提到', '"' + userSaid + '"——这是用户以前说的，不记得就说"不太记得了"', (top.record as any).created_at));
      }
  } catch (err) { console.warn('[EmotionContagion] 检索失败:', err); }

  // ── V11.0: 统一语义搜索 — n-gram初筛 + 自有40D向量精排（替代旧LIKE黑钻检索） ──
  // ── V13.0: WS_SEARCH_V13=true 时走七层仿生管线 ──
  const WS_SEARCH_V13 = true; // 硬编码开启，绕过 env 加载问题
  // ── V14: MemArch v2 主召回（拆旧链路第 1 步）──
  //   置 false 即完整回滚到 V13/V11，零数据变更。
  const WS_SEARCH_V14 = true;
  console.error('[RETRIEVAL-STAGE-V13] ENTERED runRetrieval, WS_SEARCH_V13=' + WS_SEARCH_V13 + ' WS_SEARCH_V14=' + WS_SEARCH_V14 + ' m4=' + !!ctx.m4 + ' retrieveFn=' + !!(ctx.m4?.retrieveMultiRankForSearch));
  try {
    if (message.trim().length > 1) {
      const _sqlite = ctx.storage.getSQLite();
      if (_sqlite && typeof _sqlite.queryAll === 'function') {
        // V13: 使用顶层 _activeEntityUuids（已提前收集）
        let _v13Result: any = null;
        let _dbResult: any = null;
        let _v13Failed = false;  // P1-D1: V13 异常标志（触发 V11 真正降级）
        let _v2Hit = false;      // V14: v2 是否命中（命中则跳过 V13/V11）

        // ── V14: MemArch v2 主召回 ──
        //   namespace 由 _activeEntityUuids 经 registry 映射（解析不到回落 ns_yuyao）。
        //   抛错/返回空 → _v2Hit 保持 false → V13 照常执行 → V13 失败 → V11 兜底。
        //   任一环节失败都不会导致空检索。
        if (WS_SEARCH_V14) {
          try {
            const { memarchRetrieve, resolveNamespace } = await import('../memarch-runtime.js');
            const _ns = resolveNamespace(_activeEntityUuids);
            const _ev = await memarchRetrieve(message, _ns, isTopicShift ? 12 : 8);
            for (const _e of _ev) {
              const _t = String(_e.text || '').trim();
              // 去重判据沿用 V13/V11 现有规则，不引入新的重复风险
              if (_t && !memoryFragments.some(f => f.includes(_t.substring(0, 40)))) {
                memoryFragments.push(_t);
              }
            }
            _v2Hit = _ev.length > 0;
            console.log(`[searchV14] ns=${_ns} 命中 ${_ev.length} 条 → memoryFragments +${memoryFragments.length}`);
          } catch (_v2Err) {
            // 降级必须可见 —— 不得静默退化成空检索
            console.warn('[searchV14] v2 召回失败，降级 V13:', (_v2Err as Error)?.message);
          }
        }

        // ── V13 七层仿生管线 ──
        if (!_v2Hit && WS_SEARCH_V13 && ctx.m4?.retrieveMultiRankForSearch) {
          try {
            const { searchV13: v13Search } = await import('../../m4/UnifiedSearchEngine.js');
            const { MemoryAssociationRepository } = await import('../../m4/graph/MemoryAssociationRepository.js');

            const _locusPath = (dna as any).locus_path || 'default';
            const _entities = dna.entity_genes.map((g: any) => ({ name: g.name, type: g.type }));

            const _multiRank = await ctx.m4.retrieveMultiRankForSearch(_locusPath, _entities, {
              perception: p,
              p40: input.p40,  // 🔴 P072: M3 原生 40D 透传给语义联想路（唯一合法查询量纲，禁 24D 二次投影）
              queryText: message,  // P071-Phase2: 真实消息 → G4 意图区分（原误传 locusPath 致正则空转）
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

        // ── 降级兜底（V13 不可用 / V13 失败时） ──
        // 🔴 P1-D1: V13 失败（_v13Failed）时必须真的执行兜底，不能只打日志。
        // 🔴 B4(2026-11-02) 拆除 n-gram：原本此处调 `UnifiedSearchEngine.search`，
        //   而该函数已随倒排索引拆除收口为**恒返回空** ⇒ 降级路径形同虚设，
        //   V13 一失败就是全链路空检索（日志还显示「降级到 V11」，骗人）。
        //   现改走 v11 结构化召回（recallByStructured + scoreAndRank），不依赖任何索引表：
        //   对源表做分片 LIKE 围栏 → 四权重精排（hit/calcium/recency/semantic）。
        if (!WS_SEARCH_V13 || !ctx.m4?.retrieveMultiRankForSearch || _v13Failed) {
          const _fallbackLimit = isTopicShift ? 6 : 3;
          try {
            const { recallByStructured, scoreAndRank } = await import('../../m4/retrieval/StructuredRecall.js');
            const _hits = await recallByStructured(
              _sqlite as unknown as { queryAll?: (sql: string, params?: unknown[]) => Array<Record<string, unknown>> },
              {
                domain: 'memory',
                // 沿用原有语义：无活跃实体（户主）⇒ 不加 UUID 过滤
                entityUuids: _activeEntityUuids.length > 0 ? _activeEntityUuids : undefined,
                keywords: [message],
                limit: 200,  // 围栏上限；精排后只注入 _fallbackLimit 条
              },
              input.p40,  // 🔴 P072 批2: M3 原生 40D 查询向量（禁 24D 二次投影）
            );
            const _ranked = scoreAndRank(_hits, Date.now()).slice(0, _fallbackLimit);
            _dbResult = {
              items: _ranked.map((h) => h.text),
              raw: _ranked.map((h) => ({ item: { source: h.domain, id: h.id }, score: h.score })),
              hitsBySource: _ranked.length > 0 ? { memory: _ranked.length } : {},
              totalCandidates: _hits.length,
            };
          } catch (_b4Err) {
            // 兜底失败必须可见 —— 不得静默退化成空检索
            console.error(
              '[B4-fallback] v11 结构化召回失败，本轮记忆检索为空:',
              (_b4Err as Error)?.message,
            );
            _dbResult = { items: [], raw: [], hitsBySource: {}, totalCandidates: 0 };
          }

          for (const _item of _dbResult.items) {
            if (!memoryFragments.some(f => f.includes(_item.substring(0, 40)))) {
              memoryFragments.push(_item.startsWith('💎') ? `【珍藏记忆】${_item.substring(1).trim()}` : _item);
            }
          }
          if (_dbResult.items.length > 0) {
            console.log(`[B4-fallback] v11结构化召回→${_dbResult.totalCandidates}候选→精排${_dbResult.raw.length}条→注入${_dbResult.items.length}条 | ${JSON.stringify(_dbResult.hitsBySource)}`);
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
          const _r = _sqlite.queryAll("SELECT detail, content_md, created_at FROM vault_log WHERE (detail LIKE ? OR content_md LIKE ?) AND operation='promote'" + _goldUuidFilter + " ORDER BY created_at DESC LIMIT 2", ['%' + _n + '%', '%' + _n + '%', ..._goldUuidParams]);
          _goldRows.push(..._r);
        }
      }
      if (_goldRows.length === 0) {
        _goldRows = _sqlite.queryAll("SELECT detail, content_md, created_at FROM vault_log WHERE content_md IS NOT NULL OR detail IS NOT NULL" + _goldUuidFilter + " ORDER BY created_at DESC LIMIT 5", _goldUuidParams) || [];
      }
      for (const _gr of _goldRows.slice(0, _glLimit)) {
        const _t = (_gr.content_md || _gr.detail || '').substring(0, 100);
        if (_t.length > 4 && !memoryFragments.some(f => f.includes(_t.substring(0, 20)))) {
          memoryFragments.push(memFragWithTime('金库记忆', _t, (_gr as any).created_at));
        }
      }
      if (_goldRows.length > 0) console.log(`[GoldVault] 金库命中 ${Math.min(_goldRows.length, _glLimit)} 条`);
    }
  } catch (_gvErr) { /* 金库检索不阻塞 */ }
  }  // 🔴 Foundation: 旧 KB+金库 作用域结束（S5 后由适配器路由接管；砂金块 S6 MemoryAdapter 再收编）

  // V10.0: 砂金库高钙化检索 — memories 中 calcium_level>=2 的经过加权检索
  // 🔴 2026-09-17 修复：原逻辑只取高钙化记录（可能是很久以前的），导致无法回忆最近对话
  //     改为：优先检索最近的对话组摘要（按时间倒序），确保上下文连贯
  try {
    const _sLimit = isTopicShift ? 3 : 1;
    const _sqlite = ctx.storage.getSQLite();
    if (_sqlite && typeof _sqlite.queryAll === 'function') {
      // 🔴 户籍管理法：收编 → UUIDPoliceFilter（deny-by-default，杜绝 OR IS NULL 逃生口）
      let _sandQuery = "SELECT raw_input, calcium_level, created_at FROM memories WHERE leaf_zone='user' AND calcium_level >= 2";
      const _sandParams: any[] = [];
      if (_activeEntityUuids.length > 0) {
        const { buildSqlClause: _policeClause } = await import('../../governance/police/UUIDPoliceFilter.js');
        const _police = _policeClause({ visibleUuids: new Set(_activeEntityUuids) });
        _sandQuery += _police.clause;
        _sandParams.push(..._police.params);
      }
      // 🔴 关键修改：按创建时间倒序排列，优先返回最近的对话内容
      _sandQuery += ' ORDER BY created_at DESC LIMIT 10';
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
        // 🔴 Phase 2.3 (F / T005) F0+F3（非会晤侧，受 _rqOn 门控）：
        //   formatHit 对 dialog_group / high_calcium_group 走 default 分支输出 `💭 …`，
        //   **无标签 ⇒ 配额分类会判成 OTHER**（OTHER 不占配额）⇒ F2 的 60/40 形同虚设。
        //   这里按命中域补标签（后缀取 recall-quota 的 TAG 单源，非会晤无单一实体名可挂，用裸形态）。
        //   开关关闭 ⇒ `_isGroupHit` 恒假 ⇒ 本循环退化为 2.3 之前的原样注入。
        const _rqOn = getRetrievalFusionConfig()?.recall_quota?.enabled === true;
        const _fHits = (_fResult.hits || []) as Array<{ id?: string | number; domain?: string; createdAt?: string }>;
        const _fGroupIds = new Set<string>();
        let _fGroupTagged = 0;
        for (let _fi = 0; _fi < _fResult.fragments.length; _fi++) {
          const _f = _fResult.fragments[_fi];
          const _hit = _fHits[_fi];
          const _isGroupHit = _rqOn && !!_hit
            && (_hit.domain === 'dialog_group' || _hit.domain === 'high_calcium_group');
          let _out = _f;
          if (_isGroupHit) {
            const _body = _f.replace(/^\s*💭\s*/, '').replace(/^【摘要】/, '');
            const _gkey = _body.substring(0, 20);
            // 🔴 去重键只与**组级片段**比对（S4 评审）：正文前 20 字若与任意片段比对，
            //   会被逐字重合的单条记忆误命中 ⇒ 整组被静默跳过。非组片段保持原判据。
            if (_gkey.length > 0 && memoryFragments.some((f: string) => {
              const _ri = f.indexOf('】');
              return _ri > 0 && f.slice(0, _ri + 1).includes('对话组') && f.includes(_gkey);
            })) continue;
            // 🔴 P145 批B（2026-11-01）深度回忆：用户明确要求细节（detail / full 意图）时，
            //   经 BArchiveReader 按 groupId **单点**拉起整块原文，替换掉截断正文。
            //   · 去重键 `_gkey` 仍取自**截断正文** —— 与统一中枢已注入的同组片段照样去重，
            //     不会因为「正文变长」而重复注入。
            //   · 会晤场景必须带听众 UUID 过滤（耳语按一对一记录：归属 = 听众）；
            //     解析不出当前发言人 ⇒ **fail-closed**，宁可不展开也不能裸奔。
            //   · 户主场景传 null（不过滤，单个实体自有历史）。
            //   · 任何失败静默回退截断正文（tryDeepRecall 内部已兜住并 warn）。
            //   · 动态 import：避免为本模块顶部再加一条静态依赖，模块缓存后开销可忽略。
            let _deepBody: string | null = null;
            const _deepGid = extractDialogGroupId(_hit!);
            if (_deepGid) {
              const _deepAudience: string | null = (() => {
                if (!_meetingEntityName) return null;   // 户主场景：不过滤
                try {
                  const _st = (ctx as any)._groupSession?.getState?.();
                  const _u = typeof _st?.speakerUuid === 'string' ? _st.speakerUuid : '';
                  const _n = _st?.participants?.find?.((x: any) => x.uuid === _u)?.name;
                  return _u && _n === _meetingEntityName ? _u : null;
                } catch { return null; }
              })();
              if (!_meetingEntityName || _deepAudience) {
                const { tryDeepRecall } = await import('./b-archive-recall.js');
                _deepBody = tryDeepRecall({
                  sql: ctx.storage?.getSQLite?.(),
                  message,
                  groupId: _deepGid,
                  audienceUuid: _deepAudience,
                });
              }
            }
            _out = memFragWithTime(
              _hit!.domain === 'high_calcium_group' ? TAG.highCalciumGroupMemoryBare : TAG.dialogGroupMemoryBare,
              _deepBody ?? _body,
              _hit!.createdAt,
            );
            _fGroupTagged++;
          } else if (_f.substring(0, 20).length > 0 && memoryFragments.some((f: string) => f.includes(_f.substring(0, 20)))) {
            continue;
          }
          memoryFragments.push(_out);
          if (_isGroupHit) {
            const _fGid = extractDialogGroupId(_hit!);
            if (_fGid) _fGroupIds.add(_fGid);
          }
        }
        console.log(`[FoundationRoutes] 适配器统一路由 → ${_fResult.fragments.length} 片段 (executed=${_fResult.executed})` +
          ` · 组级补标 ${_fGroupTagged} · 组去重键 ${_fGroupIds.size}`);
      } else {
        console.log(`[FoundationRoutes-shadow] 影子比对 → ${_fResult.fragments.length} 片段 (executed=${_fResult.executed}, latency=${JSON.stringify(_fResult.latency)})`);
      }
    }
  } catch (_fErr) { console.warn('[FoundationRoutes] 影子/注入失败:', (_fErr as Error)?.message); }

  // 🔴 Phase 2.3 (F / T005) F2: 非会晤场景 B60% / A40% 配额 —— **出口闸门**。
  //   覆盖上方全部注入路径（情感记忆 / V13 / V11 / 长文 / 砂金 / Foundation 多路）。
  //   近期记忆并入 B 侧同一池（R020 Q2）；铁律/金库/作品/长文属 OTHER，不受配额约束。
  //   泛词判据在非会晤侧是**保守代理**（抽词长度，不做对库校验，避免每轮多 N 次 COUNT）——
  //   F5 的数据支撑（P015 泛词 recall@3 仅 33%）来自会晤场景，故非会晤侧极少触发。
  applyRecallQuotaAtExit(
    memoryFragments, 'normal', enrichedHistory,
    extractTopicKeywords(message, [], 8).length === 0,
  );

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
