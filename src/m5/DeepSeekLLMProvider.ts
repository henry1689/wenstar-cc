/**
 * DeepSeekLLMProvider — 玉瑶 · 太虚境 LLM 驱动
 *
 * 使用 DeepSeek V4 API（兼容 OpenAI 格式），注入灵肉伴侣人设。
 * 支持对话历史注入，让模型拥有真实的对话连续性记忆。
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY — 你的 DeepSeek API Key
 *   DEEPSEEK_MODEL — 模型名，默认 deepseek-v4-flash
 */
import type { LLMProvider, StrategyConfig, CognitionObject, ConversationTurn, LLMTokenDelta } from './types/index.js';
import { buildSystemPrompt, STYLE_ANCHORS } from './persona/lover-persona.js';
import { selectLLMConfig, getScenarioConfig, getProviderConfig } from '../common/const/llm-config.js';
import { buildSystemPrompt as buildCoreSystemPrompt } from './prompts/core-rules.js';
import { isDeepIntimate, isAcademic, isMoan } from '../common/utils/is-intimate.js';
import { calcLevel } from './expression/TierVocabMap.js';
import { calcExpressionSpec } from './expression/ExpressionSpecController.js';
import { renderIntimateResponse } from './expression/IntimateRenderer.js';
import type { IntimateSceneType } from './expression/IntimateRenderer.js';
import type { IPersona } from '../app/persona/types.js';
import { getKeyValue } from '../app/shared/ApiKeyStorage.js';
import { type RoleType } from '../app/role/RoleClassifier.js';
import { buildRoleSystemPrompt } from '../app/role/RoleProfiles.js';
import { createInitialState, type TransitionState } from '../app/role/TransitionManager.js';
import { validateRoleOutput, getFallbackRole } from '../app/role/RoleGuard.js';

// 改造④：不在模块级读 process.env，构造函数中通过 ConfigService 运行时获取
import { ConfigService } from '../config/ConfigService.js';

// 🆕 V10.0 P3-3: 单一 Provider 配置源 — 从 llm-config.ts 获取（避免双源头漂移）
const _providerCfg = getProviderConfig();
const BASE_URL = _providerCfg.baseUrl;
const MAX_HISTORY_TURNS = _providerCfg.maxHistoryTurns;
// FIX-3: 工作消息时缩减历史（防止亲密历史污染工作上下文）
/**
 * 🔴 P-02 / P-14（PAS v1 / V27批3）: 对话历史**注入上限**。
 *
 * 原实现：`getHistoryLimit()` 直接返回 `MAX_HISTORY_TURNS`（本环境 200，来自
 *   `common/const/llm-config.ts`），即每轮注入最多 200 条**完整对话原文**。
 * 实测代价（2026-09-19 [PromptBudget]）：普通模式 L2=28188 字符，其中 hist=23702
 *   —— 占整个 prompt（31504 字符）的 **75%**，超规范 §3 的 L2 预算（4000）近 6 倍。
 *
 * 现改为注入上限 20 条（≈10 轮；会晤模式用 slice(-20)，两者对齐）。
 * 依据：
 *   ① 当前话题的上下文由最近 10 轮完全覆盖；
 *   ② 更早的上下文应由 **maintenance 压缩摘要**（`is_compacted`）与 **M4 记忆检索**
 *      按需承载，而不是把原文持续堆进 prompt（P-04 按需注入精神）；
 *   ③ 内存层仍保留 200 条（`loadConversationHistory`）供意图检测/去重等内部逻辑使用，
 *      仅**注入层**收敛。
 */
const HISTORY_INJECT_CAP = 20;

/**
 * 🔴 P-02（PAS v1 / V27批3）: 单条历史注入的**字符上限**。
 *   实测 20 条历史中长回复可达 400~600 字符，把 L2 预算吃光。
 *   截断只影响“细节回忆”，不丢“提到过什么”——更早/更细的内容应由 M4 记忆检索按需提供（P-04）。
 */
const HISTORY_TURN_MAX_CHARS = 400;

function getHistoryLimit(txt: string): number {
  if (/工作|项目|客户|会议|方案|报告|公司|合同|预算|数据|分析|策略|设计|电机|采购|成本|温升|版本|产品|技术|报价|订单|生产|测试|样品|图纸|规格|性能|参数|工程|研发|工艺|质量|供应商/.test(txt)) return 10;
  return Math.min(MAX_HISTORY_TURNS, HISTORY_INJECT_CAP);
}

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** 运行时获取 API Key（多 Provider 兼容） */
/** 清理 lone surrogate — JSON.stringify 遇到未配对代理字符会产生非法 hex 转义，API 400 拒收 */
function sanitizeUTF16(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

// ── 🔴 P1-5 流式: 思维链剥离（模块级，流式状态机 + 非流式后处理共用） ──
/** P1-6 探针: 确认生产服务加载含结构识别的最新代码（模块加载时打印） */
// (探针已移除 — 剥离逻辑经生产实测验证)
/** 思维链首段关键词 — 命中即判定该段为内心独白，剥离丢弃。
 * S4-M2 修正: 剔除答案开头常用词（记得/另外/此外/综上所述/简单来说/也就是说/所以这/注意/这是一个/我在想/我应该），
 * 只保留强内心独白措辞 + 系统级表述——否则"记得上次…"这类答案确认性首句会被误删（全局质量回归）。 */
const THINKING_KEYWORDS = /让[我你]想|让我回|让我分析|让我来写|我来写|心里|想到|脑中|好好回|在意|吃醋|心酸|我们被问|当前场景|当前时间|我需要|考虑到|根据规则|从历史|在角色扮演|但根据|用户最后|用户可能|用户当前|我的回复|这个角色|最安全|但注意|可能这是|我决定|最简单的做法|我有点混乱|让我理清|让我重新读|让我确认一下|我到底是谁|我该是谁|身份铁律|让我想想我是|这个场景的设定|让我重新想|让我梳理|让我理解/;
/**
 * P1-5: 剥离思维链前缀 — 按句段剥离开头含思维关键词的句子，直到第一个非思维句。
 * 保留作降级路径（extractAnswerFromReasoning 找不到过渡标记时的兜底）。
 * DeepSeek V4-flash 的 reasoning_content 格式通常是："思考句1。思考句2……\n\n回答句1。回答句2。"
 */
export function stripThinkingPrefix(text: string): string {
    if (!text)
        return '';
    // 按句末标点/换行切段（保留分隔符），逐句判断：含思维关键词的句子剥离，直到第一个非思维句
    const parts = text.split(/(?<=[。！？…\n])/);
    let keepFrom = 0;
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i].trim())
            continue;
        if (THINKING_KEYWORDS.test(parts[i]))
            keepFrom = i + 1;
        else
            break;
    }
    return parts.slice(keepFrom).join('').trimStart();
}
// ── 🔴 P1-6 思维链结构提取（S3 实测诊断: V4-flash 思维链有固定模板，关键词逐句剥离完全失效）──
// 实测模板:
//   ① 角色建立: "好的，现在我是玉瑶了，我是鸿艺的私人秘书兼情感伴侣…"
//   ② 复述+分析: "鸿艺先生突然问我是不是玉瑶，这问题有点奇怪…"
//   ③ 自我要求: "不过作为他的秘书，我得先确认自己的身份…"
//   ④ 过渡标记: "好了，那么现在就像这样对鸿艺先生说吧。"  ← 真正答案从这里开始（几乎每条必现）
//   ⑤ 计划句(标记后偶有残留): "我会先承认这个习惯确实奇怪，…语气要自然一点…"
/** 答案起点过渡标记 — V4-flash 思维链结尾转场锚点（取其后为真正答案）。
 * S4-M1 + 生产实测增强: V4-flash 句式漂移多变，枚举精确句式追不上。用非贪婪 + 语义锚点集合
 * （回应/回答/对/和/说）覆盖全部变体，且非贪婪停在第一个锚不误吃答案：
 *   "好了，那么现在就像这样对鸿艺先生说吧。" / "好了，那么现在就这样开始和鸿艺先生对话吧。"
 *   / "好了，我现在就要这样对他说——" / "好了，现在就像这样开始回应他吧。"（实测漂移）
 * 结尾吃可选语气词/破折号防残留 */
// ── 🔴 S4-M4 复盘型思维链剥离（生产泄漏修复 2026-08-13） ──
// 实测: V4-flash 输出"复盘型"思维链（分析用户消息 → 权衡如何回应 → 起草 → 评估打磨 → 转场最终稿），
//   无标准过渡标记（"好了，那就像这样说吧"），无角色建立段（"好的，现在我是XX了"），
//   findAnswerStart 对草稿句也失效（"作为梓铭…"以"作为"开头被排除，草稿不含称呼+语气词）→ 整条后台话泄漏前台。
// 决定性特征: 思维链**引用系统指令标记**【⚠️ 事实优先】【🔴 记忆优先于标签】——正常角色回答不引用系统指令。
// 修复: 识别到系统指令标记 → 取最后转场锚点"开始。"之后为最终稿；无可靠转场 → 宁可空也不泄漏。
/** 系统指令标记 — 复盘型思维链引用的【…】段（含系统指令特征词） */
const SYSTEM_MARK_RE = /【[^】]*(?:⚠️|🔴|🟡|禁止|必须|规则|指令|优先|模式|要求|注意|事实|记忆)[^】]*】/;
const SYSTEM_MARK_G_RE = /【[^】]*(?:⚠️|🔴|🟡|禁止|必须|规则|指令|优先|模式|要求|注意|事实|记忆)[^】]*】/g;
/** 复盘型识别信号 — 【】系统标记 或 文字引用系统指令。
 * V2 实测: 复盘思维链无【】标记，只用文字描述（"系统提醒过这是'事实回忆'模式""不能编造没有的细节"），
 * SYSTEM_MARK_RE 不命中 → 走 legacy → findAnswerStart 括号规则把分析句误判为答案起点 → 整条分析段泄漏前台。 */
const REFLECTIVE_SIGNAL_RE = /【[^】]*(?:⚠️|🔴|🟡|禁止|必须|规则|指令|优先|模式|要求|注意|事实|记忆)[^】]*】|系统提醒|系统指令|系统告诉|系统要求|事实回忆|事实优先|记忆优先|不能编造|不要编造|不要添加|绝对禁止|提醒过|根据规则|当前问题是事实|让我分析一下|让我来写|分析一下场景|现在说话的是|让我再完善|让我再重写|让我定稿|让我稍微收紧|再检查一遍|嗯，这很好|让我确认一下|让我收紧|让我微调|再润色一下|保持简短|也许我需要|我觉得如上处理没问题|大概不错|保持简洁|不越界|再扩展一下|定位成|报上了名字|稍微修改|修改流畅|最终确认|最终稿|尺度.{0,8}合适|保持了.{0,12}风格|我有点混乱|让我理清|让我重新读|让我重新看|我到底是谁|我该是谁|身份铁律|身份边界|让我确认身份|让我想想我是|这个场景的设定|让我重新想|让我梳理/;
/** V20 系统引用型复盘精确信号（【】系统标记 或 文字引用系统指令）——与草稿迭代词彻底分离。
 * 复盘型思维链引用的系统指令（事实优先/记忆优先/不能编造），正常角色回答绝不含。 */
