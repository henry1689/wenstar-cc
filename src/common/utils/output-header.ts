/**
 * output-header — LLM 输出「结构化头」的公共协议常量与判据
 *
 * 🔴 2026-11-08 下沉自 `m5/group/outputGuard`（ADR-020）：
 *   实体取证头（m1）与发言人头（m5）共用同一份分隔行集合与纯 JSON 判据。
 *   这两者属于**输出协议**，不是发言人逻辑 —— 放在 m5 会被 m1 反向依赖（CK-01 违规）。
 *   唯一真源在此；`outputGuard` 仅 re-export 保持既有 API。
 */

/** 头块与正文的分隔行（任一命中即视为头结束） */
export const HEADER_SEPARATORS = ['---', '===', '——', '－－', '____'];

/**
 * 正文疑似纯 JSON —— 整体跳过结构化头处理。
 * 判据：首个非空白字符是 `{` 或 `[`。**宁可漏处理，不可削正文**（V45 事故：
 * 剥离器把纯 JSON 削成 "[{"，导致工具型调用静默失败）。
 */
export function looksLikeRawJson(text: string): boolean {
  const t = (text || '').trimStart();
  return t.startsWith('{') || t.startsWith('[');
}
