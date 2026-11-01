/**
 * outputGuard — 输出校验隔离（T013 Phase 2 · ADR-013 第七层）
 *
 * 🔴 默认路径 **+0 次 LLM 调用**：主回复单次输出「结构化头 + 正文」，
 *   校验在同一个响应体上做（字段边界抽取，~1ms），只有第 2 种情况才需要二次 LLM。
 *
 * 三条处置（ADR-013 第七层）：
 *   1. speaker 头缺失 / 不在参与者列表 → 正文仍可用，按粘性规则重新归属，记告警
 *   2. speaker 头与正文自称冲突 → 二次 LLM 校验（由调用方注入，非本模块发起）
 *   3. 二次校验也不确定 → 降级 + 告警，**不自动重生成**（避免延迟雪崩）
 *
 * 🔴 实现约束（直接对应 V45 纯 JSON 削坑）：结构化头**必须用字段边界解析**
 *   （逐行、认 `key: value` 直到分隔行），**禁止用正则在全文枚举引号/键名风格**。
 *   并且：正文若本身就是纯 JSON（LLM 工具型调用），**整体跳过**，不做任何裁剪 ——
 *   V45 的事故正是剥离器把纯 JSON 削成 "[{"（1010→3 字符），导致工具型调用静默失败。
 */
import type { SessionState } from './types.js';

/** 结构化头的字段名（单一真源，勿在别处硬编码字符串） */
export const SPEAKER_HEADER_KEY = 'speaker';

/** 头块与正文的分隔行（任一命中即视为头结束） */
const HEADER_SEPARATORS = ['---', '===', '——', '－－', '____'];

/**
 * 正文疑似纯 JSON —— 整体跳过结构化头处理。
 * 判据：首个非空白字符是 `{` 或 `[`。**宁可漏处理，不可削正文**（不对称取舍）。
 */
export function looksLikeRawJson(text: string): boolean {
  const t = (text || '').trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

export interface ParsedHeader {
  /** 头里声明的发言人（未声明或未命中字段时 null） */
  speaker: string | null;
  /** 剩余正文（已去头）；未去头时等于原文 */
  body: string;
  /** 是否解析出了结构化头 */
  present: boolean;
}

/**
 * 字段边界解析结构化头。
 *
 * 规则：只看**头部连续若干行**（默认 ≤4 行），逐行尝试 `key: value`，
 * 命中 SPEAKER_HEADER_KEY 即采纳；遇到分隔行或空行即停止扫描并进入正文。
 * 不对正文做任何正则扫描 —— 正文里出现 "speaker: xxx" 不会被误认为头
 * （因为扫描在第一个空行/分隔行处终止）。
 */
export function extractSpeakerHeader(text: string, maxHeaderLines = 4): ParsedHeader {
  const raw = text ?? '';
  if (!raw || looksLikeRawJson(raw)) return { speaker: null, body: raw, present: false };

  const lines = raw.split('\n');
  let sawHeaderField = false;
  let speaker: string | null = null;
  let end = 0;

  for (let i = 0; i < Math.min(lines.length, maxHeaderLines); i++) {
    const line = lines[i].trim();
    if (line === '') { end = i; break; }                       // 空行 = 头结束（换行会被 strip）
    // 分隔行 = 头结束，且**分隔行本身属于头**，必须连同跳过 —— 否则正文残留 "---\n"
    if (HEADER_SEPARATORS.some(sep => line === sep)) { end = i + 1; break; }

    const sepIdx = line.indexOf(':');
    const colonIdx = sepIdx >= 0 ? sepIdx : line.indexOf('：');
    if (colonIdx <= 0) break;                                   // 非 `key: value` 行 ⇒ 无头
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key !== SPEAKER_HEADER_KEY) break;                      // 首个字段不是 speaker ⇒ 无头
    sawHeaderField = true;
    if (value) speaker = value;
    end = i + 1;
  }

  if (!sawHeaderField) return { speaker: null, body: raw, present: false };
  const body = lines.slice(end).join('\n').replace(/^\n+/, '');
  return { speaker, body: body || raw, present: true };
}

