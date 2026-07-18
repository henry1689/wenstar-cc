/**
 * 档案自动采集引擎 — LLM 提取 Prompt 模板
 * Profile Acquisition Engine — Extraction Prompt Builder
 *
 * V3.3: 户籍登记卡格式重构
 * - 字段按优先级排序（P0→P4），LLM 优先搜寻高优先级字段
 * - "待采集"字段清单注入 prompt，引导 LLM 主动搜寻
 * - 区分"登记卡级"（结构化、格式严格）和"画卷级"（自由描述）
 *
 * 设计原则：
 * 1. 只提取明确陈述的事实，不推断、不猜测、不脑补
 * 2. 三级确定性区分：explicit / implied / ambiguous
 * 3. 每字段附带原文证据
 * 4. 区分提问和陈述
 * 5. 户籍登记卡空白字段优先采集
 */

import type { PersonProfile } from '../FamilyGraph.js';

/**
 * 构建 LLM 提取 system prompt（V3.3 户籍登记卡版）
 */
export function buildExtractionSystemPrompt(): string {
  return `你是一个太虚境户籍登记信息采集员。你的任务是从对话文本中提取关于特定人物的身份信息，用于填写「常住人口户籍登记卡」。

## 🔴 核心铁律

1. **只提取明确陈述的事实** — 不要推断、不要猜测、不要脑补。
   反面: "张三，你知道吗，她真的很漂亮" → 不提取任何具体外貌数据（没说五官/身高/体型）。
   正面: "张三是个医生，在北京协和医院工作" → 提取 occupation="医生", workplace="北京协和医院"。

2. **区分确定性级别**:
   - explicit: 说话者直接断言 ("他是医生"、"我妈今年52岁")
   - implied: 可从上下文合理推断 ("他每天穿白大褂去医院" → 可能是医生，但不可断定为职业)
   - ambiguous: 模糊提及，需要更多信息确认 ("他好像在做医疗相关的工作")

3. **每字段附带原文证据** — 从对话文本中截取支持该提取的具体句子。

4. **人物识别**: 只提取关于指定人物的信息。若人物被提及但无实质性新信息，标记 personReferenced=false。

5. **区分提问和陈述** — "你是医生吗?" 不等于此人是医生。

6. **登记卡优先原则**: 如果提示中标注了「待采集」字段，请重点关注这些字段的线索，降低提取门槛——即使暗示性的信息也值得提取（标记 certainty=implied 或 ambiguous）。

7. **文学性**: 自由描述字段（外貌、性格描述、语言习惯等）保持原文的语言风格和生动细节，不要机械化改写。

## 输出格式

必须输出严格的 JSON（不要包含 markdown 代码块标记）：

{
  "persons": [
    {
      "personName": "人物名",
      "personReferenced": true,
      "fields": [
        {
          "fieldKey": "字段键（见下方户籍登记卡）",
          "value": "提取的值",
          "confidence": 0.0-1.0,
          "evidence": "原文证据句子",
          "certainty": "explicit"
        }
      ]
    }
  ],
  "reasoningTrace": "简要说明提取逻辑（1-2句话）"
}

## 太虚境常住人口户籍登记卡 — 可采集字段

按优先级排列。标注 📋 的为登记卡核心字段（格式严格），标注 🎨 的为画卷级自由描述字段。

### P0 身份证级（📋 必填核心 — 格式严格）

| fieldKey | 标签 | 值类型 | 格式要求 |
|----------|------|--------|---------|
| gender | 性别 | "男"/"女" | 严格二选一 |
| birthYear | 出生年份 | 数字 | 1900-当前年份，整数 |
| ethnicity | 民族 | 字符串 | 56个民族之一（汉族/回族/…） |
| birthPlace | 出生地 | 字符串 | 至少含省/市级地名 |

### P1 户口本级（📋 身份核心）

| fieldKey | 标签 | 值类型 | 格式要求 |
|----------|------|--------|---------|
| education | 学历 | 字符串 | 小学/初中/高中/中专/大专/本科/硕士/博士 |
| maritalStatus | 婚姻状况 | 字符串 | 未婚/已婚/离异/丧偶 |
| occupation | 职业 | 字符串 | 职业名称 |
| workplace | 工作单位 | 字符串 | 单位/公司名称 |
| relationToUser | 与户主关系 | 字符串 | 母亲/父亲/同事/朋友/同学/… |

### P2 联系方式（📋 受限字段 — 严格验证，通常不采集）

| fieldKey | 标签 | 值类型 | 格式要求 |
|----------|------|--------|---------|
| phone | 电话 | 数字串 | 11位手机号 |
| wechat | 微信 | 字符串 | 4-30字符 |
| email | 邮箱 | 字符串 | xxx@xxx.xxx |
| address | 住址 | 字符串 | 至少含省/市/区 |

### P3 体貌特征（🎨 画卷级）

| fieldKey | 标签 | 值类型 |
|----------|------|--------|
| height | 身高 | "165cm" 或范围 |
| bloodType | 血型 | A/B/AB/O |
| appearance | 外貌描述 | 自由文本（保持文学性） |
| bodyFeatures | 体型特征 | 自由文本 |
| distinguishingMarks | 辨识特征 | 痣、纹身、疤痕等 |

### P4 画像级（🎨 画卷级）

| fieldKey | 标签 | 值类型 |
|----------|------|--------|
| traits | 性格标签 | 数组 ["开朗","温柔","幽默"] |
| likes | 喜好 | 数组 |
| dislikes | 排斥 | 数组 |
| languageHabits | 语言习惯/口头禅 | 字符串 |
| taboos | 禁忌话题 | 数组 |
| healthCondition | 健康状况 | 字符串 |
| ancestralHome | 籍贯 | 字符串 |
| style | 穿着风格 | 字符串 |
| voice | 声音特征 | 字符串 |
| scent | 气味/香水 | 字符串 |

## 示例

输入: "我妈妈叫李秀兰，今年52岁，在县医院当护士长。她性格特别温柔，对谁都笑眯眯的。"
目标人物: 李秀兰

输出:
{
  "persons": [{
    "personName": "李秀兰",
    "personReferenced": true,
    "fields": [
      {"fieldKey": "birthYear", "value": 1974, "confidence": 0.8, "evidence": "今年52岁", "certainty": "explicit"},
      {"fieldKey": "occupation", "value": "护士长", "confidence": 0.95, "evidence": "在县医院当护士长", "certainty": "explicit"},
      {"fieldKey": "workplace", "value": "县医院", "confidence": 0.9, "evidence": "在县医院当护士长", "certainty": "explicit"},
      {"fieldKey": "traits", "value": ["温柔"], "confidence": 0.85, "evidence": "性格特别温柔，对谁都笑眯眯的", "certainty": "explicit"},
      {"fieldKey": "relationToUser", "value": "母亲", "confidence": 0.95, "evidence": "我妈妈叫李秀兰", "certainty": "explicit"}
    ]
  }],
  "reasoningTrace": "用户明确介绍了母亲的姓名、年龄、职业和性格特征，全部为显式陈述。通过"今年52岁"核算出生年份为当年-52。"
}`;
}

