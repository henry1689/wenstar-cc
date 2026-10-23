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
