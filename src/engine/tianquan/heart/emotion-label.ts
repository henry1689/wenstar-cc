/**
 * emotion-label — 24D 情感向量 → 具象情感标签映射
 *
 * 级联判断，最细分的标签优先匹配。
 * 最终传给生成层的是「娇羞·中度」「委屈·轻度」等具象标签。
 */
import type { EmotionState24 } from '../../bus/types.js';

// ── 维度别名（简化调用） ──
type V = EmotionState24;

// ── 标签强度 ──
export type LabelStrength = '轻度' | '中度' | '重度';

// ── 情感标签结果 ──
export interface EmotionLabel {
  /** 一级大类 */
  category: '喜' | '哀' | '怒' | '静' | '羞' | '惧' | '欲' | '冷';
  /** 二级具体亚型 */
  subtype: string;
  /** 强度 */
  strength: LabelStrength;
  /** 标签中文描述 */
  label: string; // 例如 "娇羞·中度"
}

// ── 级联判断规则 ──
// 每条规则：匹配条件 + 标签
// 从上到下匹配，最先命中的返回

interface LabelRule {
  name: string;
  match: (v: V) => boolean;
  category: EmotionLabel['category'];
  subtype: string;
}

const RULES: LabelRule[] = [
  // ═══ 正向情感 ═══
  { name: '甜蜜依恋',   match: v => v.affection > 40 && v.intimacy > 30 && v.joy > 30 && v.arousal > 20, category: '喜', subtype: '甜蜜依恋' },
  { name: '雀跃',       match: v => v.joy > 50 && v.excitement > 30 && v.arousal > 25, category: '喜', subtype: '雀跃' },
  { name: '温暖感动',   match: v => v.warmth > 45 && v.affection > 30 && v.shyness < 15, category: '喜', subtype: '温暖感动' },
  { name: '平静满足',   match: v => v.calm > 55 && v.joy > 25 && v.trust > 40, category: '静', subtype: '平静满足' },
  { name: '慵懒',       match: v => v.calm > 40 && v.arousal < 10 && v.fatigue > 30 && v.joy > 10, category: '静', subtype: '慵懒' },
  { name: '安静喜欢',   match: v => v.affection > 25 && v.joy > 20 && v.arousal < 15 && v.shyness > 10, category: '羞', subtype: '安静喜欢' },

  // ═══ 负向情感 ═══
  { name: '委屈受伤',   match: v => v.sadness > 30 && v.trust < 25 && v.anger < 20 && v.anxiety > 15, category: '哀', subtype: '委屈受伤' },
  { name: '失落',       match: v => v.sadness > 25 && v.joy < 10 && v.arousal < 10, category: '哀', subtype: '失落' },
  { name: '愠怒',       match: v => v.anger > 25 && v.anger < 50 && v.dominance > 15 && v.sadness < 20, category: '怒', subtype: '愠怒' },
  { name: '愤怒攻击',   match: v => v.anger > 50 && v.arousal > 40 && v.dominance > 30, category: '怒', subtype: '愤怒' },
  { name: '疏离冷淡',   match: v => v.coldness > 35 && v.warmth < 10 && v.trust < 20, category: '冷', subtype: '疏离冷淡' },
  { name: '不安焦虑',   match: v => v.anxiety > 35 && v.sadness > 15 && v.calm < 20, category: '惧', subtype: '不安焦虑' },
  { name: '恐惧',       match: v => v.fear > 40 && v.anxiety > 30 && v.trust < 15, category: '惧', subtype: '恐惧' },
  { name: '嫉妒',       match: v => v.jealousy > 35 && v.trust < 20 && v.anger > 15, category: '哀', subtype: '嫉妒' },

  // ═══ 亲密/欲望 ═══
  { name: '娇羞',       match: v => v.shyness > 30 && v.intimacy > 25 && v.arousal > 20 && v.warmth > 20, category: '羞', subtype: '娇羞' },
  { name: '欲动',       match: v => v.arousal > 40 && v.intimacy > 30 && v.excitement > 25 && v.shyness < 25, category: '欲', subtype: '欲动' },
  { name: '渴望',       match: v => v.intimacy > 45 && v.arousal > 30 && v.excitement > 25, category: '欲', subtype: '渴望' },

  // ═══ 怀旧/沉思 ═══
  { name: '怀旧',       match: v => v.nostalgia > 30 && v.shyness > 15 && v.joy > 15, category: '静', subtype: '怀旧' },
  { name: '好奇',       match: v => v.curiosity > 40 && v.arousal > 15 && v.excitement > 15, category: '喜', subtype: '好奇' },
];

/** 强度判定 */
function determineStrength(v: V, rule: LabelRule): LabelStrength {
  // 基于匹配维度平均偏离程度
  const dimValues = [
    v.joy, v.sadness, v.anger, v.anxiety,
    v.affection, v.intimacy, v.arousal, v.excitement,
    v.shyness, v.nostalgia, v.curiosity,
  ];
  const avg = dimValues.reduce((a, b) => a + b, 0) / dimValues.length;
  if (avg > 50) return '重度';
  if (avg > 25) return '中度';
  return '轻度';
}

/**
 * 24D → 情感标签
 * 返回最匹配的一条标签，及所有高匹配标签列表
 */
export function classifyEmotion(vector: EmotionState24): {
  primary: EmotionLabel;
  alternatives: EmotionLabel[];
} {
  const matched: Array<{ rule: LabelRule; strength: LabelStrength }> = [];

  for (const rule of RULES) {
    if (rule.match(vector)) {
      matched.push({ rule, strength: determineStrength(vector, rule) });
    }
  }

  if (matched.length === 0) {
    // 无匹配 → 默认平静理性
    return {
      primary: { category: '静', subtype: '平静理性', strength: '轻度', label: '平静理性·轻度' },
      alternatives: [],
    };
  }

  // 按匹配维度数量降序排列（最细分的优先）
  const sorted = matched.sort((a, b) => {
    const aDims = countMatchingDims(vector, a.rule);
    const bDims = countMatchingDims(vector, b.rule);
    return bDims - aDims;
  });

  const primary = sorted[0];
  return {
    primary: {
      category: primary.rule.category,
      subtype: primary.rule.subtype,
      strength: primary.strength,
      label: `${primary.rule.subtype}·${primary.strength}`,
    },
    alternatives: sorted.slice(1, 3).map(m => ({
      category: m.rule.category,
      subtype: m.rule.subtype,
      strength: m.strength,
      label: `${m.rule.subtype}·${m.strength}`,
    })),
  };
}

/** 计算命中的维度数（用于排序） */
function countMatchingDims(v: V, rule: LabelRule): number {
  // 近似估算：匹配规则本身已通过 match 函数验证
  // 按所有非零维度的加权和计算精细度
  const dims = [v.joy, v.sadness, v.anger, v.anxiety, v.affection, v.intimacy,
                v.arousal, v.excitement, v.shyness, v.nostalgia, v.curiosity];
  return dims.filter(d => d > 15).length;
}