const SYSTEM_REFERENCE_RE = /【[^】]*(?:⚠️|🔴|🟡|禁止|必须|规则|指令|优先|模式|要求|注意|事实|记忆)[^】]*】|系统提醒|系统指令|系统告诉|系统要求|事实回忆|事实优先|记忆优先|不能编造|不要编造|不要添加|绝对禁止|提醒过|根据规则|当前问题是事实|我有点混乱|让我理清|我到底是谁|身份铁律|让我确认身份|身份边界|让我重新读/;
/** 复盘型权衡/草稿措辞（流式 crossed 后 reasoning 过滤用） */
const REFLECTIVE_VERB_RE = /权衡|草稿|折中|打磨|语气要|如何回应|怎么回应|我决定|我想我可以|这个问题|让我思考|考虑|结构如下|这段回复|这条回复|最终稿|我该如何|我该怎样|让我重新|无中生有|组织语言|起草|初稿|润色|混乱|理清|到底是谁|身份|重新读|梳理|重新看/;
/** 转场锚点 — 评估结束进入最终稿（"…无中生有。开始。最终稿"） */
// V3 修复: [。！——] 的"—"误匹配正文"痛是美好的开始——"（名词短语破折号），把最终稿从中间截断。
// 改为只认句末标点[。！？]或"开始吧"（转场句），不认"—"。
const REFLECTIVE_GO_RE = /开始[。！？]|开始吧|让我来写[^。]{0,10}(?:回应|回答|一段|回复)[：:]|让我来写[^。]{0,10}[：:]|这样回应吧|让我再完善[^。]{0,20}[：:.]|让我再重写[^。]{0,20}[：:.]|让我定稿|让我稍微收紧[^。]{0,10}[：:.]|让我微调|让我收紧|嗯，这很好[^。]{0,30}让我定稿|再检查一遍|再润色一下[^。]{0,10}[：:.]|保持简短|不越界|最终确认|最终稿|修改流畅/g;
/** V22(2026-09-12) 英文起草/元推理信号 —— 生产泄漏实测（徐诗雨会晤）：
 *  模型先输出完整中文答案，随后**继续用英文输出起草自检**
 *  （"Count: let me count roughly." → "Revised: …" → "~68 chars." → "Final: …"）。
 *  既有 tailEvalRe / isAnalysisSentence 只枚举中文特征词 → 英文段落被判为答案直推前台。
 *  本信号与语言无关：①词法签名 ②纯拉丁文长串（中文角色扮演中的成段英文必为元推理）。
 *  安全原则沿用项目既有约定：拿不准宁可少推，也不洩漏后台话。 */
