/**
 * Validator — 角色扮演域·回复验证器（第五步）
 *
 * 职责：LLM 生成后，对照 CollectedData 做交叉验证。
 *
 * 验证项：
 *   ① 身份保持 — 自称是否正确
 *   ② 事实一致性 — 回复中的数字/日期是否在数据中
 *   ③ 边界检查 — 是否违反未知边界
 *   ④ 编造检查 — 人名是否在已知人物列表中
 *
 * 分级处置：
 *   error   → 打日志告警，建议重生成
 *   warning → 打日志 + 探针标记
 *   pass    → 静默通过
 */
import type { CollectedData, ValidationResult } from './types.js';

/** 玉瑶自称模式 */
const YUYAO_PATTERNS = [
  /(?:我是|我叫)玉瑶/,
  /我[是叫]诗雨[，,。]/,
  /诗雨[在就]这/,
];

/** 非人名的常见词（验证器过滤用） */
const NON_NAMES = new Set([
  '姐姐','妹妹','哥哥','弟弟','妈妈','爸爸','奶奶','爷爷','老婆','老公',
  '阿姨','叔叔','不是','什么','怎么','这个','那个','哪里','多少',
  '为什么','知道','问题','时候','这样','那样','不错','可以','可能',
  '因为','所以','然后','但是','而且','今年','二十','十八','十四',
  '年纪','年龄','多大','几岁','现在','今天','明天','昨天','已经',
]);

/**
 * 验证 LLM 回复
 */
export function validateReply(
  reply: string,
  data: CollectedData,
  roleplay: string,
): ValidationResult {
  const issues: string[] = [];

  // ── ① 身份保持检查 ──
  for (const p of YUYAO_PATTERNS) {
    if (p.test(reply)) {
      issues.push(`身份漂移: 回复中使用了玉瑶/诗雨自称`);
      break;
    }
  }

  // ── ② 事实一致性检查（年龄） ──
  if (data.knownFields.hasAge) {
    const ageMatch = reply.match(/(\d{1,2})(?=岁)/);
    if (ageMatch) {
      // 找到画像/FG/历史中的正确年龄
      const allText = [
        data.fg.treeText,
        ...data.kb.map(k => k.title + k.content),
        data.fg.rootProfile ? JSON.stringify(data.fg.rootProfile) : '',
      ].join(' ');
      const knownAge = allText.match(/(\d{1,2})岁/);
      if (knownAge && ageMatch[1] !== knownAge[1]) {
        issues.push(`年龄矛盾: 回复说${ageMatch[1]}岁，但数据中是${knownAge[1]}岁`);
      }
    }
  }

  // ── ③ 边界检查 — 问年龄时不应给出具体数字 ──
  if (data.context.intent === 'ask_age' && !data.knownFields.hasAge) {
    const hasNumber = /(\d{1,2})岁/.test(reply);
    if (hasNumber) {
      issues.push('边界违反: 无年龄数据但回复中包含了具体年龄数字');
    }
  }

  // ── ④ 编造检查：人名是否在已知人物列表中 ──
  const knownPeople: string[] = [roleplay, ...data.fg.familyMembers];
  const replyWords = reply.match(/[一-龥]{2,4}(?=[，。！？\s\n]|的|了|是|有|在|说|叫)/g) || [];
  for (const w of replyWords) {
    if (knownPeople.includes(w) || NON_NAMES.has(w) || w === roleplay) continue;
    issues.push(`编造嫌疑: 回复中出现了未知人名「${w}」`);
    break;
  }

  // ── 判定严重度 ──
  if (issues.length === 0) {
    return { pass: true, issues, severity: 'pass', fix: 'none' };
  }

  // 身份漂移和年龄矛盾属于 error
  const hasError = issues.some(i => i.includes('身份漂移') || i.includes('年龄矛盾'));
  if (hasError) {
    return { pass: false, issues, severity: 'error', fix: 'regenerate' };
  }

  // 其余属于 warning
  return { pass: true, issues, severity: 'warning', fix: 'none' };
}
