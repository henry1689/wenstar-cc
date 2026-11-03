/**
 * MemArch-v2.0.0 / M2-OnlineWrite / EventSegmenter
 *
 * 事件分割器（四因子边界检测）
 * 公式：E = 0.4·(1 - cos(e⃗ₜ, ē_win)) + 0.25·min(1, gap/30min) + 0.2·|Δa| + 0.15·cue
 *
 * 切分条件（任一满足即切分）：
 *   1. E ≥ 0.55
 *   2. 时间间隔超过 120 分钟（hard_gap_min）
 *   3. episode 超过 40 轮（max_turns）
 *
 * 设计依据：主设计文档 §4.2 / §16.3 segmentation
 */

import { M2_CONFIG } from './config.js';
import type { TurnFeat, SegmentationResult } from './types.js';

/** 显式转场词库 */
const TRANSITION_CUES = [
  '对了', '换个话题', '说起来', '话说回来', '顺便说一下',
  '另外', '还有', '哦对了', '那什么', '接下来',
  '先不说这个', '回到正题', '换个事', '聊点别的',
  '我突然想到', '突然想起', '对了对了',
];

export class EventSegmenter {
  private readonly cfg = M2_CONFIG.segmentation;

  /**
   * 判断当前消息是否触发事件边界
   * @param history 历史对话特征（当前 episode 内的全部轮次）
   * @param current 当前消息特征
   */
  isBoundary(history: TurnFeat[], current: TurnFeat): SegmentationResult {
    // 第一条消息，无条件切分
    if (history.length === 0) {
      return {
        is_boundary: true,
        boundary_score: 1.0,
        factors: { semantic: 0, gap: 0, arousal: 0, cue: 0 },
        reason: 'first_turn',
      };
    }

    // 硬切分条件 1：时间间隔超过 hard_gap_min
    const lastTurn = history[history.length - 1];
    const gapMin = (current.ts - lastTurn.ts) / 60_000;
    if (gapMin >= this.cfg.hard_gap_min) {
      return {
        is_boundary: true,
        boundary_score: 1.0,
        factors: {
          semantic: 0,
          gap: 1.0,
          arousal: 0,
          cue: 0,
        },
        reason: `hard_gap_${gapMin.toFixed(0)}min`,
      };
    }

    // 硬切分条件 2：episode 轮次超过 max_turns
    if (history.length >= this.cfg.max_turns) {
      return {
        is_boundary: true,
        boundary_score: 1.0,
        factors: { semantic: 0, gap: 0, arousal: 0, cue: 0 },
        reason: 'max_turns_reached',
      };
    }

    // 软切分：计算边界分数 E
    const w = this.cfg.weights;

    // 因子 1：语义相似度（无向量时跳过，贡献按权重均分给其他因子）
    let semantic = 0;
    let hasSemantic = false;
    if (current.emb && lastTurn.emb && current.emb.length > 0) {
      const windowTurns = history.slice(-this.cfg.window_turns);
      const win = this.meanVec(windowTurns.map(t => t.emb!));
      const cos = this.cosine(current.emb, win);
      semantic = 1 - cos;
      hasSemantic = true;
    }

    // 因子 2：时间间隔归一化
    const gap = Math.min(1, gapMin / this.cfg.gap_normalize_min);

    // 因子 3：唤醒度变化
    const arousal = Math.abs(current.arousal - lastTurn.arousal);

    // 因子 4：显式转场词
    const cue = this.hasTransitionCue(current.text) ? 1 : 0;

    // 合成分数（无向量时重新归一化权重）
    let E: number;
    if (hasSemantic) {
      E = w.semantic * semantic + w.gap * gap + w.arousal * arousal + w.cue * cue;
    } else {
      // 语义项缺失，权重重新分配给其余三项（按原比例缩放）
      const total = w.gap + w.arousal + w.cue;
      const scale = 1 / total;
      E = (w.gap * gap + w.arousal * arousal + w.cue * cue) * scale;
      semantic = 0;
    }

    const isBoundary = E >= this.cfg.threshold;

    return {
      is_boundary: isBoundary,
      boundary_score: E,
      factors: { semantic, gap, arousal, cue },
      reason: isBoundary ? `score_${E.toFixed(3)}` : 'below_threshold',
    };
  }

  /** 检测文本是否包含显式转场词 */
  hasTransitionCue(text: string): boolean {
    for (const cue of TRANSITION_CUES) {
      if (text.includes(cue)) return true;
    }
    return false;
  }

  /** 计算向量均值 */
  private meanVec(vecs: number[][]): number[] {
    if (vecs.length === 0) return [];
    const dim = vecs[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of vecs) {
      for (let i = 0; i < dim; i++) sum[i] += v[i];
    }
    return sum.map(s => s / vecs.length);
  }

  /** 余弦相似度 */
  private cosine(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 1;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 1;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}
