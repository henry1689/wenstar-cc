/**
 * MemArch-v2.0.0 / M2-OnlineWrite / SalienceCalculator
 *
 * 在线显著性快速计算（规则版，非 LLM）
 * 公式：S = 0.30·imp + 0.25·self + 0.20·arousal + 0.15·nov + 0.10·ent
 *
 * 设计依据：主设计文档 §4.2 / §16.3 encoding.salience_weights
 */

import { M2_CONFIG } from './config.js';
import type { WorkingEntry } from './types.js';

// ===== 规则词库（轻量匹配，可后续扩充） =====

/** imp_rule：计划/决定/首次/身体或情绪事件关键词 */
const IMPORTANCE_KEYWORDS = [
  // 计划/决定
  '决定', '打算', '计划', '准备', '一定要', '必须', '承诺', '答应',
  '目标', '任务', '项目', '开始', '结束', '完成', '通过', '失败',
  // 首次/重大事件
  '第一次', '首次', '终于', '竟然', '居然', '没想到', '突破',
  // 身体/情绪事件
  '疼', '痛', '不舒服', '生病', '发烧', '感冒', '受伤', '手术',
  '开心', '难过', '生气', '害怕', '紧张', '激动', '失望', '惊喜',
  // 关系/重大生活
  '结婚', '离婚', '搬家', '换工作', '辞职', '入职', '毕业', '开学',
  '生日', '纪念日', '春节', '过年',
];

/** self_rule：第一人称经历、关系词 */
const SELF_KEYWORDS = [
  // 第一人称
  '我', '我们', '自己', '我的', '我觉得', '我认为', '我感觉',
  // 关系词
  '妈妈', '爸爸', '爷爷', '奶奶', '姥姥', '姥爷', '哥哥', '姐姐',
  '弟弟', '妹妹', '老公', '老婆', '男朋友', '女朋友', '对象',
  '朋友', '同事', '老板', '老师', '同学', '孩子', '儿子', '女儿',
];

/** 寒暄/元话语关键词（DISCARD 倾向，用于门控辅助） */
export const SMALL_TALK_KEYWORDS = [
  '你好', '您好', '嗨', '哈喽', '在吗', '在不在',
  '谢谢', '感谢', '辛苦了', '麻烦了', '不好意思',
  '好的', '好呀', '嗯', '哦', '噢', '行', '可以',
  '再见', '拜拜', '晚安', '早上好', '下午好',
  '哈哈', '呵呵', '嘿嘿', '哈哈哈',
];

/** 有意义实体判定的最小长度（中文按字符计） */
const MEANINGFUL_ENTITY_MIN_LEN = 2;

export class SalienceCalculator {
  private readonly w = M2_CONFIG.encoding.salience_weights;

  /**
   * 计算在线显著性 S ∈ [0,1]
   * 纯规则计算，目标耗时 ≤ 5ms
   */
  calculate(entry: WorkingEntry): {
    salience: number;
    components: NonNullable<WorkingEntry['salience_components']>;
  } {
    const imp_rule = this.importanceRule(entry.content);
    const self_rule = this.selfRule(entry.content);
    const arousal = Math.max(0, Math.min(1, entry.arousal ?? 0.3));
    const nov_rule = this.noveltyRule(entry.content);
    const ent = entry.has_meaningful_entity ? 1.0 : this.entityRule(entry.content);

    const salience =
      this.w.importance * imp_rule +
      this.w.self * self_rule +
      this.w.arousal * arousal +
      this.w.novelty * nov_rule +
      this.w.entity * ent;

    return {
      salience: Math.max(0, Math.min(1, salience)),
      components: { imp_rule, self_rule, arousal, nov_rule, ent },
    };
  }

  /** imp_rule：是否包含计划/决定/首次/身体或情绪事件 */
  private importanceRule(text: string): number {
    let hits = 0;
    for (const kw of IMPORTANCE_KEYWORDS) {
      if (text.includes(kw)) hits++;
    }
    // 0 命中 = 0，1 命中 = 0.4，2+ 命中 = 0.8，3+ 命中 = 1.0
    if (hits === 0) return 0;
    if (hits === 1) return 0.4;
    if (hits === 2) return 0.8;
    return 1.0;
  }

  /** self_rule：是否出现第一人称经历、关系词 */
  private selfRule(text: string): number {
    let hits = 0;
    for (const kw of SELF_KEYWORDS) {
      if (text.includes(kw)) hits++;
    }
    if (hits === 0) return 0;
    if (hits === 1) return 0.5;
    if (hits === 2) return 0.8;
    return 1.0;
  }

  /**
   * nov_rule：快速近似新颖度
   * 无向量时用文本长度 + 感叹/疑问密度近似
   * 精确版本由 M3 睡眠步骤 3 用 LLM + 向量距离计算
   */
  private noveltyRule(text: string): number {
    let score = 0;
    const len = text.length;

    // 文本长度：短句默认普通，长句信息密度高
    if (len >= 100) score += 0.4;
    else if (len >= 50) score += 0.25;
    else if (len >= 20) score += 0.1;

    // 感叹号/问号密度（情绪强度近似）
    const exclaim = (text.match(/[!?！？]/g) || []).length;
    const density = exclaim / Math.max(1, len / 20);
    score += Math.min(0.4, density * 0.3);

    // 数字/日期出现（具体事件倾向于新颖）
    if (/\d{4}[-年]\d{1,2}[-月]\d{1,2}/.test(text)) score += 0.2;

    return Math.min(1, score);
  }

  /**
   * ent：是否有有意义实体
   * 快速版：检测是否包含中文人名/地名模式、专有名词特征
   * 完整版由 M3 实体抽取器提供
   */
  private entityRule(text: string): number {
    // 包含人名模式（2-4 个汉字 + 称呼）
    if (/[\u4e00-\u9fa5]{2,4}(先生|女士|老师|总|哥|姐|叔|姨)/.test(text)) return 1.0;

    // 包含地名模式（城市/省/国家）
    if (/(北京|上海|广州|深圳|杭州|东莞|南京|成都|武汉|西安|中国|美国|日本|英国)/.test(text)) return 1.0;

    // 包含公司/机构名特征
    if (/(公司|工厂|学校|大学|医院|银行|政府|园区|大厦|广场)/.test(text)) return 1.0;

    // 长度足够且不是纯寒暄，认为有一定实体密度
    if (text.length >= MEANINGFUL_ENTITY_MIN_LEN * 5) return 0.5;

    return 0;
  }

  /**
   * 判定是否为纯寒暄/元话语（供门控 DISCARD 分支使用）
   */
  isSmallTalk(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length > 30) return false;  // 长文本不算寒暄

    let hits = 0;
    for (const kw of SMALL_TALK_KEYWORDS) {
      if (trimmed.includes(kw)) hits++;
    }
    // 短文本且命中多个寒暄词 → 判定为寒暄
    return hits >= 1 && trimmed.length <= 15;
  }
}