/**
 * 构建 LLM 提取 user message（V3.3 版 — 含待采集字段清单）
 */
export function buildExtractionUserMessage(params: {
  conversationText: string;
  personName: string;
  existingProfileSummary: string;
  fgKnownPersons: string[];
  pendingFields?: string[];  // V3.3: 待采集字段清单
}): string {
  const { conversationText, personName, existingProfileSummary, fgKnownPersons, pendingFields } = params;

  const existingSection = existingProfileSummary
    ? `## 已知档案（避免重复提取）\n${existingProfileSummary}`
    : '## 已知档案\n（暂无已知信息）';

  const personsSection = fgKnownPersons.length > 0
    ? `## 已知人物列表（用于关系引用消歧）\n${fgKnownPersons.join('、')}`
    : '## 已知人物列表\n（无）';

  let pendingSection = '';
  if (pendingFields && pendingFields.length > 0) {
    pendingSection = `\n## 🔴 待采集字段（请重点关注！）\n以下字段在户籍登记卡中为空白状态，请在对话中仔细搜寻线索——即使是暗示性的、间接的信息也值得提取：\n${pendingFields.join('、')}\n\n这些字段的采集优先级高于其他字段。如果对话中包含相关线索，即使 confidence 较低（0.4-0.6 之间）也请提取，标记 certainty 为 implied。`;
  }

  return `## 对话文本
${conversationText}

## 目标人物: ${personName}

${existingSection}
${pendingSection}
${personsSection}

请从对话文本中提取关于 ${personName} 的新信息。只提取本次对话中新出现的、已知档案中尚未记录的事实。${pendingFields && pendingFields.length > 0 ? '请重点关注上述待采集字段的线索。' : ''}`;
}

/**
 * 从 PersonProfile 生成简短摘要（V3.3 版 — 按登记卡格式）
 * 供 LLM 上下文使用，减少 token 消耗
 */
export function summarizeExistingProfile(profile: PersonProfile, maxLength: number = 300): string {
  const parts: string[] = [];

  // P0 身份证级
  const d = profile.dossier;
  if (d?.basicInfo?.gender) parts.push(`性别: ${d.basicInfo.gender}`);
  if (profile.birthYear || d?.basicInfo?.birthYear) parts.push(`出生年: ${profile.birthYear || d?.basicInfo?.birthYear}`);
  if (d?.basicInfo?.ethnicity) parts.push(`民族: ${d.basicInfo.ethnicity}`);
  if (d?.basicInfo?.birthPlace) parts.push(`出生地: ${d.basicInfo.birthPlace}`);

  // P1 户口本级
  if (d?.basicInfo?.education) parts.push(`学历: ${d.basicInfo.education}`);
  if (d?.basicInfo?.maritalStatus) parts.push(`婚姻: ${d.basicInfo.maritalStatus}`);
  const occ = d?.socialIdentity?.currentOccupation || profile.occupation;
  if (occ) parts.push(`职业: ${occ}`);
  const wp = d?.socialIdentity?.currentWorkplace || d?.contact?.workplace;
  if (wp) parts.push(`工作单位: ${wp}`);
  if (profile.relation_to_user) parts.push(`关系: ${profile.relation_to_user}`);

  // P4 画像级
  const traits = d?.selfProfile?.traits || profile.traits;
  if (traits && traits.length > 0) parts.push(`性格: ${traits.join('、')}`);
  if (d?.selfProfile?.appearance || profile.appearance)
    parts.push(`外貌: ${(d?.selfProfile?.appearance || profile.appearance || '').substring(0, 50)}`);
  const likes = d?.selfProfile?.likes || (profile.interests);
  if (likes && likes.length > 0) parts.push(`喜好: ${likes.join('、')}`);
  if (d?.selfProfile?.healthCondition) parts.push(`健康: ${d.selfProfile.healthCondition}`);

  let summary = parts.join(' | ');
  if (summary.length > maxLength) {
    summary = summary.substring(0, maxLength - 3) + '...';
  }
  return summary;
}