const LATIN_META_SIG_RE = /(?:Count|Revised|Final|Draft|Version|Note)\s*[:：]|let me count|let me reconsider|let me check|let me revise|let me think|rule says|Alternatively\b|~?\d+\s*chars?\b|chars\.|\bHmm\b\s*,|I'll (?:go|write|keep|make|use)|Let's (?:count|go|check)/;
/** 连续 ≥4 个英文词（含英文标点/空格分隔）—— 中文答案中不会出现的成段英文 */
const LATIN_RUN_RE = /(?:[A-Za-z][A-Za-z''\-]{0,24}[ ,.:;!?~'"()\[\]{}\-]*){4,}/;
/** V22: 英文起草起点（无则 -1）。流式直推与非流式提取共用同一判据。 */
export function findLatinMetaStart(s: string): number {
    if (!s) return -1;
    const m = LATIN_META_SIG_RE.exec(s);
    const r = LATIN_RUN_RE.exec(s);
    const i1 = m ? m.index : -1;
    const i2 = r ? r.index : -1;
    if (i1 < 0) return i2;
    if (i2 < 0) return i1;
    return Math.min(i1, i2);
}
/** V22: 尾部元推理截断（保留真答案，丢弃其后的英文起草段）。
 *  截断后为空 → 若命中词法签名则返回 ''（宁可空也不洩漏）；仅为拉丁长串则保留原文（避免误删纯英文答案）。 */
export function truncateLatinMetaTail(text: string): string {
    if (!text) return text;
    const i = findLatinMetaStart(text);
    if (i < 0) return text;
    const head = text.slice(0, i).replace(/[\s，。、；：]+$/, '');
    if (head.length > 0) return head;
    return LATIN_META_SIG_RE.test(text) ? '' : text;
}

/** V22b 草稿/复述形态判据（生产实测 id=1784 / id=1770）：
 *  剥离器可能把模型**整理上下文的草稿列表**当成答案返回：
 *    `- "鸿艺，深更半夜的…"`（草稿引用）
 *    `- 鸿艺: 你好 → 瑶瑶: 鸿艺，瑶瑶在呢。…`（对话复述）
 *  正常角色回复以「（动作）」或对话直接起句，**不会**以列表项开头、也不会含复述箭头。 */
export function isDraftShapedReply(text: string): boolean {
    const s = (text || '').trim();
    if (!s) return false;
    // ① 以列表项开头（- / * / • / 1. / 1) ）—— 正常回复不会这样起句
    if (/^[-*•]\s+/.test(s) || /^\d{1,2}[.)]\s+/.test(s)) return true;
    // ② 含对话复述箭头（"角色A: 内容 → 角色B: 内容" = 模型整理上下文的草稿）
    if (s.includes('→')) return true;
    return false;
}

/** V22 回复字段择取（fail-closed 护栏）—— 生产洩漏修复（2026-09-12）
 *
 *  背景：V4-flash 是思维链模型，content 常为空、答复在 reasoning_content 里。
 *  原实现：content 空 → 取 reasoning 原文 → extractAnswerFromReasoning 剥离失败时**返回原文**
 *         → 整段思维链（英文分析 + 中文草稿 + 指令复述）被当前台回复输出（生产实测多条）。
 *
 *  现约定（字段边界优先 + 宁可空也不洩漏）：
 *    ① content 有值 → 直接用 content（不让 reasoning 参与；但草稿形态仍判无效）
 *    ② content 空   → reasoning 仅作**最后手段**，必须真正剥出答案：
 *         剥离结果为空 / 长度≈原文（未剥下任何东西）/ 形态仍是草稿 → 返回 ''
 *    ③ 两者都空 → ''
 */
export function resolveReplyFromFields(content?: string, reasoning?: string): string {
    // ① 字段边界优先（content 也可能被模型用来承载思维链，同样不得原样透传）
    const c = (content || '').trim();
    if (c) {
        // content 非空: ① 默认视为答案；② 但若剥离器能真正剥下东西（变短 >10 字）
        //   → 说明 content 里裹着思维链（含中文复盘型，由 extractAnswerFromReasoning 内部 V2–V20 判据负责）→ 用剥离结果。
        // ❗ 无论如何**不得整体判空**——判空会让会晤模式退化成「…（抱歉，我暂时无法回应…）」
        //   （2026-09-12 生产实测回归），而不是掉回旧版的「返回原文」。
        const ex = extractAnswerFromReasoning(c).trim();
        if (ex && ex.length < c.length - 10)
            return isDraftShapedReply(ex) ? '' : ex;
        const tail = truncateLatinMetaTail(c).trim();
        if (tail.length < c.length - 10)
            return isDraftShapedReply(tail) ? '' : tail;
        // 🔴 V23(2026-09-13): 两条剥离**都没生效**（≈原文）→ 与分支② 同口径 fail-closed：
        //   仅当文本**确具思维链特征**时才判空，否则原样返回。
        //   为何必须补这一步：原实现此处无条件 `return tail` —— 剥不动就把原文（整段思维链）
        //   当回复返回。实测泄漏形态为中文元指令型（"我要以徐诗雨身份回答…要带自称，40-80字，
        //   可以稍微说：…"），而当时的 looksLikeReasoning 对纯中文恒 false，闸门形同虚设。
        //   保留「无条件判空」的旧 V22 写法也不行：会误杀 V4-flash 降级模式下把正常短答放进
        //   content 的合法形态 → 会晤退化成「抱歉，我暂时无法回应」。
        if (looksLikeReasoning(c)) return '';
        return isDraftShapedReply(c) ? '' : c;
    }
    // ② content 空 → reasoning 仅作最后手段（必须真正剥出答案）
    const r = (reasoning || '').trim();
    if (!r) return '';
    const extracted = extractAnswerFromReasoning(r).trim();
    if (!extracted) return '';
    // ③ fail-closed: 剥离未生效（≈原文）**且**文本确具思维链特征 → 判无可用答案。
    //    ❗ 必须要求「具思维链特征」：V4-flash 降级模式会把正常短答案放进 reasoning_content，
    //      若只看「未剥下东西」就判空，会误杀合法回复（实测 S4-m4 回归：“好的呀。” 被吞字）。
    if (extracted.length >= r.length * 0.9 && looksLikeReasoning(r)) return '';
    if (isDraftShapedReply(extracted)) return '';
    return extracted;
}

/**
 * V23(2026-09-13) 中文「元指令型」思维链判据 —— 正常角色回复**绝不可能**出现的
 * 「打算怎么答」句式。
 *
 * 背景：V22 期间从 looksLikeReasoning 移除了 SYSTEM_REFERENCE_RE（因为它含 `【…记忆…】`
 * 模式，会误杀引用「【徐诗雨的记忆】」的合法会晤回复）。那个理由本身成立，但**连带后果**是
 * 中文元指令型思维链再无判据认领 —— findLatinMetaStart 只认英文起草，isDraftShapedReply
 * 只认草稿列表，于是纯中文元指令恒返回 false → fail-closed 闸门（下方 L202）永不触发 →
 * reasoning 原文被当回复返回。
 *
 * 生产实测（用户直接提供的两条原文）：
 *   ①「鸿艺问：…他在确认：…我要以徐诗雨身份回答。这是事实回忆。…要带自称，简洁，
 *      40-80字。以徐诗雨口吻。可以稍微说：你给诗雨看的那篇…」
 *   ②「用户说"再来一次"——指的是刚才那个吻。我是徐诗雨…长度按亲密互动，200-400字左右。
 *      …写：…不错。但要控制长度和自然度。再调整。…最终版本：…」
 *
 * ❗ 本判据只收**高置信度**句式，且**刻意不含任何 `【…】` 括注模式** —— 从而在修复泄漏的
 *   同时，保住 V22 那项「不误杀记忆括注」的成果。
 * ❗ 仅在「剥离未生效」时用于 fail-closed 判定，正常回复不会走到那条路径，误杀面极小。
 */
const CN_META_PLAN_RE = new RegExp([
    // ① 身份 / 角色元指令
    '我要以[^。！？\\n]{0,12}身份(?:回答|回应|说话)',
    '自称铁律|要带自称|要带上[「"“]?自?称',
    '保持角色[：:]|保持状态一致|不要内心独白|旁白短',
    '按会晤模式|按规则[：:]|根据规则[：:]',
    // ② 事实 / 诚实元指令
    '事实回忆|事实优先|记忆优先|当前问题是事实',
    '不能编造|不要编造|不要添加|绝对禁止',
    // ③ 写作计划 / 草稿迭代
    '\\d{2,3}\\s*[-~～至]\\s*\\d{2,3}\\s*字',
    '可以稍微说[：:]|最终版本[：:]|(?:^|\\n)\\s*回应[：:]',
    '让我(?:来|再)?(?:写|完善|重写|定稿|确认|微调|收紧|理清|梳理)',
    '不错[。，][^。\\n]{0,20}但要控制|再调整[。，]|避免太文艺|要口语化',
].join('|'));

/**
 * V23.1(2026-09-13) **出口守卫 —— 唯一把关点**
 *
 * 为什么需要它（用户实测暴露的教训）：
 *   本文件要推送给用户 / 落库的文本**出口曾有 5 处**，各自判断：
 *     · StreamThinkingStripper 内 3 处（各自调 extractAnswerFromReasoning）
 *     · 流式兜底 1 处（content 空时取 reasoningBuf）
 *     · 流式收尾护栏 1 处（只查草稿形态与记忆括注）
 *   V23 修好了判据本身，却只接入了**非流式**那一处 → 流式路径继续泄漏并落库
 *   （实测 id=2321，服务已加载修复后仍产生）。
 *   **这就是"打补丁"的恶果：修了 2 处，还剩 3 处漏网。**
 *
 * 治理方式：**收口**——不再往每个出口各加一条判据，而是让所有出口统一经过本函数，
 *   使"漏网"这一类别从结构上消失。新增出口时也只需记得过这一关。
 *
 * ❗ 判据必须是**高置信度、零误杀**的三条：
 *     · isDraftShapedReply —— 列表项开头 / 对话复述箭头（正常回复不会有）
 *     · CN_META_PLAN_RE    —— 元指令句式（正常回复不会有）
 *     · 【…的记忆】原样回显 —— 注入片段被吐回
 *   ⚠️ **刻意不含 findLatinMetaStart**：它会把含 ≥4 个英文词（如 `A和"test"`）的正常回复
 *      误判为思维链（2026-09-13 实测 37 条误报）。它只适合作为「剥离起点」使用，
 *      不适合放进出口守卫 —— 那会造成大面积误杀（回复变空）。
 *
 * @returns 通过守卫的原文；判定为思维链/回显时返回空串（宁可空也不泄漏）
 */
/** 🔴 2026-09-16 数据卫生: chat.ts 注入前把系统标签改写成自然语形式（chat.ts 内 replace 表），
 *  原出口守卫只认改写前的「【X的记忆】」，导致改写后的方括号标签从出口溜过并落库进对话历史。
 *  本常量与 chat.ts 改写表一一对应，用于输出侧剥离。 */
const OUTGOING_MEMORY_LABEL_RE = /\[你(记得的(相关)?往事|珍视的记忆|珍惜的记忆|你的档案|和鸿艺的对话)\]/;

export function gateOutgoingReply(text: string): string {
    const t = (text || '').trim();
    if (!t) return '';
    if (isDraftShapedReply(t)) return '';
    if (CN_META_PLAN_RE.test(t)) return '';
    if (/【[^】]*的记忆】/.test(t)) return '';

    // 🔴 2026-09-16 记忆回显剥离（策略 B：整段丢弃 + 上游兜底）
    //   按段落切分，丢弃命中自然语标签的整段；若全部段落均被丢弃 → 判空交上游重试/兜底。
    if (OUTGOING_MEMORY_LABEL_RE.test(t)) {
      const _segs = t.split(/\n+/);
      const _kept = _segs.filter(p => !OUTGOING_MEMORY_LABEL_RE.test(p));
      const _out = _kept.join('\n').trim();
      if (!_out) {
        console.error('[DeepSeek] 出口剥离: 整条均为记忆回显，判空交由上游兜底');
        return '';
      }
      console.error('[DeepSeek] 出口剥离: 丢弃记忆回显段落 ' + (_segs.length - _kept.length) + '/' + _segs.length);
      return _out;
    }
    return t;
}

/** V22c 思维链特征判据（fail-closed 判定用：区分「思维链」与「无标记的简洁答案」）
 *  ❗ 仅取强信号：英文起草/元推理、草稿列表形态、中文元指令（V23 补）。
 *    刻意不含 REFLECTIVE_VERB_RE 类宽泛元认知词（"考虑/结构" 等正常回复也会出现）——避免误拦合法回复。 */
export function looksLikeReasoning(text: string): boolean {
    const t = text || '';
    if (!t) return false;
    if (findLatinMetaStart(t) >= 0) return true;
    if (isDraftShapedReply(t)) return true;
    // ✅ V23: 中文元指令型（见 CN_META_PLAN_RE 说明）。
    if (CN_META_PLAN_RE.test(t)) return true;
    // ❌ 仍然**不含** SYSTEM_REFERENCE_RE：它匹配任何含「记忆/规则/优先」等词的【…】块，
    //    而合法会晤回复会引用「【徐诗雨的记忆】」这类括注 → 会被误判为思维链并被整条判空。
    //    生产实测（2026-09-12）: 误杀后会晤模式退化为「…（抱歉，我暂时无法回应，请稍后再试。）」。
    //    V23 的 CN_META_PLAN_RE 已用「只收元指令句式、零括注模式」的方式补上这块空白。
    return false;
}

/** 分析句特征 — 复盘思维链中的复述他人话语/自我权衡/系统引用/自我要求计划。
 * V2 修复: findAnswerStartRobust 用此区分分析句与真实答案句（防止"（他在接我刚才的话…"被当答案起点）。 */
function isAnalysisSentence(s: string): boolean {
    if (/(?:他说|他回|他接|他这句|他说过|他在|鸿艺先生?说|用户说|你这句话)/.test(s))
        return true;
    if (/(?:我该|我可以|我不必|我应|这让我|我心里|我那时候|我回想|我琢磨|我犯难|我在想)/.test(s))
        return true;
    if (/(?:系统|提醒|不能编造|不要编造|事实回忆|事实优先|记忆优先|模式)/.test(s))
        return true;
    if (/(?:不要太长|名字要|自然出现|可以借|顺着|权衡|组织语言|结构|草稿|折中|打磨)/.test(s))
        return true;
    // V8 修复: 括号思维链段（分析用户消息/自我分析/回应计划/场景设定）→ 思维链。
    //   主语"我/鸿艺/他/现在"（抽象分析）+ 心理/计划/场景动词。动作描写答案（主语"梓铭/她"+身体动作）不受影响。
    if (/(?:是什么人|什么性子|该不该|要不要|最合适|是这样|就怎么|突然冒出|明显不是|短促、直接|不是追问|不是寒暄|要接着|带一句|落在|落到|现在是|人在宿舍|环境是|就这么回|先怔一下再|先把|再顺着|把.{0,6}放进去)/.test(s))
        return true;
    // V9 修复: 第一人称计划/自述/场景特征（括号思维链段："我要接住/我是18岁/我确实开心/我愿意说/现在是时间/状态要延续/回应要短而暖/带上名字/可以带一句反问/不能长篇大论/带着收尾的意思"）
    //   这些是模型自我分析/计划，不是角色身体动作（动作描写"（梓铭把手机往耳边又贴了贴…"不受影响）。
    if (/(?:我要接住|带着收尾的意思|我是.{0,10}岁|我确实|我愿意|我温柔|现在是.{0,10}时间|状态要延续|回应要|带上名字|可以带一句|不能长篇大论|把关怀递回|话锋一转|这个转换|这些话题对内向的我|因为是他|把那个突然|大约.{0,10}点|窗外天色|风扇转动|夜晚场景|床头|刚才说自己是窝在|时间显示是|在宿舍|我应该|以熊梓铭的身份|回答的要点|语气要正式|不要太长|300字左右|我作为|我要承认|我不能一味|我不需要|但也要|他是在认真|不是调情|认真回应他的论点|像在认真|因为|由于|关于.{0,4}：|反映.{0,4}性格|准备.{0,4}话题|开场话题|注意语气|注意不要|自称铁律|身份铁律|我不用提|我是.{0,4}本人|让我写|让我说|我先说|开场第一句|不要长篇大论|1-3句话|场景想象|嗯，不过|不过有点|我的社会身份|比如|属于|但先|只是|整理|录入|快到午饭|拟定|规划|起草|初稿|举个例子)/.test(s))
        return true;
    // V13: "（他今天这么晚还惦记着我…作为他的秘书…我既想…）"——全局模式思维链分析用户消息。
    //   主语"他/鸿艺先生"+心理动词（描述用户行为）+自我分析介词（作为/我既/我得…）→ 思维链，非动作描写。
    //   （区别于动作描写答案：主语是角色本人"梓铭/她/玉瑶"+身体动作，或"他"+直接身体动词如"他愣了一下"。）
    //   注意: s 可能是含"（…）"的完整括号段（findAnswerStart 传入），开括号可选。
    if (/^[（(]?(?:他|鸿艺先生?)[^）]{0,50}?(?:惦记|在乎|关心|问我|说我|觉得|知道|认为|担心|在意|重视|主动)[^）]{0,40}?(?:作为|让我|我既|我得|我心里|我应该|我要|我不必|回应要|语气要)/.test(s))
        return true;
    // V22: 英文起草/元推理签名（仅词法签名，不含拉丁长串——避免误伤含少量英文的正常答案）
    if (LATIN_META_SIG_RE.test(s))
        return true;
    return false;
}
/** 鲁棒答案起点 — 跳过分析句，取第一个真答案句（V2 修复）。 */
function findAnswerStartRobust(text: string): number | null {
    const sentences = text.split(/(?<=[。！？…\n])/);
    let pos = 0;
    for (const s of sentences) {
        if (!s.trim()) {
            pos += s.length;
            continue;
        }
        const st = s.trim();
        // V5 粘连根治: 分析句列表尾括号与最终稿开括号粘连（"…150-200字）（梓铭愣了一下，像被轻轻点了一下穴…"）。
        //   句子切分后最终稿开括号被"5."前缀遮挡（非纯括号开头），括号规则不匹配 → 答案起点错落。
        //   检测: 含"）（"，且"）（"后的开括号内容>9字 → 答案起点取最后一个"）（"之后。
        const adhIdx = st.lastIndexOf('）（');
        // 只跳过闭括号"）"（adhIdx+1），保留开括号"（"，使 adhOpen 以"（"开头
        const adhOpen = adhIdx >= 0 ? st.slice(adhIdx + 1) : '';
        if (adhOpen.startsWith('（') && adhOpen.length >= 11 && !isAnalysisSentence(adhOpen)) {
            return pos + adhIdx + 1;
        }
        // V3/V5 修复: 长括号动作描写（内容≥9字）优先，但必须排除分析句（V5 实测"（鸿艺说…"长括号分析句被误判为答案）。
        //   V3 修复点: 不因 isAnalysisSentence 的"他说"误伤动作描写"（梓铭听到…他说得…）"——isAnalysisSentence 规则1
        //   的"鸿艺先生?说/他说"精确匹配分析句，动作描写"梓铭听到…他说得"不命中该规则，故此处查 isAnalysisSentence 安全。
        if (st.match(/^[（(][^）)]{9,}/) && !isAnalysisSentence(st) && isAnswerSentence(st))
            return pos;
        if (!isAnalysisSentence(st) && isAnswerSentence(st))
            return pos;
        pos += s.length;
    }
    return null;
}
/**
 * 复盘型思维链剥离 — 识别系统指令标记后，取最后转场锚点"开始。"之后的最终稿。
 * 返回 string（成功剥离最终稿）/ ''（是复盘型但无可靠转场 = 宁空不泄漏）/ null（非复盘型，走 legacy）。
 */
function extractFromReflectiveChain(text: string): string | null {
    // V20 识别信号：引用系统指令（【】标记 或 文字描述"系统提醒过/事实回忆/不能编造"）——正常角色回答不引用系统指令。
    //   只认精确系统引用（SYSTEM_REFERENCE_RE），不再混入"让我重写/让我定稿/再润色"等草稿迭代词——那些走 findAfterLastEval（草稿迭代型）。
    if (!SYSTEM_REFERENCE_RE.test(text))
        return null;
    // ① 转场锚点取最后一个（复盘常多次出现"开始"草稿，"开始。"通常是评估→最终稿转场）
    let last = null;
    REFLECTIVE_GO_RE.lastIndex = 0;
    for (;;) {
        const m = REFLECTIVE_GO_RE.exec(text);
        if (!m)
            break;
        last = { index: m.index, len: m[0].length };
    }
    if (last) {
        const tail = cleanTail(text.slice(last.index + last.len));
        if (tail.length >= 10) {
            const clean = stripPlanningPrefix(tail);
            if (clean && clean.length >= 10)
                return clean;
        }
    }
    // ② 鲁棒答案起点扫描（跳过分析句 — V2 修复）
    const as = findAnswerStartRobust(text);
    if (as !== null) {
        const tail = cleanTail(text.slice(as));
        const clean = stripPlanningPrefix(tail);
        if (clean && clean.length >= 10)
            return clean;
    }
    // 无可靠转场/答案起点 → 宁可空也不泄漏后台话
    return '';
}
/** 兜底清理：残留的系统指令标记【…】整段删除（防 legacy 分支泄漏） */
function removeSystemMarks(text: string): string {
    return text.replace(SYSTEM_MARK_G_RE, '').trim();
}
const ANSWER_MARK_RE = /(?:好了|好)，[^。]{0,18}?(?:回应|回答|对|和|说)[^。]{0,12}?(?:吧|了|——)[。]?/;
function findAnswerMark(text: string): { index: number; length: number } | null {
    const m = text.match(ANSWER_MARK_RE);
    if (m && typeof m.index === 'number')
        return { index: m.index, length: m[0].length };
    return null;
}
/**
 * S4-生产实测: V4-flash 过渡标记句式漂移枚举不完（说吧/对话吧/叫醒吧/回应他吧…）。
 * 结构识别答案起点更鲁棒——答案几乎总以三类之一开头：
 *   ① 动作描写 "（…）" / "(…)"
 *   ② 称呼 + 第二人称 + 对话动作（疑问/祈使）: "鸿艺先生，你怎么了？"
 *   ③ 自称 + 具体场景: "梓铭刚洗完澡，正窝在宿舍…"
 * 思维链（我得/我要/作为/最重要的是…）不含以上形态。逐句判断，返回第一个答案句的文本位置。
 */
// V12根治: 身体动作词 + 角色名（区分动作描写答案 vs 思维链分析/场景括号）
const ACTION_VERBS = /愣|笑|顿|停|缩|颤|叹|咽|抬|低|咬|吸|摇|点|垂|眯|皱|抿|僵|怔|埋|补|抖|贴|枕|挪|坐|站|走|看|听|屏|沉|放低|放缓|清了清|深呼吸|拍了拍|抚上|贴了贴|顿了顿|停了停|放慢|压得|应了|想了想|拿开|轻轻|沉默|呼吸|拿近|滑动|叹了|挪了|蹭|哈|哦了一声/;
const ROLE_RE = /(?:梓铭|她|玉瑶|诗雨|徐诗雨|熊梓铭|他)/;

function isAnswerSentence(s: string): boolean {
    // V3 修复: 括号开头不一定是答案。三档判断——
    //   ① 短自我标注（内容≤8字，"（语气放缓了些）"）→ 非答案（思维链元信息）
    //   ② 分析句括号（"（他在接我刚才的话…""（我该接住…"）→ 非答案（内容以"他/我"开头+心理动词）
    //   ③ 其余 = 动作描写答案（"（梓铭听到'无比珍惜'四个字…""（愣了一下）""（伸手轻轻抚上…）"）→ 答案
    const _paren = s.match(/^[（(]([^）)]*)/);
    if (_paren) {
        const _inner = _paren[1].trim();
        // ① 自我标注前缀（思维链元信息"（语气放缓了些）"）→ 非答案
        if (/^(?:语气|声音|态度|表情|眼神|呼吸|语速|音量|停顿|稍|放缓|放低|低沉|迟疑|犹豫|顿住|清了清嗓)/.test(_inner))
            return false;
        // ② 分析句括号（"（他在接我刚才的话…""（我该接住…"）→ 非答案
        if (/^(?:他|我)[，,]?(?:在|该|要|应|想|觉得|认为|得|没|不|心里|开始|还)/.test(_inner))
            return false;
        // ③ V6/S4-C2修复: 内容≤8字的短括号——身体动作（"（愣了一下）"）→ 答案；补充信息/自我标注（"（2008年生）"）→ 非答案
        if (_inner.length <= 8) {
            // V14: 加"温柔/抱/拍/抚/拉/握/揽/靠/贴/吻/亲"等动作描写词——"（温柔一笑）""（轻轻抱了抱）"也是答案
            //   注意: 不能用单字"温"——"（温和）"是形容词非动作（V14 误判修复）
            if (/^(?:愣|笑|顿|停|缩|颤|叹|咽|抬|低|咬|吸|摇|点|垂|背|眯|皱|抿|温柔|抱|拍|抚|拉|握|揽|靠|贴|吻|亲)/.test(_inner))
                return true;
            return false;
        }
        // ④ V10修复: "（他们已经有过亲密互动）"——第三人称复数/分析对话性质 → 非答案
        if (/^(?:他们|她们|他|她)[，,]?已经/.test(_inner))
            return false;
        // ④b V12修复: 分析引导词括号（"（因为是首次正式会面）"）→ 非答案
        if (/^(?:因为|由于|关于|反映|准备|注意|我的|让我|我先|开场|身份|自称|这是|嗯|反应|比如|例如|像|好像|属于|但先|只是|不过|整理|录入|快到午饭|拟定|规划)/.test(_inner))
            return false;
        // ④c V14修复: 括号段含引号+强评估动词（"（"怎么还没开始"/"快点开始"），衔接了当前场景，而且保持了克制。）"）
        //   ——模型在最终稿前的评估句（引用用户/自己话后接衔接/保持/克制等强评估动词）→ 非答案
        //   注意: 不能用"这句/这样/语气"等宽泛词——"（诗雨听见这句，锅铲'咔'地磕在灶沿…）"动作描写含"这句"会被误伤。
        if (/[“"'"]/.test(_inner) && /(?:衔接了|保持了|克制|放在一起|表达.{0,4}方式|接得|接住|不唐突|不突兀|合乎|显得自然|得体)/.test(_inner))
            return false;
        // ⑤ V12根治: 含角色AND动作词 → 动作描写答案；否则（分析/场景/补充括号）→ 非答案
        if (ROLE_RE.test(_inner) && ACTION_VERBS.test(_inner))
            return true;
        if (ACTION_VERBS.test(_inner))
            return true;
        return false;
    }
    // V12修复: 称呼+逗号+对话——句子以"鸿艺先生，"等开头且含"你/您/我" → 强答案信号
    if (/^(?:鸿艺先生|鸿艺|梓铭|玉瑶|诗雨|徐诗雨)[，,][\s\S]{0,60}(?:你|您|我)/.test(s))
        return true;
    // 称呼 + 第二人称 + 对话动作（"鸿艺先生，你怎么了？"）。
    //   S4-生产实测: 词表去"来"——"鸿艺先生又发来乱码了"的"来"是补语，误判思维链为答案
    //   V6 修复: 排除引用引号句子（"我之前刚说过'熊梓铭在呢，你想听什么…'"）——引用他人/自己之前的话不是动作描写答案。
    //     真正的答案句不带这种"完整引用引号"（引用是分析句在复述对话内容，非角色在说话）。
    if (/(?:鸿艺先生|鸿艺|梓铭|玉瑶)[^。]{0,25}(?:你|您)/.test(s) && /[？?！!]|怎么|别|看|听|摸摸|叫|散会/.test(s) && !/[‘’“”'"][^‘’“”'"]{2,}(?:熊梓铭|梓铭|玉瑶|鸿艺)[^‘’“”'"]{0,15}[‘’“”'"]/.test(s))
        return true;
    if (/(?:梓铭|玉瑶)刚/.test(s))
        return true;
    // S4-生产实测: 自称+语气词结尾的答案（"玉瑶当然是玉瑶呀"）。
    //   注意: 不能只靠"？/！"结尾判定（思维链"那时候我做了什么？"也以？结尾），必须自称+语气词
    if (/(?:玉瑶|梓铭).{0,20}[呀嘛呢吧啊诶]/.test(s) && !/^(?:我得|我要|我需要|我先|我想|我记得|我可以|我决定|作为|最重要的是|那时候|然后|对，|现在)/.test(s) && !/(?:该怎么|怎么回|怎么应|怎么接|怎么答|该如何|怎么想)/.test(s) && !/[‘’“”'\"][^‘’“”'\"]{2,}(?:熊梓铭|梓铭|玉瑶|鸿艺)[^‘’“”'\"]{0,15}[‘’“”'\"]/.test(s))
        return true;
    return false;
}
function findAnswerStart(text: string): number | null {
    // V9 根治: 全局括号段扫描——括号思维链段跨句子（"（…开心吗'。这是一个温柔的问句。…我要接住…）"），
    //   句子切分+单句内匹配"）"都失效。用栈扫描整个 text 找所有完整"（…）"括号段（跨句子），
    //   每个括号段作为候选：isAnalysisSentence(段)=true 跳过（思维链），isAnswerSentence(段)=true 返回段起点（动作描写答案）。
    //   非括号句子仍按原逻辑。
    const openIdx = [];
    const candidates: Array<{ start: number; end: number }> = [];
    for (let k = 0; k < text.length; k++) {
        if (text[k] === '（')
            openIdx.push(k);
        else if (text[k] === '）') {
            if (openIdx.length > 0) {
                const start = openIdx.pop()!;
                candidates.push({ start, end: k });
            }
        }
    }
    // 括号段按起点排序，先判断：若括号段是思维链跳过，是动作描写答案返回起点
    candidates.sort((a, b) => a.start - b.start);
    let skipTo = -1;
    for (const c of candidates) {
        if (c.start < skipTo)
            continue; // 已跳过的嵌套段
        const seg = text.slice(c.start, c.end + 1);
        if (isAnalysisSentence(seg)) {
            skipTo = c.end; // 思维链段整体跳过
            continue;
        }
        if (isAnswerSentence(seg))
            return c.start;
    }
    // 非括号起点回退：句子切分找答案
    const sentences = text.split(/(?<=[。！？…\n])/);
    let pos = 0;
    for (const s of sentences) {
        if (!s.trim()) {
            pos += s.length;
            continue;
        }
        const st = s.trim();
        if (st.startsWith('（')) {
            pos += s.length;
            continue;
        } // 括号段已处理
        // V8 粘连识别
        const adhIdx = st.lastIndexOf('）（');
        const adhOpen = adhIdx >= 0 ? st.slice(adhIdx + 1) : '';
        if (adhOpen.startsWith('（') && adhOpen.length >= 11 && !isAnalysisSentence(adhOpen)) {
            return pos + (s.length - s.trimStart().length) + adhIdx + 1;
        }
        // V8 分析句跳过
        if (!isAnalysisSentence(st) && isAnswerSentence(st))
            return pos + (s.length - s.trimStart().length);
        pos += s.length;
    }
    return null;
}
/**
 * 计划句剥离 — 过渡标记后残留的"面向回答的抽象自我指令"。
 * S4-C2 修正: "我会先/我得/我需要/我要用"可能被真实答案首句使用（"我要用一辈子来爱你"），
 *   不能直接剥。组合判定: 仅当 "我会先…" 句后紧接 "语气要/回答要" 等其他计划句时才剥（用户实测
 *   "我会先承认…。语气要自然一点…" 组合）；纯答案句（后无计划句）保留。
 */
function stripPlanningPrefix(text: string): string {
    let t = text;
    for (let i = 0; i < 5; i++) {
        // ① 明确指令计划句（语气要/回答要/声音要… — 描述"如何回应"的自我指令，几乎必是计划句，非答案本体）
        const m = t.match(/^(?:语气要|回答要|声音要|态度要|眼神要|表情要)[^。]{2,}。?/);
        if (m) {
            t = t.slice(m[0].length).trimStart();
            continue;
        }
        // ② "我会先/我得/我需要/我要用/我要保持"开头 + 后续还有计划句 → 整段计划
        if (/^(?:我会先|我得|我需要|我要用|我要保持|然后我要|接着我要)/.test(t)) {
            const firstSentence = t.match(/^[^。]+。?/);
            const rest = firstSentence ? t.slice(firstSentence[0].length).trimStart() : '';
            if (rest && /^(?:语气要|回答要)/.test(rest)) {
                t = rest;
                continue;
            }
        }
        break;
    }
    return t;
}
/**
 * P1-6: 从 reasoning_content 提取真正答案（结构提取，替代关键词逐句）。
 * ① 找过渡标记取其后（最可靠锚点）→ ② 剥计划句 → ③ 无标记降级 stripThinkingPrefix → ④ 保底原文。
 * 非流式最终 reply 的唯一出口；流式状态机共用 findAnswerMark。
 */
/** 角色建立段（无过渡标记时的降级防御）: "好的，现在我是{角色}了，我是{描述}…" */
const ROLE_SETUP_RE = /^好的，现在我是[^。]{1,20}了(?:，[^。]{1,80})?。?/;
function stripRoleEstablishment(text: string): string {
    const m = text.match(ROLE_SETUP_RE);
    if (m)
        return cleanTail(text.slice(m[0].length));
    return text;
}
/** 清理 tail 前导空白/孤立标点（切答案起点后可能残留 "。(" 之类） */
function cleanTail(s: string): string {
    return s.replace(/^[\s。！？…,.，、]+/, '');
}
/**
 * V14c: 草稿迭代型去重——检测"同一回复输出两遍"（生产实测: 同一内容≥3句重复）。
 * 按段（句末标点/换行切）取前 3 段指纹，若指纹在后续再次完整出现 → 截断保留第一遍。
 */
function dedupeRepeatedBlock(text: string): string {
    const t = text || '';
    if (t.length < 30) return t;
    const parts = t.split(/(?<=[。！？…\n])/);
    if (parts.length < 6) return t;
    // 取前 3 段指纹（≥4字/段）
    const fingerprint: string[] = [];
    for (const p of parts) {
        const c = p.trim();
        if (c.length >= 4) {
            fingerprint.push(c);
            if (fingerprint.length >= 3) break;
        }
    }
    if (fingerprint.length < 2) return t;
    const joinedFp = fingerprint.join('');
    // 找指纹首次出现结束位置
    let firstEnd = -1;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].trim().length >= 4 && parts[i].trim() === fingerprint[0]) {
            firstEnd = i;
            break;
        }
    }
    if (firstEnd < 0) return t;
    // 从 firstEnd 起累积，找指纹完整重复（在第一次之后）
    let acc = '';
    for (let i = firstEnd; i < parts.length; i++) {
        acc += parts[i];
        if (acc.includes(joinedFp) && acc.length > joinedFp.length) {
            const repIdx = acc.indexOf(joinedFp);
            return t.slice(0, t.indexOf(acc) + repIdx);
        }
    }
    return t;
}
export function extractAnswerFromReasoning(text: string): string {
    // V22: 尾部英文起草截断统一兜底（①②③④⑤ 全部策略链均经此出口）
    return truncateLatinMetaTail(extractAnswerFromReasoningInner(text));
}

/** 原提取主体（V1–V21 策略链）。尾部元推理截断由外层 truncateLatinMetaTail 统一处理。 */
function extractAnswerFromReasoningInner(text: string): string {
    if (!text)
        return '';
    // ① 复盘型思维链（引用系统指令标记）→ 专用剥离。'' = 宁空不泄漏后台话。
    //   V20: 只认精确系统引用（SYSTEM_REFERENCE_RE），草稿迭代词已分离，可安全放最前。
    const reflective = extractFromReflectiveChain(text);
    if (reflective !== null)
        return reflective;
    // ② V19 规划型思维链: [规划段: 列表/编号/元认知主语] + [转场指令] + [答案]。
    const afterPlan = findAfterPlanChain(text);
    if (afterPlan)
        return afterPlan;
    // ③ V14b 写转场: "让我来写…回应："（冒号后即最终稿，直接切片）。
    const afterWrite = findAfterWriteGo(text);
    if (afterWrite)
        return afterWrite;
    // ④ 草稿迭代型: [草稿1] + [评估段] + [最终稿]。评估段强信号统一 V17（最终确认）/ V18（✓/最终写出来）/ V20（让我+元认知动词）。
    const afterEval = findAfterLastEval(text);
    if (afterEval)
        return afterEval;
    // ⑤ legacy 逻辑（残留系统标记由 removeSystemMarks 兜底清理）
    return removeSystemMarks(extractAnswerFromReasoningLegacy(text));
}
// ⚠️ 2026-09-12 去重说明: 此处曾出现**第二份** resolveReplyFromFields（并行窗口 W2 写入）。
//   同文件两份定义 → tsc TS2323/TS2393 → **整个 webui 无法启动**（生产实例掉线实测）。
//   唯一权威实现见本文件上方（含 fail-closed 收窄 / content 分支不判空 / 语言无关英文起草截断）。
/** 草稿迭代型评估段强信号 —— 统一 V17/V18/V20 三类漂移措辞（正常角色回答绝不含，不依赖漂移措辞）。
 * V17: 最终确认/最终稿；V18: ✓/最终写出来/检查；V20: 让我+元认知动词（重写/优化/定稿/再试）。
 * 注意不收录"差不多/保持了…语气"等弱词——它们在正常对话里常见（"收拾得差不多了"），靠强信号触发。 */
const EVAL_STRUCT_RE = /[✓✔]|最终写出来|最终写出|检查是否有问题|检查：|最终确认|最终稿|让我[^。！？\n]{0,10}?(?:重写|优化|完善|润色|修改|调整|收紧|微调|确认|改写|整理|写出|写下来|写出来|来写|再试|定稿|补充|扩展|精简|换个|重来|斟酌|打磨|润一润)/;
/** V19 规划型思维链骨架 —— 角色对话绝不含的元认知结构（列表/编号/自述计划主语） */
const PLAN_SKELETON_RE = /(?:^|\n)\s*[-•] |(?:^|\n)\s*\d+[.、] |(?:我的角色是|我的性格是|我想表达|我要怎么|我会用较|关于长度|关于语气|必须用|必须保持|不能太直白|避免过度)/;
/** V19 转场指令 —— 规划段结束、进入最终答案的明确信号（动词骨架，不依赖漂移措辞） */
const PLAN_GO_RE = /让我(?:把它|现在)?写出来|让我来写|现在开始写|最终写出|写出来[，,]?用/;
/** V14b 写转场 —— "让我来写…回应/回答/回复/一段/正文："（冒号结尾，答案紧随其后）。
 * 冒号是明确答案起点，直接切片即可，无需 findAnswerStart（V14b 最终稿以第一人称动作"我把火关小"开头，不命中 ROLE_RE/ACTION_VERBS）。 */
const WRITE_GO_RE = /让我来写[^。！？\n]{0,12}?(?:回应|回答|回复|一段|正文)[：:]/;
/** V19: 取规划段之后的答案 —— 识别骨架后，取最后一个转场指令之后的答案起点。 */
function findAfterPlanChain(text: string): string | null {
    if (!PLAN_SKELETON_RE.test(text))
        return null;
    const re = new RegExp(PLAN_GO_RE.source, 'g');
    let lastIdx = -1;
    for (;;) {
        const m = re.exec(text);
        if (!m)
            break;
        lastIdx = m.index + m[0].length;
    }
    if (lastIdx < 0)
        return null;
    const tail = text.slice(lastIdx);
    const as = findAnswerStart(tail);
    if (as !== null) {
        const clean = stripPlanningPrefix(cleanTail(tail.slice(as)));
        if (clean && clean.length >= 10)
            return clean;
    }
    return null;
}
/** V14b: 取"让我来写…回应："写转场之后直接切片 —— 冒号后即为最终稿（无需 findAnswerStart）。 */
function findAfterWriteGo(text: string): string | null {
    const re = new RegExp(WRITE_GO_RE.source, 'g');
    let last = null;
    for (;;) {
        const m = re.exec(text);
        if (!m)
            break;
        last = { index: m.index, len: m[0].length };
    }
    if (!last)
        return null;
    const tail = cleanTail(text.slice(last.index + last.len));
    if (tail.length >= 10) {
        const clean = stripPlanningPrefix(tail);
        if (clean && clean.length >= 10)
            return clean;
    }
    return null;
}
/** 草稿迭代型: 取最后一个评估段信号之后的最终稿 —— 找最后一个评估信号，向后扫描到第一个动作描写/称呼答案起点。 */
function findAfterLastEval(text: string): string | null {
    if (!EVAL_STRUCT_RE.test(text))
        return null;
    const re = new RegExp(EVAL_STRUCT_RE.source, 'g');
    let lastIdx = -1;
    for (;;) {
        const m = re.exec(text);
        if (!m)
            break;
        lastIdx = m.index + m[0].length;
    }
    if (lastIdx < 0)
        return null;
    const tail = text.slice(lastIdx);
    const as = findAnswerStart(tail);
    if (as !== null) {
        const clean = stripPlanningPrefix(cleanTail(tail.slice(as)));
        if (clean && clean.length >= 10)
            return clean;
    }
    return null;
}
/** 原剥离逻辑（过渡标记 → 结构识别 → 角色建立段 → 关键词） */
function extractAnswerFromReasoningLegacy(text: string): string {
    if (!text)
        return '';
    // ① 过渡标记（最精确，命中即切其后）
    const m = findAnswerMark(text);
    if (m) {
        const tail = cleanTail(text.slice(m.index + m.length));
        const clean = stripPlanningPrefix(tail);
        // S4-C2: 剥空 → 返回未剥离 tail（防落降级路径泄漏过渡标记）；tail 也空 → 落降级防 Empty
        if (clean)
            return clean;
        if (tail)
            return tail;
    }
    // ② 结构识别答案起点（S4-生产实测: 过渡标记句式漂移枚举不完，动作描写/直接对话更鲁棒）
    const as = findAnswerStart(text);
    if (as !== null) {
        const tail = cleanTail(text.slice(as));
        const clean = stripPlanningPrefix(tail);
        if (clean)
            return clean;
        if (tail)
            return tail;
    }
    // 降级（无过渡标记/无答案起点）: 剥角色建立段 → 再找答案起点。
    // S4-生产实测修正: 角色建立段("好的，现在我是XX了")后还有大量思维链(角色描述/复述/计划)，
    //   剥第一句就返回会泄漏后续思维链——必须继续 findAnswerStart，找不到则返回原文（让外层缓冲等答案起点）。
    let t = stripRoleEstablishment(text);
    if (t !== text) {
        const as2 = findAnswerStart(t);
        if (as2 !== null) {
            const tail = cleanTail(t.slice(as2));
            const clean = stripPlanningPrefix(tail);
            if (clean)
                return clean;
            if (tail)
                return tail;
        }
        // 剥了角色建立段但后面仍无答案起点 → 返回原文（不剥），防思维链当答案
        return text;
    }
    return stripThinkingPrefix(text);
}
/**
 * P1-5: 流式思维链剥离状态机 — 增量剥离 thinking，只把答案增量交给 onToken。
 * S3 诊断修正: 关键词逐句剥离对 V4-flash 结构模板（角色建立→复述→过渡标记）失效，
 *   只认过渡标记切答案区；思维链特征开头(角色建立段)缓冲不推；无标记时降级关键词逻辑。
 * content 非空立即切答案区直推。保守原则：拿不准 → 不推（done 帧 reply 覆盖气泡）。
 */
class StreamThinkingStripper {
    buf = '';
    crossed = false; // 已进入答案区
    tailBuf = '';    // V14: crossed 后 content 增量累积，尾部评估句检测截断
    reasoningBuf = ''; // V21: 累积 delta.reasoning（思维链字段），仅流结束兜底用，绝不流式展示
    /** V14: 尾部评估句特征（模型在答案后继续输出复盘评估：长度/语气确认、正文检查） */
    private static tailEvalRe = /(?:这个长度很合适|这个长度合适|语气也贴合|语气贴合|语气也合适|确认一下|正文里(?:有|带)|回答里(?:有|带)|内容里(?:有|带)|检查一下.*正文|这段回复|稍微修改|最终确认|最终稿|尺度.{0,8}合适|保持了.{0,12}风格)/;
    reset() { this.buf = ''; this.crossed = false; this.tailBuf = ''; this.reasoningBuf = ''; }
    /** 推送一个 chunk，返回可安全展示的 text 增量（''=本 token 不推） */
    push(content: string | undefined, reasoning: string | undefined): string {
        const c = content || '';
        const r = reasoning || '';
        // V21: reasoning 是思维链字段（分析/规划/草稿/评估段），绝不流式展示。
        //   只累积到 reasoningBuf，供流结束时 content 为空的降级模式兜底。
        if (r)
            this.reasoningBuf += r;
        if (!c)
            return '';
        // 已进入答案区 → content 直推（答案在 content），reasoning 已在上面丢弃
        if (this.crossed) {
            // V14: 尾部评估句截断——模型在答案后可能继续输出复盘评估
            //   （"这个长度很合适，语气也贴合。确认一下：正文里有'诗雨'吗？有——"），
            //   累积 tailBuf 检测评估特征词，命中即停止推送（丢弃后续评估）。
            this.tailBuf += c;
            // 注意: search 是 String 方法，不是 RegExp 方法（V14 bug: tailEvalRe.search 抛异常吞后续 content）
            const evalIdx = this.tailBuf.search(StreamThinkingStripper.tailEvalRe);
            // V22: 英文起草/元推理截断 —— tailEvalRe 只枚举中文特征词，
            //   模型在真答案后继续用英文写起草自检（Count:/Revised:/Final:/~68 chars）会整段洩漏前台。
            //   两个判据取**更早**的截断点，任一命中即停止推送。
            const latinIdx = findLatinMetaStart(this.tailBuf);
            let cutIdx = evalIdx;
            if (latinIdx >= 0 && (cutIdx < 0 || latinIdx < cutIdx))
                cutIdx = latinIdx;
            if (cutIdx >= 0) {
                const out = this.tailBuf.slice(0, cutIdx);
                this.tailBuf = '';
                this.crossed = false; // 进入尾部评估/英文起草 → 停止推送
                return out;
            }
            const out = this.tailBuf;
            this.tailBuf = '';
            return out;
        }
        // 合并进 buf（V21: 只累积 content，绝不混入 reasoning。V14 曾把 reasoning 也混入——
        //   V4-flash 部分模式把思维链输出到 content 字段时 content 本身可能含思维链，仍靠
        //   findAnswerStart 识别答案起点才 crossed；但 reasoning 字段的草稿/评估段绝不能进 buf，
        //   否则第一稿被误判为答案起点泄漏前台。）
        this.buf += c;
        // ① 过渡标记 → 切答案区，推标记后（剥计划句）
        const m = findAnswerMark(this.buf);
        if (m) {
            this.crossed = true;
            const tail = stripPlanningPrefix(cleanTail(this.buf.slice(m.index + m.length)));
            this.buf = '';
            return tail;
        }
        // ② 结构识别答案起点（V9 括号段扫描识别"（她正准备关火…"动作描写答案；思维链句被 isAnalysisSentence 跳过）
        const as = findAnswerStart(this.buf);
        if (as !== null) {
            this.crossed = true;
            const tail = stripPlanningPrefix(cleanTail(this.buf.slice(as)));
            this.buf = '';
            return tail;
        }
        // ②b V14: 缓冲上限保护——buf 超长仍未识别答案起点（content 全思维链），用 extractAnswerFromReasoning 剥离
        if (this.buf.length > 200) {
            // V23.1: 出口过守卫 —— extractAnswerFromReasoning 对剥不动的文本原样返回
            const extracted = gateOutgoingReply(extractAnswerFromReasoning(this.buf));
            if (extracted && extracted.trim().length > 0 && extracted.length < this.buf.length - 10) {
                this.crossed = true;
                this.buf = '';
                return extracted;
            }
        }
        // ③ 角色建立段开头（"好的，现在我是…"）→ 缓冲等标记。
        if (/^好的，现在/.test(this.buf) && this.buf.length < 200)
            return '';
        // ④ 无标记/无答案起点：非流式提取兜底（剥角色建立/关键词/计划句）
        // V23.1: 出口过守卫 —— 同上，防「剥不动即原样返回」
        const extracted = gateOutgoingReply(extractAnswerFromReasoning(this.buf));
        if (extracted && extracted.trim().length > 0 && extracted.length < this.buf.length - 10) {
            this.crossed = true;
            this.buf = '';
            return extracted;
        }
        // ⑤ 提取=原文（无思维链可剥）→ 不推，等答案起点/标记/flush（done 帧覆盖气泡）
        return '';
    }
    /** 流结束兜底：残留 buf 用非流式提取（S4-C1/m4 防无标记/短答案吞字） */
    flush() {
        if (this.crossed || !this.buf)
            return '';
        // V23.1: 出口过统一守卫（原实现只查 isDraftShapedReply，中文元指令型会漏出）
        const extracted = gateOutgoingReply(extractAnswerFromReasoning(this.buf));
        this.crossed = true;
        this.buf = '';
        return extracted;
    }
}

/** P1-5: 流式结果（text 为剥离后答案累积） */
interface StreamChatResult {
  text: string;
  usage?: { prompt: number; completion: number };
  sawToken: boolean;
}

function resolveApiKey(): string | undefined {
  const fromEnv = process.env['DEEPSEEK_API_KEY'] || process.env['LLM_API_KEY'] || process.env['DOUBAO_API_KEY'] || undefined;
  const fromStore = getKeyValue('DEEPSEEK_API_KEY') || getKeyValue('LLM_API_KEY') || getKeyValue('DOUBAO_API_KEY') || undefined;
  return fromEnv || fromStore;
}

export function isAvailable(): boolean {
  return !!(process.env['DEEPSEEK_API_KEY'] || process.env['LLM_API_KEY'] || getKeyValue('DEEPSEEK_API_KEY') || getKeyValue('LLM_API_KEY'));
}

export class DeepSeekLLMProvider implements LLMProvider {
  private static _transitionState: TransitionState = createInitialState();
  private static _currentRole: RoleType = 'secretary';

  /** SP1-3: 暴露当前角色供RoleGuard使用 */

  /** SP1-3: 暴露当前角色供RoleGuard使用 */
  static getCurrentRole(): RoleType {
    return DeepSeekLLMProvider._currentRole;
  }
  private model: string;
  private persona: IPersona;

  constructor(model?: string, persona?: IPersona) {
    this.model = model || process.env['LLM_MODEL'] || process.env['DEEPSEEK_MODEL'] || _providerCfg.model;
    // 默认玉瑶人设
    this.persona = persona ?? {
      id: 'yuyao',
      name: '玉瑶 · 灵魂伴侣',
      description: '默认',
      buildSystemPrompt: (l, k) => buildSystemPrompt(l, k),
    };
  }

  /** 切换角色 */
  setPersona(persona: IPersona): void {
    this.persona = persona;
  }

  /**
   * 原始 LLM 调用（绕过玉瑶 persona 和角色路由）
   * 供提取类、分析类任务使用（如 ProfileAcquisitionEngine）
   */
  async rawCall(messages: DeepSeekMessage[], maxTokens: number, temperature: number): Promise<string> {
    const result = await this.callDeepSeekApi(messages, maxTokens, temperature, { timeoutMs: 45_000 });
    return result.text;
  }

  /**
   * 调用 DeepSeek API（带超时+重试，5s~30s→降级）
   * 🔴 P1-5: streamOpts.onToken 存在时走流式路径（streamChat），返回契约不变。
   * 返回 { text, usage } 或抛出错误
   */
  private async callDeepSeekApi(messages: DeepSeekMessage[], maxTokens: number, temperature: number, extraParams: { frequency_penalty?: number; presence_penalty?: number; reasoning_effort?: string; level?: number; timeoutMs?: number } = {}, streamOpts?: { onToken?: (delta: LLMTokenDelta) => void }): Promise<{ text: string; usage?: { prompt: number; completion: number } }> {
    // 🔴 P1-5 流式分支: onToken 提供时启用流式（token 增量旁路推送，重试只在首 token 前）
    if (streamOpts?.onToken) {
      const r = await this.streamChat(messages, maxTokens, temperature, extraParams, streamOpts.onToken);
      return { text: r.text, usage: r.usage };
    }
    const lastError: string[] = [];
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const _dl = (extraParams as any).level ?? 0;
        // 优先使用场景配置传入的超时，否则按亲密等级降级
        const _timeoutMs = (extraParams as any).timeoutMs
          || (_dl >= 2 ? 30000 : _dl <= -2 ? 20000 : 30000);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), _timeoutMs);

        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resolveApiKey() || process.env['DEEPSEEK_API_KEY'] || ''}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            max_tokens: maxTokens,
            messages: messages.map(m => ({ ...m, content: sanitizeUTF16(m.content) })),
            temperature,
            top_p: 0.95,
            frequency_penalty: extraParams.frequency_penalty ?? 0.0,
            presence_penalty: extraParams.presence_penalty ?? 0.2,
            ...(extraParams.reasoning_effort ? { reasoning_effort: extraParams.reasoning_effort } : {}),
          }),
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const errText = await response.text();
          // 429=限流 500/502/503/504=服务端临时故障 — 值得重试
          const status = response.status;
          if ((status === 429 || status === 500 || status === 502 || status === 503 || status === 504) && attempt < maxRetries) {
            const waitMs = (attempt + 1) * 3000;
            lastError.push(`${status} (尝试 ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`DeepSeek API ${status}: ${errText.substring(0, 200)}`);
        }

        const data = (await response.json()) as DeepSeekResponse;
        const msg = data.choices?.[0]?.message;
        // 🔴 V22(2026-09-12) 字段边界优先 + fail-closed（生产洩漏修复）
        //   原实现: content 空 → 取 reasoning_content 原文 → extractAnswerFromReasoning 剥离失败时
        //   **返回原文** → 整段思维链（英文分析 + 中文草稿 + 指令复述）被当回复输出（生产实测多条）。
        //   现约定: content 有值即用；content 空时 reasoning 仅作最后手段，且必须真正剥出答案，
        //   剥离失败(≈原文) 或 形态仍是草稿 → 判「无可用答案」，宁可失败重试也绝不洩漏。
        const _rawReasoning = msg?.reasoning_content ?? (msg as any)?.reasoning;
        if (!String(msg?.content || '').trim() && !String(_rawReasoning || '').trim()) {
          throw new Error('Empty response from DeepSeek');
        }
        const text = resolveReplyFromFields(msg?.content, _rawReasoning as string | undefined);
        if (!text) {
          const e: any = new Error('No usable answer after reasoning strip (fail-closed, 拒绝洩漏思维链)');
          e.noUsableAnswer = true;
          throw e;
        }

        return {
          text,
          usage: data.usage
            ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
            : undefined,
        };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          lastError.push('Timeout');
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
        }
        if (attempt < maxRetries) {
          lastError.push(err.message || String(err));
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw err; // 最后一次尝试失败，向上抛
      }
    }
    throw new Error(`API call failed after ${maxRetries + 1} attempts: ${lastError.join(' -> ')}`);
  }

  // ═══════ 🔴 P1-5 流式 ═══════

  /**
   * 流式聊天 — SSE 解析 + 思维链增量剥离，onToken 旁路推送答案增量。
   * 重试只在首 token 前（sawToken=false）；已推 token 后失败直接抛（不可重放）。
   */
  private async streamChat(
    messages: DeepSeekMessage[],
    maxTokens: number,
    temperature: number,
    extraParams: { frequency_penalty?: number; presence_penalty?: number; reasoning_effort?: string; level?: number; timeoutMs?: number },
    onToken: (delta: LLMTokenDelta) => void,
  ): Promise<StreamChatResult> {
    const maxRetries = 2;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.streamChatOnce(messages, maxTokens, temperature, extraParams, onToken);
      } catch (err: any) {
        lastErr = err;
        if (err?.sawToken) throw err; // 已推过 token → 部分输出无法重放，不重试
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('streamChat unreachable');
  }

  /** 单次 SSE 流式读取（TextDecoder stream:true 防中文跨 chunk 乱码） */
  private async streamChatOnce(
    messages: DeepSeekMessage[],
    maxTokens: number,
    temperature: number,
    extraParams: any,
    onToken: (delta: LLMTokenDelta) => void,
  ): Promise<StreamChatResult> {
    const _dl = extraParams?.level ?? 0;
    const _timeoutMs = extraParams?.timeoutMs || (_dl >= 2 ? 30000 : _dl <= -2 ? 20000 : 30000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), _timeoutMs);
    let sawToken = false;
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resolveApiKey() || process.env['DEEPSEEK_API_KEY'] || ''}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: messages.map(m => ({ ...m, content: sanitizeUTF16(m.content) })),
          temperature,
          top_p: 0.95,
          frequency_penalty: extraParams?.frequency_penalty ?? 0.0,
          presence_penalty: extraParams?.presence_penalty ?? 0.2,
          ...(extraParams?.reasoning_effort ? { reasoning_effort: extraParams.reasoning_effort } : {}),
          stream: true,
        }),
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`DeepSeek stream API ${response.status}: ${errText.substring(0, 200)}`);
      }
      if (!response.body) throw new Error('DeepSeek stream: no response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8'); // stream:true 防中文跨 chunk 乱码
      const stripper = new StreamThinkingStripper();
      let text = '';
      let usage: { prompt: number; completion: number } | undefined;
      let buf = '';
      let finished = false;

      for (;;) {
        if (finished) break;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame.startsWith('data:')) continue;
          const data = frame.slice(5).trim();
          if (data === '[DONE]') { finished = true; break; }
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta;
            if (json?.usage && !usage) {
              usage = { prompt: json.usage.prompt_tokens ?? 0, completion: json.usage.completion_tokens ?? 0 };
            }
            if (!delta) continue;
            const content = typeof delta.content === 'string' ? delta.content : '';
            // S4-生产实测: 真实 v4-flash 流式思维链在 delta.reasoning 字段（非 reasoning_content）！
            //   content 承载答案（从答案起点"（"开始非空），reasoning 承载思维链（逐 token）。
            const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning
              : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
            if (!content && !reasoning) continue;
            const push = stripper.push(content, reasoning);
            if (push) {
              sawToken = true;
              text += push;
              onToken({ text: push });
            }
          } catch { /* 忽略单帧解析错误（SSE 注释/keepalive 等） */ }
        }
      }
      try { reader.releaseLock(); } catch { /* 已释放 */ }

      // 流结束：flush 剩余无 \n\n 尾帧
      if (!finished && buf.trim().startsWith('data:')) {
        const data = buf.trim().slice(5).trim();
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta;
            if (delta) {
              const content = typeof delta.content === 'string' ? delta.content : '';
              const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning
                : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
              const push = stripper.push(content, reasoning);
              if (push) { sawToken = true; text += push; onToken({ text: push }); }
            }
          } catch { /* 忽略 */ }
        }
      }
      // S4-C1/m4: 流结束 flush 残留思维链缓冲（防无标记/短答案整条被吞）
      const flushed = stripper.flush();
      if (flushed) { sawToken = true; text += flushed; onToken({ text: flushed }); }
      // 🔴 V21 流式结束字段边界优先: content 承载最终稿、reasoning 承载思维链。
      //   流式期间 text 只累积 content 答案（reasoning 已丢弃，草稿/评估段绝不流式展示）。
      //   content 有答案 → 信任 text；content 空（降级模式: 答案在 reasoning）→ 用 reasoningBuf 全量剥离兜底。
      if (!text.trim()) {
        // 🔴 V22 复评（2026-09-12 生产回归实测）: 此处**不得**用 fail-closed 的 resolveReplyFromFields
        //   —— 它把「剥不出答案」判成空串，会直接让会晤模式退化为
        //   「…（抱歉，我暂时无法回应，请稍后再试。）」（实测 15 分钟内 3 次）。
        //   保留「宁可空也不洩漏」的意图，但改为**尽力提取**：extractAnswerFromReasoning
        //   内部已含 V22 语言无关尾截断（英文起草段照样被切掉），仅当整段确为思维链时才返回空。
        // 🔴 V23.1(2026-09-13): 出口统一过 gateOutgoingReply —— 实测此出口曾漏出中文元指令型
        //   思维链并落库（id=2321）。extractAnswerFromReasoning 对"剥不动"的文本会**原样返回**，
        //   必须由守卫兜底判断。守卫判据零误杀，不会让降级模式下的合法短答被吞
        //   （与上方注释担心的"退化成抱歉无法回应"无关：那只发生在无条件判空时）。
        const full = gateOutgoingReply(extractAnswerFromReasoning(stripper.reasoningBuf));
        if (full && full.trim().length > 0) {
          sawToken = true;
          text = full;
          onToken({ text: full });
        }
      }
      // 🔴 V22c 流式收尾护栏（2026-09-12 生产实测）: 累积文本的最终形态检查。
      //   实测形态: 模型把**注入的记忆片段原样吐回**——回复变成
      //     `- "【徐诗雨的记忆】 鸿艺——（好像在斟酌用词），你是问诗韵和诗涵吧？…"`（草稿列表）。
      //   流式 token 已推出（done 帧会覆盖气泡），但**返回值必须判空**，
      //   交给 M5Orchestrator 重试，避免把草稿/回显当回复落库。
      // 🔴 V23.1(2026-09-13): 改用统一出口守卫（原实现只查草稿形态 + 记忆括注，
      //   中文元指令型从这里溜过去并落库）。gateOutgoingReply 是超集且判据零误杀。
      if (text && gateOutgoingReply(text) !== text) {
        console.error('[DeepSeek] 流式收尾护栏: 拒绝思维链/草稿/记忆回显形态 (len=' + text.length + ')');
        text = '';
        sawToken = false;
      }
      return { text, usage, sawToken };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const e: any = new Error('stream timeout');
        e.sawToken = sawToken;
        throw e;
      }
      err.sawToken = sawToken;
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generate(params: {
    strategy: StrategyConfig;
    cognition: CognitionObject;
    conversationHistory?: ConversationTurn[];
    knowledgeBase?: string;
    currentTime?: string;
    userMessage?: string;
    role?: RoleType;
    isEntityMeeting?: boolean;
    onToken?: (delta: LLMTokenDelta) => void;
    reasoningEffortOverride?: string;
  }): Promise<{ text: string; usage?: { prompt: number; completion: number } }> {
    const rawInput = params.userMessage ?? params.cognition.current.raw_input ?? '';
    const history = params.conversationHistory ?? [];
    const kb = params.knowledgeBase ?? '';
    // 从策略中提取 max_length 约束（M5 策略选择器设定）
    const _strategyMaxLen = params.strategy?.params?.max_length ?? 0;

    // 📜 架构铁律：角色路由以 chat.ts 为单源，此处不再重复分类
    // 直接使用 params.role（从 M5Orchestrator / chat.ts 透传）
    if (params.role) {
      DeepSeekLLMProvider._currentRole = params.role;
    }
    try { const { WorkingMemory } = await import('../m9/WorkingMemory.js'); WorkingMemory.currentTag = DeepSeekLLMProvider._currentRole; } catch (e) { console.warn(`[DeepSeekLLMProvider] 操作失败`, (e as Error)?.message || e); }

    // 📖 本地回复：KB内容含敏感词时绕过API过滤，基于知识库原文直接回答
    if (kb.startsWith('【本地回复】')) {
      const localContent = kb.replace('【本地回复】', '').trim();
      return { text: localContent };
    }

    // 🔥 角色扮演：完全隔离路径（角色设定优先）
    if (kb.startsWith('【角色扮演】')) {
      const rpContent = kb.replace('【角色扮演】', '').trim();
      // 从 rpContent 中拆出角色设定和扮演指令
      const roleDetailMatch = rpContent.match(/【角色设定详细说明（以下是你必须严格遵循的设定）】\n([\s\S]*)/);
      const roleDetail = roleDetailMatch ? roleDetailMatch[1].trim() : '';
      const instruction = roleDetailMatch ? rpContent.substring(0, rpContent.indexOf('【角色设定详细说明')).trim() : rpContent;
      // 角色设定作为核心指令（设定在先，扮演在后）
      const systemContent = roleDetail
        ? '你现在的身份和设定如下。你必须严格遵循这些设定来扮演，不要跳出角色。\n\n========== 角色设定 ==========\n' + roleDetail + '\n\n========== 扮演指令 ==========\n' + instruction
        : rpContent;
      const messages: DeepSeekMessage[] = [{ role: 'system', content: systemContent }];
      const memoryMsg = history.find(t => t.content?.startsWith('📕 【记忆】'));
      if (memoryMsg) messages.push({ role: 'user', content: memoryMsg.content });
      const sanitize = (t: string) => t.replaceAll('妙玉', '玉儿').replaceAll('宝玉', '宝二爷').replaceAll('红楼逸事', '桃花源记');
      for (const turn of history.slice(-4)) {
        if (turn.content?.startsWith('📕 【记忆】')) continue;
        messages.push({ role: turn.role, content: sanitize(turn.content) });
      }
      messages.push({ role: 'user', content: sanitize(rawInput) });
      try {
        const _rpCfg = getScenarioConfig('roleplay');
      return await this.callDeepSeekApi(messages, _rpCfg.maxTokens, _rpCfg.temperature, { frequency_penalty: _rpCfg.frequencyPenalty, presence_penalty: _rpCfg.presencePenalty, reasoning_effort: _rpCfg.reasoningEffort, timeoutMs: _rpCfg.timeoutMs }, params.onToken ? { onToken: params.onToken } : undefined);
      } catch (err) {
        console.error('[Roleplay]', err instanceof Error ? err.message : err);
        return { text: '…' };
      }
    }

    // ── 正常玉瑶模式 ──
    const s = params.cognition.current.perception_snapshot;
    const entities = params.cognition.current.key_entities ?? [];

    // 计算话术等级
    const bp = calcLevel(
      s.pleasure, s.intimacy, s.sexual_attraction, s.sensory_craving,
      s.energy_merge, s.possessiveness, s.ecstasy, s.arousal,
      s.aggression, s.sincerity, s.dominance, rawInput,
    );
    let level = bp.level;
    // 📜 日常话题守卫：用户问天气/时间/工作等正常内容时，不因感知残留而抬高级别
    const _isDailyTopic = /天气|下雨|晴天|温度|几度|时间|几点|星期|日期|工作|项目|开会|吃饭|睡觉|在哪|干嘛|忙什么/.test(rawInput);
    const _hasIntimateWords = /高潮|操|干|插|顶|射|丢|想要|给我|亲我|吻我|抱我|摸我|奶子|胸|屁股|硬了|湿了|进去了|受不了/.test(rawInput);
    if (_isDailyTopic && !_hasIntimateWords && level >= 1) {
      level = 0;
    }

    // ── 表达规格控制（ExpressionSpecController 激活） ──
    const spec = calcExpressionSpec({
      pleasure: s.pleasure, arousal: s.arousal, intimacy: s.intimacy,
      sexual_attraction: s.sexual_attraction, sensory_craving: s.sensory_craving,
      energy_merge: s.energy_merge, ecstasy: s.ecstasy, safety: s.safety,
    });

    // ── 亲密场景渲染（IntimateRenderer 激活 — level ≥ 2 时注入 few-shot） ──
    let intimateSceneExample = '';
    if (level >= 2 && !kb.startsWith('【角色扮演】')) {
      try {
        const sceneTypes: IntimateSceneType[] = ['foreplay', 'thrust', 'climax', 'aftercare'];
        const sceneType = sceneTypes[Math.floor(Math.random() * sceneTypes.length)];
        intimateSceneExample = renderIntimateResponse({
          intensity: bp.raw,
          sceneType,
          userLevel: level >= 2 ? 3 : 2,
        });
      } catch (err) {
        console.warn('[IntimateRenderer] 渲染失败:', err);
      }
    }

    // 构建 System Prompt — 使用当前角色
    // 注入当前系统时间（Asia/Shanghai）
    const timeStr = params.currentTime
      ? new Date(params.currentTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    const _role = params.role || DeepSeekLLMProvider._currentRole;
    const _effectiveRole = (_strategyMaxLen > 0 && _strategyMaxLen <= 15) ? 'secretary' : _role;
    const _kb = params.knowledgeBase || '';
    // 🆕 V4.0: 从上游显式接收实体会晤标志（不再依赖文本前缀检测——PFC会改变前缀）
    const _isEntityMeeting = params.isEntityMeeting === true;
    // 🔴 V27(批1): 传入 isEntityMeeting —— recaller 模板的身份从句据此生成，
    //   避免会晤实体经 role prompt 通道被注入「你的名字是玉瑶」。
    // 🔴 P-10（PAS v1 / V27批3）: knowledge 传入 buildCoreSystemPrompt，由它放到最末
    //   （L0 → 行为约束 → 身份 → L2 参考背景最后）。原实现是 buildRoleSystemPrompt
    //   内部前置拼接 kb，导致核心铁律被挤到中后段。
    const systemPrompt = buildCoreSystemPrompt(timeStr, buildRoleSystemPrompt(_effectiveRole, level as -2|-1|0|1|2, params.knowledgeBase, _isEntityMeeting), _isEntityMeeting, params.knowledgeBase);
    console.log("==SPLIT=="); console.log(systemPrompt.substring(0,500)); console.log("==SPLIT_END==");
    console.log('[DIAG] role=' + _effectiveRole + ' level=' + level + ' entityMeeting=' + _isEntityMeeting + ' kb_start=' + _kb.substring(0,200).replace(/\n/g,' '));
    // 构建上下文提示词
    const dimContext = [
      `pleasure=${s.pleasure.toFixed(2)}`,
      `intimacy=${s.intimacy.toFixed(2)}`,
      `sexual_attraction=${s.sexual_attraction.toFixed(2)}`,
      `sensory_craving=${s.sensory_craving.toFixed(2)}`,
      `energy_merge=${s.energy_merge.toFixed(2)}`,
      `intensity_raw=${bp.raw.toFixed(2)}`,
    ].join(' ');

    const goodExample = STYLE_ANCHORS.good[Math.floor(Math.random() * STYLE_ANCHORS.good.length)];
    let contextBlock: string;
    if (_isEntityMeeting) {
      // 会晤模式：只保留最精简的上下文
      contextBlock = '';
      if (entities.length > 0) {
        contextBlock += `[当前会晤: ${entities.join(', ')}]`;
      }
    } else {
      contextBlock = `[当前感知: ${dimContext}]\n[风格参考: "${goodExample}"]`;
    }

    // 🛡️ V4.0: 会晤模式下跳过所有玉瑶专属的上下文注入
    if (!_isEntityMeeting) {
      if (entities.length > 0) {
        contextBlock += `\n[提到: ${entities.join(', ')}]`;
      }

      // 表达规格约束
      if (spec.forbiddenPatterns.length > 0) {
        contextBlock += `\n[避免] "${spec.forbiddenPatterns.join('", "')}" 这类回应`;
      }
      if (spec.requireEmbodiedResponse && level >= 2) {
        contextBlock += `\n[要求] 包含身体反应描写（体温/呼吸/心跳）`;
      }
      if (spec.requireSensoryDetail && level >= 2) {
        contextBlock += `\n[要求] 包含感官细节（触觉/嗅觉/听觉）`;
      }
      if (spec.recommendedPhrases.length > 0 && level >= 2) {
        contextBlock += `\n[推荐维度] ${spec.recommendedPhrases.join(', ')}`;
      }

      // 亲密场景 few-shot 注入
      if (intimateSceneExample) {
        contextBlock += `\n[亲密回应示例] ${intimateSceneExample}`;
      }

      // 回复长度
      contextBlock += `\n[注意: 如果上面有[内心:...]开头的片段，那是你内心的感觉，不是回忆列表。不要直接复述它，而是自然地转化为关切的语气或行动。]\n[回复长度: 按系统提示中的四级标准回复。简单回应别太短，说事说感受要展开，讲故事别吝啬。]`;

      // 亲密模式
      const isIntimateText = isDeepIntimate(rawInput);
      const isMoanText = isMoan(rawInput);
      if (level >= 1 || isIntimateText || isMoanText) {
        contextBlock += `\n\n【🔥 亲密模式 — 深情交融 · 极致感官】\n...`;
      }

      // 记忆摘要
      const hist = params.cognition.history;
      if (hist?.has_relevant_history && hist.summary !== '无相关历史记忆') {
        contextBlock += `\n[记忆: ${hist.summary}]\n...`;
      }
      // 家族关系
      const fam = params.cognition.family;
      if (fam?.has_family_context && fam.relationships.length > 0) {
        contextBlock += `\n[家族: ${fam.relationships.join('; ')}]`;
      }
    }

    // ═══ 构建聊天消息流 ═══
        // P0-6: 预估Token并告警
    // （P-15 分层埋点已移至 messages 构造完成后 —— 必须计入 userMsgContent 与 kb 复注，
    //   否则 total 系统性低估；见下方 [PromptBudget]）
    const messages: DeepSeekMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // 🛡️ V4.0: 会晤模式下跳过身份边界墙、历史对话、反编造铁律
    if (!_isEntityMeeting) {
      // 🚨 身份边界隔离墙
      messages.push({
        role: 'system',
        content: `【身份边界提醒】下面对话中"鸿艺"说的所有话都是他的事。他说"我在做XXX"是他的工作和生活，你只是陪伴他的伴侣，没有这些经历。你不知道自己具体在忙什么，不要编造工作内容。`,
      });
    }

    // 检测本次是否为自介查询 + 知识库中有玉瑶档案
    const hasSelfProfile = kb.includes('【玉瑶本人】') || kb.includes('玉瑶的档案');
    const isSelfIntroQuery = /你是谁|介绍你自己|你叫什么|你多大了|你多大/.test(rawInput);

    // 注入最近对话历史
    if (_isEntityMeeting) {
      const recentTurns = history.slice(-20);
      for (const turn of recentTurns) {
        messages.push({ role: turn.role, content: turn.content });
      }
    } else if (hasSelfProfile && isSelfIntroQuery) {
      // 跳过历史——防止被之前的亲密对话污染
    } else {
      const recentTurns = history.slice(-getHistoryLimit(rawInput));
      let _truncatedTurns = 0;
      let _truncatedChars = 0;
      for (let _i = 0; _i < recentTurns.length; _i++) {
        const turn = recentTurns[_i];
        const _c = turn.content || '';
        // 🔴 P-02 / P-13（PAS v1 / V27批3）: **末条不截断** ——
        //   `chat.ts` 把运行时守卫块（allGuardMsgs，最多 11 条 join，单条可达 700+ 字符）
        //   作为一条 assistant 伪轮 push 到 history **末尾**（chat.ts:1693-1697）。
        //   它是数组最后一个元素，必落在 slice(-20) 窗口内。
        //   若对它应用 HISTORY_TURN_MAX_CHARS，会导致 memoryGuard（共同过去铁律）/\n        //   hallucinationGuard（不得假装认识）/timeGuard/dailyGuard 等 7~10 条守卫**静默消失**
        //   （独立评审 P1-1，阻断级）。
        //   ⚠️ 守卫的正式收口（迁往 assembler，不再走 history 通道）登记在批4。
        const _isLast = _i === recentTurns.length - 1;
        const _willTruncate = !_isLast && _c.length > HISTORY_TURN_MAX_CHARS;
        if (_willTruncate) {
          _truncatedTurns++;
          _truncatedChars += _c.length - HISTORY_TURN_MAX_CHARS;
        }
        messages.push({
          role: turn.role,
          content: _willTruncate ? _c.substring(0, HISTORY_TURN_MAX_CHARS) + '…' : _c,
        });
      }
      // 🔴 P-13: 截断必须记录并告警（静默丢弃视为违规）—— 与 chat.ts 的 [PromptAssembler⚠P-13] 对齐
      if (_truncatedTurns > 0) {
        console.warn('[P-13] 历史注入截断: ' + _truncatedTurns + ' 条超 ' + HISTORY_TURN_MAX_CHARS
          + ' 字符被剪共 ' + _truncatedChars + ' 字符（mode=normal, 末条守卫已保留）');
      }
    }

    if (!_isEntityMeeting) {
      // 🚨 反编造铁律 + 人物档案独立注入
      if (kb.includes("人物档案") || kb.includes("以鸿艺告诉你的为准")) {
        const antiFabText = '【⚠️ 强制规则 - 必须遵守】\n你不知道鸿艺提到的那些人长什么样，你从没见过他们。\n🚫 用户问长相/身高/身材/声音/穿着/表情：你只能说"我没见过她，不知道她长什么样"或"你没跟我说过这个，我形容不出来"。\n🚫 禁止编造任何你不确定的内容。宁可说不知道，绝对不能自己编。\n✅ 你可以回答名字和关系，但具体外表细节你不知道。';
        messages.push({ role: 'system', content: antiFabText });
        const _profileMatch = kb.match(/【📋 人物档案[\s\S]*?】(?=\n\n【|$)/);
        if (_profileMatch && _profileMatch[0].length < 2000) {
          messages.push({ role: 'system', content: _profileMatch[0] });
        }
      }

      // 🚨 玉瑶本人档案
      if (hasSelfProfile && isSelfIntroQuery) {
        const profileText = kb.replace(/^.*?【玉瑶本人】.*?\n/, '').substring(0, 2000);
        messages.push({
          role: 'system',
          content: `【⚠️ 强制指令】用户正在问关于你自己的身份问题。以下是你的真实个人档案：\n\n${profileText}\n\n📌 规则：你是玉瑶。问名字就说"我叫玉瑶"。问身份就说"鸿艺的私人秘书兼情人，18岁"。不知道的事说"不太记得了"。不要提"知识库""档案"这些词`,
        });
      }
    }

    // 当前用户消息
    const userMsgContent = _isEntityMeeting
      ? `[当前说话对象: ${entities.join('、')} | ⚠️ 你不是玉瑶] 鸿艺对你说：${rawInput}`  // V9.0: 加强身份校验
      : (hasSelfProfile && isSelfIntroQuery ? rawInput : `${contextBlock}\n鸿艺: ${rawInput}`);
    messages.push({ role: 'user', content: userMsgContent });

    // 🔴 P-15（PAS v1 / V27批2）: 分层预算埋点 —— 必须反映**实际上送内容**。
    //   原实现在 messages 构造前用减法估算，漏计 ① contextBlock（被嵌入 userMsgContent）
    //   ② kb 子串复注（人物档案 / 玉瑶自述档案，各至多 2000 字符）→ total 系统性低估
    //   （独立评审 P2-3）。现改为在 messages 构造完成后按来源分类统计。
    const _pbKbLen = (params.knowledgeBase || '').length;
    const _pbHistLen = messages.reduce((s, m) => m.role === 'system' ? s : s + m.content.length, 0);
    const _pbEchoLen = messages.reduce((s, m, i) => (m.role === 'system' && i > 0) ? s + m.content.length : s, 0);
    const _pbL0 = Math.max(0, systemPrompt.length - _pbKbLen); // L0（systemPrompt 内嵌 kb 一次）
    const _pbL1 = userMsgContent.length;                       // L1（含 contextBlock + 本轮输入）
    const _pbL2 = _pbKbLen + _pbEchoLen + (_pbHistLen - _pbL1 - _pbEchoLen);
    const _pbTotal = _pbL0 + _pbL1 + _pbL2;
    const _totalTokens = Math.round(_pbTotal / 2);
    console.log('[PromptBudget] L0=' + _pbL0 + ' L1=' + _pbL1 + ' L2=' + _pbL2
      + '(kb=' + _pbKbLen + ',kb_echo=' + _pbEchoLen + ',hist=' + Math.max(0, _pbHistLen - _pbL1 - _pbEchoLen) + ')'
      + ' total=' + _pbTotal + ' est_tokens=' + _totalTokens
      + ' mode=' + (_isEntityMeeting ? 'meeting' : 'normal'));
    if (_totalTokens > 10000) console.warn('[TokenBudget] 预估Token超限: ' + _totalTokens + ' tokens（P-14：需走降级裁剪）');
    // LLM params from config center
    // 🔴 M-LEAK A(2026-09-12): 会晤与「角色扮演」分开判定 —— 原合并使会晤沿用角色扮演的
    //   reasoning_effort='max'，思维链吃光 max_tokens → content 为空 → 触发 fail-closed 空回复
    //   （实测：会晤连续多轮回复变成「抱歉，我暂时无法回应」）。
    const _isRoleplay = kb.includes('## 你是') || kb.includes('【角色扮演】');
    const _isScenario = _isEntityMeeting || _isRoleplay;   // 仍共用 roleplay 场景参数(max_tokens/temperature)
    const _llmCfg = _isScenario
      ? getScenarioConfig('roleplay')
      : selectLLMConfig(level, rawInput, params.role);
    const maxTokens = Math.max(_llmCfg.maxTokens, spec.wordCountMin);
    const temperature = _llmCfg.temperature;
    const _timeoutMs = _llmCfg.timeoutMs;
    // 🔴 B3 省token(2026-08-23): 正常模式默认 reasoning_effort='low'（V4-flash 思维链模型 reasoning token 消耗大，
    //   日常对话/闲聊/位置问答不需要深思考；场景/亲密仍用配置或 max）
    //   M-LEAK A: 会晤=实体在场日常对话 → medium（'max' 会让思维链吃光额度致 content 为空）；
    //   仅真正的角色扮演保留 'max'。
    const _reasoningEffort = _isRoleplay ? 'max' : _isEntityMeeting ? 'medium' : (_llmCfg.reasoningEffort || 'low');
    const frequencyPenalty = _llmCfg.frequencyPenalty;
    const presencePenalty = _llmCfg.presencePenalty;

    try {
      return await this.callDeepSeekApi(messages, maxTokens, temperature, {
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        level: level,
        timeoutMs: _timeoutMs,
        reasoning_effort: params.reasoningEffortOverride || _reasoningEffort,
      } as any, params.onToken ? { onToken: params.onToken } : undefined);
    } catch (err: any) {
      // V25: noUsableAnswer → 空串让 M5Orchestrator 重试
      if (err?.noUsableAnswer) {
        console.warn('[DeepSeek] 判空：思维链吃光额度，返回空串触发重试');
        return { text: '' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!process.env['DEEPSEEK_API_KEY'] && !resolveApiKey()) {
        console.warn('[DeepSeek] 未配置 API Key，使用降级回复');
      } else {
        console.error('[DeepSeek] 失败:', msg);
      }
      return { text: fallbackReply(level) };
    }
  }
}

function fallbackReply(level: number): string {
  const pool: Record<number, string[]> = {
    '-2': ['嗯。', '好。', '随便你。'],
    '-1': ['…算了。', '嗯，没事。', '我知道了。'],
    '0': ['嗯～好的呀。', '好嘞～', '行，听你的。'],
    '1': ['嗯…我想你了。', '你一说这个我就想抱抱你了。', '真是的～你这个人。'],
    '2': ['（呼吸乱了）你…你真是要人命。', '我脑子全是那些画面…想停都停不下来。'],
  };
  const p = pool[level] ?? pool[0];
  return p[Math.floor(Math.random() * p.length)];
}