/**
 * 组装结构化头（生成侧用）。🔴 与解析侧严格对称，键名单一真源。
 */
export function withSpeakerHeader(speakerName: string, body: string): string {
  return `${SPEAKER_HEADER_KEY}: ${speakerName}\n---\n${body}`;
}

// ═══════════════════════════════════════════════════════════════
// 自称冲突检测
// ═══════════════════════════════════════════════════════════════

/**
 * 自称检测。🔴 判据刻意**很窄** —— 只认显式第一人称自称句式：
 *   「我是X」「我叫X」「我是X啊」「我叫X呢」
 * 不做「正文提到 X」这类宽泛判断（P043 教训：保护性判据的关键词必须比被保护文本更窄，
 * 否则会自我抵消；这里同理 —— 宽判据会把「我和徐诗雨聊过」误判成自称徐诗雨）。
 */
const SELF_IDENT_RE = /(?:^|[，。！？；\s])(?:我|俺|本宫)\s*(?:叫|是)\s*([一-龥]{2,8})/g;

/**
 * 返回正文里被显式自称的名字（可能多个）；空数组 = 未自称。
 *
 * @param candidates 已知人名白名单（**长名优先匹配**）。`([一-龥]{2,8})` 会把句尾语气词
 *   一起吃进来（"我叫熊梓铭呢" → "熊梓铭呢"），传入白名单后按最长前缀归位，
 *   否则调用方拿一个带尾巴的名字去比对必然不命中，**冲突漏检**（漏检方向是安全的，但仍是错）。
 */
export function detectSelfIdent(body: string, candidates?: string[]): string[] {
  const out: string[] = [];
  const sorted = (candidates || []).filter(c => c && c.length >= 2).sort((a, b) => b.length - a.length);
  const re = new RegExp(SELF_IDENT_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body || '')) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    let name = raw;
    if (sorted.length > 0) {
      const hit = sorted.find(c => raw === c || raw.startsWith(c));   // 最长名优先
      if (hit) name = hit;
    }
    out.push(name);
    if (out.length >= 5) break;   // 防极端长文反复匹配
  }
  return [...new Set(out)];
}

// ═══════════════════════════════════════════════════════════════
// 轮内分段解析（P1-A 步骤 1/2 · 2026-10-27）
// ═══════════════════════════════════════════════════════════════
//
// 🔴 背景：生产实测到 `【罗珍思】徐诗雨：（…）` 这种**一轮两人**形态 ——
//   LLM 自己在正文里写 `名：` 分段，而前端把粘性发言人的 `【名】` 拼在整段之前。
//   上面的 `extractSpeakerHeader` 只解析**头部** `speaker:` 字段，对正文分段完全不认，
//   于是整轮被归给粘性发言人 ⇒ 徐诗雨的台词记在罗珍思名下。
//
// 🔴 设计约束：
//   1. **姓名白名单只来自调用方传入的 `names`**（`SessionState.participants`），
//      本文件**不得出现任何人名字面量**（对应 RISK_NO_HARDCODED）。
//   2. 只认**行首锚定**的标记，不做全文正则枚举（V45 教训：禁止在全文枚举引号/键名风格）。
//   3. 分段解析是**纯函数、零 LLM、零 IO**（ADR-013 第七层）。

/** 轮内一段：发言人 + 该段正文（已剥掉段首标记） */
export interface SpeakerSegment {
  /** 该段归属人；null = 该段无标记，由调用方按粘性归属 */
  speaker: string | null;
  /** 该段正文 */
  text: string;
}

/** 段首标记：`【名字】` 或 行首 `名字：` / `名字:`（名字须命中白名单才成立） */
const SEGMENT_MARKER_RE = /^\s*(?:【([^】]{1,12})】|([一-龥]{2,12})\s*[：:])/;

/**
 * 按白名单把回复体切成若干发言人段。
 *
 * **为什么必须白名单**：不加白名单时，正文里任何「XX：」都会被当成发言切换
 * （如「注意：…」「原因：…」），把一段话切得七零八落。
 * 长名优先匹配，避免「徐诗雨」被「诗雨」抢先吃掉。
 *
 * @param text  回复正文（结构化头已由 `extractSpeakerHeader` 剥掉）
 * @param names 参与者白名单（**由调用方传入，本函数不自带任何人名**）
 */
