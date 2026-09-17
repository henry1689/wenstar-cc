/** 核心记忆体系审计（14项） */
import type { CheckResult } from '../types.js';
import { passed, failed, error, clock, apiGet } from '../helpers.js';
import { queryCount } from '../db.js';
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

const MODULE = 'memory' as const;

/**
 * 健康判据返回值。
 *
 * 🔴 设计：判据（evaluate*）与「取数/呈现」（checkMemory_xx）分离 ——
 *   判据是纯函数，可离线测试（见 __tests__/sandbox-health.test.ts），
 *   巡检项只负责取数后把结果交给判据。这样阈值逻辑集中一处，不随 SQL 漂移。
 */
export interface HealthVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * 摘要通道判据（砂金库四段链路中的「摘要」段）。
 *
 * 背景（2026-09-13 砂金库全局诊断）：实测缺陷 —— `【对话摘要】` 记录有 11 条，
 *   而 `is_summary=1` 一条都没有；且摘要会被自己所属的压缩流程归档压掉。
 *   两者都让摘要**静默失效**很久而无人察觉。
 * 宽松点：不苛求 100% 可识别（部分识别 + 无归档 = 健康），只在「通道整体失效」时报不健康。
 */
export function evaluateSummaryChannel(withSummaries: number, identified: number, archived: number): HealthVerdict {
  if (withSummaries <= 0) return { ok: true };  // 从未触发过压缩 —— 不是缺陷
  if (identified <= 0) return { ok: false, reason: `存在 ${withSummaries} 条摘要，但无一条 is_summary=1 —— 摘要通道失效` };
  if (archived > 0) return { ok: false, reason: `摘要被归档压掉 ${archived} 条 —— 归档流程未豁免摘要` };
  return { ok: true };
}

/**
 * 上下文窗口供给判据。
 *
 * available 取「可注入条数最多的实体」，configured 取 MEMORY_CONFIG.compaction.contextWindowTurns。
 * 历史教训：该窗口曾在三处各自定义且取值不同，保留下来的条数与实际注入的条数脱节 ——
 * 「留而不用」正是"聊久了记不住前面的事"的直接成因之一。
 * 配置为 0 视为未配置 → 不误报（不把"没配"当成"坏了"）。
 */
export function evaluateContextWindow(available: number, configured: number): HealthVerdict {
  if (configured <= 0) return { ok: true };
  if (available < configured) return { ok: false, reason: `可注入 ${available} 条 < 配置窗口 ${configured} 条 —— 聊久了会记不住前面的事` };
  return { ok: true };
}

/** 摘要嵌套判据（摘要对摘要再摘要，实测出现过层层套娃）。 */
export function evaluateSummaryNesting(nested: number): HealthVerdict {
  return nested > 0
    ? { ok: false, reason: `检测到 ${nested} 条摘要嵌套 —— 生成摘要时未排除已有摘要` }
    : { ok: true };
}

export async function checkMemoryAll(): Promise<CheckResult[]> {
  return Promise.all([
    checkThreeLayerStorage(),
    checkSandGoldPersistence(),
    checkStructuredMemory(),
    checkBlackDiamond(),
    checkThreeSegmentLink(),
    checkMemoryFlow(),
    checkNoteSubsystem(),
    checkItemLocation(),
    checkImportantFact(),
    checkTimedReminder(),
    checkPersonImportance(),
    // ── L3 守护层：把「静默失效」的链路变成可巡检、可告警的显式状态 ──
    checkSummaryChannel(),
    checkContextWindowSupply(),
    checkSummaryNesting(),
  ]);
}

async function checkThreeLayerStorage(): Promise<CheckResult> {
  const t = clock();
  try {
    const [conv, mem, bd] = await Promise.all([
      queryCount("SELECT COUNT(*) as c FROM conversations"),
      queryCount("SELECT COUNT(*) as c FROM memories"),
      queryCount("SELECT COUNT(*) as c FROM black_diamond"),
    ]);
    return conv > 0 && mem > 0 && bd > 0
      ? passed('memory_01', '三库分层存储', MODULE, `三表均存在: conv=${conv}, mem=${mem}, bd=${bd}`, { conv, mem, bd }, t.stop())
      : failed('memory_01', '三库分层存储', MODULE, `conv=${conv}, mem=${mem}, bd=${bd}`, { conv, mem, bd }, t.stop());
  } catch (e) { return error('memory_01', '三库分层存储', MODULE, e, t.stop()); }
}

