/**
 * EntityContextBuilder — 实体会晤人物上下文构建器
 *
 * 从实体 dossier + edges + 对话历史构建 LLM 上下文。
 * 替代旧的 _loadRPFamily / _loadRPKnowledge / _loadRPPastHistory 等分散逻辑。
 *
 * 核心原则：
 * - 唯一数据源 = dossier 结构化档案（不依赖碎片对话）
 * - 实时查询 = edges BFS 关系（不缓存于硬编码 prompt）
 * - 按需组装 = 只取本次会晤需要的字段（不注入全量档案）
 */

import type { FamilyGraph, PersonProfile, PersonDossier } from './FamilyGraph.js';
import { getRelationLabel } from './shared/RelationLabels.js';
import { buildGreetingProtocol } from './EntityGreetingProtocol.js';

/** 构建选项 */
export interface EntityContextOptions {
  /** 会晤目标人名 */
  entityName: string;
  /** 是否包含外貌描述 */
  appearance?: boolean;
  /** 是否包含女性详细体征 */
  feminineDetails?: boolean;
  /** 历史对话条数 */
  recentHistoryCount?: number;
  /** 🆕 V3.0: 是否首轮对话（注入开场协议） */
  isFirstTurn?: boolean;
  /** 🆕 V3.0: 用户名（用于开场协议称呼） */
  userName?: string;
  /** 🆕 V4.0: 与该实体的近期对话记录 */
  recentConversations?: Array<{ role: string; content: string; timestamp: string }>;
}

/** 构建结果 */
export interface EntityContextResult {
  /** 注入 LLM 的 system prompt 文本 */
  systemText: string;
  /** 人物摘要（供日志/调试） */
  summary: string;
  /** 档案完整度 */
  completeness: number;
}

/**
 * 从 PersonDossier 构建会晤人物上下文。
 */
