/**
 * proactive-trigger — 主动回忆触发器（MEM-UNIFY-V1 批4）
 * ====================================================
 * 任务书 §六批4：主动触发（节日/纪念日/情绪/日常/话题关联）。
 *
 * 定位：
 *   · **纯规则 + 零 LLM + 零副作用**：只产出结构化信号（类型/权重/原因/证据），
 *     不拼提示词、不写库、不调用模型；
 *   · 文案组装在调用层（`webui/chat/proactive-stage.ts`），文案来源仍为
 *     `m5/prompts/memory-expression-law.ts`（MEMORY-LAW-V1 单源，m4 不得反向依赖 m5）；
 *   · 节日名由调用方传入（唯一节日真源 = `engine/temporal/celestial/CalendarEngine`），
 *     本模块不维护第二份节日表；
 *   · 纪念日查询只读 `memories`（同月同日 + 往年 + 高钙/地标），不读 vault_log（D3 审计台账）。
 *
 * 失败语义：任何单类检测异常都只丢该类信号（warn），不得让主动回忆阻塞召回主链。
 */

import { detectConceptThemes } from '../retrieval/meeting-recall.js';

/** 主动回忆信号类型 */
export type ProactiveTriggerType = 'festival' | 'anniversary' | 'emotion' | 'routine' | 'topic';

/** 一条主动信号 */
export interface ProactiveTrigger {
  type: ProactiveTriggerType;
  /** 0~1，越大越应主动开口；调用方可按配置阈值过滤 */
  weight: number;
  /** 人类可读原因（日志与提示词共用） */
  reason: string;
  /** 结构化证据：节日名 / 年份 / 时段 / 概念主题 / 情绪极性 */
  signal?: string;
}

export interface ProactiveSqlSource {
  queryAll(sql: string, params?: unknown[]): Array<Record<string, unknown>>;
}

export interface ProactiveOptions {
  /** 注入 now（确定性测试） */
  now?: Date;
  /** 当日节日（调用方从 CalendarEngine 取；缺省则不做节日检测） */
  festivals?: string[];
  sqlite?: ProactiveSqlSource | null;
  /** 检索主体 UUID（纪念日必须有，否则跳过） */
  entityUuid?: string | null;
  /** 纪念日钙化门槛，默认 3 */
  anniversaryMinCalcium?: number;
  /** 纪念日查询开关，默认 true（仍需 sqlite + entityUuid） */
  anniversary?: boolean;
}

export interface ProactiveResult {
  active: boolean;
  triggers: ProactiveTrigger[];
}

/** 负面情绪词（需要陪伴/安慰） */
const EMOTION_NEG_RE =
  /(难过|伤心|委屈|低落|烦|累|疲惫|压力|焦虑|害怕|孤独|想哭|哭了|不舒服|生病|疼|加班|被骂|吵架|郁闷|崩溃|不开心|失眠|心慌)/;
/** 正面情绪词（可以一起分享喜悦） */
const EMOTION_POS_RE =
  /(开心|高兴|快乐|幸福|舒服|惊喜|激动|期待|想你|喜欢你|爱你|太好了|顺利|成功|得意|满足)/;
/** 纪念日/周年显式提及（无库命中时也保留一条轻信号） */
const ANNIVERSARY_HINT_RE = /(纪念日|周年|去年今[天日]|前年今[天日]|我们那[一]?天)/;