async function checkSandGoldPersistence(): Promise<CheckResult> {
  const t = clock();
  try {
    const [total, compacted] = await Promise.all([
      queryCount("SELECT COUNT(*) as c FROM conversations"),
      queryCount("SELECT COUNT(*) as c FROM conversations WHERE is_compacted=1"),
    ]);
    return passed('memory_02', '砂金库永久留存', MODULE, `总计${total}条, 已压缩${compacted}条`, { total, compacted }, t.stop());
  } catch (e) { return error('memory_02', '砂金库永久留存', MODULE, e, t.stop()); }
}

async function checkStructuredMemory(): Promise<CheckResult> {
  const t = clock();
  try {
    const mem = await queryCount("SELECT COUNT(*) as c FROM memories");
    const withCa = await queryCount("SELECT COUNT(*) as c FROM memories WHERE calcium_score > 0");
    return mem > 0
      ? passed('memory_03', '金库结构化记忆', MODULE, `memories共${mem}条, 有钙化分${withCa}条`, { mem, withCa }, t.stop())
      : failed('memory_03', '金库结构化记忆', MODULE, `memories表为空`, { mem }, t.stop());
  } catch (e) { return error('memory_03', '金库结构化记忆', MODULE, e, t.stop()); }
}

async function checkBlackDiamond(): Promise<CheckResult> {
  const t = clock();
  try {
    const cnt = await queryCount("SELECT COUNT(*) as c FROM black_diamond");
    return cnt > 0
      ? passed('memory_04', '黑钻永久记忆', MODULE, `黑钻${cnt}条`, { bd: cnt }, t.stop())
      : failed('memory_04', '黑钻永久记忆', MODULE, `black_diamond表为空`, { bd: cnt }, t.stop());
  } catch (e) { return error('memory_04', '黑钻永久记忆', MODULE, e, t.stop()); }
}

async function checkThreeSegmentLink(): Promise<CheckResult> {
  const t = clock();
  try {
    const [withDna, total] = await Promise.all([
      queryCount("SELECT COUNT(*) as c FROM conversations WHERE dna_root_id IS NOT NULL"),
      queryCount("SELECT COUNT(*) as c FROM conversations"),
    ]);
    const pct = total > 0 ? Math.round(withDna / total * 100) : 0;
    return pct > 80
      ? passed('memory_05', '三段式关联', MODULE, `DNA关联率${pct}%(${withDna}/${total})`, { dnaRate: pct, withDna, total }, t.stop())
      : failed('memory_05', '三段式关联', MODULE, `DNA关联率仅${pct}%`, { dnaRate: pct, withDna, total }, t.stop());
  } catch (e) { return error('memory_05', '三段式关联', MODULE, e, t.stop()); }
}

async function checkMemoryFlow(): Promise<CheckResult> {
  const t = clock();
  try {
    const [mem, bd] = await Promise.all([
      queryCount("SELECT COUNT(*) as c FROM memories"),
      queryCount("SELECT COUNT(*) as c FROM black_diamond"),
    ]);
    return mem > 0 && bd > 0
      ? passed('memory_06', '记忆自动流转', MODULE, `金库${mem}条→黑钻${bd}条`, { mem, bd }, t.stop())
      : failed('memory_06', '记忆自动流转', MODULE, `mem=${mem}, bd=${bd}`, { mem, bd }, t.stop());
  } catch (e) { return error('memory_06', '记忆自动流转', MODULE, e, t.stop()); }
}

async function checkNoteSubsystem(): Promise<CheckResult> {
  const t = clock();
  try {
    const notes = await queryCount("SELECT COUNT(*) as c FROM memories WHERE memory_type='note'");
    return passed('memory_07', '记事记忆子系统', MODULE, `记事${notes}条`, { notes }, t.stop());
  } catch (e) { return error('memory_07', '记事记忆子系统', MODULE, e, t.stop()); }
}

async function checkItemLocation(): Promise<CheckResult> {
  const t = clock();
  try {
    const r = await fetch(`http://localhost:3000/api/memory?q=${encodeURIComponent('车钥匙')}`);
    const d = await r.json();
    const hit = Array.isArray(d.results) && d.results.length > 0;
    return hit
      ? passed('memory_08', '物品位置记忆', MODULE, `搜索"车钥匙"命中${d.results.length}条`, { hits: d.results.length }, t.stop())
      : failed('memory_08', '物品位置记忆', MODULE, `搜索"车钥匙"无结果`, { hits: 0 }, t.stop());
  } catch (e) { return error('memory_08', '物品位置记忆', MODULE, e, t.stop()); }
}