export function buildEntityContext(
  familyGraph: FamilyGraph,
  options: EntityContextOptions
): EntityContextResult {
  const { entityName, appearance = true, feminineDetails = false, recentHistoryCount = 5, isFirstTurn = false, userName = '鸿艺', recentConversations } = options;

  const profile = familyGraph.getPersonProfile(entityName);
  if (!profile) {
    return {
      systemText: `你是 ${entityName}。（暂无详细档案）`,
      summary: `${entityName}: 档案不存在`,
      completeness: 0,
    };
  }

  const dossier = profile.dossier || {} as PersonDossier;
  const selfProfile = dossier.selfProfile || {};
  const basicInfo = dossier.basicInfo || {};
  const socialIdentity = dossier.socialIdentity || {};

  // 关系边
  const edges = _getRelatedEdges(familyGraph, entityName);

  const parts: string[] = [];

  // ═══ 身份声明 ═══
  parts.push(`## 你的身份`);
  parts.push(`你是 **${entityName}**。以下是你的人生档案，请严格基于此档案回复。`);
  parts.push('');

  // ═══ 基本信息 ═══
  const bioParts: string[] = [];
  if (basicInfo.gender) bioParts.push(`性别: ${basicInfo.gender}`);
  if (basicInfo.birthYear) bioParts.push(`出生年: ${basicInfo.birthYear}`);
  if (basicInfo.birthPlace) bioParts.push(`出生地: ${basicInfo.birthPlace}`);
  if (basicInfo.education) bioParts.push(`学历: ${basicInfo.education}`);
  if (basicInfo.maritalStatus) bioParts.push(`婚姻: ${basicInfo.maritalStatus}`);
  if (basicInfo.ethnicity) bioParts.push(`民族: ${basicInfo.ethnicity}`);
  // 🆕 V4.0: 从生命里程碑中提取年龄信息
  if (!basicInfo.birthYear) {
    const allMilestones = dossier.lifeMilestones || [];
    for (const ms of allMilestones) {
      const ageMatch = (ms.event || '').match(/年龄[：:]\s*(\d+)\s*岁/);
      if (ageMatch) {
        bioParts.push(`当前年龄: ${ageMatch[1]}岁 (${ms.date || '近期记录'})`);
        break;
      }
      const birthMatch = (ms.event || '').match(/(\d{4})\s*年/);
      if (birthMatch) {
        bioParts.push(`出生年: ${birthMatch[1]}`);
        break;
      }
    }
  }

  if (bioParts.length > 0) {
    parts.push('### 基本信息');
    parts.push(bioParts.join('  |  '));
    parts.push('');
  }

  // ═══ 职业与社会身份 ═══
  const socialParts: string[] = [];
  if (socialIdentity.currentOccupation) socialParts.push(`职业: ${socialIdentity.currentOccupation}`);
  if (socialIdentity.currentWorkplace) socialParts.push(`工作单位: ${socialIdentity.currentWorkplace}`);
  if (profile.relation_to_user) socialParts.push(`与用户的关系: ${profile.relation_to_user}`);
  if (socialParts.length > 0) {
    parts.push('### 社会身份');
    parts.push(socialParts.join('  |  '));
    parts.push('');
  }

  // ═══ 性格 ═══
  const traitParts: string[] = [];
  if (selfProfile.traits && selfProfile.traits.length > 0)
    traitParts.push(`性格: ${selfProfile.traits.join('、')}`);
  if (selfProfile.likes && selfProfile.likes.length > 0)
    traitParts.push(`喜好: ${selfProfile.likes.join('、')}`);
  if (selfProfile.dislikes && selfProfile.dislikes.length > 0)
    traitParts.push(`排斥: ${selfProfile.dislikes.join('、')}`);
  if (selfProfile.languageHabits)
    traitParts.push(`语言习惯: ${selfProfile.languageHabits}`);
  if (selfProfile.taboos && selfProfile.taboos.length > 0)
    traitParts.push(`禁忌: ${selfProfile.taboos.join('、')}`);
  if (traitParts.length > 0) {
    parts.push('### 性格与习惯');
    parts.push(traitParts.join('\n'));
    parts.push('');
  }

  // ═══ 外貌 ═══
  if (appearance) {
    const appearParts: string[] = [];
    if (selfProfile.appearance) appearParts.push(selfProfile.appearance);
    if (selfProfile.bodyFeatures) appearParts.push(selfProfile.bodyFeatures);
    if (selfProfile.style) appearParts.push(selfProfile.style);
    if (selfProfile.voice) appearParts.push(selfProfile.voice);
    if (selfProfile.distinguishingMarks) appearParts.push(selfProfile.distinguishingMarks);
    if (appearParts.length > 0) {
      parts.push('### 外貌与形象');
      parts.push(appearParts.join('  |  '));
      parts.push('');
    }
  }

  // ═══ 女性体征 ═══
  if (feminineDetails && selfProfile.feminineDetails) {
    const fd = selfProfile.feminineDetails;
    const fdParts: string[] = [];
    if (fd.firstImpression) fdParts.push(`整体印象: ${fd.firstImpression}`);
    if (fd.stature) fdParts.push(`身高体型: ${fd.stature}`);
    if (fd.measurements) fdParts.push(`三围: ${fd.measurements}`);
    if (fd.breasts) fdParts.push(`胸部: ${fd.breasts}`);
    if (fd.skin) fdParts.push(`皮肤: ${fd.skin}`);
    if (fd.allure) fdParts.push(`魅力: ${fd.allure}`);
    if (fdParts.length > 0) {
      parts.push('### 女性体征');
      parts.push(fdParts.join('\n'));
      parts.push('');
    }
  }

  // ═══ 人际关系 ═══
  if (edges.length > 0) {
    const relativeDetails: string[] = [];
    for (const edge of edges) {
      const relProfile = familyGraph.getPersonProfile(edge.entity);
      const relBasic = relProfile?.dossier?.basicInfo || {};
      const relMilestones = relProfile?.dossier?.lifeMilestones || [];
      // 构建亲属详情
      let detail = `${edge.entity}（${edge.relationLabel}`;
      if (relBasic.gender) detail += `，${relBasic.gender}`;
      if (relBasic.birthYear) detail += `，${relBasic.birthYear}年生`;
      if (relBasic.education) detail += `，${relBasic.education}`;
      if (relProfile?.occupation || (relProfile?.dossier as any)?.socialIdentity?.currentOccupation) detail += `，${relProfile?.occupation || (relProfile?.dossier as any)?.socialIdentity?.currentOccupation || ''}`;
      // 从里程碑提取年龄
      if (!relBasic.birthYear) {
        for (const ms of relMilestones) {
          const ageMatch = (ms.event || '').match(/年龄[：:]\s*(\d+)\s*岁/);
          if (ageMatch) { detail += `，现年${ageMatch[1]}岁`; break; }
        }
      }
      detail += '）';
      if (detail.length > edge.entity.length + 10) {
        relativeDetails.push(detail);
      } else {
        relativeDetails.push(`- ${edge.entity}: ${edge.relationLabel}`);
      }
    }

    parts.push('### 你认识的人（含详情）');
    for (const d of relativeDetails) {
      parts.push(`- ${d}`);
    }
    parts.push('');
  }

  // ═══ 人生里程碑 ═══
  if (dossier.lifeMilestones && dossier.lifeMilestones.length > 0) {
    parts.push('### 人生里程碑');
    for (const ms of dossier.lifeMilestones.slice(0, 5)) {
      parts.push(`- ${ms.date}: ${ms.event}`);
    }
    parts.push('');
  }

  // 🆕 V4.0: 近期对话历史 — 让实体知道上次聊到哪了 ═══
  if (recentConversations && recentConversations.length > 0) {
    parts.push('### 你和鸿艺最近的对话');
    parts.push('以下是你们近期的交流记录，你可以参考以保持对话的连贯性：');
    for (const conv of recentConversations.slice(0, recentHistoryCount)) {
      const role = conv.role === 'user' ? '鸿艺' : '你';
      const date = conv.timestamp ? conv.timestamp.substring(0, 10) : '';
      const snippet = (conv.content || '').substring(0, 150);
      parts.push(`- (${date}) ${role}：${snippet}`);
    }
    parts.push('');
  }

  // ═══ 行为约束 ═══
  parts.push('### 行为规范');
  parts.push(`- 你不扮演任何人——你就是 ${entityName} 本人`);
  parts.push('- 你的回复应基于档案中记录的性格、语言习惯、知识范围');
  parts.push('- 你对用户的认识来自档案中的关系记录');
  parts.push('- 档案中标注"待采集"的信息，说明你不知道——如实说不知道，不编造');
  parts.push('- 对话中用户告诉你新的个人信息，你会记住（系统自动归档）');

  let systemText = parts.join('\n');

  // 🆕 V3.0: 首轮注入开场协议
  if (isFirstTurn) {
    const greeting = buildGreetingProtocol(profile, userName);
    if (greeting) {
      systemText = greeting + '\n\n' + systemText;
    }
  }

  const summary = `${entityName}: ${profile.relation_to_user || ''} ${socialIdentity.currentOccupation || ''}`.trim();

  return {
    systemText,
    summary,
    completeness: Math.round((profile.completeness || 0) * 100),
  };
}

/** 获取实体的关系边 */
function _getRelatedEdges(familyGraph: FamilyGraph, entityName: string): Array<{ entity: string; relationLabel: string }> {
  try {
    const fg = familyGraph as any;
    if (typeof fg.getRelatedPersons !== 'function') return [];
    const persons = fg.getRelatedPersons(entityName) || [];
    return persons.map((p: any) => ({
      entity: p.name || p.entity,
      relationLabel: getRelationLabel(p.relation, true),
    }));
  } catch {
    return [];
  }
}

export default buildEntityContext;
