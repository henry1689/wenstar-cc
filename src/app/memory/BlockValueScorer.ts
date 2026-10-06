/**
 * BlockValueScorer — 对话块价值判定（**确定性规则，零 LLM**）
 * ==============================================================
 * ADR-010 P1-B / 2026-10-06
 *
 * 职责：给一个已闭合的对话块（dialog_group）打「块钙分」，并抽出块级元数据
 *      （场景指纹 / 情绪曲线 / 衰减类别）。产物写入 `dialog_groups` 表。
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 为什么是确定性规则，而不是「轻量 LLM 打分」
 *
 *   ① 撞本仓铁律「Harness 零 LLM 监控」—— 心跳/定时/监控类后台必须纯系统级运行，
 *      零 LLM 调用零 token。块闭合是后台路径，引入 LLM 直接违反。
 *   ② **不可复现的判据 × 不可逆的持久化决策 = 结构性风险。** LLM 打分同一块
 *      今天 3 分、明天 5 分，而「块进不进检索池」是写定后长期生效的决定 ⇒
 *      检索池内容随机漂移，且漂移不可归因。
 *   ③ 原料本来就全在：括号场景正则、dg.perceptions 情绪曲线、FEATURE_ROUND_RE
 *      承诺识别、话题转折检测、退化内容拦截 —— 六条里五条仓内已有实现。
 *
 *   LLM 至多允许**单向增强**（只能把被规则低判的块捞回，**无权剔除**规则判高的块），
 *   使失败模式安全。本批未启用该增强。
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 判据收拢处（本仓不变量 #7：禁止同一业务规则在多个地方重复实现）
 *
 *   本文件是以下判据的**唯一实现处**，调用方一律引用：
 *     · `FEATURE_ROUND_RE` —— 承诺/约定/引文轮识别（原内联在 dialog-group-stage）
 *     · `SCENE_PAREN_MIN_LEN` + `extractSceneParens` —— 场景描写判据
 *     · `isDegenerateContent` —— 直接复用 m2/MemoryWriteGateway 的实现，**不重写**
 *     · 钙化标度 —— 复用 m2/math.computeCalcium，与逐轮砂金写入**同标度**
 *       （dialog-group-stage 的 H3 注释：同一段内容在库里出现两套分数会导致检索排序错乱）
 */

import { createHash } from 'node:crypto';
import { computeCalcium } from '../../m2/math.js';
import { isDegenerateContent } from '../../m2/MemoryWriteGateway.js';
import type { Perception24D } from '../../m3/types/perception.js';

// ══════════════════════════════════════════════════════════════
// 判据常量（收拢处 —— 改这里即改全链路）
// ══════════════════════════════════════════════════════════════

/**
 * 承诺/约定/引文/重要时间节点轮的特征词集。
 *
 * 由 dialog-group-stage 迁入（原为闭组时锚点补充用的内联常量）—— 同一份词表现在
 * 同时服务「锚点特征轮补充」与「块价值判定」，故必须单一定义。
 * 刻意使用**通用**承诺/约定/书面引用词，零硬编码人名/诗名。
 */
export const FEATURE_ROUND_RE =
  /答应|承诺|约定|约好|保证|一定|下次|寒假|暑假|开学|回来|盼着|记得|记住|重要|关键|写过|念过|背过|那首诗|那句话|答应过|白露|时节|一首诗/;

/**
 * 判定为「有效场景描写」的括号内容最小字数。
 *
 * 🔴 ADR-010 修正 D：**不能只判「有没有括号」**。实测 `conversations` 的 assistant
 *   行 79.2% 带括号 —— 因为括号里既有「（她整张脸都烧透了…）」这种场景，也有
 *   「（她笑了笑）」这种两三字语气词。只判存在性会让**几乎所有块**都吃到这一分，
 *   判据失去区分度，降噪直接失效。故设最小长度门槛，且该门槛可配置。
 */
export const SCENE_PAREN_MIN_LEN = 30;

/** 拉取 UTF-8 全角/半角括号内文本 */
const PAREN_RE = /[（(]([^）)]*)[）)]/g;

/** 单项满分与总分上限 */
const MAX_SCENE = 2;
const MAX_EMOTION = 2;
const COMMITMENT_POINTS = 3;
const TURNING_POINTS = 2;
const SCORE_MAX = 10;

/** 退化轮占比达到此值即判整块为「退化块」 */
const DEGRADED_RATIO_THRESHOLD = 0.6;

// ══════════════════════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════════════════════

/** 块内一轮（问答对） */
export interface BlockRound {
  q: string;
  a: string;
}

