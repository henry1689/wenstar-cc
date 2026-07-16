/**
 * EmotionRegulator.ts — 记忆驱动情绪调节器 (V3.1)
 * ==================================================
 * 仿海马体→杏仁核的抑制回路：用过去相似场景的经验，
 * 对当前过激情绪输出可解释、有依据的微调建议。
 *
 * 生物依据: 海马体↔杏仁核双向回路。
 *   上行: 杏仁核给海马体标记情绪强度
 *   下行: 海马体根据过去经验告诉杏仁核"这场景不危险"→ 下调恐惧
 *
 * 使用:
 *   const reg = new EmotionRegulator(sqlite);
 *   const result = reg.regulate(perception, relatedMemories);
 *   // → { suggestedShift, confidence, basis }
 *   // 注入 LLM: "根据过去的经验，可以适度安抚用户。上次类似场景后用户情绪好转了。"
 */
import type { DNA } from '../../../m1/types/dna.js';
import type { Perception24D } from '../../../m3/types/perception.js';
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';

export interface EmotionRegulation {
  /** 建议的情绪微调方向 */
  suggestedShift: { pleasure: number; arousal: number };
  /** 调节置信度 [0,1] */
  confidence: number;
  /** 安抚依据——来自历史记忆的经验（可直接注入 LLM） */
  basis: string | null;
  /** 是否建议安抚 */
  shouldSoothe: boolean;
  /** 相关依据记忆数 */
  evidenceCount: number;
}

export class EmotionRegulator {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 根据相关记忆输出情绪调节建议
   * @param currentPerception 当前 M3 感知结果
   * @param relatedMemories   M4 检索到的相关记忆
   */
  regulate(currentPerception: Perception24D, relatedMemories: DNA[]): EmotionRegulation {
    const result: EmotionRegulation = {
      suggestedShift: { pleasure: 0, arousal: 0 },
      confidence: 0,
      basis: null,
      shouldSoothe: false,
      evidenceCount: relatedMemories.length,
    };

    if (relatedMemories.length === 0) return result;

    // ── 1. 从相关记忆中提取"那个场景的结果情绪" ──
    const pastPleasures: number[] = [];
    const subsequentOutcomes: Array<{ deltaPleasure: number; snippet: string }> = [];
    const snippets: string[] = [];

    for (const mem of relatedMemories.slice(0, 10)) {
      try {
        // 原始记忆的情绪
        const perc = (mem as any).perception_json ? JSON.parse((mem as any).perception_json) : {};
        if (typeof perc.pleasure === 'number') {
          pastPleasures.push(perc.pleasure);
        }

        // 后续追踪（perception_v2 记录了不同心境下的感知叠加）
        const v2 = (mem as any).perception_v2 ? JSON.parse((mem as any).perception_v2) : null;
        if (v2 && typeof v2.pleasure === 'number') {
          const delta = v2.pleasure - (perc.pleasure || 0);
          subsequentOutcomes.push({
            deltaPleasure: delta,
            snippet: (mem.raw_input || '').substring(0, 60),
          });
        }

        if (mem.raw_input && snippets.length < 3) {
          snippets.push(mem.raw_input.substring(0, 60));
        }
      } catch (e) { console.warn(`[EmotionRegulator] 操作失败`, (e as Error)?.message || e); }
    }

    // ── 2. 判断是否过激 ──
    const currPleasure = currentPerception.pleasure || 0;
    const currArousal = currentPerception.arousal || 0;
    const isOverActivated = currArousal > 0.6 || currPleasure < -0.3;

    if (!isOverActivated) return result;

    // ── 3. 计算调节方向 ──
    if (pastPleasures.length > 0) {
      const avgPast = pastPleasures.reduce((s, v) => s + v, 0) / pastPleasures.length;

      // 如果过去相似场景的情绪更好 → 建议上调 pleasure
      if (avgPast > currPleasure && avgPast > 0) {
        result.suggestedShift.pleasure = Math.min(0.3, avgPast - currPleasure);
      }
      // 如果当前 arousal 过高 → 建议下调
      if (currArousal > 0.5) {
        result.suggestedShift.arousal = -0.15;
      }
    }

    // ── 4. 从后续结局中提取安抚依据 ──
    const improved = subsequentOutcomes.filter(o => o.deltaPleasure > 0.1);
    const worsened = subsequentOutcomes.filter(o => o.deltaPleasure < -0.1);

    if (improved.length > worsened.length && improved.length > 0) {
      result.confidence = Math.min(0.85, 0.4 + improved.length * 0.15);
      result.shouldSoothe = true;
      result.basis = `过去的经验：${improved.length} 次类似场景后情绪好转了。如"${improved[0].snippet}"`;
    } else if (worsened.length > improved.length) {
      result.confidence = 0.3;
      result.basis = `过去的经验：类似场景后情绪未见好转。需谨慎回应而非直接安抚。`;
      result.shouldSoothe = false;
    } else if (snippets.length > 0) {
      result.confidence = 0.4;
      result.basis = `之前的类似对话："${snippets[0]}"`;
      result.shouldSoothe = currArousal > 0.4;
    }

    // ── 5. 置信度太低时，不做调节 ──
    if (result.confidence < 0.35) {
      result.suggestedShift = { pleasure: 0, arousal: 0 };
      result.basis = null;
      result.shouldSoothe = false;
    }

    return result;
  }

  /**
   * 将调节结果格式化为 LLM 上下文提示
   */
  formatForContext(regulation: EmotionRegulation): string | null {
    if (!regulation.shouldSoothe || !regulation.basis) return null;

    const parts: string[] = ['【情绪调节建议】'];
    if (regulation.confidence > 0.6) {
      parts.push('根据过去的经验，可以适度安抚当前情绪。');
    }
    parts.push(regulation.basis);
    if (regulation.suggestedShift.pleasure > 0) {
      parts.push('建议语气：比平时更温柔一些。');
    }
    return parts.join(' ');
  }
}