export function splitSpeakerSegments(text: string, names: readonly string[]): SpeakerSegment[] {
  const raw = text ?? '';
  const whitelist = (names || []).filter(n => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);            // 长名优先
  if (whitelist.length === 0 || !raw.trim()) {
    return [{ speaker: null, text: raw }];
  }

  /** 行首反复剥标记：`【罗珍思】徐诗雨：…` 连剥两层，取**最后一个**命中的标记 */
  const resolve = (m: RegExpMatchArray): string | null => {
    const cand = (m[1] ?? m[2] ?? '').trim();
    if (!cand) return null;
    const hit = whitelist.find(n => cand === n || cand.startsWith(n));
    return hit ?? null;
  };

  const out: SpeakerSegment[] = [];
  let cur: SpeakerSegment = { speaker: null, text: '' };

  for (const line of raw.split('\n')) {
    let rest = line;
    let segSpeaker: string | null = null;
    // 同一行可能叠两层标记（`【罗珍思】徐诗雨：…`），循环剥到剥不动为止
    for (let guard = 0; guard < 3; guard++) {
      const m = rest.match(SEGMENT_MARKER_RE);
      if (!m) break;
      const who = resolve(m);
      if (!who) break;                                  // 名字不在白名单 ⇒ 不是标记，原样保留
      segSpeaker = who;                                 // 后剥的覆盖先剥的（更靠近正文）
      rest = rest.slice(m[0].length);
    }

    if (segSpeaker !== null) {
      if (cur.text.trim() !== '') out.push(cur);        // 收尾当前段（空段不收，避免产生空记录）
      cur = { speaker: segSpeaker, text: rest };
    } else {
      cur.text = cur.text ? cur.text + '\n' + rest : rest;
    }
  }

  if (cur.text.trim() !== '') out.push(cur);
  // 一条标记都没有 ⇒ 退回单段（保持与旧行为一致：整条一个发言人）
  return out.length > 0 ? out : [{ speaker: null, text: raw }];
}

// ═══════════════════════════════════════════════════════════════
// 零主语自称 · 窄口径（P1-A 步骤 3 · 2026-10-27）
// ═══════════════════════════════════════════════════════════════
//
// 🔴 为什么不能直接放宽 `SELF_IDENT_RE`：那条判据的窄是**有意为之**（P043 ——
//   保护性判据的关键词必须比被保护文本更窄，否则自我抵消：宽判据会把
//   「我和徐诗雨聊过」误判成自称徐诗雨）。所以零主语自称**另起一条独立窄判据**，
//   不动原判据。
//
// 🔴 三条件同时成立才算冲突（缺一不计）：
//   ① **句首**（行首或句末标点之后）—— 排除句中提及；
//   ② 命中白名单某人的**≥2 字后缀**（`徐诗雨` 的后缀 `诗雨`）——
//      这样「诗雨这边…」能命中 `徐诗雨`，而 `徐诗雨` 自己说话时写「诗雨…」
//      因为该后缀所属人**就是 declared 本人**而被排除；
//   ③ 该后缀所属人 **≠ 本轮声明发言人 declared**。
//
// 🔴 **只记 warn，不自动重生成**（ADR-013 第七层：避免延迟雪崩）。

/** 句首锚点：行首，或句末标点之后 */
const SENTENCE_START_RE = /(?:^|[。！？；\n])/;

/**
 * 检测「零主语自称」冲突。
 *
 * @param body       段正文
 * @param declared   本轮该段声明的发言人（null = 未声明，直接返回空）
 * @param candidates 参与者白名单（调用方传入，本函数不自带人名）
 * @returns 与 declared 冲突的自称名；空数组 = 无冲突
 */
