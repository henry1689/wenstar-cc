/**
 * MemSym 通路分发器 · 主旨判定器（批δ）
 * ========================================
 * 依据：ADR-MEM-002 第三块判定标尺 + 白皮书§四歧义样例库（memsym-boundary-cases-v1.json）。
 * 判定保守方向偏向 A（隐患六：误判代价不对称——A 被误判成 B=违规风险；B 被误判成 A=仅氛围受损）。
 * 歧义保护：带过往关键词但主旨是当下的句子（"就像我们之前那种温柔的感觉"）严禁误降级进 A——
 *   误降级会到处乱加"印象里、不太确定"，氛围感破碎（业主加固条款②）。
 */
import { RECALL_TRIGGER_RE } from './meeting-recall.js';

/** 回顾指向标记（"那一次具体的事"——主旨倾向往事陈述） */
const EVENT_MARK_RE = /(?:那天|那天晚上|那一回|那一趟|第一次|第[二三四五六七八九十]次|什么时候|几点|几号|何年|聊了|干了|做了什么|发生了|吃的什么|去的哪|在哪|几岁)/;
/** 当下指向标记（"此刻/今天"——主旨倾向当下交互） */
const NOW_MARK_RE = /(?:现在|今天|此刻|这会儿|这会|眼下|此刻|当下|这下|这不|一会|一会儿)/;
/**
 * 歧义保护短语表（白皮书§四 B-AMBIG-01..07 ——判定器重点保护对象）。
 * 这些构造哪怕含过往关键词，主旨也是"借意象烘托当下"→ B，严禁误降级。
 */
const AMBIG_CURRENT_RE =
  /(?:就像我们之前|像以前那样|还记得那种.*现在|我们老样子|之前舒服的那种|以前怎么哄|上次说.*今天|上次提.*今天|像从前那样|跟以前一样.*现在|以后也像|下次还像)/;

/**
 * 主旨判定：'A'=回溯往事（三档协议全套）；'B'=当下对话（元素浸润复用）。
 * 规则主路径（零 LLM 开销）；存疑样本默认落 A（保守偏向）。
 */
export function classifyMemSymPath(message: string): 'A' | 'B' {
  const msg = (message || '').trim();
  if (!msg) return 'B';
  // ① 歧义保护短语 → B（哪怕含过去关键词）
  if (AMBIG_CURRENT_RE.test(msg) && !EVENT_MARK_RE.test(msg)) return 'B';
  // ② 回溯触发词命中 → 结合指向标记细分
  if (RECALL_TRIGGER_RE.test(msg) || EVENT_MARK_RE.test(msg)) {
    // 过去+当下双标记且无具体回顾指向 → 借记忆烘托当下（B-AMBIG-06/07 型）→ B
    if (NOW_MARK_RE.test(msg) && !EVENT_MARK_RE.test(msg)) return 'B';
    return 'A';
  }
  return 'B';
}

/** B 路钙化增强配置（ADR-MEM-002 第三块：B 系数 < A 系数（A 召回 boost≈0.2）+ 冷却 + 上限） */
export const B_BOOST_CONFIG = {
  coefficient: 0.05,      // 低系数（郑重回忆分量更重——默契生长但不压倒主动回忆）
  cooldownHours: 6,       // 冷却窗口（防高频刷屏把单一特质顶成模板）
  dailyCapPerElement: 8,  // 单元素单日加分上限
} as const;

/** B 路元素复用的钙化增强（作用于元素自身 impression_score——"越聊越懂"的权重自增强） */
export function boostElementSource(
  sqlite: { queryAll: (sql: string, p: unknown[]) => unknown[]; writeRaw?: (sql: string, p: unknown[]) => unknown },
  entityUuid: string, anchorId: string | undefined,
): void {
  if (!anchorId || !sqlite.writeRaw) return;
  try {
    const rows = sqlite.queryAll(
      'SELECT impression, recall_count, last_recalled_at FROM memsym_elements WHERE id = ? AND entity_uuid = ?',
      [anchorId, entityUuid]) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    const r = rows[0];
    const imp = Number(r.impression ?? 0.5);
    const cnt = Number(r.recall_count ?? 0);
    // 冷却：距上次复用不足 cooldownHours 不加分
    if (r.last_recalled_at) {
      const last = Date.parse(String(r.last_recalled_at));
      if (Number.isFinite(last) && Date.now() - last < B_BOOST_CONFIG.cooldownHours * 3600_000) return;
    }
    // 单日上限（recall_count 增量近似日内频次；上限=每日 cap 累计语义下的保守近似）
    if (cnt >= B_BOOST_CONFIG.dailyCapPerElement * 30) return; // 月累计护栏
    const next = Math.min(1.0, imp + B_BOOST_CONFIG.coefficient);
    sqlite.writeRaw(
      'UPDATE memsym_elements SET impression = ?, recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ? AND entity_uuid = ?',
      [next, new Date().toISOString(), anchorId, entityUuid]);
  } catch { /* 增强失败不阻塞对话（观测面有日志） */ }
}
