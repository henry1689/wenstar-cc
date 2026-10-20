/**
 * recall-quota — Phase 2.3（F / T005）A/B 链路统一召回配额
 * ============================================================
 * 纯函数模块：零 DB / 零配置读取 / 零副作用 —— 配置与预算由调用方
 * （`webui/chat/retrieval-stage.ts`）算好传入，本模块只做「分类 + 按额度截断」。
 *
 * 为什么需要它（2.3 的核心问题）：
 *   2.1 组级生命周期 + 2.2 钙化接入召回之后，一条会话的 memoryFragments 同时来自
 *   **四类**来源：高钙组（A 链路·钙化驱动）、对话组摘要（B 链路·字面命中驱动）、
 *   单条记忆（近期/历史/关键词）、以及铁律/金库/作品等其它注入。原先没有配额 ⇒
 *   谁被排在前面谁占满预算，A 链路与 B 链路互相挤占，编排无从谈起。
 *
 * 三条铁律（业主 2026-10-20 经 R020 裁决）：
 *   1. 会晤  A40% / B40% / 近期记忆20%；非会晤  B60% / A40%（近期记忆并入 B 侧）。
 *   2. 泛词（关键词为空或经数据校验的命中不足）时 A 类降到 `generic_query_high_calcium`，
 *      让出的额度按原比例回给 B 与近期记忆 —— 没有具体话题词时，钙化地标帮不上忙。
 *   3. OTHER（铁律/金库/作品/长文/时间检索/知识库…）**不占配额**，只受全局预算约束 ——
 *      它们不是「记忆候选」，被配额裁掉会直接损伤系统护栏。
 *
 * 失败语义（fail-open）：配置关 / 预算非有限 / 比例非法 → 原样返回，绝不阻断召回。
 */

/** 配额类别（四类：三类占配额，other 不占） */
export type QuotaClass = 'high_calcium_group' | 'block_summary' | 'recent_memory' | 'other';
/** 占配额的三类（不含 other） */
export type QuotaClassKey = Exclude<QuotaClass, 'other'>;
/** 场景：会晤 / 非会晤 */
export type QuotaScenario = 'meeting' | 'normal';

/**
 * 标签后缀（**与检索层的拼标签处共用同一常量**，杜绝「标签写法」与「分类判据」两份实现漂移）。
 * 调用方用 `memFragWithTime(实体名 + TAG.dialogGroup, body, createdAt)` 拼出
 * `【徐诗韵的对话组·10-20】…`，本模块按同一后缀反向识别。
 */
export const TAG = {
  /**
   * 🔴 启用配额（`recall_quota.enabled=true`）时使用的标签 —— 必须含「记忆」二字。
   *
   * 原因（S4 评审发现）：MemoryInjector 的记忆档判定是
   * `frag.includes('记忆') || preservedLabel.includes('记忆')` ⇒ 无「记忆」的标签会被判成
   * 普通砂金，优先级 0.85→0.60（低于金库 0.70），在注入层的二次截断里被系统性挤出
   * —— 配额在入口保住的份额会被注入层降权吃掉，F1/F2 被自己的 F-0 抵消。
   * 含「记忆」后，组片段优先级与改动前的 `【X的记忆】` 完全一致（0.85），且**不再依赖正文
   * 是否恰好含"记忆"一词**（改动前 A 路优先级是随正文抖动的）。
   */
  highCalciumGroupMemory: '的对话组记忆·高钙',
  /** B 链路（启用配额时）：含「记忆」以保持 0.85 优先级 */
  dialogGroupMemory: '的对话组记忆',
  /** 同上的裸形态（非会晤无单一实体名可挂；分类判据两种都认） */
  highCalciumGroupMemoryBare: '对话组记忆·高钙',
  /** 同上的裸形态（B 链路） */
  dialogGroupMemoryBare: '对话组记忆',
  /**
   * 关闭配额（`recall_quota.enabled=false`）时回退到的**改动前标签**：
   * 2.3 之前统一中枢把所有路由都打成 `X的记忆`，高钙通道打成 `X的对话组·高钙`。
   * 开关关闭时标签走这一组 ⇒ 片段形态、优先级与 2.3 之前完全一致。
   */
  highCalciumGroup: '的对话组·高钙',
  dialogGroup: '的对话组',
  highCalciumGroupBare: '对话组·高钙',
  dialogGroupBare: '对话组',
  /** 单条记忆（近期/历史槽位） */
  memory: '的记忆',
  /** 单条记忆·关键词命中 */
  memoryRelevant: '的记忆·相关',
  /** 砂金库兜底：比上下文更早的对话原文 */
  earlierRaw: '对话·',
} as const;