/**
 * 块的衰减类别。
 *
 * 🔴 ADR-010 修正 C：衰减率**按内容类别**推导，**不由钙分决定**。
 *   依据 MemoryConfig.ts 的 P2-1 注释：「calcium_score 仅用于晋升门槛和召回优先级，
 *   衰减速率由内容类别独立推导」—— 这是仓内**刻意做的解耦**，不得重新耦合。
 *   本字段是块层的类别表达，供块层自己的衰减策略消费（`dialog_groups` 是独立表，
 *   不走 memories 的 runDecay，故不伪造「家人」之类标签去迎合那边的关键词匹配）。
 */
export type BlockDecayClass = 'emotional' | 'relational' | 'work' | 'neutral';

export interface BlockScoreInput {
  rounds: readonly BlockRound[];
  /** 每轮的感知向量（与 rounds 同序；缺项按中性处理） */
  perceptions: readonly Perception24D[];
  /** 块内峰值钙分 [0,1]（chat.ts 逐轮累积） */
  maxCalcium: number;
  maxCalciumRound: number;
  /** 块的话题路径（如 life.daily） */
  locusPath: string;
  /** 闭合原因：topic_switch / idle_timeout / max_turn / meeting_exit / user_trigger */
  closeReason: string;
  /** 块内出现过的实体名（不含「我」「玉瑶」由调用方筛） */
  entityNames: readonly string[];
}

/** 逐项贡献（可审计：审计日志里能看到分数是怎么来的） */
export interface BlockSignals {
  /** 场景描写 0..2 */
  scene: number;
  /** 情绪起伏 0..2 */
  emotion: number;
  /** 承诺/约定 0..3 */
  commitment: number;
  /** 话题转折 0..2 */
  turningPoint: number;
  /** 退化轮惩罚（≤0） */
  degradedPenalty: number;
}

export interface BlockScore {
  /** 块钙分 0..10（与 memories.calcium_score 同标度） */
  score: number;
  decayClass: BlockDecayClass;
  signals: BlockSignals;
  /** 场景指纹 —— 防复读 / 块去重（等值比对，见 sceneAnchorHash 注释的边界说明） */
  sceneAnchorHash: string;
  /** 块内情绪序列（每轮钙分，0..1，保留 3 位） */
  emotionCurve: number[];
  turnCount: number;
  /** 退化块（单纯应答/寒暄为主） */
  degraded: boolean;
  /** 有效场景描写占比 0..1（口径：≥SCENE_PAREN_MIN_LEN 字的括号内容 的轮次占比） */
  sceneRatio: number;
}

// ══════════════════════════════════════════════════════════════
// 单项判据
// ══════════════════════════════════════════════════════════════

/** 取一段文本里所有括号内内容（去空白） */
export function extractSceneParens(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  PAREN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAREN_RE.exec(text)) !== null) {
    const inner = (m[1] || '').trim();
    if (inner) out.push(inner);
  }
  return out;
}

/**
 * 场景描写占比 —— **有效**括号（内容 ≥ SCENE_PAREN_MIN_LEN 字）所占的轮次比例。
 * 一轮内出现任一有效括号即计该轮有效（不按括号个数累加，避免长回复刷分）。
 */
export function sceneRatioOf(rounds: readonly BlockRound[]): number {
  if (rounds.length === 0) return 0;
  let hit = 0;
  for (const r of rounds) {
    const parens = extractSceneParens(`${r.q}\n${r.a}`);
    if (parens.some((p) => p.length >= SCENE_PAREN_MIN_LEN)) hit++;
  }
  return hit / rounds.length;
}

/** 情绪曲线：逐轮钙分 [0,1]（与 memories 同标度） */
export function emotionCurveOf(perceptions: readonly Perception24D[]): number[] {
  return perceptions.map((p) => {
    if (!p) return 0;
    try {
      return Math.round(computeCalcium(p).score * 1000) / 1000;
    } catch {
      return 0;
    }
  });
}

/**
 * 情绪起伏 0..MAX_EMOTION：情绪曲线极差越大越「有戏」。
 * 平坦的一段（全程中性）拿 0 分；大起大落拿满分。
 * 用极差而非方差：起承转合看的是峰值与谷值的距离，不是离散度。
 */
export function emotionSignalOf(curve: readonly number[]): number {
  if (curve.length < 2) return 0;
  const span = Math.max(...curve) - Math.min(...curve);
  // 极差 0.5 及以上视为「明显起伏」→ 满分（实测单块内极差通常 <0.4）
  return Math.round(Math.min(1, span / 0.5) * MAX_EMOTION * 100) / 100;
}

/** 承诺/约定 0..COMMITMENT_POINTS：命中即得，**不按命中次数累加**（一次承诺就是一次承诺） */
export function commitmentSignalOf(rounds: readonly BlockRound[]): number {
  for (const r of rounds) {
    if (FEATURE_ROUND_RE.test(`${r.q}\n${r.a}`)) return COMMITMENT_POINTS;
  }
  return 0;
}

/** 话题转折 0..TURNING_POINTS */
export function turningPointSignalOf(closeReason: string): number {
  return closeReason === 'topic_switch' ? TURNING_POINTS : 0;
}