export function detectZeroSubjectConflict(
  body: string,
  declared: string | null,
  candidates: readonly string[],
): string[] {
  if (!declared) return [];                                   // 未声明 ⇒ 无可比对象
  const names = (candidates || []).filter(n => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return [];

  const out: string[] = [];
  // 🔴 **只看段首第一个非空行**（2026-10-27 真数据探针实测的误报收窄）：
  //   实测 `罗珍思：（阿珍应了一声…）\n阿珍这边没什么要拿的…` —— 阿珍是罗珍思的**昵称自指**，
  //   第二行被当成「自称他人」误报。自称冲突描述的是**发言人怎么开口**，故只取首行；
  //   扫全文必然把昵称自指、后文提及一并误伤（P043：判据须比被保护文本更窄）。
  const firstLine = (body || '').split('\n').find(l => l.trim() !== '') ?? '';
  const anchors = [...firstLine.matchAll(new RegExp(SENTENCE_START_RE.source, 'g'))]
    .map(m => (m.index ?? 0) + m[0].length);
  for (const start of anchors) {
    const head = firstLine.slice(start, start + 12);
    if (!head) continue;
    for (const n of names) {
      if (n === declared) continue;                          // 条件③：与 declared 同人 ⇒ 不算冲突
      for (let k = n.length; k >= 2; k--) {                  // 条件②：≥2 字后缀
        const suffix = n.slice(n.length - k);
        if (!head.startsWith(suffix)) continue;
        // 条件① 已由句首锚点保证；此处只登记，不改写正文
        if (!out.includes(n)) out.push(n);
      }
    }
    if (out.length >= 3) break;                              // 防长文反复命中
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 综合校验
// ═══════════════════════════════════════════════════════════════

export interface OutputCheckResult {
  /** 可直接使用的正文（已去结构化头） */
  body: string;
  /** 头里声明的发言人 */
  headerSpeaker: string | null;
  /** 归属后的发言人名（粘性兜底后） */
  assignedSpeaker: string | null;
  /** 归属后的发言人 UUID（供 applyMeetingUuidFilter 用） */
  speakerUuid: string | null;
  ok: boolean;
  /** 告警文案（null = 无告警） */
  warn: string | null;
  /** 需要二次 LLM 校验（头与自称冲突） */
  needsSecondaryCheck: boolean;
}

/**
 * 校验会晤回复的发言者一致性。**纯函数、零 LLM、零 IO**。
 *
 * @param state   当前会话状态（提供参与者白名单与粘性基准）
 * @param reply   模型原始输出（可能带结构化头）
 */
export function validateReplyIdentity(state: SessionState, reply: string): OutputCheckResult {
  const { speaker: headerSpeaker, body, present } = extractSpeakerHeader(reply);
  const names = state.participants.map(p => p.name);
  /** 按名字找参与者：先精确，再**长名优先**前缀匹配（"诗雨"→"徐诗雨"；带语气词也归位） */
  const byName = (n: string | null) => {
    const s = (n || '').trim();
    if (!s) return null;
    const exact = state.participants.find(p => p.name === s);
    if (exact) return exact;
    const longestFirst = [...state.participants].sort((a, b) => b.name.length - a.name.length);
    return longestFirst.find(p => s.startsWith(p.name)) ?? null;
  };

  const sticky = state.speakerUuid
    ? state.participants.find(p => p.uuid === state.speakerUuid) ?? null
    : null;

  // 情况 0：头缺失 / 纯 JSON 正文 → 正文可用，按粘性归属
  if (!present) {
    return {
      body, headerSpeaker: null,
      assignedSpeaker: sticky?.name ?? null,
      speakerUuid: sticky?.uuid ?? null,
      ok: true, warn: null, needsSecondaryCheck: false,
    };
  }

  const declared = byName(headerSpeaker);

  // 情况 1b：头声明的不是参与者 → 正文仍可用，改按粘性归属 + 告警
  if (!declared) {
    return {
      body, headerSpeaker,
      assignedSpeaker: sticky?.name ?? null,
      speakerUuid: sticky?.uuid ?? null,
      ok: false,
      warn: `speaker头「${headerSpeaker || '(空)'}」不在参与者列表，已按粘性归属 ${sticky?.name ?? '(无)'}`,
      needsSecondaryCheck: false,
    };
  }

  // 情况 2：头与正文自称冲突 → 交二次 LLM 校验（本模块不发起）
  const selfIdent = detectSelfIdent(body);
  const conflicting = selfIdent.filter(n => byName(n) && byName(n)!.name !== declared.name);
  if (conflicting.length > 0) {
    return {
      body, headerSpeaker,
      assignedSpeaker: declared.name,
      speakerUuid: declared.uuid,
      ok: false,
      warn: `speaker头=「${declared.name}」但正文自称「${conflicting.join('/')}」，需二次校验`,
      needsSecondaryCheck: true,
    };
  }

  // 情况 0（正常）：头声明合法且无自称冲突
  return {
    body, headerSpeaker,
    assignedSpeaker: declared.name,
    speakerUuid: declared.uuid,
    ok: true, warn: null, needsSecondaryCheck: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// 出口归一（P1-A 步骤 1 · 2026-10-27）—— 供路由层接线的唯一入口
// ═══════════════════════════════════════════════════════════════

export interface ReplyAttribution {
  /**
   * 单发言人轮次 → 该发言人（前端据此前置 `【名】`）；
   * **多发言人轮次 → null**（前端 `speaker?【名】+content:content` 在 null 时不加前缀，
   * 从而直接显示正文自带的分段标记，**不再出现 `【罗珍思】徐诗雨：` 这种前后矛盾**）。
   */
  speakerName: string | null;
  /** 归一后的正文（段首重复标记已剥除；多发言人轮次每段补 `【名】`） */
  body: string;
  /** 是否多发言人轮次 */
  multi: boolean;
  /** 分段明细（供调用方记日志 / 后续逐段落库） */
  segments: SpeakerSegment[];
  /** 告警（零主语自称冲突等）；null = 无。🔴 只记不改写、不自动重生成 */
  warn: string | null;
}

/**
 * 回复出口归一 —— **本批次接线的生产入口**。
 *
 * 🔴 之前 `outputGuard` 全仓只有它自己的测试在调用（生产零接线），
 *   于是前端无条件拼粘性发言人、正文里的分段标记无人解析，产生
 *   `【罗珍思】徐诗雨：…` 的身份错乱。本函数把三件事一次做完：
 *   ① 解析轮内分段；② 每段独立归属（标记优先，缺省回落 sticky）；③ 出口归一。
 *
 * **纯函数、零 LLM、零 IO**；姓名只来自入参 `names`，本文件不自带任何人名。
 *
 * @param reply  模型原始回复（可能含结构化头 + 正文分段）
 * @param names  参与者白名单
 * @param sticky 粘性发言人（上一轮主发言），分段无标记时的回落值
 */
export function attributeReply(
  reply: string,
  names: readonly string[],
  sticky: string | null,
): ReplyAttribution {
  const list = (names || []).filter(n => n && n.length >= 2);
  const { body: headless, present, speaker: headerSpeaker } = extractSpeakerHeader(reply ?? '');
  const fallback = headerSpeaker || sticky || null;

  // 无白名单（私聊/玉瑶态）⇒ 不做分段，保持旧行为
  if (list.length === 0) {
    return {
      speakerName: fallback, body: headless, multi: false,
      segments: [{ speaker: fallback, text: headless }],
      warn: null,
    };
  }

  const segs = splitSpeakerSegments(headless, list);
  const named: SpeakerSegment[] = segs.map(s => ({ speaker: s.speaker ?? fallback, text: s.text }));

  // ── 零主语自称冲突（只记 warn）──
  const warns: string[] = [];
  for (const s of named) {
    if (!s.speaker) continue;
    const hit = detectZeroSubjectConflict(s.text, s.speaker, list);
    if (hit.length > 0) warns.push(`段声明「${s.speaker}」但句首自称「${hit.join('/')}」`);
  }

  const multi = named.length > 1;
  const body = multi
    // 多发言人：每段补统一标记，前端 speakerName=null 不再拼前缀
    ? named.map(s => `【${s.speaker ?? '？'}】${s.text}`).join('\n')
    // 单发言人：段首标记已由 splitSpeakerSegments 剥除，避免 `【徐诗雨】徐诗雨：` 双叠
    : (named[0]?.text ?? headless);

  return {
    speakerName: multi ? null : (named[0]?.speaker ?? fallback),
    body,
    multi,
    segments: named,
    warn: warns.length > 0 ? warns.join('；') : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 内部概念泄漏 · **只检测不削字**（P1-C-1 · 业主 2026-10-27 裁决）
// ═══════════════════════════════════════════════════════════════
//
// 🔴 实测泄漏：`那个"徐诗涵 · 人物档案"没归类的事` —— LLM 把系统注入的
//   KB 标题复述了出来。`人物档案` 确为自有串：
//   `FamilyGraphSync.ts:81 title: '人物档案: ${name}'`、`FusionEngine.ts:207 /【📋 人物档案】/`。
//
// 🔴🔴 **为什么只告警、绝不削字** —— 这是出口守卫模块自己的红线
//   （`src/m5/DeepSeekLLMProvider.ts:347-353`）：
//     · 「判据必须是**高置信度、零误杀**的三条」
//     · 「⚠️ 刻意不含 findLatinMetaStart……**不适合放进出口守卫 —— 那会造成大面积误杀（回复变空）**」
//     · 「判据锚在**自有字符串**上，而不是『模型可能怎么措辞』的**枚举**——枚举必然随模型措辞漂移」
//   关键词类判据一旦用于削字，就是上面明令禁止的那类事故。
//   故本函数**只产出命中事实**，`auditReplyExit` 只打日志 —— **正文一字不动**。
//   要升级为削字/置空，须业主另批并重新评估误杀率。
//
// ⚠️ 命中只是**疑似**泄漏（模型也可能在正当解释这些概念），故必须人工看日志才能定性。

/** 系统自有 / 被提示词明令禁止的内部概念闭集（单一真源，改这里即全局生效） */
const INTERNAL_CONCEPT_MARKERS: readonly string[] = Object.freeze([
  '知识库',            // core-rules.ts:78 明令「不提"知识库/文档"这些词」
  '人物档案',          // FamilyGraphSync.ts:81 自有标题串
  '户口档案',          // core-rules.ts:106 / chat.ts:1413 注入
  '户口号',
  'TXS',               // 户口号前缀（chat.ts:1413「户口号为 TXS 编号」）
  'entity_uuid',
  'belong_entity_uuid',
]);

export interface InternalConceptHit {
  /** 命中的自有串 */
  marker: string;
  /** 首次出现位置（-1 不可能，命中才入列） */
  index: number;
}

/**
 * 检测回复中的内部概念回显。**纯函数、只读、不改写任何文本。**
 *
 * @returns 命中列表；空数组 = 干净
 */
export function detectInternalConceptEcho(reply: string): InternalConceptHit[] {
  const text = reply ?? '';
  const out: InternalConceptHit[] = [];
  for (const marker of INTERNAL_CONCEPT_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0) out.push({ marker, index });
  }
  return out;
}

/**
 * 出口审计 —— **只打日志，绝不修改 `reply`**（P1-C-1 业主裁决「先只检测不削字」）。
 *
 * @param reply  待审回复（本函数不改它，也不返回它 —— 返回 void 即结构上无从改写）
 * @param source 出口标识（stream / sync），便于区分是哪条链路漏的
 */
export function auditReplyExit(reply: string, source: 'stream' | 'sync'): void {
  try {
    const hits = detectInternalConceptEcho(reply);
    if (hits.length === 0) return;
    console.warn(
      `[OutputGuard] 内部概念疑似泄漏(${source}) ${hits.length} 处: `
      + hits.map(h => `${h.marker}@${h.index}`).join(', ')
      + ' —— 仅告警，未削字（业主 2026-10-27 裁决）',
    );
  } catch (e) {
    // 审计绝不能反过来影响回复
    console.warn('[OutputGuard] 出口审计异常（已忽略，不影响回复）:', (e as Error)?.message);
  }
}