/** 日常场景时段窗（左闭右开，24 时制） */
const ROUTINE_WINDOWS: ReadonlyArray<{ key: string; start: number; end: number; label: string }> = [
  { key: 'early', start: 6, end: 9, label: '早间' },
  { key: 'noon', start: 11, end: 13, label: '午间' },
  { key: 'offwork', start: 17, end: 19, label: '下班时段' },
  { key: 'night', start: 21, end: 24, label: '睡前' },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 检测本轮主动回忆信号。
 * 顺序：节日 → 纪念日 → 情绪 → 日常 → 话题关联；返回按权重降序。
 */
export function detectProactiveTriggers(message: string, opts: ProactiveOptions = {}): ProactiveResult {
  const msg = String(message || '').trim();
  if (!msg) return { active: false, triggers: [] };

  const now = opts.now ?? new Date();
  const triggers: ProactiveTrigger[] = [];

  // ── ① 节日 ──
  for (const name of opts.festivals ?? []) {
    const f = String(name || '').trim();
    if (!f) continue;
    triggers.push({ type: 'festival', weight: 0.9, reason: `今天是${f}`, signal: f });
  }

  // ── ② 纪念日（往年同月同日的高钙/地标记忆）──
  let anniversaryHit = false;
  if (opts.anniversary !== false && opts.sqlite && opts.entityUuid) {
    try {
      const mmdd = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const year = String(now.getFullYear());
      const floor = Math.max(1, Math.floor(opts.anniversaryMinCalcium ?? 3));
      const rows = opts.sqlite.queryAll(
        `SELECT COUNT(*) AS n, MIN(substr(created_at, 1, 4)) AS earliest FROM memories
         WHERE belong_entity_uuid = ? AND substr(created_at, 6, 5) = ? AND substr(created_at, 1, 4) < ?
           AND COALESCE(memory_type, '') != 'note'
           AND (COALESCE(calcium_level, 0) >= ? OR COALESCE(is_landmark, 0) = 1)`,
        [opts.entityUuid, mmdd, year, floor],
      );
      const n = Number(rows?.[0]?.n) || 0;
      if (n > 0) {
        anniversaryHit = true;
        const earliest = String(rows?.[0]?.earliest || '');
        triggers.push({
          type: 'anniversary',
          weight: 0.85,
          reason: earliest ? `往年今日（${earliest} 起）有 ${n} 条高钙/地标记忆` : `往年今日有 ${n} 条高钙/地标记忆`,
          signal: mmdd,
        });
      }
    } catch (e) {
      console.warn('[Proactive] 纪念日查询失败:', (e as Error)?.message || e);
    }
  }
  if (!anniversaryHit && ANNIVERSARY_HINT_RE.test(msg)) {
    triggers.push({ type: 'anniversary', weight: 0.6, reason: '对方提到纪念日/往年今日', signal: 'hint' });
  }

  // ── ③ 情绪 ──
  const neg = EMOTION_NEG_RE.exec(msg);
  const pos = EMOTION_POS_RE.exec(msg);
  if (neg) {
    triggers.push({ type: 'emotion', weight: 0.8, reason: `对方情绪需要陪伴（${neg[0]}）`, signal: 'negative' });
  } else if (pos) {
    triggers.push({ type: 'emotion', weight: 0.6, reason: `对方情绪积极（${pos[0]}）`, signal: 'positive' });
  }

  // ── ④ 日常场景（按当前时段，不看关键词）──
  const hour = now.getHours();
  const win = ROUTINE_WINDOWS.find(w => hour >= w.start && hour < w.end);
  if (win) {
    triggers.push({ type: 'routine', weight: 0.4, reason: `日常场景：${win.label}`, signal: win.key });
  }

  // ── ⑤ 话题关联（复用召回概念图单源）──
  try {
    const themes = detectConceptThemes(msg);
    if (themes.length > 0) {
      const names = themes.map(t => t.name);
      triggers.push({ type: 'topic', weight: 0.7, reason: `话题关联：${names.join('/')}`, signal: names.join(',') });
    }
  } catch (e) {
    console.warn('[Proactive] 话题关联判定失败:', (e as Error)?.message || e);
  }

  triggers.sort((a, b) => b.weight - a.weight);
  return { active: triggers.length > 0, triggers };
}

/** 按权重阈值过滤（配置 `proactive.min_weight`）；过滤后重新判定 active */
export function filterTriggers(result: ProactiveResult, minWeight: number): ProactiveResult {
  const floor = Number.isFinite(minWeight) ? minWeight : 0;
  const kept = (result.triggers || []).filter(t => t.weight >= floor);
  return { active: kept.length > 0, triggers: kept };
}