/** 退化轮占比（复用 m2 的 isDegenerateContent，不重写判据） */
export function degradedRatioOf(rounds: readonly BlockRound[]): number {
  if (rounds.length === 0) return 1;
  let d = 0;
  for (const r of rounds) {
    // 问答两侧都退化才算退化轮 —— 用户敷衍但角色认真回应，仍是有效剧情
    if (isDegenerateContent(r.q) && isDegenerateContent(r.a)) d++;
  }
  return d / rounds.length;
}

/**
 * 衰减类别 —— **按内容类别推导，不由钙分决定**（ADR-010 修正 C / MemoryConfig P2-1）。
 *
 * 判据顺序即优先级：情感 > 关系 > 工作 > 中性。
 * 用感知维的**峰值**而非均值：一段里只要有一轮足够亲密，整块就按情感类留存
 * —— 与真人记忆一致（一段相处里最动人的那一刻决定这段记多久）。
 */
export function decayClassOf(
  perceptions: readonly Perception24D[],
  locusPath: string,
  entityNames: readonly string[],
): BlockDecayClass {
  const peak = (key: keyof Perception24D): number => {
    let m = 0;
    for (const p of perceptions) {
      const v = Number((p as any)?.[key]) || 0;
      if (v > m) m = v;
    }
    return m;
  };
  if (peak('intimacy') >= 0.45 || peak('sexual_attraction') >= 0.45) return 'emotional';
  if (entityNames.length > 0 && peak('sincerity') >= 0.4) return 'relational';
  if (/work|project|office/i.test(locusPath)) return 'work';
  return 'neutral';
}

/**
 * 场景指纹 —— 用于**防复读**与块去重。
 *
 * 组成：归一化后的**有效场景描写文本** + 话题路径主类 + 实体名排序。
 * 归一化：去空白与标点、只留字母数字汉字 ⇒ 同一场景的两种措辞若差异较大则**不会**得到同一指纹。
 *
 * 🔴 边界（不要把它当相似度用）：这是**等值指纹**，不是相似度度量。
 *   它可靠地回答「这是不是同一个场景」（完全重复），不能回答「这两个场景有多像」。
 *   相近但措辞不同的场景不会被判同 —— 需要相似度时另建特征向量，不要在这里假装。
 */
export function sceneAnchorHashOf(
  rounds: readonly BlockRound[],
  locusPath: string,
  entityNames: readonly string[],
): string {
  const scenes: string[] = [];
  for (const r of rounds) {
    for (const p of extractSceneParens(`${r.q}\n${r.a}`)) {
      if (p.length >= SCENE_PAREN_MIN_LEN) scenes.push(p);
    }
  }
  const normalized = scenes
    .join('|')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 4000);
  const locusMain = String(locusPath || '').split('.')[1] || String(locusPath || '');
  const ents = [...entityNames].filter(Boolean).sort().join(',');
  return createHash('sha256')
    .update(`${normalized}#${locusMain}#${ents}`)
    .digest('hex')
    .slice(0, 16);
}

// ══════════════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════════════

/**
 * 为一个已闭合的对话块打分。
 *
 * **纯函数**：无 IO、无副作用、无随机 —— 同一输入恒得同一输出（这正是选它而非 LLM 的理由）。
 * 空块返回全零（调用方应跳过写入）。
 */
export function scoreBlock(input: BlockScoreInput): BlockScore {
  const rounds = input.rounds || [];
  const perceptions = input.perceptions || [];
  const turnCount = rounds.length;

  const sceneRatio = sceneRatioOf(rounds);
  const scene = Math.round(sceneRatio * MAX_SCENE * 100) / 100;
  const curve = emotionCurveOf(perceptions);
  const emotion = emotionSignalOf(curve);
  const commitment = commitmentSignalOf(rounds);
  const turningPoint = turningPointSignalOf(input.closeReason);
  const degradedRatio = degradedRatioOf(rounds);
  const degraded = turnCount > 0 && degradedRatio >= DEGRADED_RATIO_THRESHOLD;
  // 退化惩罚：按退化占比线性扣，最多扣 3 分（不足以抹掉承诺/情感的正分，只压平纯寒暄）
  const degradedPenalty = -Math.round(degradedRatio * 3 * 100) / 100;

  const raw = scene + emotion + commitment + turningPoint + degradedPenalty;
  const score = Math.round(Math.max(0, Math.min(SCORE_MAX, raw)) * 100) / 100;

  return {
    score,
    decayClass: decayClassOf(perceptions, input.locusPath, input.entityNames),
    signals: { scene, emotion, commitment, turningPoint, degradedPenalty },
    sceneAnchorHash: sceneAnchorHashOf(rounds, input.locusPath, input.entityNames),
    emotionCurve: curve,
    turnCount,
    degraded,
    sceneRatio: Math.round(sceneRatio * 1000) / 1000,
  };
}
