/**
 * Validator — 通用回复校验器
 *
 * 🔴 铁律：
 *   1. 全字段共用一套逻辑，无年龄/亲属等个案分支
 *   2. 三層校验：身份/事实/边界，一套逻辑覆盖所有实体
 *   3. 回复中所有数字、人名、身份必须能在1-4层中找到匹配项
 *
 * 🔴 修复5：两条硬规则
 *   ① 指代越界校验：回复中出现的人名必须在当前角色已知列表内
 *   ② 年龄编造校验：hasAge=false 时禁止 数字+岁
 */
import type { FourLayerData, ValidationResult, PersonStructProfile } from './types.js';

/** 中文数字匹配（紧邻单位词） */
const CN_NUM_PATTERN = /(\d{1,3})(?=岁|年|月|日)/g;

/** 人名匹配（2-4字中文上下文） */
const NAME_PATTERN = /[一-龥]{2,4}(?=[，。！？\s\n]|的|了|是|有|在|说|吗|啊|呢|呀|吧|哈|哈)/g;

export function validateReply(reply: string, data: FourLayerData, roleplay: string): ValidationResult {
  const issues: string[] = [];

  // ── ① 身份校验 ──
  const identityCheck = checkIdentity(reply, data.layer1.profile, roleplay);
  if (!identityCheck.pass) issues.push(...identityCheck.issues);

  // ── ② 事实校验 ──
  const factCheck = checkFacts(reply, data, roleplay);
  issues.push(...factCheck.issues);

  // ── ③ 边界校验 ──
  const boundaryCheck = checkBoundaries(reply, data, roleplay);
  issues.push(...boundaryCheck.issues);

  // ── ④ 修复5-①：指代越界校验 ──
  const refCheck = checkReferenceLeak(reply, data, roleplay);
  issues.push(...refCheck.issues);

  // ── ⑤ 修复5-②：年龄编造校验 ──
  const ageCheck = checkAgeFabrication(reply, data);
  issues.push(...ageCheck.issues);

  // ── 判定 ──
  if (issues.length === 0) {
    return { pass: true, severity: 'pass', issues: [], needsRegenerate: false };
  }

  const hasError = issues.some(i => i.startsWith('[ERR]'));
  return {
    pass: !hasError,
    severity: hasError ? 'error' : 'warning',
    issues,
    needsRegenerate: hasError,
  };
}

// ─── ① 身份校验 ───

function checkIdentity(reply: string, _profile: PersonStructProfile | null, _roleplay: string): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  if (/玉瑶/.test(reply) && !/不是玉瑶|我不是玉瑶/.test(reply)) {
    issues.push('[ERR] 身份漂移：回复中出现了"玉瑶"自称');
  }
  return { pass: issues.length === 0, issues };
}

// ─── ② 事实校验 ───

function checkFacts(reply: string, data: FourLayerData, _roleplay: string): { issues: string[] } {
  const issues: string[] = [];
  const numbers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CN_NUM_PATTERN.exec(reply)) !== null) {
    numbers.push(m[0]);
  }
  if (numbers.length > 0) {
    const allDataText = collectAllDataText(data);
    for (const num of numbers) {
      if (!allDataText.includes(num)) {
        issues.push(`[WARN] 事实存疑：回复中出现数字"${num}"，但四层数据中未找到匹配`);
      }
    }
  }
  return { issues };
}

// ─── ③ 边界校验 ───

function checkBoundaries(reply: string, data: FourLayerData, _roleplay: string): { issues: string[] } {
  const issues: string[] = [];
  const knownNames = collectKnownNames(data);
  const replyNames = reply.match(NAME_PATTERN) || [];
  for (const name of replyNames) {
    if (name === '我' || name === '你' || name === '他' || name === '她') continue;
    if (knownNames.has(name)) continue;
    if (/姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|奶奶|爷爷|老婆|老公|阿姨|叔叔/.test(name)) continue;
    issues.push(`[WARN] 边界嫌疑：回复中出现未知人名"${name}"`);
    break;
  }
  return { issues };
}

// ─── ④ 修复5-①：指代越界校验 ───

function checkReferenceLeak(reply: string, data: FourLayerData, roleplay: string): { issues: string[] } {
  const issues: string[] = [];
  const roleNames = collectKnownNames(data);

  // 角色自己的名字是合法的
  roleNames.add(roleplay);

  const replyNames = reply.match(NAME_PATTERN) || [];
  for (const name of replyNames) {
    if (name === roleplay || name === '我' || name === '你' || name === '他' || name === '她') continue;
    // 亲属称谓合法
    if (/姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|奶奶|爷爷|老婆|老公|阿姨|叔叔|表姐|表妹|表哥|表弟|堂姐|堂妹|堂哥|堂弟/.test(name)) continue;
    // 不在角色已知人物列表 → 越界
    if (!roleNames.has(name)) {
      issues.push(`[ERR] 指代越界：回复中出现"${name}"，该人物不在当前角色的已知关系中`);
      break;
    }
  }
  return { issues };
}

// ─── ⑤ 修复5-②：年龄编造校验 ───

function checkAgeFabrication(reply: string, data: FourLayerData): { issues: string[] } {
  const issues: string[] = [];

  // 检查角色本人年龄
  if (!data.layer1.knownFields.age) {
    const ageMatch = reply.match(/(\d{1,2})岁/);
    if (ageMatch) {
      issues.push(`[ERR] 年龄编造：角色无年龄数据，但回复中出现了"${ageMatch[1]}岁"`);
    }
  }

  // 检查每个亲属的年龄
  for (const rel of data.layer2.relatives) {
    if (!rel.knownFields?.age) {
      // 如果亲属没有年龄数据，检查回复中是否包含该亲属+数字+岁
      const relAgePattern = new RegExp(`${rel.name}[^。]*?(\\d{1,2})岁`);
      const m = reply.match(relAgePattern);
      if (m) {
        issues.push(`[ERR] 年龄编造：${rel.name}无年龄数据，但回复中出现了"${m[1]}岁"`);
      }
    }
  }

  return { issues };
}

// ─── 工具 ───

function collectAllDataText(data: FourLayerData): string {
  return [data.layer1.identityText, data.layer2.relationText, data.layer3.memoryText, data.layer4.knowledgeText]
    .join(' ');
}

function collectKnownNames(data: FourLayerData): Set<string> {
  const names = new Set<string>();
  if (data.layer1.profile) names.add(data.layer1.profile.name);
  for (const rel of data.layer2.relatives) names.add(rel.name);
  return names;
}