/** yaml `recall_quota` 段（与 src/config/retrieval-fusion-config.ts 的 RecallQuotaConfig 同构） */
export interface RecallQuotaConfig {
  /** 总开关：false = 不裁剪（一键回退到 2.3 之前的行为） */
  enabled: boolean;
  /** 某类完全没有供给时，是否释放其额度给有供给的类（避免平白浪费预算） */
  release_empty_class_quota: boolean;
  /** 泛词判据：经数据校验的关键词命中数低于此值即视为泛词 */
  generic_query_min_hits: number;
  /** 会晤场景配额（和应为 1） */
  meeting: { high_calcium_group: number; block_summary: number; recent_memory: number };
  /** 非会晤场景配额（和应为 1；近期记忆并入 block_summary 侧） */
  normal: { high_calcium_group: number; block_summary: number };
  /** 泛词时 A 类占比（其余按原比例回给 B / 近期记忆） */
  generic_query_high_calcium: number;
}

export interface ApplyRecallQuotaOptions {
  scenario: QuotaScenario;
  /**
   * 全局记忆预算 C（字符）。与 chat.ts 注入点同一公式：
   * `clamp(历史字符 × memory_max_ratio_of_history, 200, hard_max_chars)`。
   * 由调用方用同一输入（enrichedHistory）现场算，避免「同规则两份实现」。
   */
  budget: number;
  cfg: RecallQuotaConfig | null | undefined;
  /** 泛词（调用方判定：会晤用「经数据校验的关键词命中」，非会晤用抽词长度） */
  genericQuery?: boolean;
}

export interface ClassStat {
  total: number;
  kept: number;
  dropped: number;
  /** 该类片段总字符 */
  chars: number;
  /** 保留字符 */
  keptChars: number;
  /** 额度（字符）。非会晤场景 block_summary 与 recent_memory 共享同一额度 */
  quotaChars: number;
}

export interface ApplyRecallQuotaResult {
  /** 结果片段（保持原有注入顺序；applied=false 时与入参完全一致） */
  kept: string[];
  /** 是否真的执行了裁剪逻辑（false = 配置关/预算非法/比例非法 → 原样返回） */
  applied: boolean;
  scenario: QuotaScenario;
  budget: number;
  genericQuery: boolean;
  classes: Record<QuotaClassKey, ClassStat>;
  /** OTHER 类（不占配额，永不因配额被裁） */
  other: { total: number; chars: number };
  /** 因配额被裁掉的片段条数 */
  dropped: number;
}

/** 去掉标签尾部的时间坐标（`·10-20` / `·2025-12-31`）——T003 之后所有标签都带它 */
function stripTimeSuffix(tag: string): string {
  return tag.replace(/·\d{4}-\d{2}-\d{2}$/, '').replace(/·\d{2}-\d{2}$/, '');
}

/** 取片段的标签段（首个【…】内的文本），无标签返回 '' */
function tagOf(fragment: string): string {
  const m = /^【([^】]+)】/.exec(fragment || '');
  return m ? stripTimeSuffix(m[1]) : '';
}

/**
 * 片段 → 配额类别。
 *
 * 判据只看**标签**，不看正文（正文是用户私密内容，不得作为分类依据）。
 * 未识别的标签一律归 other ⇒ 只受全局预算约束，永不被配额裁剪（fail-open）。
 */
export function classifyFragment(fragment: string): QuotaClass {
  const tag = tagOf(fragment);
  if (!tag) return 'other';
  // A/B 链路按「是否含高钙」区分，且**同时认新旧标签形态**：
  //   启用配额：`X的对话组记忆·高钙` / `X的对话组记忆` / 裸形态；
  //   关闭配额：`X的对话组·高钙` / `X的对话组`（2.3 之前的形态）。
  // 判据只要求「含 对话组」，不依赖「的」的位置与是否含「记忆」，避免形态漂移漏判。
  if (tag.includes('高钙') && tag.includes('对话组')) return 'high_calcium_group';
  if (tag.includes('对话组')) return 'block_summary';
  // B 链路：砂金库兜底取回的「更早对话原文」
  if (tag.startsWith(TAG.earlierRaw) && !tag.startsWith('对话原文')) return 'block_summary';
  // 近期/历史记忆 + 关键词命中记忆 + 高钙砂金 + 情感召回的单条记忆
  if (tag.endsWith(TAG.memoryRelevant) || tag.endsWith(TAG.memory)
    || tag.endsWith('重要记忆') || tag === '用户曾提到' || tag === '回忆') {
    return 'recent_memory';
  }
  return 'other';
}

