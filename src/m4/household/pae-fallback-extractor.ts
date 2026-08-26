/**
 * pae-fallback-extractor.ts — PAE 正则降级提取器（P1 降级链）
 * ==========================================================
 * LLM 提取失败/超时时保底：从登记句式（姓名：X / 性别：X / 电话：X 等）中提取基础字段，
 * 确保 LLM 通道抖动时基础档案信息仍能落库（姓名/性别/联系方式等格式明确字段）。
 *
 * 设计原则（准确性优先）：
 *   - 只提取"格式明确"的字段（显式冒号句式），宁可漏、不可错
 *   - 关系类字段（relationToUser）由 edges 系统管理，这里不提取（commitField 会拒）
 *   - 置信度按字段类型给出（与 PRIORITY_THRESHOLDS 匹配，保证可直写）
 */
import type { ExtractionResult, ExtractionField } from './ProfileAcquisitionEngine.js';

/** 登记句式信号词（用于判断此人是否被"登记式"提及） */
const REGISTRATION_SIGNAL = /(?:姓名|名字|性别|电话|手机|微信|邮箱|住址|地址|户口|身份证|出生|生日|今年|登记|介绍)/;

const FIELD_PATTERNS: Array<{ key: string; path: string; re: RegExp; confidence: number; label: string }> = [
  { key: 'name',            path: 'name',                       re: /姓名[：:]\s*([^\s/，,；;。|]+)/,        confidence: 0.7, label: '姓名' },
  { key: 'gender',          path: 'gender',                     re: /性别[：:]\s*([男女性])/,                  confidence: 0.7, label: '性别' },
  { key: 'phone',           path: 'phone',                      re: /(?:电话|手机)[：:]\s*(\d[\d\- ]{6,}\d)/,  confidence: 0.85, label: '电话' },
  { key: 'wechat',          path: 'wechat',                     re: /微信[：:]\s*([^\s，,；;。]+)/,             confidence: 0.8, label: '微信' },
  { key: 'email',           path: 'email',                      re: /邮箱[：:]\s*([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/, confidence: 0.85, label: '邮箱' },
  { key: 'address',         path: 'address',                    re: /(?:住址|地址)[：:]\s*([^\s，,；;。]+)/,   confidence: 0.8, label: '住址' },
];

/**
 * 正则降级提取：从对话文本提取登记字段。
 * @param text  对话文本（已截断）
 * @param persons 待提取的人名（M1 entity_genes / batch）
 * @returns ExtractionResult[]（字段为空且无提及的 person 不返回）
 */
export function fallbackExtract(text: string, persons: string[]): ExtractionResult[] {
  if (!text || !persons || persons.length === 0) return [];
  const results: ExtractionResult[] = [];

  for (const personName of persons) {
    // 该人是否在文本中被提及
    if (!text.includes(personName)) continue;
    const fields: ExtractionField[] = [];

    for (const fp of FIELD_PATTERNS) {
      const m = text.match(fp.re);
      if (m && m[1]) {
        // 姓名只取与 personName 一致的（避免把别人的姓名填错）
        if (fp.key === 'name' && m[1].trim() !== personName) continue;
        fields.push({
          fieldPath: fp.path,
          value: m[1].trim(),
          confidence: fp.confidence,
          evidence: m[0],
          certainty: 'explicit',
        });
      }
    }

    // 无显式登记字段但被登记句式提及 → 仍标记 referenced（供上层建档判断）
    if (fields.length === 0 && !REGISTRATION_SIGNAL.test(text)) continue;

    results.push({
      personName,
      fields,
      reasoningTrace: 'fallback_regex',
      overallConfidence: fields.length > 0 ? 0.7 : 0.3,
      personReferenced: REGISTRATION_SIGNAL.test(text) || fields.length > 0,
    });
  }

  return results;
}
