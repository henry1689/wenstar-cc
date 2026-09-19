/**
 * prompt-sanitizer — 会晤 prompt 身份泄漏清洗器（纯函数，可单测）
 *
 * 🔴 V27(批1) 背景：2026-09-19 实测，会晤模式（entityMeeting=true）的 prompt
 *   234/234 (100%) 被注入玉瑶人设「你是玉瑶 · 灵魂伴侣，鸿艺的私人秘书兼情人，18岁」，
 *   导致会晤实体（熊梓铭/徐诗雨等）身份混淆、回答不合逻辑。
 *   源头已在 chat.ts 修复（PFC 旧链路加模式守卫 + assembler 侧统一守卫），
 *   本模块作为**出口兜底 + 防回归断言**存在。
 *
 * 设计约束（来自独立评审意见）：
 *   ① 只清洗头部窗口 —— 避免误删正文中合法提及（例如实体复述用户原话"你以为你是玉瑶吗"）
 *   ② 剥离后必须仍保留会晤实体结构锚点，否则**回退原文**（宁可少洗，不可洗坏）
 *   ③ 禁止洗成空串 —— 清空会导致后续 LLM 调用丢失全部上下文
 *   ④ 返回结构化结果，便于日志审计与单元测试
 */

/** 玉瑶身份标记（段内命中任一即视为污染段） */
export const YUYAO_IDENTITY_MARKERS: readonly string[] = [
  '你是玉瑶',
  '你的名字是玉瑶',
  '你的名字叫玉瑶',
  '玉瑶 · 灵魂伴侣',
  '玉瑶的私人秘书兼情人',
];

/** 会晤实体的结构锚点（清洗后必须至少保留一个，否则回退） */
export const MEETING_ENTITY_ANCHORS: readonly string[] = [
  '## 你的身份',
  '## 🚪 会晤开场协议',
  '## 多人会晤',
  '### 过去的对话记忆',
  '## 你的家人',
];

export interface SanitizeOptions {
  /** 只在此字符窗口内做标记检测与剥离（默认 2000），避免误删正文 */
  headLimit?: number;
}

export interface SanitizeResult {
  /** 清洗后的文本（未清洗时与原文本全等） */
  text: string;
  /** 是否发生了剥离 */
  stripped: boolean;
  /** 被剥离的字符数 */
  strippedChars: number;
  /** 被剥离内容样本（前 80 字符，供审计） */
  strippedSample: string;
  /** 是否因安全检查不通过而回退原文 */
  reverted: boolean;
  /** 回退原因（未回退时为空串） */
  revertReason: string;
}

const NOOP = (text: string): SanitizeResult => ({
  text, stripped: false, strippedChars: 0, strippedSample: '', reverted: false, revertReason: '',
});

const REVERT = (text: string, reason: string): SanitizeResult => ({
  text, stripped: false, strippedChars: 0, strippedSample: '', reverted: true, revertReason: reason,
});

/**
 * 清洗会晤 prompt 中的玉瑶人设污染段。
 *
 * @param text 待清洗的 prompt 文本（会晤模式下的 finalKnowledgeText）
 * @param opts headLimit — 头部窗口大小
 */
export function sanitizeMeetingPrompt(text: string, opts: SanitizeOptions = {}): SanitizeResult {
  const headLimit = opts.headLimit ?? 2000;
  if (!text) return NOOP(text);

  // 快筛：整篇无任何标记 → 直接返回（绝大多数会晤轮次走这里）
  if (!YUYAO_IDENTITY_MARKERS.some(mk => text.includes(mk))) return NOOP(text);

  const segments = text.split('\n\n');
  const kept: string[] = [];
  const removed: string[] = [];
  let consumed = 0;

  for (const seg of segments) {
    const inHead = consumed < headLimit;
    const dirty = inHead && YUYAO_IDENTITY_MARKERS.some(mk => seg.includes(mk));
    if (dirty) removed.push(seg);
    else kept.push(seg);
    consumed += seg.length + 2; // +2 近似 '\n\n' 分隔符
  }

  // 标记只出现在头部窗口之外 → 不动（避免误删正文合法提及）
  if (removed.length === 0) return NOOP(text);

  const cleaned = kept.join('\n\n');

  // 安全检查 ①：禁止洗空
  if (!cleaned.trim()) return REVERT(text, '清洗后为空串');

  // 安全检查 ②：原本存在会晤实体锚点 → 清洗后必须仍保留至少一个
  const anchorsBefore = MEETING_ENTITY_ANCHORS.filter(a => text.includes(a)).length;
  const anchorsAfter = MEETING_ENTITY_ANCHORS.filter(a => cleaned.includes(a)).length;
  if (anchorsBefore > 0 && anchorsAfter === 0) {
    return REVERT(text, '清洗后丢失全部会晤实体锚点');
  }

  const removedText = removed.join('\n\n');
  return {
    text: cleaned,
    stripped: true,
    strippedChars: text.length - cleaned.length,
    strippedSample: removedText.substring(0, 80).replace(/\s+/g, ' '),
    reverted: false,
    revertReason: '',
  };
}