async function checkImportantFact(): Promise<CheckResult> {
  const t = clock();
  try {
    const r = await fetch(`http://localhost:3000/api/memory?q=${encodeURIComponent('张经理')}`);
    const d = await r.json();
    const hit = Array.isArray(d.results) && d.results.length > 0;
    return hit
      ? passed('memory_09', '重要事实记忆', MODULE, `搜索"张经理"命中${d.results.length}条`, { hits: d.results.length }, t.stop())
      : failed('memory_09', '重要事实记忆', MODULE, `搜索"张经理"无结果`, { hits: 0 }, t.stop());
  } catch (e) { return error('memory_09', '重要事实记忆', MODULE, e, t.stop()); }
}

async function checkTimedReminder(): Promise<CheckResult> {
  const t = clock();
  try {
    const r = await fetch(`http://localhost:3000/api/memory/reminders`);
    const d = await r.json();
    const reminders = Array.isArray(d.reminders) ? d.reminders : [];
    return passed('memory_10', '定时提醒', MODULE, `待触发${reminders.length}条`, { pending: reminders.length }, t.stop());
  } catch (e) { return error('memory_10', '定时提醒', MODULE, e, t.stop()); }
}

async function checkPersonImportance(): Promise<CheckResult> {
  const t = clock();
  try {
    const d = await apiGet('/api/family/self-check');
    const nodes = d?.fg?.personCount || 0;
    return nodes > 0
      ? passed('memory_11', '人物重要度', MODULE, `FG共${nodes}个节点`, { personCount: nodes }, t.stop())
      : failed('memory_11', '人物重要度', MODULE, `FG无节点`, { personCount: 0 }, t.stop());
  } catch (e) { return error('memory_11', '人物重要度', MODULE, e, t.stop()); }
}

// ────────────────────────────────────────────────────────────
// L3 守护层（memory_12~14）— 判据见文件顶部 evaluate*
// ────────────────────────────────────────────────────────────

/** 摘要通道：有摘要却不可识别 / 摘要被归档压掉 —— 二者都会让摘要静默失效 */
async function checkSummaryChannel(): Promise<CheckResult> {
  const t = clock();
  try {
    const [withSummaries, identified, archived] = await Promise.all([
      queryCount("SELECT COUNT(*) as c FROM conversations WHERE content LIKE '【对话摘要】%'"),
      queryCount("SELECT COUNT(*) as c FROM conversations WHERE is_summary=1"),
      queryCount("SELECT COUNT(*) as c FROM conversations WHERE is_summary=1 AND is_compacted=1"),
    ]);
    const v = evaluateSummaryChannel(withSummaries, identified, archived);
    const data = { withSummaries, identified, archived };
    const detail = `摘要${withSummaries}条, 可识别${identified}条, 被归档${archived}条`;
    return v.ok
      ? passed('memory_12', '摘要通道', MODULE, detail, data, t.stop())
      : failed('memory_12', '摘要通道', MODULE, v.reason ?? detail, data, t.stop());
  } catch (e) { return error('memory_12', '摘要通道', MODULE, e, t.stop()); }
}

/** 上下文窗口供给：取「可注入条数最多的实体」与配置窗口比对 */
async function checkContextWindowSupply(): Promise<CheckResult> {
  const t = clock();
  try {
    const available = await queryCount(
      "SELECT COUNT(*) as c FROM conversations WHERE belong_entity_uuid IS NOT NULL " +
      "GROUP BY belong_entity_uuid ORDER BY c DESC LIMIT 1"
    );
    const configured = MEMORY_CONFIG.compaction.contextWindowTurns;
    const v = evaluateContextWindow(available, configured);
    const data = { available, configured };
    const detail = `单实体最多可注入${available}条, 配置窗口${configured}条`;
    return v.ok
      ? passed('memory_13', '上下文窗口供给', MODULE, detail, data, t.stop())
      : failed('memory_13', '上下文窗口供给', MODULE, v.reason ?? detail, data, t.stop());
  } catch (e) { return error('memory_13', '上下文窗口供给', MODULE, e, t.stop()); }
}

/** 摘要嵌套：摘要对摘要再摘要（层层套娃） */
async function checkSummaryNesting(): Promise<CheckResult> {
  const t = clock();
  try {
    const nested = await queryCount(
      "SELECT COUNT(*) as c FROM conversations WHERE " +
      "instr(content, '【历史对话】【历史对话】') > 0 OR instr(content, '【对话摘要】【对话摘要】') > 0"
    );
    const v = evaluateSummaryNesting(nested);
    const data = { nested };
    const detail = `嵌套${nested}条`;
    return v.ok
      ? passed('memory_14', '摘要嵌套', MODULE, detail, data, t.stop())
      : failed('memory_14', '摘要嵌套', MODULE, v.reason ?? detail, data, t.stop());
  } catch (e) { return error('memory_14', '摘要嵌套', MODULE, e, t.stop()); }
}