/**
 * 取对话组主键（用于 F3 同组去重：同一组被 B 链路与 A 链路都命中时只注一次）。
 * 只认两个组域，其余一律返回 null（不猜 payload）。
 */
export function extractDialogGroupId(
  hit: { id?: string | number; domain?: string } | null | undefined,
): string | null {
  const domain = String(hit?.domain ?? '');
  if (domain !== 'dialog_group' && domain !== 'high_calcium_group') return null;
  const id = hit?.id;
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s || null;
}

/**
 * 读比例：有限且非负才接受。
 *
 * 🔴 非法值**不静默归 0**（S4 评审）—— 归 0 会让该类被整类清空，与
 * 「比例非法 → 原样返回」的 fail-open 契约相悖；改返回 NaN，由上层判定降级。
 */
function readShare(v: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : Number.NaN;
}

function emptyStat(): ClassStat {
  return { total: 0, kept: 0, dropped: 0, chars: 0, keptChars: 0, quotaChars: 0 };
}

/** 合法比例：有限、非负，且总和 > 0 */
function isValidShare(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

/**
 * A/B 链路统一召回配额。
 *
 * @param fragments 检索阶段已拼装好的全部片段（含 OTHER），顺序即注入顺序
 * @param opts      场景 / 预算 / 配置 / 泛词标记
 */
export function applyRecallQuota(
  fragments: string[],
  opts: ApplyRecallQuotaOptions,
): ApplyRecallQuotaResult {
  const list = Array.isArray(fragments) ? fragments.map(f => String(f ?? '')) : [];
  const scenario: QuotaScenario = opts?.scenario === 'normal' ? 'normal' : 'meeting';
  const genericQuery = !!opts?.genericQuery;
  const budget = Number(opts?.budget);

  const passthrough = (applied: boolean): ApplyRecallQuotaResult => ({
    kept: list.slice(),
    applied,
    scenario,
    budget: Number.isFinite(budget) ? budget : 0,
    genericQuery,
    classes: { high_calcium_group: emptyStat(), block_summary: emptyStat(), recent_memory: emptyStat() },
    other: { total: 0, chars: 0 },
    dropped: 0,
  });

  const cfg = opts?.cfg;
  if (!cfg || cfg.enabled !== true) return passthrough(false);
  if (!Number.isFinite(budget) || budget <= 0) return passthrough(false);

  // ── 1. 比例（泛词时 A 降档，余量按原比例回给 B / 近期记忆） ──
  let shareA: number;
  let shareB: number;
  let shareR: number;
  if (scenario === 'meeting') {
    shareA = readShare(cfg.meeting?.high_calcium_group);
    shareB = readShare(cfg.meeting?.block_summary);
    shareR = readShare(cfg.meeting?.recent_memory);
  } else {
    shareA = readShare(cfg.normal?.high_calcium_group);
    shareB = readShare(cfg.normal?.block_summary);
    shareR = 0;  // 非会晤：近期记忆并入 B 侧（R020 Q2，避免四分类）
  }
  // 🔴 任一比例非法（NaN / 负 / 非数值）→ 整体降级，**不裁剪**（fail-open）。
  //   不做「非法归 0 继续跑」：那会让该类被静默清空，属静默降级而非兜底。
  if (![shareA, shareB, shareR].every(Number.isFinite)) return passthrough(false);
  if (genericQuery) {
    const a = readShare(cfg.generic_query_high_calcium);
    if (!Number.isFinite(a)) return passthrough(false);
    const rest = 1 - a;
    // 会晤：B 与近期记忆按原比例分 rest；非会晤：B 独占 rest
    const denom = scenario === 'meeting' ? shareB + shareR : shareB;
    if (denom > 0) {
      shareB = scenario === 'meeting' ? (shareB / denom) * rest : rest;
      shareR = scenario === 'meeting' ? (shareR / denom) * rest : 0;
      shareA = a;
    }
    // denom === 0（B/近期记忆本就全为 0 的畸形配置）→ 保持原比例，不重分配
  }
  const sum = shareA + shareB + shareR;
  if (!isValidShare(sum)) return passthrough(false);  // 配置非法 → 降级，不裁剪
  shareA /= sum; shareB /= sum; shareR /= sum;

  // ── 2. 分类（只分类一次，后续按序消费） ──
  const classOf: QuotaClass[] = new Array(list.length);
  const classes: Record<QuotaClassKey, ClassStat> = {
    high_calcium_group: emptyStat(),
    block_summary: emptyStat(),
    recent_memory: emptyStat(),
  };
  const otherStat = { total: 0, chars: 0 };
  for (let i = 0; i < list.length; i++) {
    const k = classifyFragment(list[i]);
    classOf[i] = k;
    if (k === 'other') {
      otherStat.total++;
      otherStat.chars += list[i].length;
      continue;
    }
    classes[k].total++;
    classes[k].chars += list[i].length;
  }

  // ── 3. 额度分组与份额 ──
  // 会晤：A / B / 近期记忆 三个独立池。
  // 非会晤：A 独立池；B 与近期记忆**同池**（R020 Q2「近期记忆并入 B 侧」——
  //   若各给一份，B 侧实际额度会翻倍成 120%，配额就形同虚设）。
  const shareOfGroup: Record<string, number> = scenario === 'meeting'
    ? { A: shareA, B: shareB, R: shareR }
    : { A: shareA, S: shareB };
  const groupOfClass: Record<QuotaClassKey, string> = scenario === 'meeting'
    ? { high_calcium_group: 'A', block_summary: 'B', recent_memory: 'R' }
    : { high_calcium_group: 'A', block_summary: 'S', recent_memory: 'S' };
  // 每类「有没有供给」——按池聚合（非会晤时 B 与近期记忆算同一个池的供给）
  const supplyByGroup: Record<string, boolean> = {};
  for (const g of Object.keys(shareOfGroup)) supplyByGroup[g] = false;
  for (const k of ['high_calcium_group', 'block_summary', 'recent_memory'] as QuotaClassKey[]) {
    if (classes[k].total > 0) supplyByGroup[groupOfClass[k]] = true;
  }
  // 释放「完全没有供给」的池的份额（否则 A 无供给时会平白锁死 40% 预算，B 侧被无谓压到 60%）
  const quotaByGroup: Record<string, number> = {};
  if (cfg.release_empty_class_quota === true) {
    const alive = Object.keys(shareOfGroup).filter(g => supplyByGroup[g]);
    const aliveShare = alive.reduce((s, g) => s + shareOfGroup[g], 0);
    for (const g of Object.keys(shareOfGroup)) {
      quotaByGroup[g] = Math.floor(budget * (supplyByGroup[g] && aliveShare > 0 ? shareOfGroup[g] / aliveShare : 0));
    }
  } else {
    for (const g of Object.keys(shareOfGroup)) quotaByGroup[g] = Math.floor(budget * shareOfGroup[g]);
  }
  for (const k of ['high_calcium_group', 'block_summary', 'recent_memory'] as QuotaClassKey[]) {
    classes[k].quotaChars = quotaByGroup[groupOfClass[k]];
  }

  // ── 4. 按注入顺序截断（**全局按序**遍历，同池的两类共用同一计数器） ──
  const usedByGroup: Record<string, number> = {};
  for (const g of Object.keys(shareOfGroup)) usedByGroup[g] = 0;
  const droppedByClass: Record<QuotaClassKey, number> = { high_calcium_group: 0, block_summary: 0, recent_memory: 0 };
  const keptCharsByClass: Record<QuotaClassKey, number> = { high_calcium_group: 0, block_summary: 0, recent_memory: 0 };
  const keptCountByClass: Record<QuotaClassKey, number> = { high_calcium_group: 0, block_summary: 0, recent_memory: 0 };
  const drop = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const k = classOf[i];
    if (k === 'other') continue;
    const g = groupOfClass[k];
    const len = list[i].length;
    if (usedByGroup[g] + len <= quotaByGroup[g]) {
      usedByGroup[g] += len;
      keptCharsByClass[k] += len;
      keptCountByClass[k]++;
    } else {
      drop.add(i);
      droppedByClass[k]++;
    }
  }
  for (const k of ['high_calcium_group', 'block_summary', 'recent_memory'] as QuotaClassKey[]) {
    classes[k].keptChars = keptCharsByClass[k];
    classes[k].kept = keptCountByClass[k];
    classes[k].dropped = droppedByClass[k];
  }

  const kept = list.filter((_, i) => !drop.has(i));
  return {
    kept,
    applied: true,
    scenario,
    budget,
    genericQuery,
    classes,
    other: otherStat,
    dropped: drop.size,
  };
}
